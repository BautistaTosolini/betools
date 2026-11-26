// Hilo de sondeo compartido por los watchers. Equivale al `fs.watchFile` del código TS (el archivo puede no
// existir todavía y `fs.watch` pierde eventos cuando se reemplaza), con un empujón opcional de `notify`
// para reaccionar sin esperar al intervalo.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

// Los eventos de escritura llegan en ráfagas: se agrupan antes de leer.
const DEBOUNCE: Duration = Duration::from_millis(50);

pub(crate) enum Msg {
    Nudge,
    Stop,
}

pub(crate) struct Ticker {
    tx: Sender<Msg>,
}

impl Ticker {
    pub(crate) fn spawn(interval: Duration, mut tick: impl FnMut() + Send + 'static) -> Ticker {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || loop {
            match rx.recv_timeout(interval) {
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Ok(Msg::Nudge) => {
                    let deadline = Instant::now() + DEBOUNCE;
                    loop {
                        let left = deadline.saturating_duration_since(Instant::now());
                        if left.is_zero() {
                            break;
                        }
                        match rx.recv_timeout(left) {
                            Ok(Msg::Nudge) => {}
                            Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                            Err(RecvTimeoutError::Timeout) => break,
                        }
                    }
                    tick();
                }
                Err(RecvTimeoutError::Timeout) => tick(),
            }
        });
        Ticker { tx }
    }

    pub(crate) fn sender(&self) -> Sender<Msg> {
        self.tx.clone()
    }
}

impl Drop for Ticker {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
    }
}

// Vigila carpetas (con cuenta de referencias, porque varias sesiones comparten la carpeta del proyecto).
// Si la carpeta no existe todavía se reintenta en cada tick; si `notify` no está disponible queda el sondeo.
pub(crate) struct DirWatch {
    inner: Mutex<DirState>,
}

struct DirState {
    watcher: Option<RecommendedWatcher>,
    refs: HashMap<PathBuf, usize>,
    active: HashSet<PathBuf>,
}

impl DirWatch {
    pub(crate) fn new(nudge: Sender<Msg>) -> DirWatch {
        let watcher = notify::recommended_watcher(move |_ev: notify::Result<notify::Event>| {
            let _ = nudge.send(Msg::Nudge);
        })
        .ok();
        DirWatch { inner: Mutex::new(DirState { watcher, refs: HashMap::new(), active: HashSet::new() }) }
    }

    pub(crate) fn add(&self, dir: &Path) {
        let mut s = self.inner.lock().unwrap();
        *s.refs.entry(dir.to_path_buf()).or_insert(0) += 1;
        s.attach(dir);
    }

    pub(crate) fn remove(&self, dir: &Path) {
        let mut s = self.inner.lock().unwrap();
        let Some(n) = s.refs.get_mut(dir) else { return };
        *n -= 1;
        if *n > 0 {
            return;
        }
        s.refs.remove(dir);
        if s.active.remove(dir) {
            if let Some(w) = s.watcher.as_mut() {
                let _ = w.unwatch(dir);
            }
        }
    }

    // Engancha las carpetas que no existían cuando se pidió la vigilancia.
    pub(crate) fn refresh(&self) {
        let mut s = self.inner.lock().unwrap();
        let pending: Vec<PathBuf> = s.refs.keys().filter(|d| !s.active.contains(*d)).cloned().collect();
        for d in pending {
            s.attach(&d);
        }
    }
}

impl DirState {
    fn attach(&mut self, dir: &Path) {
        if self.active.contains(dir) || !dir.is_dir() {
            return;
        }
        if let Some(w) = self.watcher.as_mut() {
            if w.watch(dir, RecursiveMode::NonRecursive).is_ok() {
                self.active.insert(dir.to_path_buf());
            }
        }
    }
}
