// Títulos "<TICKET> <resumen>" que guarda ~/.claude/hooks/warp-tab-title.sh en ~/.claude/tab-titles/<session_id>.
// Es la convención de los CLAUDE.md de clientes; betools la lee y, al renombrar desde la app, escribe el mismo
// archivo.
use crate::js;
use crate::ticker::{DirWatch, Ticker};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

type OnChange = Arc<dyn Fn(&str, Option<String>) + Send + Sync>;

#[derive(Default)]
struct State {
    titles: HashMap<String, Option<String>>,
    polling: HashSet<String>,
}

struct Inner {
    dir: PathBuf,
    state: Mutex<State>,
    on_change: OnChange,
    dirs: OnceLock<DirWatch>,
}

pub struct TabTitles {
    inner: Arc<Inner>,
    _ticker: Ticker,
}

impl TabTitles {
    pub fn new(on_change: impl Fn(&str, Option<String>) + Send + Sync + 'static) -> Self {
        Self::with_dir(dirs::home_dir().unwrap_or_default().join(".claude").join("tab-titles"), on_change)
    }

    pub fn with_dir(dir: PathBuf, on_change: impl Fn(&str, Option<String>) + Send + Sync + 'static) -> Self {
        let inner = Arc::new(Inner { dir, state: Mutex::default(), on_change: Arc::new(on_change), dirs: OnceLock::new() });
        let i2 = inner.clone();
        // Sondeo: el archivo puede no existir hasta que Claude nombre la sesión.
        let ticker = Ticker::spawn(Duration::from_millis(1500), move || i2.tick());
        let dw = DirWatch::new(ticker.sender());
        dw.add(&inner.dir);
        let _ = inner.dirs.set(dw);
        TabTitles { inner, _ticker: ticker }
    }

    pub fn watch(&self, id: &str) {
        let mut s = self.inner.state.lock().unwrap();
        // Se controla por el sondeo y no por el mapa: un set() antes de watch() llena el mapa y dejaba el id sin seguir.
        if !s.polling.insert(id.to_string()) {
            return;
        }
        s.titles.insert(id.to_string(), self.inner.read(id));
    }

    pub fn unwatch(&self, id: &str) {
        let mut s = self.inner.state.lock().unwrap();
        s.polling.remove(id);
        s.titles.remove(id);
    }

    pub fn get(&self, id: &str) -> Option<String> {
        self.inner.state.lock().unwrap().titles.get(id).cloned().flatten()
    }

    pub fn set(&self, id: &str, title: &str) -> io::Result<()> {
        let t = js::collapse_ws(title);
        let file = self.inner.dir.join(id);
        if !t.is_empty() {
            fs::create_dir_all(&self.inner.dir)?;
            fs::write(&file, format!("{t}\n"))?;
        } else if let Err(e) = fs::remove_file(&file) {
            if e.kind() != io::ErrorKind::NotFound {
                return Err(e);
            }
        }
        let next = Some(t).filter(|t| !t.is_empty());
        {
            let mut s = self.inner.state.lock().unwrap();
            if s.titles.get(id).cloned().flatten() == next {
                return Ok(());
            }
            s.titles.insert(id.to_string(), next.clone());
        }
        (self.inner.on_change)(id, next);
        Ok(())
    }
}

impl Inner {
    fn read(&self, id: &str) -> Option<String> {
        let t = js::collapse_ws(&js::read_lossy(&self.dir.join(id))?);
        Some(t).filter(|t| !t.is_empty())
    }

    fn tick(&self) {
        if let Some(dw) = self.dirs.get() {
            dw.refresh();
        }
        let ids: Vec<String> = self.state.lock().unwrap().polling.iter().cloned().collect();
        for id in ids {
            let next = self.read(&id);
            {
                let mut s = self.state.lock().unwrap();
                // Pudo desvigilarse mientras se leía.
                if !s.polling.contains(&id) || s.titles.get(&id).cloned().flatten() == next {
                    continue;
                }
                s.titles.insert(id.clone(), next.clone());
            }
            (self.on_change)(&id, next);
        }
    }
}
