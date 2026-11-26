mod common;

use betools_pty::{claude_args, ResolvedEnv, PtyEvents, PtyManager};
use betools_types::Session;
use common::{wait_for, Log};
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

struct Ev {
    log: Arc<Log>,
    bin: String,
    transcript: bool,
    rc: Option<String>,
    env: Mutex<Result<ResolvedEnv, String>>,
    spawns: Mutex<Vec<String>>,
}

impl PtyEvents for Ev {
    fn on_spawn(&self, id: &str) -> PathBuf {
        self.spawns.lock().unwrap().push(id.to_string());
        PathBuf::from(format!("/tmp/status-{id}"))
    }
    fn on_data(&self, id: &str, data: &str) {
        self.log.data.lock().unwrap().push((id.to_string(), data.to_string()));
    }
    fn on_exit(&self, id: &str, code: i32) {
        self.log.exits.lock().unwrap().push((id.to_string(), code));
    }
    fn resolve_env(&self, _s: &Session) -> Result<ResolvedEnv, String> {
        self.env.lock().unwrap().clone()
    }
    fn remote_control_name(&self, _s: &Session) -> Option<String> {
        self.rc.clone()
    }
    fn claude_bin(&self) -> String {
        self.bin.clone()
    }
    fn transcript_exists(&self, _cwd: &str, _id: &str) -> bool {
        self.transcript
    }
    fn user_status_line(&self) -> String {
        "echo user-line".into()
    }
}

// Claude falso: imprime argumentos y entorno, tamaño del pty y repite lo que se escribe.
const FAKE: &str = r#"#!/bin/sh
for a in "$@"; do printf 'ARG[%s]\n' "$a"; done
printf 'TERM=%s COLORTERM=%s NOFLICKER=%s SYNC=%s\n' "$TERM" "$COLORTERM" "$CLAUDE_CODE_NO_FLICKER" "$CLAUDE_CODE_FORCE_SYNC_OUTPUT"
printf 'STATUS=%s USERSL=%s FOO=%s CWD=%s\n' "$CLAWHIP_STATUS_FILE" "$BETOOLS_USER_STATUSLINE" "$FOO" "$(pwd)"
printf 'INHERITED=%s\n' "$CLAUDECODE"
printf 'SIZE=%s\n' "$(stty size)"
printf 'READY\n'
while IFS= read -r line; do
  case "$line" in
    quit) exit 3 ;;
    die) kill -9 $$ ;;
    flood) seq 1 60000; printf 'FLOODEND\n' ;;
    env) printf 'E1=[%s] E2=[%s] E3=[%s] TERM=%s\n' "$E1" "$E2" "$E3" "$TERM" ;;
    size) printf 'SIZE=%s\n' "$(stty size)" ;;
    utf8) i=0; while [ $i -lt 20000 ]; do printf '€'; i=$((i+1)); done; printf 'END\n' ;;
    *) printf 'got:%s\n' "$line" ;;
  esac
done
"#;

struct Fx {
    _dir: TempDir,
    cwd: PathBuf,
    log: Arc<Log>,
    ev: Arc<Ev>,
    mgr: PtyManager,
}

fn fx_with(transcript: bool, rc: Option<&str>, env: Result<ResolvedEnv, String>) -> Fx {
    let dir = TempDir::new().unwrap();
    let bin = dir.path().join("claude");
    fs::write(&bin, FAKE).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    let cwd = dir.path().join("work dir");
    fs::create_dir_all(&cwd).unwrap();
    let log = Arc::new(Log::default());
    let ev = Arc::new(Ev {
        log: log.clone(),
        bin: bin.to_str().unwrap().to_string(),
        transcript,
        rc: rc.map(String::from),
        env: Mutex::new(env),
        spawns: Mutex::default(),
    });
    let mgr = PtyManager::new(ev.clone());
    Fx { _dir: dir, cwd, log, ev, mgr }
}

fn fx() -> Fx {
    fx_with(false, None, Ok(ResolvedEnv::default()))
}

fn session(fx: &Fx, id: &str) -> Session {
    Session {
        id: id.into(),
        name: "mi sesion".into(),
        cwd: fx.cwd.to_str().unwrap().into(),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        last_active_at: "2024-01-01T00:00:00.000Z".into(),
        env: None,
    }
}

fn base(id: &str) -> Session {
    Session { id: id.into(), name: "n".into(), cwd: "/".into(), created_at: String::new(), last_active_at: String::new(), env: None }
}

#[test]
fn claude_args_new_session() {
    let a = claude_args(&base("abc"), false, &[], None);
    assert_eq!(&a[..5], ["--session-id", "abc", "--name", "n", "--settings"]);
    assert_eq!(a.len(), 6);
    assert_eq!(a[5], betools_pty::build_settings(false));
}

