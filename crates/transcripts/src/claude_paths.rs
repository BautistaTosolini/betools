// Claude Code guarda cada sesión en ~/.claude/projects/<cwd codificado>/<sessionId>.jsonl, donde todo carácter
// no alfanumérico del cwd se reemplaza por "-". Las variantes `_in` reciben la raíz para poder probarlas aisladas.
use std::fs;
use std::path::{Path, PathBuf};

pub fn projects_root() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude").join("projects")
}

// JS reemplaza por unidad UTF-16: un carácter fuera del plano básico (emoji) da dos guiones.
pub fn project_dir_in(root: &Path, cwd: &str) -> PathBuf {
    let mut name = String::with_capacity(cwd.len());
    for c in cwd.chars() {
        if c.is_ascii_alphanumeric() {
            name.push(c);
        } else {
            name.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    // join(root, "") de Node no deja barra final; PathBuf::join sí.
    if name.is_empty() { root.to_path_buf() } else { root.join(name) }
}

pub fn project_dir(cwd: &str) -> PathBuf {
    project_dir_in(&projects_root(), cwd)
}

pub fn transcript_path_in(root: &Path, cwd: &str, session_id: &str) -> PathBuf {
    project_dir_in(root, cwd).join(format!("{session_id}.jsonl"))
}

pub fn transcript_path(cwd: &str, session_id: &str) -> PathBuf {
    transcript_path_in(&projects_root(), cwd, session_id)
}

// El transcript no siempre está donde indica el cwd: si la carpeta del proyecto se movió o la sesión cambió de
// directorio, el .jsonl queda en otra carpeta de ~/.claude/projects. Se busca primero en la ubicación esperada
// y después por ID en todas.
pub fn find_transcript_in(root: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    let expected = transcript_path_in(root, cwd, session_id);
    if expected.exists() {
        return Some(expected);
    }
    // readdirSync de Node ordena los nombres (scandir + alphasort).
    let mut names: Vec<_> = fs::read_dir(root).ok()?.flatten().map(|e| e.file_name()).collect();
    names.sort();
    for n in names {
        let p = root.join(n).join(format!("{session_id}.jsonl"));
        if p.exists() {
            return Some(p);
        }
    }
    None
}

pub fn find_transcript(cwd: &str, session_id: &str) -> Option<PathBuf> {
    find_transcript_in(&projects_root(), cwd, session_id)
}
