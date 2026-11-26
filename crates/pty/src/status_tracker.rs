use betools_types::SessionStatus;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

// Estado de cada sesión a partir de hooks de Claude Code. Los hooks se pasan con --settings
// solo a las sesiones que lanza betools (no se toca ~/.claude/settings.json) y cada uno
// agrega una palabra al archivo $CLAWHIP_STATUS_FILE de su sesión.
fn append(word: &str) -> String {
    format!("printf '{word}\\n' >> \"$CLAWHIP_STATUS_FILE\"")
}

fn hook(command: String) -> Value {
    json!([{ "hooks": [{ "type": "command", "command": command }] }])
}

fn hooks() -> Value {
    json!({
        "SessionStart": hook(append("idle")),
        "UserPromptSubmit": hook(append("working")),
        // Después de aprobar un permiso, la herramienta corre y la sesión vuelve a "trabajando".
        "PostToolUse": hook(append("working")),
        // El payload llega por stdin; se lee entero (sin grep -q) para no cortar el pipe.
        "Notification": hook(format!(
            "p=$(cat); case \"$p\" in \
             *permission_prompt*|*elicitation_dialog*|*\"needs your permission\"*) {};; \
             *idle_prompt*) {};; esac; exit 0",
            append("waiting"),
            append("idle_prompt")
        )),
        "Stop": hook(append("done")),
    })
}

// Comandos cuyo único fin es volcar el entorno completo. No impide un "echo $VAR" puntual
// (bloquearlo impediría usar la variable por nombre), por eso va junto con la instrucción en el prompt.
const ENV_DUMP_DENY: &[&str] = &[
    "Bash(env)",
    "Bash(printenv)",
    "Bash(printenv:*)",
    "Bash(set)",
    "Bash(export)",
    "Bash(export -p)",
    "Bash(declare -x)",
    "Bash(declare -p)",
    "Bash(cat /proc/self/environ)",
    "Bash(strings /proc/self/environ)",
];

// Status line propio: guarda el JSON que manda Claude Code (modelo, contexto, límites del plan) en
// $CLAWHIP_STATUS_FILE.line para que betools lo muestre arriba, y después corre el status line del
// usuario (si tiene) con BETOOLS=1, para que pueda omitir lo que ya muestra betools.
const STATUS_LINE: &str = "p=$(cat); f=\"$CLAWHIP_STATUS_FILE.line\"; printf '%s' \"$p\" > \"$f.tmp\" && mv -f \"$f.tmp\" \"$f\"; \
if [ -n \"$BETOOLS_USER_STATUSLINE\" ]; then printf '%s' \"$p\" | BETOOLS=1 sh -c \"$BETOOLS_USER_STATUSLINE\"; fi; exit 0";

pub fn build_settings(has_secrets: bool) -> String {
    let mut s = json!({
        "hooks": hooks(),
        // refreshInterval: cada 30 s además de los eventos, para que los límites no queden viejos.
        "statusLine": { "type": "command", "command": STATUS_LINE, "refreshInterval": 30 },
    });
    if has_secrets {
        s["permissions"] = json!({ "deny": ENV_DUMP_DENY });
    }
    s.to_string()
}

/// Comando de status line del usuario (~/.claude/settings.json), que el de betools reemplaza y vuelve a llamar.
pub fn user_status_line() -> String {
    dirs::home_dir().map(|h| user_status_line_from(&h)).unwrap_or_default()
}

pub fn user_status_line_from(home: &Path) -> String {
    let read = || -> Option<String> {
        let s: Value = serde_json::from_str(&fs::read_to_string(home.join(".claude").join("settings.json")).ok()?).ok()?;
        let sl = s.get("statusLine")?;
        if sl.get("type")?.as_str()? != "command" {
            return None;
        }
        Some(sl.get("command")?.as_str()?.to_string())
    };
    read().unwrap_or_default()
}

type OnChange = dyn Fn(&str, SessionStatus, SessionStatus) + Send + Sync;

// Intervalo de sondeo del archivo de estado (el mismo que usaba fs.watchFile).
const POLL: Duration = Duration::from_millis(400);

struct Tracked {
    token: u64,
    // Al soltarse, el hilo de sondeo termina enseguida.
    _stop: Sender<()>,
}

