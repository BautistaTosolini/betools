//! Lo que la lógica necesita del entorno que la aloja (ventana, portapapeles, diálogos...).
//! Lo implementa la app de escritorio con Tauri; las pruebas usan uno falso.

use serde_json::Value;
use std::path::Path;

/// Aviso de escritorio por una sesión que terminó o espera una respuesta.
#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    pub session_id: String,
    pub title: String,
    pub body: String,
    /// "critical" en Electron cuando la sesión espera tu respuesta.
    pub urgent: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrayEntry {
    pub session_id: String,
    pub label: String,
}

/// Contenido de la bandeja: "Show", una entrada por sesión y "Quit (stops the sessions)".
#[derive(Debug, Clone, PartialEq)]
pub struct TrayState {
    pub tooltip: String,
    pub entries: Vec<TrayEntry>,
}

/// Los métodos pueden llamarse desde cualquier hilo y no deben llamar de vuelta a `App` de forma
/// síncrona desde `emit` (se invoca con candados de los managers tomados).
pub trait Host: Send + Sync + 'static {
    /// `webContents.send(channel, ...args)`. Sin ventana, se descarta.
    fn emit(&self, channel: &str, args: Vec<Value>);
    fn clipboard_read(&self) -> Result<String, String>;
    fn clipboard_write(&self, text: &str) -> Result<(), String>;
    /// Diálogo de carpeta; `None` si se cancela. Bloquea hasta que se cierra.
    fn pick_folder(&self) -> Option<String>;
    /// Solo recibe http(s) y mailto: (el filtro está en la lógica).
    fn open_external(&self, url: &str) -> Result<(), String>;
    /// Abre un archivo con la regla de `openers.json` y, si falla, con la app del sistema.
    fn open_file(&self, user_data: &Path, path: &str) -> Result<(), String> {
        betools_store::open_artifact(user_data, path).map_err(|e| e.to_string())
    }
    /// Muestra el archivo en el gestor de archivos.
    fn reveal_file(&self, path: &str) {
        betools_store::reveal_artifact(path);
    }
    fn notify(&self, notice: Notice);
    fn show_window(&self);
    /// La ventana está visible y con foco (para no avisar de la sesión que estás mirando).
    fn window_focused(&self) -> bool;
    fn update_tray(&self, _state: TrayState) {}
}