#[test]
fn claude_args_resume_secrets_and_remote_control() {
    let names = vec!["A".to_string(), "B".to_string()];
    let a = claude_args(&base("abc"), true, &names, Some("Mi RC"));
    assert_eq!(&a[..3], ["--resume", "abc", "--settings"]);
    assert_eq!(a[3], betools_pty::build_settings(true));
    assert_eq!(a[4], "--append-system-prompt");
    assert!(a[5].starts_with("This session has environment variables with sensitive values: A, B. Use them only by reference"));
    assert!(a[5].ends_with("stop and ask the user for it."));
    assert_eq!(&a[6..], ["--remote-control", "Mi RC"]);
}

#[test]
fn claude_args_remote_control_without_name_has_no_argument() {
    let a = claude_args(&base("abc"), true, &[], Some(""));
    assert_eq!(a.last().unwrap(), "--remote-control");
    assert_eq!(a.len(), 5);
}

#[test]
fn lazy_start_passes_args_env_and_cwd() {
    let fx = fx();
    let s = session(&fx, "s1");
    assert!(!fx.mgr.is_running("s1"));
    assert_eq!(fx.mgr.attach(&s, 100, 30), None);
    fx.log.wait_text("s1", "READY");
    let t = fx.log.text("s1");
    assert!(t.contains("ARG[--session-id]\r\nARG[s1]\r\nARG[--name]\r\nARG[mi sesion]\r\nARG[--settings]\r\n"), "{t}");
    assert!(t.contains("TERM=xterm-256color COLORTERM=truecolor NOFLICKER=1 SYNC=1"), "{t}");
    assert!(t.contains("STATUS=/tmp/status-s1 USERSL=echo user-line FOO= "), "{t}");
    assert!(t.contains(&format!("CWD={}", fx.cwd.display())), "{t}");
    assert!(t.contains("INHERITED=\r\n"), "{t}");
    assert!(t.contains("SIZE=30 100"), "{t}");
    assert!(fx.mgr.is_running("s1"));
    assert_eq!(fx.mgr.size("s1"), Some((100, 30)));
    assert_eq!(*fx.ev.spawns.lock().unwrap(), ["s1"]);
}

#[test]
fn resume_when_transcript_exists() {
    let fx = fx_with(true, Some("rc"), Ok(ResolvedEnv::default()));
    fx.mgr.attach(&session(&fx, "s1"), 80, 24);
    fx.log.wait_text("s1", "READY");
    let t = fx.log.text("s1");
    assert!(t.starts_with("ARG[--resume]\r\nARG[s1]\r\nARG[--settings]\r\n"), "{t}");
    assert!(t.contains("ARG[--remote-control]\r\nARG[rc]\r\nTERM="), "{t}");
}

#[test]
fn resolved_env_is_passed_and_errors_are_shown_first() {
    let env = ResolvedEnv {
        env: HashMap::from([("FOO".to_string(), "bar".to_string())]),
        names: vec!["FOO".into()],
        errors: vec!["falló X".into(), "falló Y".into()],
    };
    let fx = fx_with(false, None, Ok(env));
    fx.mgr.attach(&session(&fx, "s1"), 80, 24);
    fx.log.wait_text("s1", "READY");
    let t = fx.log.text("s1");
    assert!(
        t.starts_with("\x1b[33mSome environment variables could not be loaded (the session starts without them):\r\n  · falló X\r\n  · falló Y\x1b[0m\r\n\r\n"),
        "{t}"
    );
    assert!(t.contains("FOO=bar"), "{t}");
    assert!(t.contains("ARG[--append-system-prompt]"), "{t}");
}

#[test]
fn resolve_env_failure_starts_without_variables() {
    let fx = fx_with(false, None, Err("boom".into()));
    fx.mgr.attach(&session(&fx, "s1"), 80, 24);
    fx.log.wait_text("s1", "READY");
    assert!(fx.log.text("s1").contains("  · boom\x1b[0m"));
}

#[test]
fn attach_to_a_running_session_returns_the_buffer_and_resizes() {
    let fx = fx();
    let s = session(&fx, "s1");
    fx.mgr.attach(&s, 100, 30);
    fx.log.wait_text("s1", "READY");
    let buf = fx.mgr.attach(&s, 90, 20).expect("buffer");
    assert_eq!(buf, fx.log.text("s1"));
    assert_eq!(fx.mgr.size("s1"), Some((90, 20)));
    fx.mgr.write("s1", "size\r");
    fx.log.wait_text("s1", "SIZE=20 90");
}