struct Inner {
    dir: PathBuf,
    status: Mutex<HashMap<String, SessionStatus>>,
    tracked: Mutex<HashMap<String, Tracked>>,
    next_token: Mutex<u64>,
    on_change: Box<OnChange>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct StatusTracker {
    inner: Arc<Inner>,
}

impl StatusTracker {
    /// `on_change(id, next, prev)` se llama desde el hilo que detectó el cambio, sin candados tomados.
    pub fn new(dir: impl Into<PathBuf>, on_change: impl Fn(&str, SessionStatus, SessionStatus) + Send + Sync + 'static) -> std::io::Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        Ok(Self {
            inner: Arc::new(Inner {
                dir,
                status: Mutex::default(),
                tracked: Mutex::default(),
                next_token: Mutex::new(0),
                on_change: Box::new(on_change),
            }),
        })
    }

    pub fn get(&self, id: &str) -> SessionStatus {
        self.inner.get(id)
    }

    /// Se llama justo antes de lanzar el pty. Devuelve el archivo que escriben los hooks.
    pub fn start(&self, id: &str) -> std::io::Result<PathBuf> {
        let inner = &self.inner;
        inner.stop(id);
        let file = inner.dir.join(format!("{id}.status"));
        fs::write(&file, "")?;
        let token = {
            let mut t = lock(&inner.next_token);
            *t += 1;
            *t
        };
        let (tx, rx) = mpsc::channel::<()>();
        lock(&inner.tracked).insert(id.to_string(), Tracked { token, _stop: tx });
        let weak = Arc::downgrade(inner);
        let (id_owned, path) = (id.to_string(), file.clone());
        std::thread::spawn(move || poll(weak, rx, id_owned, token, path));
        inner.set(id, SessionStatus::Idle);
        Ok(file)
    }

    pub fn exited(&self, id: &str) {
        self.inner.stop(id);
        self.inner.set(id, SessionStatus::Exited);
    }

    pub fn forget(&self, id: &str) {
        self.inner.stop(id);
        lock(&self.inner.status).remove(id);
    }

    /// "done" significa "terminó y no lo viste": al mirar la sesión pasa a "idle".
    pub fn seen(&self, id: &str) {
        if self.get(id) == SessionStatus::Done {
            self.inner.set(id, SessionStatus::Idle);
        }
    }

    /// Interrupción (Esc o Ctrl+C): el hook Stop no corre en ese caso, se detecta por el transcript.
    pub fn interrupted(&self, id: &str) {
        if matches!(self.get(id), SessionStatus::Working | SessionStatus::Waiting) {
            self.inner.set(id, SessionStatus::Idle);
        }
    }
}

impl Inner {
    fn get(&self, id: &str) -> SessionStatus {
        lock(&self.status).get(id).copied().unwrap_or(SessionStatus::Stopped)
    }

    fn stop(&self, id: &str) {
        lock(&self.tracked).remove(id);
    }

    fn is_current(&self, id: &str, token: u64) -> bool {
        lock(&self.tracked).get(id).is_some_and(|t| t.token == token)
    }

    fn set(&self, id: &str, next: SessionStatus) {
        let prev = {
            let mut s = lock(&self.status);
            let prev = s.get(id).copied().unwrap_or(SessionStatus::Stopped);
            if prev == next {
                return;
            }
            s.insert(id.to_string(), next);
            prev
        };
        (self.on_change)(id, next, prev);
    }

    fn apply(&self, id: &str, event: &str) {
        let cur = self.get(id);
        match event {
            "idle" => self.set(id, SessionStatus::Idle),
            "working" => self.set(id, SessionStatus::Working),
            "waiting" => self.set(id, SessionStatus::Waiting),
            "done" => self.set(id, SessionStatus::Done),
            // Si se interrumpió con Esc, Stop no corre; el aviso de inactividad corrige el estado.
            "idle_prompt" if matches!(cur, SessionStatus::Working | SessionStatus::Waiting) => self.set(id, SessionStatus::Idle),
            _ => {}
        }
    }
}

// `String.prototype.trim` de JS: no incluye U+0085 (que sí recorta `str::trim`) e incluye U+FEFF.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c| {
        matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

fn poll(weak: Weak<Inner>, stop: mpsc::Receiver<()>, id: String, token: u64, file: PathBuf) {
    let mut offset: u64 = 0;
    // El hilo no retiene el tracker: si se suelta, `upgrade` falla y termina.
    while let Err(RecvTimeoutError::Timeout) = stop.recv_timeout(POLL) {
        let Some(inner) = weak.upgrade() else { return };
        if !inner.is_current(&id, token) {
            return;
        }
        let Ok(size) = fs::metadata(&file).map(|m| m.len()) else { continue };
        if size <= offset {
            continue;
        }
        let mut buf = Vec::with_capacity((size - offset) as usize);
        let read = fs::File::open(&file).and_then(|mut f| {
            f.seek(SeekFrom::Start(offset))?;
            f.take(size - offset).read_to_end(&mut buf)
        });
        if read.is_err() {
            continue;
        }
        offset = size;
        for word in String::from_utf8_lossy(&buf).split('\n') {
            // El estado pudo cambiar de dueño (stop/start) mientras se aplicaban palabras.
            if !inner.is_current(&id, token) {
                return;
            }
            inner.apply(&id, js_trim(word));
        }
    }
}
