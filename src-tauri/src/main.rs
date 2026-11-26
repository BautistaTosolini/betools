//! App de escritorio de betools sobre Tauri 2: ventana, bandeja, instancia única y arranque.
//! La lógica vive en betools-app; acá solo está lo que en Electron es `src/main/index.ts` de ventana.

// Sin consola extra en Windows; no cambia nada en Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;

use betools_app::{App as Core, AppConfig, Host};
use betools_desktop_core::{instance, local_storage, Args};
use host::{TauriHost, TRAY, WINDOW};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use tauri::image::Image;
use tauri::menu::Menu;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::Color;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;

/// Cola ordenada de `ipc_send` (pty:input, pty:resize...): un solo hilo las ejecuta en el orden en que
/// llegan, como el bucle de eventos de Electron. Con comandos concurrentes las teclas se desordenarían.
struct SendQueue(Mutex<Sender<(String, Vec<Value>)>>);

/// Mantiene vivo el candado de instancia única mientras corra la app.
#[allow(dead_code)]
struct InstanceGuard(std::fs::File);

/// `ipcRenderer.invoke`. Corre fuera del hilo principal: los diálogos y los procesos bloquean.
#[tauri::command]
async fn ipc_invoke(host: State<'_, Arc<TauriHost>>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    let core = host.core().clone();
    tauri::async_runtime::spawn_blocking(move || core.invoke(&channel, args)).await.map_err(|e| e.to_string())?
}

/// `ipcRenderer.send`: sin respuesta; solo encola.
#[tauri::command]
fn ipc_send(queue: State<'_, SendQueue>, channel: String, args: Vec<Value>) {
    let _ = queue.0.lock().unwrap_or_else(|e| e.into_inner()).send((channel, args));
}

/// `webFrame.setZoomFactor`: zoom de toda la ventana.
#[tauri::command]
fn set_zoom(window: WebviewWindow, factor: f64) -> Result<(), String> {
    window.set_zoom(factor).map_err(|e| e.to_string())
}

/// Ctrl+Shift+I, como el `toggleDevTools` de Electron.
#[tauri::command]
fn toggle_devtools(window: WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

/// Instalada, el ícono va como recurso; en desarrollo se usa el de resources/.
fn icon_path(handle: &AppHandle) -> PathBuf {
    handle
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("icon.png"))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../resources/icon.png")))
}

/// Solo http(s) y mailto se abren afuera; es el filtro de index.ts.
fn is_external(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

fn create_window(app: &tauri::App, args: &Args, host: &Arc<TauriHost>) -> tauri::Result<WebviewWindow> {
    let user_data = args.user_data();
    let handle = app.handle().clone();

    let mut builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
        .title("betools")
        .inner_size(1500.0, 920.0)
        .visible(!args.hidden)
        .background_color(Color(15, 15, 15, 255))
        .data_directory(args.webview_dir())
        // Los arrastres de la interfaz son HTML5 normales: Tauri no debe interceptarlos.
        .disable_drag_drop_handler()
        .on_navigation({
            let handle = handle.clone();
            move |url| {
                // La ventana nunca navega fuera de la app (p. ej. un link en la vista Rendered): se abre afuera.
                let internal = url.scheme() == "tauri"
                    || (cfg!(debug_assertions) && url.host_str() == Some("localhost"))
                    || url.as_str() == "about:blank";
                if !internal && is_external(url) {
                    let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                }
                internal
            }
        });

    if let Ok(icon) = Image::from_path(&host.icon) {
        builder = builder.icon(icon)?;
    }

    // Primera ejecución sobre una instalación de Electron: se siembra el localStorage del webview.
    let importing = local_storage::pending(&user_data);
    if importing {
        match local_storage::read_entries(&user_data) {
            Ok(entries) => builder = builder.initialization_script(local_storage::init_script(&entries)),
            Err(e) => eprintln!("betools: no se pudo importar el localStorage de Electron: {e}"),
        }
        let user_data = user_data.clone();
        builder = builder.on_page_load(move |_, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = local_storage::mark_imported(&user_data);
            }
        });
    }

    let window = builder.build()?;

    // Con "cerrar a la bandeja", la X oculta la ventana y las sesiones siguen corriendo.
    let (h, w) = (host.clone(), window.clone());
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. }
            if !h.quitting.load(Ordering::SeqCst) && h.has_tray() && h.core().close_to_tray() =>
        {
            api.prevent_close();
            let _ = w.hide();
        }
        WindowEvent::Focused(true) => h.core().on_window_focus(),
        _ => {}
    });
    Ok(window)
}

