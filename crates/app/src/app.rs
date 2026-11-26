//! Estado y ciclo de vida de la app: equivalente a src/main/index.ts sin el código de ventana.

use crate::docs::DocWatcher;
use crate::host::{Host, Notice, TrayEntry, TrayState};
use crate::util::{js_trim, lock, pretty_model};
use betools_pty::{PtyEvents, PtyManager, ResolvedEnv, ShellEvents, ShellManager, StatusTracker};
use betools_secrets::{Keyring, LocalSecrets};
use betools_store::{SessionStore, SettingsStore, SlashCommands};
use betools_transcripts::{Callbacks, DailyTokenCounter, StatusLineWatcher, TabTitles, TranscriptWatcher, INTERRUPTED};
use betools_types::{ConversationItem, ConversationKind, Session, SessionMeta, SessionStatus, StoreState};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

/// Configuración de arranque. Solo `user_data` es obligatorio.
pub struct AppConfig {
    /// El `userData` de Electron (`~/.config/betools`).
    pub user_data: PathBuf,
    /// Ejecutable de Claude; por defecto se resuelve como en la app Electron (`claudeBin()`).
    pub claude_bin: Option<String>,
    /// Llavero para los secretos locales; por defecto el Secret Service del sistema.
    pub keyring: Option<Box<dyn Keyring>>,
}

impl AppConfig {
    pub fn new(user_data: impl Into<PathBuf>) -> Self {
        Self { user_data: user_data.into(), claude_bin: None, keyring: None }
    }
}

pub(crate) type Back = Arc<OnceLock<Weak<Inner>>>;

fn up(back: &Back) -> Option<Arc<Inner>> {
    back.get().and_then(Weak::upgrade)
}

/// `setTimeout` sin cancelación: la lógica descarta el resultado con un token si ya no corresponde.
pub(crate) fn after(d: Duration, f: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        std::thread::sleep(d);
        f();
    });
}

pub(crate) struct Inner {
    pub host: Arc<dyn Host>,
    pub user_data: PathBuf,
    status_dir: PathBuf,
    pub store: Mutex<SessionStore>,
    pub settings: Mutex<SettingsStore>,
    pub secrets: LocalSecrets,
    pub slash: SlashCommands,
    pub ptys: PtyManager,
    pub shells: ShellManager,
    pub watcher: TranscriptWatcher,
    pub status: StatusTracker,
    pub titles: TabTitles,
    pub lines: StatusLineWatcher,
    pub daily: DailyTokenCounter,
    pub pending: Mutex<Vec<String>>,
    pub restart_timers: Mutex<HashMap<String, u64>>,
    timer_seq: AtomicU64,
    pub docs: DocWatcher,
}

/// Lógica de betools sin ventana. Se comparte entre hilos (`Clone` es barato).
#[derive(Clone)]
pub struct App(pub(crate) Arc<Inner>);

// Puente de eventos de los managers de pty: no retienen la app (si se suelta, quedan inertes).
struct PtyBridge {
    back: Back,
    claude_bin: Option<String>,
}

impl PtyEvents for PtyBridge {
    fn on_spawn(&self, id: &str) -> PathBuf {
        up(&self.back).map(|i| i.on_spawn(id)).unwrap_or_default()
    }
    fn on_data(&self, id: &str, data: &str) {
        if let Some(i) = up(&self.back) {
            i.emit("pty:data", vec![json!(id), json!(data)]);
        }
    }
    fn on_exit(&self, id: &str, code: i32) {
        if let Some(i) = up(&self.back) {
            i.status.exited(id);
            i.emit("pty:exit", vec![json!(id), json!(code)]);
        }
    }
    fn resolve_env(&self, session: &Session) -> Result<ResolvedEnv, String> {
        up(&self.back).map_or(Ok(ResolvedEnv::default()), |i| i.resolve_env(session))
    }
    // Nombre en claude.ai/el teléfono: el título de betools (ticket + resumen). Sin título, Claude lo nombra
    // con la conversación.
    fn remote_control_name(&self, session: &Session) -> Option<String> {
        let i = up(&self.back)?;
        let on = lock(&i.settings).get().remote_control;
        on.then(|| i.display_title(&session.id).unwrap_or_default())
    }
    fn claude_bin(&self) -> String {
        self.claude_bin.clone().unwrap_or_else(|| betools_store::claude_bin().to_string())
    }
    fn transcript_exists(&self, cwd: &str, id: &str) -> bool {
        betools_store::transcript_exists(cwd, id)
    }
}

