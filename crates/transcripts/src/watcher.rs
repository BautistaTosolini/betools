// Sigue el .jsonl de cada sesión y avisa cuando cambian sus artefactos, título, modelo y conversación.
// Sondeo cada segundo (el archivo puede no existir todavía y `notify` pierde eventos cuando se reemplaza) con un
// empujón de `notify` sobre la carpeta del proyecto para reaccionar al instante.
use crate::claude_paths::{find_transcript_in, projects_root, transcript_path_in};
use crate::parser::TranscriptParser;
use crate::ticker::{DirWatch, Ticker};
use betools_types::{Artifact, ConversationItem, Session};
use std::collections::HashMap;
use std::fs::{self, File};
use std::os::unix::fs::FileExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const CHUNK: u64 = 4 * 1024 * 1024;

type OnChange = Arc<dyn Fn(&str, Vec<Artifact>) + Send + Sync>;
type OnTitle = Arc<dyn Fn(&str, Option<String>) + Send + Sync>;
type OnModel = Arc<dyn Fn(&str, Option<String>) + Send + Sync>;
// start: desde qué índice reemplazar (0 si se releyó el archivo desde cero).
type OnConversation = Arc<dyn Fn(&str, usize, Vec<ConversationItem>) + Send + Sync>;

#[derive(Clone)]
pub struct Callbacks {
    on_change: OnChange,
    on_title: OnTitle,
    on_model: OnModel,
    on_conversation: OnConversation,
}

impl Callbacks {
    pub fn new(
        on_change: impl Fn(&str, Vec<Artifact>) + Send + Sync + 'static,
        on_title: impl Fn(&str, Option<String>) + Send + Sync + 'static,
    ) -> Self {
        Callbacks { on_change: Arc::new(on_change), on_title: Arc::new(on_title), on_model: Arc::new(|_, _| {}), on_conversation: Arc::new(|_, _, _| {}) }
    }

    pub fn on_model(mut self, f: impl Fn(&str, Option<String>) + Send + Sync + 'static) -> Self {
        self.on_model = Arc::new(f);
        self
    }

    pub fn on_conversation(mut self, f: impl Fn(&str, usize, Vec<ConversationItem>) + Send + Sync + 'static) -> Self {
        self.on_conversation = Arc::new(f);
        self
    }
}

struct Watched {
    file: PathBuf,
    offset: u64,
    parser: TranscriptParser,
}

enum Event {
    Change(Vec<Artifact>),
    Conversation(usize, Vec<ConversationItem>),
    Title(Option<String>),
    Model(Option<String>),
}

struct Inner {
    root: PathBuf,
    cb: Callbacks,
    watched: Mutex<HashMap<String, Watched>>,
    // Serializa lectura + avisos para que los eventos de una sesión salgan en orden. Los callbacks no deben
    // llamar a watch().
    io: Mutex<()>,
    dirs: OnceLock<DirWatch>,
}

pub struct TranscriptWatcher {
    inner: Arc<Inner>,
    _ticker: Ticker,
}

impl TranscriptWatcher {
    pub fn new(cb: Callbacks) -> Self {
        Self::with_root(cb, projects_root())
    }

    // `root` es ~/.claude/projects (se inyecta para probar aislado).
    pub fn with_root(cb: Callbacks, root: PathBuf) -> Self {
        let inner = Arc::new(Inner { root, cb, watched: Mutex::default(), io: Mutex::new(()), dirs: OnceLock::new() });
        let i2 = inner.clone();
        let ticker = Ticker::spawn(Duration::from_millis(1000), move || i2.tick());
        let _ = inner.dirs.set(DirWatch::new(ticker.sender()));
        TranscriptWatcher { inner, _ticker: ticker }
    }

    pub fn conversation(&self, id: &str) -> Vec<ConversationItem> {
        self.inner.watched.lock().unwrap().get(id).map(|w| w.parser.items().to_vec()).unwrap_or_default()
    }

    pub fn model(&self, id: &str) -> Option<String> {
        self.inner.watched.lock().unwrap().get(id).and_then(|w| w.parser.model().map(String::from))
    }

    pub fn title(&self, id: &str) -> Option<String> {
        self.inner.watched.lock().unwrap().get(id).and_then(|w| w.parser.title().map(String::from))
    }

