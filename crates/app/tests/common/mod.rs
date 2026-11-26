#![allow(dead_code)]
//! Entorno de pruebas: Host falso, HOME aislado, llavero falso y un "claude" falso (script de shell).

use betools_app::{App, AppConfig, Host, Notice, TrayState};
use betools_secrets::Keyring;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once, OnceLock};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct FakeHost {
    pub events: Mutex<Vec<(String, Vec<Value>)>>,
    pub clipboard: Mutex<String>,
    pub urls: Mutex<Vec<String>>,
    pub opened: Mutex<Vec<String>>,
    pub revealed: Mutex<Vec<String>>,
    pub notices: Mutex<Vec<Notice>>,
    pub tray: Mutex<Vec<TrayState>>,
    pub pick: Mutex<Option<String>>,
    pub shown: Mutex<usize>,
    pub focused: AtomicBool,
}

impl Host for FakeHost {
    fn emit(&self, channel: &str, args: Vec<Value>) {
        self.events.lock().unwrap().push((channel.to_string(), args));
    }
    fn clipboard_read(&self) -> Result<String, String> {
        Ok(self.clipboard.lock().unwrap().clone())
    }
    fn clipboard_write(&self, text: &str) -> Result<(), String> {
        *self.clipboard.lock().unwrap() = text.to_string();
        Ok(())
    }
    fn pick_folder(&self) -> Option<String> {
        self.pick.lock().unwrap().clone()
    }
    fn open_external(&self, url: &str) -> Result<(), String> {
        self.urls.lock().unwrap().push(url.to_string());
        Ok(())
    }
    fn open_file(&self, _user_data: &Path, path: &str) -> Result<(), String> {
        self.opened.lock().unwrap().push(path.to_string());
        Ok(())
    }
    fn reveal_file(&self, path: &str) {
        self.revealed.lock().unwrap().push(path.to_string());
    }
    fn notify(&self, n: Notice) {
        self.notices.lock().unwrap().push(n);
    }
    fn show_window(&self) {
        *self.shown.lock().unwrap() += 1;
    }
    fn window_focused(&self) -> bool {
        self.focused.load(Ordering::SeqCst)
    }
    fn update_tray(&self, s: TrayState) {
        self.tray.lock().unwrap().push(s);
    }
}

impl FakeHost {
    pub fn named(&self, ch: &str) -> Vec<Vec<Value>> {
        self.events.lock().unwrap().iter().filter(|(c, _)| c == ch).map(|(_, a)| a.clone()).collect()
    }
    pub fn count(&self, ch: &str) -> usize {
        self.named(ch).len()
    }
    /// Texto de todo el `pty:data` de una clave, concatenado.
    pub fn output(&self, key: &str) -> String {
        self.named("pty:data").iter().filter(|a| a[0] == key).map(|a| a[1].as_str().unwrap().to_string()).collect()
    }
}

struct FakeKeyring;
impl Keyring for FakeKeyring {
    fn password(&self, _create: bool) -> anyhow::Result<Option<String>> {
        Ok(Some("test-password".into()))
    }
}

/// HOME compartido y temporal para todo el binario de pruebas: nada toca el real.
pub fn home() -> &'static Path {
    static DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
    static ONCE: Once = Once::new();
    let dir = DIR.get_or_init(|| tempfile::tempdir().unwrap());
    ONCE.call_once(|| {
        std::env::set_var("HOME", dir.path());
        std::env::remove_var("XDG_CONFIG_HOME");
        // La terminal usa $SHELL: con zsh y un HOME vacío arrancaría el asistente de configuración.
        std::env::set_var("SHELL", "/bin/sh");
    });
    dir.path()
}

// "claude" falso: avisa que arrancó, imprime variables para verificar el entorno y obedece comandos simples.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
echo "fake-ready FOO=$FOO BAR=$BAR"
while IFS= read -r line; do
  case "$line" in
    work*) printf 'working\n' >> "$CLAWHIP_STATUS_FILE" ;;
    wait*) printf 'waiting\n' >> "$CLAWHIP_STATUS_FILE" ;;
    done*) printf 'done\n' >> "$CLAWHIP_STATUS_FILE" ;;
    quit*) exit 3 ;;
    *) echo "echo:$line" ;;
  esac
done
"#;

pub struct Env {
    pub tmp: tempfile::TempDir,
    pub host: Arc<FakeHost>,
    pub app: App,
    pub user_data: PathBuf,
}

pub fn env() -> Env {
    env_with(|_| {})
}

pub fn env_with(prepare: impl FnOnce(&Path)) -> Env {
    env_script(FAKE_CLAUDE, prepare)
}

/// Como `env_with`, con otro script en lugar del "claude" falso por defecto.
pub fn env_script(script: &str, prepare: impl FnOnce(&Path)) -> Env {
    home();
    let tmp = tempfile::tempdir().unwrap();
    let user_data = tmp.path().join("userData");
    std::fs::create_dir_all(&user_data).unwrap();
    prepare(&user_data);
    let bin = tmp.path().join("fake-claude");
    std::fs::write(&bin, script).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let host = Arc::new(FakeHost::default());
    let mut cfg = AppConfig::new(&user_data);
    cfg.claude_bin = Some(bin.to_string_lossy().into_owned());
    cfg.keyring = Some(Box::new(FakeKeyring));
    let app = App::new(host.clone(), cfg).expect("app");
    Env { tmp, host, app, user_data }
}

impl Env {
    pub fn invoke(&self, ch: &str, args: Vec<Value>) -> Result<Value, String> {
        self.app.invoke(ch, args)
    }
    pub fn ok(&self, ch: &str, args: Vec<Value>) -> Value {
        self.app.invoke(ch, args).unwrap_or_else(|e| panic!("{ch}: {e}"))
    }
    pub fn err(&self, ch: &str, args: Vec<Value>) -> String {
        self.app.invoke(ch, args).expect_err(ch)
    }
    /// Carpeta de trabajo nueva dentro del tmp de la prueba.
    pub fn dir(&self, name: &str) -> String {
        let p = self.tmp.path().join(name);
        std::fs::create_dir_all(&p).unwrap();
        p.to_string_lossy().into_owned()
    }
    /// Crea una sesión y devuelve su id.
    pub fn session(&self, name: &str) -> String {
        let cwd = self.dir(&format!("cwd-{name}"));
        self.ok("sessions:create", vec![json!(cwd), json!(name)])["id"].as_str().unwrap().to_string()
    }
    pub fn attach(&self, key: &str) {
        self.app.send("pty:attach", vec![json!(key), json!(100), json!(30)]).unwrap();
    }
    pub fn input(&self, key: &str, data: &str) {
        self.app.send("pty:input", vec![json!(key), json!(data)]).unwrap();
    }
    pub fn status(&self, id: &str) -> String {
        self.ok("sessions:list", vec![])["status"][id].as_str().unwrap().to_string()
    }
}

pub fn wait_for(what: &str, f: impl Fn() -> bool) {
    wait_for_secs(what, 10, f)
}

pub fn wait_for_secs(what: &str, secs: u64, f: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timeout esperando: {what}");
}

impl Drop for Env {
    fn drop(&mut self) {
        self.app.shutdown();
    }
}