struct ShellBridge(Back);

impl ShellEvents for ShellBridge {
    fn on_data(&self, key: &str, data: &str) {
        if let Some(i) = up(&self.0) {
            i.emit("pty:data", vec![json!(key), json!(data)]);
        }
    }
    fn on_exit(&self, key: &str, code: i32) {
        if let Some(i) = up(&self.0) {
            i.emit("pty:exit", vec![json!(key), json!(code)]);
        }
    }
    fn resolve_env(&self, session: &Session) -> Result<ResolvedEnv, String> {
        up(&self.0).map_or(Ok(ResolvedEnv::default()), |i| i.resolve_env(session))
    }
}

/// Ejecuta un futuro en un hilo propio con su runtime: sirve igual desde hilos del manager de pty,
/// desde un hilo de bloqueo de Tauri o desde uno que ya está dentro de un runtime.
pub(crate) fn block_on<F: std::future::Future>(make: impl FnOnce() -> F + Send) -> Result<F::Output, String>
where
    F::Output: Send,
{
    std::thread::scope(|s| {
        s.spawn(|| {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
            Ok(rt.block_on(make()))
        })
        .join()
        .map_err(|_| "internal error".to_string())?
    })
}

impl App {
    /// Construye todo menos lo que depende de la ventana: llamar a `start` cuando exista.
    pub fn new(host: Arc<dyn Host>, config: AppConfig) -> Result<App, String> {
        let AppConfig { user_data, claude_bin, keyring } = config;
        betools_store::migrate_legacy_data(&user_data).map_err(|e| e.to_string())?;
        let store = SessionStore::new(&user_data).map_err(|e| e.to_string())?;
        let settings = SettingsStore::new(&user_data);
        let secrets = match keyring {
            Some(k) => LocalSecrets::with_keyring(&user_data, k),
            None => LocalSecrets::new(&user_data, "betools"),
        };
        let status_dir = user_data.join("status");
        let back: Back = Arc::default();

        let b = back.clone();
        let status = StatusTracker::new(&status_dir, move |id, next, _prev| {
            if let Some(i) = up(&b) {
                i.on_status(id, next);
            }
        })
        .map_err(|e| e.to_string())?;
        let ptys = PtyManager::new(Arc::new(PtyBridge { back: back.clone(), claude_bin }));
        let shells = ShellManager::new(Arc::new(ShellBridge(back.clone())));
        let b = back.clone();
        let lines = StatusLineWatcher::new(
            user_data.join("plan-limits.json"),
            {
                let b = b.clone();
                move |id, _| {
                    if let Some(i) = up(&b) {
                        i.emit_meta(id);
                    }
                }
            },
            move |limits| {
                if let Some(i) = up(&b) {
                    i.emit("usage:limits", vec![json!(limits)]);
                }
            },
        );
        let callbacks = {
            let (b1, b2, b3, b4) = (back.clone(), back.clone(), back.clone(), back.clone());
            Callbacks::new(
                move |id, artifacts| {
                    if let Some(i) = up(&b1) {
                        i.emit("artifacts:changed", vec![json!(id), json!(artifacts)]);
                    }
                },
                move |id, _| {
                    if let Some(i) = up(&b2) {
                        i.emit_title(id);
                    }
                },
            )
            .on_model(move |id, _| {
                if let Some(i) = up(&b3) {
                    i.emit_meta(id);
                }
            })
            .on_conversation(move |id, start, items| {
                if let Some(i) = up(&b4) {
                    i.on_conversation(id, start, items);
                }
            })
        };
        let watcher = TranscriptWatcher::new(callbacks);
        let b = back.clone();
        let daily = DailyTokenCounter::new(move |t| {
            if let Some(i) = up(&b) {
                i.emit("usage:daily", vec![json!(t)]);
            }
        });
        let b = back.clone();
        let titles = TabTitles::new(move |id, _| {
            if let Some(i) = up(&b) {
                i.emit_title(id);
            }
        });

        let inner = Arc::new(Inner {
            host,
            user_data,
            status_dir,
            store: Mutex::new(store),
            settings: Mutex::new(settings),
            secrets,
            slash: SlashCommands::new(),
            ptys,
            shells,
            watcher,
            status,
            titles,
            lines,
            daily,
            pending: Mutex::default(),
            restart_timers: Mutex::default(),
            timer_seq: AtomicU64::new(0),
            docs: DocWatcher::default(),
        });
        let _ = back.set(Arc::downgrade(&inner));
        for s in inner.state().sessions {
            inner.watcher.watch(&s);
            inner.titles.watch(&s.id);
        }
        Ok(App(inner))
    }

