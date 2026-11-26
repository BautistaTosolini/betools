//! Visor de documentos: solo Markdown, hasta 5 MB. Cada documento abierto se vigila (polling) y se
//! reenvía a la interfaz cuando cambia, por ejemplo si Claude lo edita.

use crate::host::Host;
use crate::util::{extname, lock, node_io_error};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const DOC_MAX: u64 = 5 * 1024 * 1024;
// Mismo intervalo que `watchFile(path, { interval: 1000 })`.
const POLL: Duration = Duration::from_millis(1000);

/// `{ text, mtime }`: mtime en milisegundos con fracción, como `stat.mtimeMs`.
pub(crate) fn read_doc(path: &str) -> Result<Value, String> {
    if !matches!(extname(path).to_lowercase().as_str(), ".md" | ".markdown" | ".mdx") {
        return Err("Only Markdown files can be opened in betools.".into());
    }
    let st = std::fs::metadata(path).map_err(|e| node_io_error(&e, "stat", path))?;
    if !st.is_file() {
        return Err(format!("Not a file: {path}"));
    }
    if st.len() > DOC_MAX {
        return Err("The file is too large to preview (over 5 MB).".into());
    }
    let bytes = std::fs::read(path).map_err(|e| node_io_error(&e, "open", path))?;
    Ok(json!({ "text": String::from_utf8_lossy(&bytes), "mtime": mtime_ms(&st) }))
}

fn mtime_ms(st: &std::fs::Metadata) -> f64 {
    st.mtime() as f64 * 1000.0 + st.mtime_nsec() as f64 / 1e6
}

// Firma de `stat` que compara watchFile; un archivo que falta cuenta como ceros.
fn signature(path: &str) -> (f64, u64) {
    std::fs::metadata(path).map(|m| (mtime_ms(&m), m.len())).unwrap_or((0.0, 0))
}

struct Watch {
    count: usize,
    // Al soltarse, el hilo de sondeo termina.
    _stop: Sender<()>,
}

#[derive(Default)]
pub(crate) struct DocWatcher {
    watches: Mutex<HashMap<String, Watch>>,
}

impl DocWatcher {
    pub fn watch(&self, host: &Arc<dyn Host>, path: &str) {
        let mut w = lock(&self.watches);
        if let Some(e) = w.get_mut(path) {
            e.count += 1;
            return;
        }
        let (tx, rx) = mpsc::channel::<()>();
        w.insert(path.to_string(), Watch { count: 1, _stop: tx });
        let (host, path) = (host.clone(), path.to_string());
        let mut prev = signature(&path);
        std::thread::spawn(move || {
            while let Err(RecvTimeoutError::Timeout) = rx.recv_timeout(POLL) {
                let cur = signature(&path);
                if cur == prev {
                    continue;
                }
                prev = cur;
                // Se borró o se volvió ilegible: null.
                let doc = read_doc(&path).unwrap_or(Value::Null);
                host.emit("doc:changed", vec![Value::String(path.clone()), doc]);
            }
        });
    }

    pub fn unwatch(&self, path: &str) {
        let mut w = lock(&self.watches);
        let n = w.get(path).map_or(0, |e| e.count).saturating_sub(1);
        match w.get_mut(path) {
            Some(e) if n > 0 => e.count = n,
            _ => {
                w.remove(path);
            }
        }
    }
}
