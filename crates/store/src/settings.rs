use crate::util::home_dir;
use crate::Result;
use betools_types::Settings;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn defaults() -> Map<String, Value> {
    let Value::Object(m) = json!({ "closeToTray": true, "autostart": false, "notifications": true, "eagerStart": false, "remoteControl": true }) else {
        unreachable!()
    };
    m
}

/// `Partial<Settings>`: solo se pisan los campos presentes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub close_to_tray: Option<bool>,
    pub autostart: Option<bool>,
    pub notifications: Option<bool>,
    pub eager_start: Option<bool>,
    pub remote_control: Option<bool>,
}

pub struct SettingsStore {
    file: PathBuf,
    // Mapa y no struct: claves desconocidas del archivo se conservan al reescribirlo, como en JS.
    state: Map<String, Value>,
    autostart_dir: PathBuf,
    exec: PathBuf,
}

impl SettingsStore {
    /// El autoarranque apunta al ejecutable en curso (el binario empaquetado) con `--hidden`.
    pub fn new(user_data_dir: &Path) -> Self {
        let exec = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("betools"));
        Self::with_exec(user_data_dir, exec, &home_dir())
    }

    /// Variante con ejecutable y HOME explícitos (pruebas, o un lanzador distinto del binario actual).
    pub fn with_exec(user_data_dir: &Path, exec: PathBuf, home: &Path) -> Self {
        let file = user_data_dir.join("settings.json");
        let mut state = defaults();
        if let Some(Value::Object(saved)) = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()) {
            state.extend(saved);
        }
        let mut s = Self { file, state, autostart_dir: home.join(".config").join("autostart"), exec };
        // Si estaba el autoarranque con el nombre anterior (clawhip), se reemplaza por el nuevo.
        let legacy = s.autostart_dir.join("clawhip.desktop");
        if legacy.exists() {
            let _ = fs::remove_file(&legacy);
            let _ = s.set_autostart(true);
        }
        // El archivo de autostart manda: si el usuario lo borró a mano, se refleja.
        let on = s.autostart_file().exists();
        s.state.insert("autostart".into(), Value::Bool(on));
        // Reescribe la entrada para que apunte al ejecutable actual (p. ej. al pasar de dev a instalada).
        if on {
            let _ = s.set_autostart(true);
        }
        s
    }

    fn autostart_file(&self) -> PathBuf {
        self.autostart_dir.join("betools.desktop")
    }

    pub fn get(&self) -> Settings {
        serde_json::from_value(Value::Object(self.state.clone()))
            .or_else(|_| serde_json::from_value(Value::Object(defaults())))
            .expect("defaults válidos")
    }

    pub fn update(&mut self, patch: SettingsPatch) -> Result<Settings> {
        let fields = [
            ("closeToTray", patch.close_to_tray),
            ("autostart", patch.autostart),
            ("notifications", patch.notifications),
            ("eagerStart", patch.eager_start),
            ("remoteControl", patch.remote_control),
        ];
        for (k, v) in fields {
            if let Some(v) = v {
                self.state.insert(k.into(), Value::Bool(v));
            }
        }
        if let Some(on) = patch.autostart {
            self.set_autostart(on)?;
        }
        fs::write(&self.file, serde_json::to_string_pretty(&self.state)?)?;
        Ok(self.get())
    }

    // Entrada XDG en ~/.config/autostart.
    fn set_autostart(&self, enabled: bool) -> Result<()> {
        let file = self.autostart_file();
        if !enabled {
            return match fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
                _ => Ok(()),
            };
        }
        let exec = format!("{} --hidden", quote(&self.exec.to_string_lossy()));
        fs::create_dir_all(&self.autostart_dir)?;
        let text = ["[Desktop Entry]", "Type=Application", "Name=betools", "Comment=Claude Code sessions", &format!("Exec={exec}"), "X-GNOME-Autostart-enabled=true", ""].join("\n");
        fs::write(file, text)?;
        Ok(())
    }
}

