use crate::env::{clean_env, ResolvedEnv};
use crate::term::{Attached, Core, SpawnSpec};
use betools_types::Session;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const BUFFER_LIMIT: usize = 1024 * 1024;
pub const SHELL_PREFIX: &str = "shell:";

pub trait ShellEvents: Send + Sync + 'static {
    fn on_data(&self, key: &str, data: &str);
    fn on_exit(&self, key: &str, code: i32);
    /// Puede bloquear: corre en un hilo aparte.
    fn resolve_env(&self, session: &Session) -> Result<ResolvedEnv, String>;
}

/// Shell del usuario por sesión (pestaña "Terminal"): en la carpeta de la sesión y con sus mismas
/// variables de entorno, para cosas como `aws sso login`. Clave: "shell:<sessionId>".
#[derive(Clone)]
pub struct ShellManager {
    events: Arc<dyn ShellEvents>,
    // El extra de cada arranque son los comandos pedidos mientras el shell todavía no estaba listo.
    core: Arc<Core<Vec<String>>>,
}

impl ShellManager {
    pub fn new(events: Arc<dyn ShellEvents>) -> Self {
        let (ed, ex) = (events.clone(), events.clone());
        let core = Core::new(
            BUFFER_LIMIT,
            Box::new(move |k, data| ed.on_data(k, data)),
            Box::new(move |k, code| ex.on_exit(k, code)),
        );
        Self { events, core }
    }

    pub fn is_running(&self, key: &str) -> bool {
        self.core.is_running(key)
    }

    pub fn attach(&self, session: &Session, cols: u16, rows: u16) -> Option<String> {
        self.attach_inner(session, cols, rows, |_| {})
    }

    /// Como `attach`, pero entrega el scrollback con `deliver` antes de que pueda emitirse salida
    /// posterior. `deliver` no debe llamar de vuelta al manager.
    pub fn attach_with(&self, session: &Session, cols: u16, rows: u16, deliver: impl FnOnce(&str)) {
        self.attach_inner(session, cols, rows, deliver);
    }

    fn attach_inner(&self, session: &Session, cols: u16, rows: u16, deliver: impl FnOnce(&str)) -> Option<String> {
        let key = format!("{SHELL_PREFIX}{}", session.id);
        match self.core.attach(&key, cols, rows, Vec::new(), || true, deliver) {
            Attached::Buffer(b) => Some(b),
            Attached::Begun => {
                let this = self.clone();
                let session = session.clone();
                std::thread::spawn(move || this.start(&session));
                None
            }
            Attached::Starting | Attached::Rejected => None,
        }
    }

    /// Escribe un comando y Enter. Si el shell todavía está arrancando, queda en cola.
    pub fn run(&self, session: &Session, command: &str) {
        let key = format!("{SHELL_PREFIX}{}", session.id);
        if let Some(p) = self.core.proc(&key) {
            p.write(&format!("{command}\r"));
            return;
        }
        if !self.core.is_starting(&key) {
            self.attach(session, 120, 30);
        }
        let queued = self.core.update_pending(&key, |p| p.extra.push(command.to_string()));
        // El shell terminó de arrancar entre medio: se escribe directo.
        if !queued {
            if let Some(p) = self.core.proc(&key) {
                p.write(&format!("{command}\r"));
            }
        }
    }

    fn start(&self, session: &Session) {
        let key = format!("{SHELL_PREFIX}{}", session.id);
        let mut resolved = ResolvedEnv::default();
        match self.events.resolve_env(session) {
            Ok(r) => resolved = r,
            Err(e) => resolved.errors.push(e),
        }
        if !self.core.is_starting(&key) {
            return;
        }
        if !resolved.errors.is_empty() {
            let lines = resolved.errors.iter().map(|e| format!("  · {e}")).collect::<Vec<_>>().join("\r\n");
            self.events.on_data(&key, &format!("\x1b[33mSome variables could not be loaded:\r\n{lines}\x1b[0m\r\n"));
        }
        let result = self.core.finish_start(&key, |cols, rows, queued| {
            let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/bash".into());
            let cwd = if Path::new(&session.cwd).exists() { Some(PathBuf::from(&session.cwd)) } else { std::env::var_os("HOME").map(PathBuf::from) };
            let mut env = clean_env();
            env.extend(resolved.env.clone());
            env.insert("TERM".into(), "xterm-256color".into());
            env.insert("COLORTERM".into(), "truecolor".into());
            env.insert("CLAWHIP_SESSION_ID".into(), session.id.clone());
            (SpawnSpec { program: shell, args: vec!["-l".into()], cwd, env, cols, rows }, queued)
        });
        match result {
            // Comandos pedidos mientras arrancaba: se mandan cuando el shell ya está listo para leer.
            Some(Ok((proc, queued))) => {
                for c in queued {
                    proc.write(&format!("{c}\r"));
                }
            }
            Some(Err(e)) => {
                self.events.on_data(&key, &format!("\r\n\x1b[31mFailed to start shell: {e}\x1b[0m\r\n"));
                self.events.on_exit(&key, 1);
            }
            None => {}
        }
    }

    pub fn write(&self, key: &str, data: &str) {
        if let Some(p) = self.core.proc(key) {
            p.write(data);
        }
    }

    pub fn resize(&self, key: &str, cols: u16, rows: u16) {
        if cols > 0 && rows > 0 {
            if let Some(p) = self.core.proc(key) {
                p.resize(cols, rows);
            }
        }
    }

    pub fn kill(&self, key: &str) {
        self.core.kill(key);
    }

    pub fn kill_all(&self) {
        self.core.kill_all();
    }
}
