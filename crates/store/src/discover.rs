use crate::claude_paths::encode_cwd;
use crate::util::{home_dir, is_js_ws, iso_from_millis, js_trim, read_dir_sorted};
use betools_types::DiscoveredSession;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const HEAD: u64 = 256 * 1024;
const TAIL: u64 = 256 * 1024;

fn read_range(file: &Path, start: u64, length: u64) -> std::io::Result<String> {
    let mut f = File::open(file)?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.take(length).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn parse_lines(text: &str) -> Vec<Value> {
    // Líneas cortadas en el borde del rango o no-JSON se descartan.
    text.split('\n').filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(_) => true,
    }
}

fn str_field<'a>(d: &'a Value, key: &str) -> Option<&'a str> {
    d.get(key).and_then(Value::as_str)
}

fn prompt_text(d: &Value) -> Option<String> {
    if str_field(d, "type") != Some("user") || truthy(d.get("isMeta")) || truthy(d.get("isSidechain")) {
        return None;
    }
    let text = match d.get("message").and_then(|m| m.get("content"))? {
        Value::String(s) => s.as_str(),
        // Solo el primer bloque de texto: si no trae `text` como cadena, el mensaje no sirve.
        Value::Array(a) => a.iter().find(|x| str_field(x, "type") == Some("text")).and_then(|x| str_field(x, "text"))?,
        _ => return None,
    };
    let t = js_trim(text);
    // Se saltan los mensajes que inyecta el sistema (comandos, recordatorios, caveats).
    if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") {
        return None;
    }
    Some(truncate_utf16(&collapse_ws(t), 140))
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if is_js_ws(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

// slice(0, n) de JS cuenta unidades UTF-16; un par sustituto cortado a la mitad se descarta.
fn truncate_utf16(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

fn is_dir(p: &str) -> bool {
    fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

struct FileInfo {
    id: String,
    dir: String,
    path: std::path::PathBuf,
    mtime: SystemTime,
    size: u64,
}

struct Raw {
    id: String,
    dir: String,
    mtime: SystemTime,
    size: u64,
    head_cwd: Option<String>,
    tail_cwd: Option<String>,
    title: String,
}

fn millis(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

pub fn discover_sessions(exclude: &HashSet<String>) -> Vec<DiscoveredSession> {
    discover_sessions_limit(exclude, 300)
}

/// Lista las sesiones de ~/.claude/projects, las más recientes primero.
/// Lee solo el principio (primer prompt) y el final (cwd actual, título) de cada archivo.
///
/// El cwd: las primeras líneas guardan el directorio donde empezó la sesión, que puede ya no
/// existir si la carpeta se movió (p. ej. ~/workdir/clients/vemo → ~/workdir/infra/clients/vemo).
/// Se usa, en orden: el directorio que corresponde a la carpeta de proyecto donde vive el .jsonl
/// (desde donde se lanzó), el mismo deducido de un movimiento de carpeta, y si no, el último y el
/// primer cwd registrados que existan.
pub fn discover_sessions_limit(exclude: &HashSet<String>, limit: usize) -> Vec<DiscoveredSession> {
    let root = home_dir().join(".claude").join("projects");
    // Sin ~/.claude/projects (Claude Code nunca se usó en este equipo) no hay nada que importar.
    let Ok(dirs) = read_dir_sorted(&root) else { return vec![] };
    let mut files: Vec<FileInfo> = vec![];
    for dir in dirs {
        if !dir.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let dir_name = dir.file_name().to_string_lossy().into_owned();
        let Ok(entries) = read_dir_sorted(&dir.path()) else { continue };
        for f in entries {
            let name = f.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".jsonl") else { continue };
            if exclude.contains(id) {
                continue;
            }
            let path = f.path();
            let Ok(st) = fs::metadata(&path) else { continue };
            if st.len() == 0 {
                continue;
            }
            let Ok(mtime) = st.modified() else { continue };
            files.push(FileInfo { id: id.to_string(), dir: dir_name.clone(), path, mtime, size: st.len() });
        }
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.mtime));

    let mut raws: Vec<Raw> = vec![];
    for f in files.into_iter().take(limit) {
        let Ok(head_text) = read_range(&f.path, 0, HEAD.min(f.size)) else { continue };
        let head = parse_lines(&head_text);
        let tail = if f.size > HEAD {
            match read_range(&f.path, f.size.saturating_sub(TAIL), TAIL.min(f.size)) {
                Ok(t) => parse_lines(&t),
                Err(_) => continue,
            }
        } else {
            head.clone()
        };
        let non_empty = |s: &str| (!s.is_empty()).then(|| s.to_string());
        let head_cwd = head.iter().find_map(|d| str_field(d, "cwd")).and_then(non_empty);
        let mut tail_cwd = None;
        // Gana el último título puesto a mano; si no hay, el último generado por Claude.
        let (mut custom, mut ai) = (String::new(), String::new());
        for d in &tail {
            if let Some(c) = str_field(d, "cwd") {
                tail_cwd = non_empty(c);
            }
            match str_field(d, "type") {
                Some("custom-title") => {
                    if let Some(t) = str_field(d, "customTitle") {
                        custom = t.to_string();
                    }
                }
                Some("ai-title") => {
                    if let Some(t) = str_field(d, "aiTitle") {
                        ai = t.to_string();
                    }
                }
                _ => {}
            }
        }
        if head_cwd.is_none() && tail_cwd.is_none() {
            continue;
        }
        let title = [custom, ai]
            .into_iter()
            .find(|t| !t.is_empty())
            .or_else(|| head.iter().find_map(prompt_text))
            .unwrap_or_else(|| "(no prompt)".into());
        raws.push(Raw { id: f.id, dir: f.dir, mtime: f.mtime, size: f.size, head_cwd, tail_cwd, title });
    }

    let cands = |r: &Raw| [r.tail_cwd.clone(), r.head_cwd.clone()].into_iter().flatten().collect::<Vec<_>>();

    // Directorio real de cada carpeta de proyecto: un cwd existente cuya codificación coincide.
    let mut dir_cwd: HashMap<&str, String> = HashMap::new();
    for r in &raws {
        for c in cands(r) {
            if !dir_cwd.contains_key(r.dir.as_str()) && encode_cwd(&c) == r.dir && is_dir(&c) {
                dir_cwd.insert(&r.dir, c);
            }
        }
    }

    // Carpetas movidas: de sesiones que empezaron en un path que ya no existe y siguieron en otro
    // con el mismo final (…/clients/vemo → …/infra/clients/vemo) se aprende el cambio de prefijo.
    // Vec y no HashMap: se recorre en orden de inserción, como el Map de JS.
    let mut rewrites: Vec<(String, String)> = vec![];
    for r in &raws {
        let (Some(h), Some(t)) = (&r.head_cwd, &r.tail_cwd) else { continue };
        if h == t || is_dir(h) || !is_dir(t) {
            continue;
        }
        let a: Vec<&str> = h.split('/').collect();
        let b: Vec<&str> = t.split('/').collect();
        let mut k = 0;
        while k + 1 < a.len() && k + 1 < b.len() && a[a.len() - 1 - k] == b[b.len() - 1 - k] {
            k += 1;
        }
        if k > 0 {
            let (from, to) = (a[..a.len() - k].join("/"), b[..b.len() - k].join("/"));
            match rewrites.iter_mut().find(|(f, _)| *f == from) {
                Some(e) => e.1 = to,
                None => rewrites.push((from, to)),
            }
        }
    }
    // Solo se acepta si el resultado existe y coincide con la carpeta de proyecto del .jsonl.
    let rewrite = |r: &Raw| -> Option<String> {
        for c in cands(r) {
            for (from, to) in &rewrites {
                if c != *from && !c.starts_with(&format!("{from}/")) {
                    continue;
                }
                let cand = format!("{to}{}", &c[from.len()..]);
                if encode_cwd(&cand) == r.dir && is_dir(&cand) {
                    return Some(cand);
                }
            }
        }
        None
    };

    raws.iter()
        .map(|r| {
            // Primero el directorio desde el que se lanzó (el de la carpeta de proyecto): durante la sesión
            // Claude puede haber hecho cd a subdirectorios profundos, que no sirven como lugar de trabajo.
            let found = [dir_cwd.get(r.dir.as_str()).cloned(), rewrite(r), r.tail_cwd.clone(), r.head_cwd.clone()]
                .into_iter()
                .flatten()
                .find(|c| is_dir(c));
            let cwd_exists = found.is_some();
            DiscoveredSession {
                id: r.id.clone(),
                cwd: found.or_else(|| r.tail_cwd.clone()).or_else(|| r.head_cwd.clone()).unwrap_or_default(),
                cwd_exists,
                title: r.title.clone(),
                modified_at: iso_from_millis(millis(r.mtime)),
                // Math.round: la mitad sube.
                size_kb: (r.size + 512) / 1024,
            }
        })
        .collect()
}
