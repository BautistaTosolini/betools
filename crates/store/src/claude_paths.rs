use crate::util::{home_dir, read_dir_sorted};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

fn projects_root() -> PathBuf {
    home_dir().join(".claude").join("projects")
}

// Claude Code guarda cada sesión en ~/.claude/projects/<cwd codificado>/<sessionId>.jsonl,
// donde todo carácter no alfanumérico del cwd se reemplaza por "-".
// JS reemplaza por unidad UTF-16: un carácter fuera del plano básico (emoji) da dos guiones.
pub fn encode_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for c in cwd.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    out
}

pub fn project_dir(cwd: &str) -> PathBuf {
    projects_root().join(encode_cwd(cwd))
}

pub fn transcript_path(cwd: &str, session_id: &str) -> PathBuf {
    project_dir(cwd).join(format!("{session_id}.jsonl"))
}

// El transcript no siempre está donde indica el cwd: si la carpeta del proyecto se movió o la
// sesión cambió de directorio, el .jsonl queda en otra carpeta de ~/.claude/projects.
// Se busca primero en la ubicación esperada y después por ID en todas.
pub fn find_transcript(cwd: &str, session_id: &str) -> Option<PathBuf> {
    let expected = transcript_path(cwd, session_id);
    if expected.exists() {
        return Some(expected);
    }
    // Sin ~/.claude/projects, read_dir falla y no hay nada que buscar.
    for entry in read_dir_sorted(&projects_root()).ok()? {
        let p = entry.path().join(format!("{session_id}.jsonl"));
        if p.exists() {
            return Some(p);
        }
    }
    None
}

pub fn transcript_exists(cwd: &str, session_id: &str) -> bool {
    find_transcript(cwd, session_id).is_some()
}

/// Resuelve el binario de claude una sola vez. Si la app se lanza desde el escritorio o el
/// autostart, el PATH no incluye lo que agrega el perfil del usuario (~/.local/bin, nvm, etc.):
/// se pregunta a un login shell.
#[derive(Default)]
pub struct ClaudeBin(OnceLock<String>);

impl ClaudeBin {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self) -> &str {
        self.0.get_or_init(resolve)
    }
}

/// Instancia global para el resto de crates; `ClaudeBin::new()` sirve cuando hace falta una caché propia.
pub fn claude_bin() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(resolve)
}

fn resolve() -> String {
    if let Some(v) = std::env::var_os("CLAWHIP_CLAUDE_BIN").filter(|v| !v.is_empty()) {
        return v.to_string_lossy().into_owned();
    }
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/bash".into());
    if let Some(out) = run_with_timeout(&shell, &["-lc", "command -v claude"], Duration::from_secs(5)) {
        // Un perfil ruidoso imprime banners antes: vale la última línea.
        if let Some(path) = out.trim().lines().next_back() {
            if !path.is_empty() && Path::new(path).exists() {
                return path.to_string();
            }
        }
    }
    let fallback = home_dir().join(".local").join("bin").join("claude");
    if fallback.exists() {
        fallback.to_string_lossy().into_owned()
    } else {
        "claude".into()
    }
}

// stdout del comando si termina bien dentro del plazo; si no, None.
fn run_with_timeout(bin: &str, args: &[&str], limit: Duration) -> Option<String> {
    let mut child = Command::new(bin).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let out = reader.join().ok()?;
    status.success().then_some(out)
}
