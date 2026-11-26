// Datos que Claude Code le pasa al comando de status line (JSON por stdin). Las sesiones que lanza betools usan
// un status line propio (ver status-tracker) que guarda ese JSON en <statusFile>.line.
// Campos usados: model.display_name, context_window.used_percentage y rate_limits.{five_hour,seven_day}
// (este último solo existe con suscripción Pro/Max y después de la primera respuesta).
// Referencia: https://code.claude.com/docs/en/statusline
use crate::js::{self, get, get_str, truthy};
use crate::ticker::{DirWatch, Ticker};
use betools_types::{DailyTokens, PlanLimits, PlanWindow, SessionMeta};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite())
}

// Margen para considerar que dos resets_at son la misma ventana (pueden variar unos segundos entre lecturas).
const SAME_WINDOW_S: f64 = 300.0;

// Combina la lectura guardada con una nueva de la misma ventana (5 h o semanal):
// - ventana nueva (reinicio posterior): se toma la nueva, aunque sea menor;
// - lectura de una ventana anterior (otra sesión con datos viejos): se ignora;
// - misma ventana: se queda el mayor porcentaje.
pub fn merge_window(cur: Option<&PlanWindow>, next: Option<&PlanWindow>, now_sec: f64) -> Option<PlanWindow> {
    let Some(next) = next else { return cur.cloned() };
    let Some(cur) = cur else { return Some(next.clone()) };
    let (c, n) = (cur.resets_at.map(|r| r as f64), next.resets_at.map(|r| r as f64));
    if n.is_some_and(|n| n < now_sec) {
        return Some(cur.clone());
    }
    if c.is_some_and(|c| c < now_sec) {
        return Some(next.clone());
    }
    let (Some(c), Some(n)) = (c, n) else {
        return Some(if next.pct >= cur.pct { next } else { cur }.clone());
    };
    if n > c + SAME_WINDOW_S {
        return Some(next.clone());
    }
    if n < c - SAME_WINDOW_S {
        return Some(cur.clone());
    }
    Some(if next.pct >= cur.pct { next } else { cur }.clone())
}

type Stat = Option<(SystemTime, u64)>;

fn stat(p: &Path) -> Stat {
    let m = fs::metadata(p).ok()?;
    Some((m.modified().ok()?, m.len()))
}

type OnMeta = Arc<dyn Fn(&str, SessionMeta) + Send + Sync>;
type OnLimits = Arc<dyn Fn(PlanLimits) + Send + Sync>;

struct Entry {
    file: PathBuf,
    last: Stat,
}

struct SlState {
    files: HashMap<String, Entry>,
    meta: HashMap<String, SessionMeta>,
    limits: Option<PlanLimits>,
}

struct SlInner {
    limits_file: PathBuf,
    state: Mutex<SlState>,
    on_meta: OnMeta,
    on_limits: OnLimits,
    dirs: OnceLock<DirWatch>,
}

pub struct StatusLineWatcher {
    inner: Arc<SlInner>,
    _ticker: Ticker,
}

impl StatusLineWatcher {
    pub fn new(
        limits_file: impl Into<PathBuf>,
        on_meta: impl Fn(&str, SessionMeta) + Send + Sync + 'static,
        on_limits: impl Fn(PlanLimits) + Send + Sync + 'static,
    ) -> Self {
        let limits_file = limits_file.into();
        // Los límites son de la cuenta, no de la sesión: se guarda el último para mostrarlo al reabrir.
        let limits = js::read_lossy(&limits_file).and_then(|s| js::parse_json(&s)).and_then(|v| serde_json::from_value(v).ok());
        let inner = Arc::new(SlInner {
            limits_file,
            state: Mutex::new(SlState { files: HashMap::new(), meta: HashMap::new(), limits }),
            on_meta: Arc::new(on_meta),
            on_limits: Arc::new(on_limits),
            dirs: OnceLock::new(),
        });
        let i2 = inner.clone();
        let ticker = Ticker::spawn(Duration::from_millis(1000), move || i2.tick());
        let _ = inner.dirs.set(DirWatch::new(ticker.sender()));
        StatusLineWatcher { inner, _ticker: ticker }
    }

