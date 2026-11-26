#![allow(dead_code)]
// Cada archivo de pruebas corre con un HOME propio y vacío (os.homedir lee $HOME en cada llamada),
// y las pruebas del archivo se serializan porque comparten HOME y variables de entorno.
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

static HOME: OnceLock<tempfile::TempDir> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

pub fn home() -> PathBuf {
    HOME.get().expect("guard() primero").path().to_path_buf()
}

pub fn claude() -> PathBuf {
    home().join(".claude")
}

/// beforeEach: HOME temporal, ~/.claude vacío. El guard mantiene la serialización.
pub fn guard() -> MutexGuard<'static, ()> {
    let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = HOME.get_or_init(|| tempfile::tempdir().unwrap());
    std::env::set_var("HOME", h.path());
    let _ = std::fs::remove_dir_all(h.path().join(".claude"));
    g
}

pub fn put(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}