    pub fn list(&self, id: &str) -> Vec<Artifact> {
        self.inner.watched.lock().unwrap().get(id).map(|w| w.parser.list()).unwrap_or_default()
    }

    pub fn watch(&self, session: &Session) {
        let _io = self.inner.io.lock().unwrap();
        {
            let mut m = self.inner.watched.lock().unwrap();
            if m.contains_key(&session.id) {
                return;
            }
            // Sesión nueva: todavía no hay archivo; Claude lo va a crear en la ubicación esperada.
            let file = find_transcript_in(&self.inner.root, &session.cwd, &session.id)
                .unwrap_or_else(|| transcript_path_in(&self.inner.root, &session.cwd, &session.id));
            if let (Some(dw), Some(dir)) = (self.inner.dirs.get(), file.parent()) {
                dw.add(dir);
            }
            m.insert(session.id.clone(), Watched { file, offset: 0, parser: TranscriptParser::new() });
        }
        self.inner.read(&session.id);
    }

    pub fn unwatch(&self, id: &str) {
        let removed = self.inner.watched.lock().unwrap().remove(id);
        if let (Some(w), Some(dw)) = (removed, self.inner.dirs.get()) {
            if let Some(dir) = w.file.parent() {
                dw.remove(dir);
            }
        }
    }
}

impl Drop for TranscriptWatcher {
    fn drop(&mut self) {
        let ids: Vec<String> = self.inner.watched.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.unwatch(&id);
        }
    }
}

impl Inner {
    fn tick(&self) {
        if let Some(dw) = self.dirs.get() {
            dw.refresh();
        }
        let _io = self.io.lock().unwrap();
        let ids: Vec<String> = self.watched.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.read(&id);
        }
    }

    // Se llama con `io` tomado.
    fn read(&self, id: &str) {
        let events = {
            let mut m = self.watched.lock().unwrap();
            match m.get_mut(id) {
                Some(w) => w.read(),
                None => return,
            }
        };
        for e in events {
            match e {
                Event::Change(a) => (self.cb.on_change)(id, a),
                Event::Conversation(s, items) => (self.cb.on_conversation)(id, s, items),
                Event::Title(t) => (self.cb.on_title)(id, t),
                Event::Model(m) => (self.cb.on_model)(id, m),
            }
        }
    }
}

impl Watched {
    fn read(&mut self) -> Vec<Event> {
        let mut reset = false;
        let Ok(size) = fs::metadata(&self.file).map(|m| m.len()) else { return vec![] }; // todavía no existe
        if size < self.offset {
            // Se truncó o reemplazó: se vuelve a leer desde cero.
            self.offset = 0;
            self.parser = TranscriptParser::new();
            reset = true;
        }
        if size == self.offset {
            // Truncado a 0: la conversación quedó vacía y hay que avisarlo (si no, la UI conserva lo viejo).
            return if reset { vec![Event::Conversation(0, vec![])] } else { vec![] };
        }

        let mut changed = false;
        let count_before = self.parser.items().len();
        let title_before = self.parser.title().map(String::from);
        let model_before = self.parser.model().map(String::from);
        let Ok(f) = File::open(&self.file) else { return vec![] };
        let mut buf = vec![0u8; CHUNK.min(size - self.offset) as usize];
        while self.offset < size {
            let want = buf.len().min((size - self.offset) as usize);
            let n = match f.read_at(&mut buf[..want], self.offset) {
                Ok(n) if n > 0 => n,
                _ => break,
            };
            self.offset += n as u64;
            changed = self.parser.push(&buf[..n]) || changed;
        }
        let mut events = Vec::new();
        if changed {
            events.push(Event::Change(self.parser.list()));
        }
        if reset {
            events.push(Event::Conversation(0, self.parser.items().to_vec()));
        } else {
            let start = self.parser.take_changed_from().map_or(count_before, |c| c.min(count_before));
            let now = self.parser.items();
            // Se reenvía desde el primer ítem tocado (un bloque más de la misma respuesta, el resultado de una
            // herramienta) o desde los nuevos.
            if now.len() > start {
                events.push(Event::Conversation(start, now[start..].to_vec()));
            }
        }
        if self.parser.title().map(String::from) != title_before {
            events.push(Event::Title(self.parser.title().map(String::from)));
        }
        if self.parser.model().map(String::from) != model_before {
            events.push(Event::Model(self.parser.model().map(String::from)));
        }
        events
    }
}
