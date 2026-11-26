use crate::env::{clean_env, ResolvedEnv};
use crate::status_tracker::build_settings;
use crate::term::{Attached, Core, SpawnSpec};
use betools_types::Session;
use std::path::{Path, PathBuf};
use std::sync::Arc;

// Máximo de salida guardada por sesión para poder redibujar la terminal si la interfaz se recarga.
const BUFFER_LIMIT: usize = 2 * 1024 * 1024;

/// Dependencias externas del manager (entorno, rutas de Claude, estado, eventos).
/// Todo se invoca desde hilos propios del manager; `on_data`/`on_exit` nunca con candados tomados.
pub trait PtyEvents: Send + Sync + 'static {
    /// Devuelve el archivo de estado que van a escribir los hooks de esta sesión.
    /// Se llama con el manager bloqueado: no debe llamar de vuelta al manager.
    fn on_spawn(&self, id: &str) -> PathBuf;
    fn on_data(&self, id: &str, data: &str);
    fn on_exit(&self, id: &str, code: i32);
    /// Variables de entorno de la sesión (carpeta + propias), resueltas al lanzar. Puede bloquear:
    /// corre en un hilo aparte.
    fn resolve_env(&self, session: &Session) -> Result<ResolvedEnv, String>;
    /// Remote Control: None = apagado; Some("") = encendido sin nombre; Some(texto) = nombre visible.
    fn remote_control_name(&self, session: &Session) -> Option<String>;
    /// Ejecutable de Claude (`claudeBin()`).
    fn claude_bin(&self) -> String;
    /// Si ya hay transcript de la sesión (`transcriptExists(cwd, id)`).
    fn transcript_exists(&self, cwd: &str, id: &str) -> bool;
    /// Status line del usuario (`userStatusLine()`), que va en `BETOOLS_USER_STATUSLINE`.
    fn user_status_line(&self) -> String {
        crate::status_tracker::user_status_line()
    }
}

// Instrucción para Claude cuando la sesión tiene variables con secretos.
pub fn secrets_prompt(names: &[String]) -> String {
    [
        format!("This session has environment variables with sensitive values: {}.", names.join(", ")),
        "Use them only by reference in commands (for example \"$NAME\"). Never print, display, log, copy to".to_string(),
        "files or include their values in replies, and never run commands whose purpose is to show them".to_string(),
        "(echo, printenv, env, set, cat /proc/*/environ, etc.). If a task requires seeing the value, stop".to_string(),
        "and ask the user for it.".to_string(),
    ]
    .join(" ")
}

/// Argumentos de la línea de comando de Claude, en el mismo orden que arma pty-manager.ts.
pub fn claude_args(session: &Session, has_transcript: bool, secret_names: &[String], remote_control: Option<&str>) -> Vec<String> {
    // Sesión con historial → --resume. Sesión nueva (o sin mensajes todavía) → --session-id.
    let mut args: Vec<String> = if has_transcript {
        vec!["--resume".into(), session.id.clone()]
    } else {
        vec!["--session-id".into(), session.id.clone(), "--name".into(), session.name.clone()]
    };
    args.push("--settings".into());
    args.push(build_settings(!secret_names.is_empty()));
    if !secret_names.is_empty() {
        args.push("--append-system-prompt".into());
        args.push(secrets_prompt(secret_names));
    }
    // Va al final: el nombre es opcional y, sin él, el flag no debe tomar el argumento siguiente.
    // Doc: https://code.claude.com/docs/en/remote-control
    if let Some(rc) = remote_control {
        args.push("--remote-control".into());
        if !rc.is_empty() {
            args.push(rc.to_string());
        }
    }
    args
}

#[derive(Clone)]
pub struct PtyManager {
    events: Arc<dyn PtyEvents>,
    core: Arc<Core<()>>,
}

impl PtyManager {
    pub fn new(events: Arc<dyn PtyEvents>) -> Self {
        let (ed, ex) = (events.clone(), events.clone());
        let core = Core::new(
            BUFFER_LIMIT,
            Box::new(move |id, data| ed.on_data(id, data)),
            Box::new(move |id, code| ex.on_exit(id, code)),
        );
        Self { events, core }
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.core.is_running(id)
    }

    /// (cols, rows) del pty vivo.
    pub fn size(&self, id: &str) -> Option<(u16, u16)> {
        self.core.size(id)
    }

    /// Si el proceso ya corre, devuelve lo acumulado para redibujar; si no, lo lanza (en segundo plano).
    pub fn attach(&self, session: &Session, cols: u16, rows: u16) -> Option<String> {
        self.attach_inner(session, cols, rows, |_| {})
    }