// Argumento entre comillas dobles de un Exec XDG: se escapan " \ ` $.
fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        if matches!(c, '"' | '\\' | '`' | '$') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Env {
        _tmp: tempfile::TempDir,
        data: PathBuf,
        home: PathBuf,
    }

    fn env() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let home = tmp.path().join("home");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&home).unwrap();
        Env { _tmp: tmp, data, home }
    }

    fn store(e: &Env) -> SettingsStore {
        SettingsStore::with_exec(&e.data, PathBuf::from("/opt/betools/betools"), &e.home)
    }

    fn desktop(e: &Env) -> PathBuf {
        e.home.join(".config/autostart/betools.desktop")
    }

    #[test]
    fn defaults_when_missing_or_corrupt() {
        let e = env();
        let want = Settings { close_to_tray: true, autostart: false, notifications: true, eager_start: false, remote_control: true };
        assert_eq!(store(&e).get(), want);
        fs::write(e.data.join("settings.json"), "{no").unwrap();
        assert_eq!(store(&e).get(), want);
    }

    #[test]
    fn partial_file_is_merged_over_defaults() {
        let e = env();
        fs::write(e.data.join("settings.json"), r#"{"closeToTray":false,"eagerStart":true}"#).unwrap();
        let s = store(&e).get();
        assert!(!s.close_to_tray && s.eager_start && s.notifications && s.remote_control);
    }

    #[test]
    fn update_persists_and_keeps_unknown_keys() {
        let e = env();
        fs::write(e.data.join("settings.json"), r#"{"futureFlag":123}"#).unwrap();
        let mut s = store(&e);
        let out = s.update(SettingsPatch { notifications: Some(false), ..Default::default() }).unwrap();
        assert!(!out.notifications && out.close_to_tray);
        let saved: Value = serde_json::from_str(&fs::read_to_string(e.data.join("settings.json")).unwrap()).unwrap();
        assert_eq!(saved["futureFlag"], 123);
        assert_eq!(saved["notifications"], false);
        assert!(!store(&e).get().notifications);
    }

    #[test]
    fn autostart_writes_and_removes_the_desktop_entry() {
        let e = env();
        let mut s = store(&e);
        assert!(!desktop(&e).exists());
        assert!(s.update(SettingsPatch { autostart: Some(true), ..Default::default() }).unwrap().autostart);
        let text = fs::read_to_string(desktop(&e)).unwrap();
        assert_eq!(
            text,
            "[Desktop Entry]\nType=Application\nName=betools\nComment=Claude Code sessions\nExec=\"/opt/betools/betools\" --hidden\nX-GNOME-Autostart-enabled=true\n"
        );
        assert!(store(&e).get().autostart);
        assert!(!s.update(SettingsPatch { autostart: Some(false), ..Default::default() }).unwrap().autostart);
        assert!(!desktop(&e).exists());
        // Quitar lo que no existe no falla.
        s.update(SettingsPatch { autostart: Some(false), ..Default::default() }).unwrap();
    }

    #[test]
    fn desktop_file_wins_over_the_saved_flag() {
        let e = env();
        fs::write(e.data.join("settings.json"), r#"{"autostart":true}"#).unwrap();
        assert!(!store(&e).get().autostart);
        let mut s = store(&e);
        s.update(SettingsPatch { autostart: Some(true), ..Default::default() }).unwrap();
        fs::remove_file(desktop(&e)).unwrap();
        assert!(!store(&e).get().autostart);
    }

    #[test]
    fn exec_is_rewritten_to_the_current_binary_on_start() {
        let e = env();
        let mut s = store(&e);
        s.update(SettingsPatch { autostart: Some(true), ..Default::default() }).unwrap();
        SettingsStore::with_exec(&e.data, PathBuf::from("/new/place/betools"), &e.home);
        assert!(fs::read_to_string(desktop(&e)).unwrap().contains("Exec=\"/new/place/betools\" --hidden\n"));
    }

    #[test]
    fn legacy_entry_is_replaced() {
        let e = env();
        let dir = e.home.join(".config/autostart");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("clawhip.desktop"), "old").unwrap();
        assert!(store(&e).get().autostart);
        assert!(!dir.join("clawhip.desktop").exists());
        assert!(desktop(&e).exists());
    }

    #[test]
    fn exec_path_is_quoted() {
        assert_eq!(quote(r#"/a b/"x"$y`z\"#), r#""/a b/\"x\"\$y\`z\\""#);
    }
}
