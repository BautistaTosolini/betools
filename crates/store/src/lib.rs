//! Persistencia y descubrimiento local de betools: sesiones, ajustes, migración de datos,
//! sesiones de Claude Code, comandos slash y apertura de artefactos.
//! Port de session-store, settings, migrate, discover, claude-paths, slash-commands y artifact-opener.

pub mod artifact_opener;
pub mod claude_paths;
pub mod discover;
pub mod migrate;
pub mod session_store;
pub mod settings;
pub mod slash_commands;
mod util;

pub use artifact_opener::{open_artifact, reveal_artifact};
pub use claude_paths::{claude_bin, find_transcript, project_dir, transcript_exists, transcript_path, ClaudeBin};
pub use discover::{discover_sessions, discover_sessions_limit};
pub use migrate::{migrate_legacy_data, migrate_legacy_data_from};
pub use session_store::{FolderPatch, SessionStore};
pub use settings::{SettingsPatch, SettingsStore};
pub use slash_commands::{clean_env, SlashCommands};
pub use util::{default_user_data_dir, home_dir, iso_from_millis, now_iso};

/// Los mensajes se conservan tal cual los daba el código TypeScript.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