    /// Arranque que va después de crear la ventana: conteo diario de tokens y, si está activado,
    /// el inicio de todas las sesiones.
    pub fn start(&self) {
        let i = &self.0;
        i.daily.start(Duration::from_millis(10_000));
        i.update_tray();
        // Opcional: levantar todas las sesiones al iniciar (por defecto se levantan al seleccionarlas).
        // Tamaño provisorio; la terminal lo corrige al mostrarse.
        if lock(&i.settings).get().eager_start {
            for s in i.state().sessions {
                i.ptys.attach(&s, 120, 40);
            }
        }
    }

    /// La ventana recibió el foco: la sesión seleccionada deja de estar "done".
    pub fn on_window_focus(&self) {
        if let Some(id) = self.0.state().selected_id {
            self.0.status.seen(&id);
        }
    }

    /// Con "cerrar a la bandeja", la X oculta la ventana (si hay bandeja) y las sesiones siguen corriendo.
    pub fn close_to_tray(&self) -> bool {
        lock(&self.0.settings).get().close_to_tray
    }

    /// Click en una sesión de la bandeja o en una notificación.
    pub fn select_from_outside(&self, id: &str) {
        self.0.select_from_outside(id);
    }

    /// Repinta la bandeja (el host la llama al crearla).
    pub fn update_tray(&self) {
        self.0.update_tray();
    }

    /// Al salir se terminan los procesos; las sesiones siguen en sessions.json y se retoman con
    /// --resume en el próximo arranque. Sirve también para SIGTERM/SIGINT/SIGHUP.
    pub fn shutdown(&self) {
        self.0.ptys.kill_all();
        self.0.shells.kill_all();
    }
}

impl Inner {
    pub fn emit(&self, channel: &str, args: Vec<Value>) {
        self.host.emit(channel, args);
    }

    pub fn state(&self) -> StoreState {
        lock(&self.store).get()
    }

    pub fn find_session(&self, id: &str) -> Option<Session> {
        lock(&self.store).find(id).cloned()
    }

    pub fn next_timer(&self) -> u64 {
        self.timer_seq.fetch_add(1, Ordering::Relaxed)
    }

    /// Título visible: el de la pestaña (<TICKET> <resumen>) y, si no hay, el de Claude (/rename o ai-title).
    pub fn display_title(&self, id: &str) -> Option<String> {
        self.titles.get(id).or_else(|| self.watcher.title(id))
    }

    fn label_of(&self, s: &Session) -> String {
        self.display_title(&s.id).unwrap_or_else(|| s.name.clone())
    }

    pub fn emit_title(&self, id: &str) {
        self.emit("session:title", vec![json!(id), json!(self.display_title(id))]);
        self.update_tray();
    }

    pub fn meta_of(&self, id: &str) -> SessionMeta {
        let live = self.lines.get_meta(id);
        SessionMeta {
            model: live.as_ref().and_then(|m| m.model.clone()).or_else(|| pretty_model(self.watcher.model(id).as_deref())),
            context_pct: live.and_then(|m| m.context_pct),
        }
    }

    fn emit_meta(&self, id: &str) {
        self.emit("session:meta", vec![json!(id), json!(self.meta_of(id))]);
    }

