//! Lógica de betools sin ventana: equivalente a src/main/index.ts. La usa la app de escritorio
//! (Tauri) a través del trait `Host`.

mod app;
mod dispatch;
mod docs;
mod env;
mod host;
mod util;

pub use app::{App, AppConfig};
pub use dispatch::{EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS};
pub use host::{Host, Notice, TrayEntry, TrayState};