    /// Como `attach`, pero entrega el scrollback con `deliver` antes de que pueda emitirse salida
    /// posterior (en Node el reenvío ocurría en el mismo turno, así que no se intercalaba ni duplicaba).
    /// `deliver` corre con un candado de la sesión: no debe llamar de vuelta al manager.
    pub fn attach_with(&self, session: &Session, cols: u16, rows: u16, deliver: impl FnOnce(&str)) {
        self.attach_inner(session, cols, rows, deliver);
    }

    fn attach_inner(&self, session: &Session, cols: u16, rows: u16, deliver: impl FnOnce(&str)) -> Option<String> {
        // Una ruta que existe pero no es carpeta haría que portable-pty lance en HOME sin avisar.
        let cwd_ok = || Path::new(&session.cwd).is_dir();
        match self.core.attach(&session.id, cols, rows, (), cwd_ok, deliver) {
            Attached::Buffer(b) => Some(b),
            Attached::Starting => None,
            Attached::Rejected => {
                // La carpeta de trabajo se movió o se borró: se avisa en la terminal en vez de fallar.
                self.events
                    .on_data(&session.id, &format!("\r\n\x1b[33mThe working directory no longer exists: {}\x1b[0m\r\n", session.cwd));
                self.events.on_exit(&session.id, 1);
                None
            }
            Attached::Begun => {
                let this = self.clone();
                let session = session.clone();
                std::thread::spawn(move || this.start(&session));
                None
            }
        }
    }

    fn start(&self, session: &Session) {
        let mut resolved = ResolvedEnv::default();
        match self.events.resolve_env(session) {
            Ok(r) => resolved = r,
            Err(e) => resolved.errors.push(e),
        }
        // Se cerró la sesión mientras se resolvían las variables.
        if !self.core.is_starting(&session.id) {
            return;
        }
        if !resolved.errors.is_empty() {
            let lines = resolved.errors.iter().map(|e| format!("  · {e}")).collect::<Vec<_>>().join("\r\n");
            self.events.on_data(
                &session.id,
                &format!("\x1b[33mSome environment variables could not be loaded (the session starts without them):\r\n{lines}\x1b[0m\r\n\r\n"),
            );
        }
        let ev = &self.events;
        let result = self.core.finish_start(&session.id, |cols, rows, ()| {
            let has_transcript = ev.transcript_exists(&session.cwd, &session.id);
            let rc = ev.remote_control_name(session);
            let args = claude_args(session, has_transcript, &resolved.names, rc.as_deref());
            let status_file = ev.on_spawn(&session.id);
            let mut env = clean_env();
            // Variables de la carpeta y de la sesión. Van antes de las propias de betools para no pisarlas.
            env.extend(resolved.env.clone());
            env.insert("TERM".into(), "xterm-256color".into());
            env.insert("COLORTERM".into(), "truecolor".into());
            // Renderer de pantalla completa: evita que Claude reescriba el scrollback en cada frame
            // (causa del salto del scroll en xterm.js).
            env.insert("CLAUDE_CODE_NO_FLICKER".into(), "1".into());
            // Frames atómicos (DEC 2026), que xterm.js 6 soporta.
            env.insert("CLAUDE_CODE_FORCE_SYNC_OUTPUT".into(), "1".into());
            env.insert("CLAWHIP_STATUS_FILE".into(), status_file.to_string_lossy().into_owned());
            env.insert("BETOOLS_USER_STATUSLINE".into(), ev.user_status_line());
            (SpawnSpec { program: ev.claude_bin(), args, cwd: Some(PathBuf::from(&session.cwd)), env, cols, rows }, ())
        });
        // Si falla el lanzamiento (binario inexistente), la interfaz lo ve en la terminal y la sesión queda "exited".
        if let Some(Err(e)) = result {
            self.events.on_data(&session.id, &format!("\r\n\x1b[31mFailed to start claude: {e}\x1b[0m\r\n"));
            self.events.on_exit(&session.id, 1);
        }
    }

    pub fn write(&self, id: &str, data: &str) {
        if let Some(p) = self.core.proc(id) {
            p.write(data);
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if cols > 0 && rows > 0 {
            if let Some(p) = self.core.proc(id) {
                p.resize(cols, rows);
            }
        }
    }

    pub fn kill(&self, id: &str) {
        self.core.kill(id);
    }

    pub fn kill_all(&self) {
        self.core.kill_all();
    }
}