    // Se llama con el manager de pty tomado (vía StatusTracker::start): no puede tocar `ptys`.
    fn on_spawn(&self, id: &str) -> PathBuf {
        let file = self.status.start(id).unwrap_or_else(|_| self.status_dir.join(format!("{id}.status")));
        self.lines.watch(id, &file.to_string_lossy());
        file
    }

    pub fn resolve_env(&self, session: &Session) -> Result<ResolvedEnv, String> {
        let layers = self.env_layers(session);
        let r = block_on(|| betools_secrets::resolve_env(&layers, &self.secrets))?;
        Ok(ResolvedEnv { env: r.env.into_iter().collect(), names: r.names, errors: r.errors })
    }

    // Corre en el hilo que detectó el cambio, posiblemente con el manager de pty tomado: nada de `ptys`
    // acá; los reinicios van en un hilo aparte.
    fn on_status(self: &Arc<Self>, id: &str, next: SessionStatus) {
        self.emit("session:status", vec![json!(id), json!(next)]);
        self.update_tray();
        // Reinicio pendiente por cambio de variables: se hace cuando Claude termina el turno.
        if lock(&self.pending).iter().any(|p| p == id) {
            if next == SessionStatus::Exited {
                self.set_pending(id, false);
            } else if matches!(next, SessionStatus::Idle | SessionStatus::Done) {
                let (inner, id) = (self.clone(), id.to_string());
                after(Duration::from_millis(1000), move || inner.apply_restart(&id));
            }
        }
        if matches!(next, SessionStatus::Waiting | SessionStatus::Done) {
            self.notify(id, next);
        }
    }

    fn on_conversation(&self, id: &str, start: usize, items: Vec<ConversationItem>) {
        self.emit("conversation:changed", vec![json!(id), json!(start), json!(items)]);
        // Solo interrupciones recientes: al cargar el transcript entero aparecen también las viejas.
        let now = chrono::Utc::now().timestamp_millis();
        let recent = |at: &str| chrono::DateTime::parse_from_rfc3339(at).is_ok_and(|t| now - t.timestamp_millis() < 60_000);
        if start > 0 && items.iter().any(|it| it.kind == ConversationKind::Summary && it.text == INTERRUPTED && recent(&it.at)) {
            self.status.interrupted(id);
        }
    }

    fn notify(&self, id: &str, next: SessionStatus) {
        if !lock(&self.settings).get().notifications {
            return;
        }
        let Some(session) = self.find_session(id) else { return };
        // No se avisa de la sesión que estás mirando.
        if self.host.window_focused() && self.state().selected_id.as_deref() == Some(id) {
            return;
        }
        let waiting = next == SessionStatus::Waiting;
        self.host.notify(Notice {
            session_id: id.to_string(),
            title: self.label_of(&session),
            body: if waiting { "Needs your input" } else { "Done" }.into(),
            urgent: waiting,
        });
    }

    pub fn update_tray(&self) {
        let sessions = self.state().sessions;
        let waiting = sessions.iter().filter(|s| self.status.get(&s.id) == SessionStatus::Waiting).count();
        let entries = sessions
            .iter()
            .map(|s| {
                let mark = match self.status.get(&s.id) {
                    SessionStatus::Working => "\u{23F3}",
                    SessionStatus::Waiting => "\u{2757}",
                    SessionStatus::Done => "\u{2714}",
                    _ => "  ",
                };
                TrayEntry { session_id: s.id.clone(), label: format!("{mark} {}", self.label_of(s)) }
            })
            .collect();
        let tooltip = if waiting > 0 { format!("betools \u{2014} {waiting} waiting for input") } else { "betools".into() };
        self.host.update_tray(TrayState { tooltip, entries });
    }

    pub fn select_from_outside(&self, id: &str) {
        let _ = lock(&self.store).select(id);
        self.status.seen(id);
        self.emit("ui:select", vec![json!(id)]);
        self.host.show_window();
    }

    /// `name.trim() || basename(path)`.
    pub fn name_or_base(name: &str, path: &str) -> String {
        let n = js_trim(name);
        if n.is_empty() { crate::util::basename(path).to_string() } else { n.to_string() }
    }
}