    pub fn get_meta(&self, id: &str) -> Option<SessionMeta> {
        self.inner.state.lock().unwrap().meta.get(id).cloned()
    }

    pub fn get_limits(&self) -> Option<PlanLimits> {
        self.inner.state.lock().unwrap().limits.clone()
    }

    pub fn watch(&self, id: &str, status_file: &str) {
        self.unwatch(id);
        let file = PathBuf::from(format!("{status_file}.line"));
        if let (Some(dw), Some(dir)) = (self.inner.dirs.get(), file.parent()) {
            dw.add(dir);
        }
        self.inner.state.lock().unwrap().files.insert(id.to_string(), Entry { file: file.clone(), last: stat(&file) });
        self.inner.read(id, &file);
    }

    pub fn unwatch(&self, id: &str) {
        let removed = self.inner.state.lock().unwrap().files.remove(id);
        if let (Some(e), Some(dw)) = (removed, self.inner.dirs.get()) {
            if let Some(dir) = e.file.parent() {
                dw.remove(dir);
            }
        }
    }

    pub fn forget(&self, id: &str) {
        self.unwatch(id);
        self.inner.state.lock().unwrap().meta.remove(id);
    }
}

impl Drop for StatusLineWatcher {
    fn drop(&mut self) {
        let ids: Vec<String> = self.inner.state.lock().unwrap().files.keys().cloned().collect();
        for id in ids {
            self.unwatch(&id);
        }
    }
}

enum Event {
    Meta(String, SessionMeta),
    Limits(PlanLimits),
}

impl SlInner {
    fn tick(&self) {
        if let Some(dw) = self.dirs.get() {
            dw.refresh();
        }
        let todo: Vec<(String, PathBuf)> = {
            let mut s = self.state.lock().unwrap();
            s.files
                .iter_mut()
                .filter_map(|(id, e)| {
                    let now = stat(&e.file);
                    (now != e.last).then(|| {
                        e.last = now;
                        (id.clone(), e.file.clone())
                    })
                })
                .collect()
        };
        for (id, file) in todo {
            self.read(&id, &file);
        }
    }

    fn read(&self, id: &str, file: &Path) {
        let events = self.read_locked(id, file);
        for e in events {
            match e {
                Event::Meta(id, m) => (self.on_meta)(&id, m),
                Event::Limits(l) => (self.on_limits)(l),
            }
        }
    }

    fn read_locked(&self, id: &str, file: &Path) -> Vec<Event> {
        let mut st = self.state.lock().unwrap();
        if st.files.get(id).map(|e| e.file.as_path()) != Some(file) {
            return vec![];
        }
        let Some(d) = js::read_lossy(file).and_then(|s| js::parse_json(&s)).filter(Value::is_object) else {
            return vec![];
        };
        let mut events = Vec::new();
        let model = get(&d, "model");
        let name = model.and_then(|m| get_str(m, "display_name")).filter(|s| !s.is_empty());
        let mid = model.and_then(|m| get_str(m, "id")).filter(|s| !s.is_empty());
        let meta = SessionMeta {
            model: name.or(mid).map(String::from),
            context_pct: num(get(&d, "context_window").and_then(|c| c.get("used_percentage"))),
        };
        if st.meta.get(id) != Some(&meta) {
            st.meta.insert(id.to_string(), meta.clone());
            events.push(Event::Meta(id.to_string(), meta));
        }

        let Some(rl) = get(&d, "rate_limits") else { return events };
        let (five, seven) = (get(rl, "five_hour"), get(rl, "seven_day"));
        if !truthy(five) && !truthy(seven) {
            return events;
        }
        let win = |w: Option<&Value>| {
            let w = w.filter(|w| truthy(Some(w)))?;
            let pct = num(w.get("used_percentage"))?;
            Some(PlanWindow { pct, resets_at: num(w.get("resets_at")).map(|r| r as i64) })
        };
        // Cada sesión guarda la lectura de SU última respuesta y el status line se repite cada 30 s, así que una
        // sesión quieta vuelve a mandar un valor viejo. Se combina por ventana: el consumo solo sube hasta el reinicio.
        let now_s = js::now_ms() as f64 / 1000.0;
        let cur = st.limits.as_ref();
        let next = PlanLimits {
            five_hour: merge_window(cur.and_then(|l| l.five_hour.as_ref()), win(five).as_ref(), now_s),
            seven_day: merge_window(cur.and_then(|l| l.seven_day.as_ref()), win(seven).as_ref(), now_s),
            updated_at: js::now_ms(),
        };
        if cur.is_some_and(|c| c.five_hour == next.five_hour && c.seven_day == next.seven_day) {
            return events;
        }
        st.limits = Some(next.clone());
        // Si no se puede guardar solo se pierde el valor al reiniciar.
        let _ = self.save(&next);
        events.push(Event::Limits(next));
        events
    }