#[test]
fn write_and_resize_ignore_invalid_input() {
    let fx = fx();
    let s = session(&fx, "s1");
    fx.mgr.attach(&s, 100, 30);
    fx.log.wait_text("s1", "READY");
    fx.mgr.resize("s1", 0, 10);
    fx.mgr.resize("s1", 10, 0);
    assert_eq!(fx.mgr.size("s1"), Some((100, 30)));
    fx.mgr.resize("s1", 70, 25);
    assert_eq!(fx.mgr.size("s1"), Some((70, 25)));
    fx.mgr.write("s1", "hola\r");
    fx.log.wait_text("s1", "got:hola");
    // Sesiones inexistentes: sin efecto ni pánico.
    fx.mgr.write("nope", "x");
    fx.mgr.resize("nope", 1, 1);
    fx.mgr.kill("nope");
    assert_eq!(fx.mgr.size("nope"), None);
}

#[test]
fn natural_exit_reports_the_code_and_clears_the_entry() {
    let fx = fx();
    let s = session(&fx, "s1");
    fx.mgr.attach(&s, 100, 30);
    fx.log.wait_text("s1", "READY");
    fx.mgr.write("s1", "quit\r");
    wait_for(|| !fx.log.exits_of("s1").is_empty(), "exit");
    assert_eq!(fx.log.exits_of("s1"), [3]);
    assert!(!fx.mgr.is_running("s1"));
    // Reiniciar: una nueva atención vuelve a lanzar.
    fx.mgr.attach(&s, 100, 30);
    wait_for(|| fx.log.text("s1").matches("READY").count() == 2, "restart");
}

#[test]
fn kill_is_silent_and_restart_gets_a_fresh_buffer() {
    let fx = fx();
    let s = session(&fx, "s1");
    fx.mgr.attach(&s, 100, 30);
    fx.log.wait_text("s1", "READY");
    fx.mgr.kill("s1");
    assert!(!fx.mgr.is_running("s1"));
    std::thread::sleep(std::time::Duration::from_millis(700));
    assert!(fx.log.exits_of("s1").is_empty());
    assert_eq!(fx.mgr.attach(&s, 100, 30), None);
    wait_for(|| fx.log.text("s1").matches("READY").count() == 2, "second start");
    let buf = fx.mgr.attach(&s, 100, 30).unwrap();
    assert_eq!(buf.matches("READY").count(), 1, "el buffer nuevo no arrastra el anterior");
}

#[test]
fn kill_all_stops_every_session() {
    let fx = fx();
    for id in ["a", "b"] {
        fx.mgr.attach(&session(&fx, id), 80, 24);
    }
    fx.log.wait_text("a", "READY");
    fx.log.wait_text("b", "READY");
    fx.mgr.kill_all();
    assert!(!fx.mgr.is_running("a") && !fx.mgr.is_running("b"));
    assert!(fx.log.exits.lock().unwrap().is_empty());
}

#[test]
fn missing_cwd_reports_in_terminal_and_exits_with_1() {
    let fx = fx();
    let mut s = session(&fx, "s1");
    s.cwd = "/no/existe/xyz".into();
    assert_eq!(fx.mgr.attach(&s, 80, 24), None);
    assert_eq!(fx.log.text("s1"), "\r\n\x1b[33mThe working directory no longer exists: /no/existe/xyz\x1b[0m\r\n");
    assert_eq!(fx.log.exits_of("s1"), [1]);
    assert!(!fx.mgr.is_running("s1"));
    assert!(fx.ev.spawns.lock().unwrap().is_empty());
}

#[test]
fn kill_during_start_cancels_the_launch() {
    let fx = fx();
    let s = session(&fx, "s1");
    fx.mgr.attach(&s, 80, 24);
    fx.mgr.kill("s1");
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(!fx.mgr.is_running("s1"));
    assert!(fx.log.exits.lock().unwrap().is_empty());
}

#[test]
fn second_attach_while_starting_does_not_launch_twice() {
    let fx = fx();
    let s = session(&fx, "s1");
    fx.mgr.attach(&s, 80, 24);
    assert_eq!(fx.mgr.attach(&s, 120, 40), None);
    fx.log.wait_text("s1", "READY");
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(fx.log.text("s1").matches("READY").count(), 1);
    assert_eq!(fx.ev.spawns.lock().unwrap().len(), 1);
    // Se usa el último tamaño pedido.
    assert!(fx.log.text("s1").contains("SIZE=40 120"));
}

#[test]
fn utf8_is_never_split_between_chunks() {
    let fx = fx();
    fx.mgr.attach(&session(&fx, "s1"), 80, 24);
    fx.log.wait_text("s1", "READY");
    fx.mgr.write("s1", "utf8\r");
    fx.log.wait_text("s1", "END");
    let t = fx.log.text("s1");
    assert_eq!(t.matches('€').count(), 20000);
    assert!(!t.contains('\u{FFFD}'));
    assert!(fx.log.chunks("s1").len() > 2, "la salida llegó en varios bloques");
}

