// Lectura de transcripts de Claude Code, uso del plan y títulos de pestaña (puerto de transcript-parser,
// transcript-watcher, usage y titles de src/main).
pub mod claude_paths;
mod js;
pub mod parser;
mod ticker;
pub mod titles;
pub mod usage;
pub mod watcher;

pub use parser::{TranscriptParser, DOCUMENT_EXTS, INTERRUPTED};
pub use titles::TabTitles;
pub use usage::{merge_window, DailyTokenCounter, StatusLineWatcher};
pub use watcher::{Callbacks, TranscriptWatcher};