/// Ícono de 22x22 como en index.ts (`resize({ width: 22, height: 22 })`).
fn tray_image(icon: &std::path::Path) -> Option<Image<'static>> {
    let img = image::open(icon).ok()?.resize(22, 22, image::imageops::FilterType::Lanczos3).to_rgba8();
    let (w, h) = img.dimensions();
    Some(Image::new_owned(img.into_raw(), w, h))
}

fn create_tray(app: &tauri::App, host: &Arc<TauriHost>) {
    let build = || -> tauri::Result<()> {
        let mut builder = TrayIconBuilder::with_id(TRAY)
            .tooltip("betools")
            .menu(&Menu::new(app)?)
            .on_menu_event(|app, event| {
                let host = app.state::<Arc<TauriHost>>();
                match event.id().as_ref() {
                    "show" => host.show_window(),
                    "quit" => {
                        host.quitting.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    id => {
                        if let Some(session) = id.strip_prefix("s:") {
                            host.core().select_from_outside(session);
                        }
                    }
                }
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    tray.app_handle().state::<Arc<TauriHost>>().show_window();
                }
            });
        if let Some(icon) = tray_image(&host.icon) {
            builder = builder.icon(icon);
        }
        builder.build(app)?;
        Ok(())
    };
    // Sin soporte de bandeja: la X cierra la app como antes.
    if let Err(e) = build() {
        eprintln!("betools: sin bandeja: {e}");
    }
}

fn main() {
    let args = Args::parse(std::env::args().skip(1));
    let user_data = args.user_data();

    // Dos instancias reanudarían las mismas sesiones y escribirían el mismo transcript.
    let primary = match instance::acquire(&user_data) {
        Ok(instance::Instance::Primary(p)) => Some(p),
        Ok(instance::Instance::Secondary) => std::process::exit(0),
        Err(e) => {
            eprintln!("betools: no se pudo comprobar la instancia única: {e}");
            None
        }
    };

    let (tx, rx) = mpsc::channel::<(String, Vec<Value>)>();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SendQueue(Mutex::new(tx)))
        .invoke_handler(tauri::generate_handler![ipc_invoke, ipc_send, set_zoom, toggle_devtools])
        .setup(move |app| {
            let host = Arc::new(TauriHost::new(app.handle().clone(), icon_path(app.handle())));
            app.manage(host.clone());
            if let Some(p) = primary {
                let h = host.clone();
                // La segunda instancia muestra la ventana de esta.
                app.manage(InstanceGuard(p.on_second(move || h.show_window())));
            }

            let core = Core::new(host.clone(), AppConfig::new(user_data.clone()))?;
            host.bind(core.clone());

            let worker = core.clone();
            std::thread::spawn(move || {
                for (channel, args) in rx {
                    if let Err(e) = worker.send(&channel, args) {
                        eprintln!("betools: {channel}: {e}");
                    }
                }
            });

            // Con SIGTERM/SIGINT/SIGHUP (apagado, kill, cierre de la terminal) se terminan los procesos de
            // Claude en lugar de dejarlos huérfanos.
            if let Ok(mut signals) = signal_hook::iterator::Signals::new([
                signal_hook::consts::SIGTERM,
                signal_hook::consts::SIGINT,
                signal_hook::consts::SIGHUP,
            ]) {
                let (h, core, handle) = (host.clone(), core.clone(), app.handle().clone());
                std::thread::spawn(move || {
                    if signals.forever().next().is_some() {
                        h.quitting.store(true, Ordering::SeqCst);
                        core.shutdown();
                        handle.exit(0);
                    }
                });
            }

            create_window(app, &args, &host)?;
            create_tray(app, &host);
            core.start();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar betools")
        .run(|handle, event| match event {
            RunEvent::ExitRequested { .. } => {
                if let Some(host) = handle.try_state::<Arc<TauriHost>>() {
                    host.quitting.store(true, Ordering::SeqCst);
                }
            }
            // Al salir se terminan los procesos; las sesiones siguen en sessions.json y se retoman con --resume.
            RunEvent::Exit => {
                if let Some(core) = handle.try_state::<Arc<TauriHost>>().and_then(|h| h.try_core().cloned()) {
                    core.shutdown();
                }
            }
            _ => {}
        });
}
