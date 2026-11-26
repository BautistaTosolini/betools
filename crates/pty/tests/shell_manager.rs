mod common;

use betools_pty::{ResolvedEnv, ShellEvents, ShellManager, SHELL_PREFIX};
use betools_types::Session;
use common::{wait_for, Log};
use std::collections::HashMap;
use std::sync::{Arc, Once};
use tempfile::TempDir;

struct Ev {
    log: Arc<Log>,
    env: ResolvedEnv,
}

impl ShellEvents for Ev {
    fn on_data(&self, key: &str, data: &str) {
        self.log.data.lock().unwrap().push((key.to_string(), data.to_string()));
    }
    fn on_exit(&self, key: &str, code: i32) {
        self.log.exits.lock().unwrap().push((key.to_string(), code));
    }
    fn resolve_env(&self, _s: &Session) -> Result<ResolvedEnv, String> {
        Ok(self.env.clone())
    }
}

// El shell se elige con $SHELL; se fija una sola vez, antes de que otros hilos lean el entorno.
fn init() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| std::env::set_var("SHELL", "/bin/sh"));
}

fn setup(env: ResolvedEnv) -> (TempDir, Arc<Log>, ShellManager, Session) {
    init();
    let dir = TempDir::new().unwrap();
    let log = Arc::new(Log::default());
    let mgr = ShellManager::new(Arc::new(Ev { log: log.clone(), env }));
    let s = Session {
        id: "abc".into(),
        name: "n".into(),
        cwd: dir.path().to_str().unwrap().into(),
        created_at: String::new(),
        last_active_at: String::new(),
        env: None,
    };
    (dir, log, mgr, s)
}

const KEY: &str = "shell:abc";

#[test]
fn prefix_is_shell_colon() {
    assert_eq!(SHELL_PREFIX, "shell:");
}

#[test]
fn run_before_the_shell_is_ready_is_queued() {
    let (dir, log, mgr, s) = setup(ResolvedEnv { env: HashMap::from([("MIVAR".into(), "valor".into())]), ..Default::default() });
    mgr.run(&s, "echo ${CLAWHIP_SESSION_ID}x ${MIVAR}y $((6*7)); pwd");
    log.wait_text(KEY, "abcx valory 42");
    log.wait_text(KEY, &dir.path().file_name().unwrap().to_string_lossy());
    assert!(mgr.is_running(KEY));
}

#[test]
fn run_on_a_running_shell_writes_the_command() {
    let (_d, log, mgr, s) = setup(ResolvedEnv::default());
    assert_eq!(mgr.attach(&s, 100, 30), None);
    wait_for(|| mgr.is_running(KEY), "start");
    mgr.run(&s, "echo uno$((1+1))");
    log.wait_text(KEY, "uno2");
    // Reenganchar devuelve lo acumulado.
    let buf = mgr.attach(&s, 90, 20).unwrap();
    assert!(buf.contains("uno2"));
    mgr.write(KEY, "stty size\r");
    log.wait_text(KEY, "20 90");
}

#[test]
fn errors_are_shown_and_missing_cwd_falls_back_to_home() {
    let (_d, log, mgr, mut s) = setup(ResolvedEnv { errors: vec!["falló X".into()], ..Default::default() });
    s.cwd = "/no/existe/xyz".into();
    mgr.attach(&s, 80, 24);
    log.wait_text(KEY, "\x1b[33mSome variables could not be loaded:\r\n  · falló X\x1b[0m\r\n");
    wait_for(|| mgr.is_running(KEY), "start");
    mgr.run(&s, "pwd");
    let home = std::env::var("HOME").unwrap();
    log.wait_text(KEY, &format!("\r\n{home}\r\n"));
}

#[test]
fn exit_is_reported_with_its_code_and_kill_is_silent() {
    let (_d, log, mgr, s) = setup(ResolvedEnv::default());
    mgr.attach(&s, 80, 24);
    wait_for(|| mgr.is_running(KEY), "start");
    mgr.run(&s, "exit 5");
    wait_for(|| !log.exits_of(KEY).is_empty(), "exit");
    assert_eq!(log.exits_of(KEY), [5]);
    assert!(!mgr.is_running(KEY));

    mgr.attach(&s, 80, 24);
    wait_for(|| mgr.is_running(KEY), "restart");
    mgr.kill(KEY);
    assert!(!mgr.is_running(KEY));
    std::thread::sleep(std::time::Duration::from_millis(600));
    assert_eq!(log.exits_of(KEY), [5]);
    mgr.kill_all();
}

// El scrollback entregado por attach_with es exactamente lo ya emitido (sin duplicar bloques).
#[test]
fn attach_snapshot_is_exactly_what_was_already_emitted() {
    let (_d, log, mgr, s) = setup(ResolvedEnv::default());
    mgr.attach(&s, 80, 24);
    wait_for(|| mgr.is_running(KEY), "start");
    mgr.run(&s, "seq 1 60000; echo FLOODEND");
    let mut checked = 0;
    while !log.text(KEY).contains("FLOODEND\r\n") {
        mgr.attach_with(&s, 80, 24, |buf| assert_eq!(buf, log.text(KEY)));
        checked += 1;
    }
    assert!(checked > 5, "attach corrió {checked} veces durante la ráfaga");
    mgr.kill_all();
}

#[test]
fn killed_by_signal_reports_exit_code_0_like_node_pty() {
    let (_d, log, mgr, s) = setup(ResolvedEnv::default());
    mgr.attach(&s, 80, 24);
    wait_for(|| mgr.is_running(KEY), "start");
    mgr.run(&s, "kill -9 $$");
    wait_for(|| !log.exits_of(KEY).is_empty(), "exit");
    assert_eq!(log.exits_of(KEY), [0]);
}