    fn save(&self, limits: &PlanLimits) -> std::io::Result<()> {
        if let Some(dir) = self.limits_file.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut tmp = self.limits_file.clone().into_os_string();
        tmp.push(".tmp");
        fs::write(&tmp, js::to_js_json(limits))?;
        fs::rename(&tmp, &self.limits_file)
    }
}

// ---------------------------------------------------------------------------------------------
// Tokens del día: suma de message.usage de todas las respuestas con timestamp de hoy (hora local) en todos los
// transcripts de ~/.claude/projects, incluidas las sesiones fuera de betools y los subagentes. Una respuesta se
// guarda en varias líneas (una por bloque) con el mismo usage, así que se cuenta una vez por message.id.

const CHUNK: u64 = 4 * 1024 * 1024;

#[derive(Default)]
struct FileState {
    offset: u64,
    remainder: Vec<u8>,
}

struct DtState {
    day: i64,
    files: HashMap<PathBuf, FileState>,
    seen: HashSet<String>,
    totals: DailyTokens,
}

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct DtInner {
    projects: PathBuf,
    clock: Clock,
    state: Mutex<DtState>,
    on_change: Arc<dyn Fn(DailyTokens) + Send + Sync>,
}

pub struct DailyTokenCounter {
    inner: Arc<DtInner>,
    ticker: Mutex<Option<Ticker>>,
}

fn empty(day: i64) -> DailyTokens {
    DailyTokens { day: js::iso_ms(day), input: 0, output: 0, cache_write: 0, cache_read: 0, total: 0, messages: 0 }
}

impl DailyTokenCounter {
    pub fn new(on_change: impl Fn(DailyTokens) + Send + Sync + 'static) -> Self {
        Self::with_options(on_change, crate::claude_paths::projects_root(), Arc::new(js::now_ms))
    }

    // `clock` devuelve milisegundos Unix; se inyecta para probar el cambio de día.
    pub fn with_options(on_change: impl Fn(DailyTokens) + Send + Sync + 'static, projects: PathBuf, clock: Clock) -> Self {
        let day = js::start_of_day(clock());
        let inner = Arc::new(DtInner {
            projects,
            clock,
            state: Mutex::new(DtState { day, files: HashMap::new(), seen: HashSet::new(), totals: empty(day) }),
            on_change: Arc::new(on_change),
        });
        DailyTokenCounter { inner, ticker: Mutex::new(None) }
    }

    pub fn get(&self) -> DailyTokens {
        self.inner.state.lock().unwrap().totals.clone()
    }

    pub fn start(&self, interval: Duration) {
        self.scan();
        let i = self.inner.clone();
        *self.ticker.lock().unwrap() = Some(Ticker::spawn(interval, move || i.scan()));
    }

    pub fn stop(&self) {
        self.ticker.lock().unwrap().take();
    }

    pub fn scan(&self) {
        self.inner.scan();
    }
}