#[test]
fn scrollback_is_capped_to_the_tail() {
    let fx = fx();
    let s = session(&fx, "s1");
    fx.mgr.attach(&s, 80, 24);
    fx.log.wait_text("s1", "READY");
    for _ in 0..40 {
        fx.mgr.write("s1", "utf8\r");
    }
    wait_for(|| fx.log.text("s1").matches("END").count() == 40, "40 ráfagas");
    // 40 * 20004 unidades = ~800 K < 2 M: aún completo.
    assert_eq!(fx.mgr.attach(&s, 80, 24).unwrap(), fx.log.text("s1"));
}

#[test]
fn launch_failure_is_reported_in_the_terminal() {
    let mut fx = fx();
    let ev = Arc::new(Ev {
        log: fx.log.clone(),
        bin: "/no/such/claude".into(),
        transcript: false,
        rc: None,
        env: Mutex::new(Ok(ResolvedEnv::default())),
        spawns: Mutex::default(),
    });
    fx.mgr = PtyManager::new(ev);
    fx.mgr.attach(&session(&fx, "s1"), 80, 24);
    wait_for(|| !fx.log.exits_of("s1").is_empty(), "exit");
    assert!(fx.log.text("s1").contains("Failed to start claude"));
    assert_eq!(fx.log.exits_of("s1"), [1]);
    assert!(!fx.mgr.is_running("s1"));
}

// En Node, "guardar en el scrollback + emitir" y el reenvío de attach ocurrían en turnos distintos del
// event loop: el scrollback entregado siempre era exactamente lo ya emitido. Con hilos, un bloque podía
// quedar en ambos lados (duplicado) si attach caía entre el guardado y la emisión.
#[test]
fn attach_snapshot_is_exactly_what_was_already_emitted() {
    let fx = fx();
    let s = session(&fx, "s1");
    fx.mgr.attach(&s, 80, 24);
    fx.log.wait_text("s1", "READY");
    fx.mgr.write("s1", "flood\r");
    let mut checked = 0;
    while !fx.log.text("s1").contains("FLOODEND") {
        fx.mgr.attach_with(&s, 80, 24, |buf| {
            let emitted = fx.log.text("s1");
            assert_eq!(buf, emitted, "el scrollback entregado debe coincidir con lo emitido hasta ese momento");
        });
        checked += 1;
    }
    assert!(checked > 5, "attach corrió {checked} veces durante la ráfaga");
}

#[test]
fn killed_by_signal_reports_exit_code_0_like_node_pty() {
    let fx = fx();
    fx.mgr.attach(&session(&fx, "s1"), 80, 24);
    fx.log.wait_text("s1", "READY");
    fx.mgr.write("s1", "die\r");
    wait_for(|| !fx.log.exits_of("s1").is_empty(), "exit");
    assert_eq!(fx.log.exits_of("s1"), [0]);
}

#[test]
fn cwd_that_is_a_file_is_reported_instead_of_silently_running_in_home() {
    let fx = fx();
    let file = fx.cwd.join("archivo");
    fs::write(&file, "x").unwrap();
    let mut s = session(&fx, "s1");
    s.cwd = file.to_str().unwrap().into();
    assert_eq!(fx.mgr.attach(&s, 80, 24), None);
    assert_eq!(fx.log.exits_of("s1"), [1]);
    assert!(fx.log.text("s1").contains("The working directory no longer exists"));
    assert!(!fx.mgr.is_running("s1"));
}

#[test]
fn env_values_are_passed_verbatim_and_fixed_vars_win_over_session_vars() {
    let env = ResolvedEnv {
        env: HashMap::from([
            ("E1".to_string(), "".to_string()),
            ("E2".to_string(), "ñandú € 😀 \"q\" 'a' $x".to_string()),
            ("E3".to_string(), "a b".to_string()),
            ("TERM".to_string(), "dumb".to_string()),
        ]),
        ..Default::default()
    };
    let fx = fx_with(false, None, Ok(env));
    fx.mgr.attach(&session(&fx, "s1"), 80, 24);
    fx.log.wait_text("s1", "READY");
    fx.mgr.write("s1", "env\r");
    fx.log.wait_text("s1", "E3=[a b] TERM=xterm-256color");
    assert!(fx.log.text("s1").contains("E1=[] E2=[ñandú € 😀 \"q\" 'a' $x] E3=[a b]"));
}

#[allow(dead_code)]
fn _unused(_: &Path) {}
