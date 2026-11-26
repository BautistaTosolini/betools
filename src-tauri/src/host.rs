//! `Host` de betools-app sobre Tauri: eventos hacia la interfaz, portapapeles, diálogos, bandeja,
//! notificaciones y ventana. Cada método puede llamarse desde cualquier hilo.

use betools_app::{App as Core, Host, Notice, TrayState};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub const WINDOW: &str = "main";
pub const TRAY: &str = "main";

pub struct TauriHost {
    handle: AppHandle,
    core: OnceLock<Core>,
    /// Equivale a `quitting` de index.ts: con true, la X cierra de verdad en lugar de ir a la bandeja.
    pub quitting: AtomicBool,
    clipboard: Mutex<Option<arboard::Clipboard>>,
    pub icon: PathBuf,
}

impl TauriHost {
    pub fn new(handle: AppHandle, icon: PathBuf) -> Self {
        Self { handle, core: OnceLock::new(), quitting: AtomicBool::new(false), clipboard: Mutex::new(None), icon }
    }

    /// La lógica se crea con el host, así que se enlaza después (antes de crear la ventana).
    pub fn bind(&self, core: Core) {
        let _ = self.core.set(core);
    }

    pub fn core(&self) -> &Core {
        self.core.get().expect("la lógica se enlaza antes de crear la ventana")
    }

    pub fn try_core(&self) -> Option<&Core> {
        self.core.get()
    }

    pub fn has_tray(&self) -> bool {
        self.handle.tray_by_id(TRAY).is_some()
    }

    /// Una sola instancia viva: en X11 el contenido copiado desaparece si el dueño se destruye.
    fn clipboard(&self) -> Result<MutexGuard<'_, Option<arboard::Clipboard>>, String> {
        let mut guard = self.clipboard.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
        }
        Ok(guard)
    }
}

fn tray_menu(app: &AppHandle, state: &TrayState) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "show", "Show", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for e in &state.entries {
        menu.append(&MenuItem::with_id(app, format!("s:{}", e.session_id), &e.label, true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit (stops the sessions)", true, None::<&str>)?)?;
    Ok(menu)
}

impl Host for TauriHost {
    fn emit(&self, channel: &str, args: Vec<Value>) {
        // Sin ventana el evento se descarta, como `win.webContents.send` con la ventana destruida.
        let _ = self.handle.emit("ipc", json!({ "channel": channel, "args": args }));
    }

    fn clipboard_read(&self) -> Result<String, String> {
        let mut guard = self.clipboard()?;
        match guard.as_mut().expect("recién creado").get_text() {
            Ok(t) => Ok(t),
            // `clipboard.readText()` devuelve "" si no hay texto.
            Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn clipboard_write(&self, text: &str) -> Result<(), String> {
        let mut guard = self.clipboard()?;
        guard.as_mut().expect("recién creado").set_text(text.to_string()).map_err(|e| e.to_string())
    }

    fn pick_folder(&self) -> Option<String> {
        let mut dialog = self.handle.dialog().file();
        if let Some(w) = self.handle.get_webview_window(WINDOW) {
            dialog = dialog.set_parent(&w);
        }
        let path = dialog.blocking_pick_folder()?.into_path().ok()?;
        Some(path.to_string_lossy().into_owned())
    }

    fn open_external(&self, url: &str) -> Result<(), String> {
        self.handle.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
    }

    fn notify(&self, notice: Notice) {
        let Some(core) = self.core.get().cloned() else { return };
        let icon = self.icon.to_string_lossy().into_owned();
        // `show` y la espera del clic no deben bloquear a quien llama (se invoca con candados tomados).
        std::thread::spawn(move || {
            let mut n = notify_rust::Notification::new();
            n.appname("betools")
                .summary(&notice.title)
                .body(&notice.body)
                .icon(&icon)
                .urgency(if notice.urgent { notify_rust::Urgency::Critical } else { notify_rust::Urgency::Normal })
                .action("default", "Open");
            if let Ok(handle) = n.show() {
                // Clic en la notificación: selecciona la sesión y muestra la ventana.
                handle.wait_for_action(|action| {
                    if action == "default" {
                        core.select_from_outside(&notice.session_id);
                    }
                });
            }
        });
    }

    fn show_window(&self) {
        if let Some(w) = self.handle.get_webview_window(WINDOW) {
            if w.is_minimized().unwrap_or(false) {
                let _ = w.unminimize();
            }
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    fn window_focused(&self) -> bool {
        self.handle
            .get_webview_window(WINDOW)
            .is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
    }

    fn update_tray(&self, state: TrayState) {
        let handle = self.handle.clone();
        // El menú de la bandeja (GTK) se arma en el hilo principal.
        let _ = self.handle.run_on_main_thread(move || {
            let Some(tray) = handle.tray_by_id(TRAY) else { return };
            let _ = tray.set_tooltip(Some(&state.tooltip));
            if let Ok(menu) = tray_menu(&handle, &state) {
                let _ = tray.set_menu(Some(menu));
            }
        });
    }
}