impl DtInner {
    fn scan(&self) {
        let totals = {
            let mut s = self.state.lock().unwrap();
            let today = js::start_of_day((self.clock)());
            if today != s.day {
                s.day = today;
                s.files.clear();
                s.seen.clear();
                s.totals = empty(today);
            }
            let before = s.totals.total;
            for file in self.recent_files(s.day) {
                s.read_file(&file);
            }
            (s.totals.total != before || before == 0).then(|| s.totals.clone())
        };
        if let Some(t) = totals {
            (self.on_change)(t);
        }
    }

    // .jsonl modificados hoy, hasta 3 niveles (proyecto / sesión / subagents).
    fn recent_files(&self, day: i64) -> Vec<PathBuf> {
        fn walk(dir: &Path, depth: u32, day: f64, out: &mut Vec<PathBuf>) {
            let Ok(entries) = fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let p = e.path();
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    if depth < 3 {
                        walk(&p, depth + 1, day, out);
                    }
                } else if e.file_name().to_string_lossy().ends_with(".jsonl") && js::mtime_ms(&p).is_some_and(|m| m >= day) {
                    out.push(p);
                }
            }
        }
        let mut out = Vec::new();
        if self.projects.exists() {
            walk(&self.projects, 0, day as f64, &mut out);
        }
        out
    }
}

impl DtState {
    fn read_file(&mut self, file: &Path) {
        let Ok(size) = fs::metadata(file).map(|m| m.len()) else { return };
        if self.files.get(file).is_none_or(|s| size < s.offset) {
            self.files.insert(file.to_path_buf(), FileState::default());
        }
        let st = self.files.get_mut(file).unwrap();
        if size == st.offset {
            return;
        }
        let Ok(f) = File::open(file) else { return };
        let mut buf = vec![0u8; CHUNK.min(size - st.offset) as usize];
        let mut lines: Vec<Vec<u8>> = Vec::new();
        while st.offset < size {
            let want = buf.len().min((size - st.offset) as usize);
            let n = match f.read_at(&mut buf[..want], st.offset) {
                Ok(n) if n > 0 => n,
                _ => break,
            };
            st.offset += n as u64;
            let data = [st.remainder.as_slice(), &buf[..n]].concat();
            let mut start = 0;
            while let Some(rel) = data[start..].iter().position(|&b| b == b'\n') {
                if rel > 0 {
                    lines.push(data[start..start + rel].to_vec());
                }
                start += rel + 1;
            }
            st.remainder = data[start..].to_vec();
        }
        for l in lines {
            self.line(&l);
        }
    }

    fn line(&mut self, raw: &[u8]) {
        // Filtro barato antes de parsear: solo interesan respuestas con usage.
        if !raw.windows(7).any(|w| w == b"\"usage\"") {
            return;
        }
        let Some(d) = js::parse_json_bytes(raw) else { return };
        if get_str(&d, "type") != Some("assistant") {
            return;
        }
        let msg = get(&d, "message");
        let Some(u) = msg.and_then(|m| get(m, "usage")).filter(|u| truthy(Some(u))) else { return };
        let Some(ts) = get_str(&d, "timestamp").and_then(js::parse_date) else { return };
        if ts < self.day {
            return;
        }
        let key = msg.and_then(|m| get(m, "id")).or_else(|| get(&d, "requestId")).or_else(|| get(&d, "uuid"));
        if truthy(key) && !self.seen.insert(js::js_string(key.unwrap())) {
            return;
        }
        let tok = |k: &str| num(u.get(k)).unwrap_or(0.0) as u64;
        let (input, output, cache_write, cache_read) =
            (tok("input_tokens"), tok("output_tokens"), tok("cache_creation_input_tokens"), tok("cache_read_input_tokens"));
        let t = &mut self.totals;
        t.input += input;
        t.output += output;
        t.cache_write += cache_write;
        t.cache_read += cache_read;
        t.total += input + output + cache_write + cache_read;
        t.messages += 1;
    }
}
