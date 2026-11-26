//! Port de pty-manager.ts, shell-manager.ts y status-tracker.ts.

mod decoder;
mod env;
mod pty_manager;
mod shell_manager;
pub mod status_tracker;
mod term;

pub use decoder::Utf8Decoder;
pub use env::{clean_env, ResolvedEnv};
pub use pty_manager::{claude_args, secrets_prompt, PtyEvents, PtyManager};
pub use shell_manager::{ShellEvents, ShellManager, SHELL_PREFIX};
pub use status_tracker::{build_settings, user_status_line, StatusTracker};
