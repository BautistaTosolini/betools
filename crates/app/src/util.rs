//! Equivalentes de pequeñas funciones de JS/Node que usa index.ts.

use regex::Regex;
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard, OnceLock};

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `String.prototype.trim`: no recorta U+0085 (NEL) y sí U+FEFF.
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}')
}

/// `path.basename` de POSIX: ignora las barras finales.
pub(crate) fn basename(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// `path.extname` de POSIX (con el punto; vacío si no hay o es un archivo oculto sin extensión).
pub(crate) fn extname(p: &str) -> &str {
    let base = basename(p);
    match base.rfind('.') {
        Some(i) if i > 0 && base != ".." => &base[i..],
        _ => "",
    }
}

/// "claude-opus-5-5" → "Opus 5.5"; "claude-sonnet-4-5-20250929" → "Sonnet 4.5". Solo para cuando
/// todavía no hay status line (sesión sin lanzar): ahí Claude Code da el nombre visible.
pub(crate) fn pretty_model(id: Option<&str>) -> Option<String> {
    let id = id.filter(|s| !s.is_empty())?;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^claude-([a-z]+)-([0-9]+)(?:-([0-9]{1,2}))?(?:-[0-9]{8})?(\[1m\])?$").unwrap());
    let Some(m) = re.captures(id) else { return Some(id.to_string()) };
    let family = &m[1];
    let mut chars = family.chars();
    let head: String = chars.next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
    Some(format!(
        "{head}{} {}{}{}",
        chars.as_str(),
        &m[2],
        m.get(3).map(|v| format!(".{}", v.as_str())).unwrap_or_default(),
        if m.get(4).is_some() { " (1M)" } else { "" }
    ))
}

/// Paths adicionales: se normalizan, sin duplicados ni el principal. Pueden no existir ya
/// (sesiones de una estructura de carpetas vieja), así que no se valida que existan.
pub(crate) fn clean_extra(paths: &[String], main: Option<&str>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for p in paths {
        let t = js_trim(p).trim_end_matches('/');
        if !t.is_empty() && Some(t) != main && seen.insert(t.to_string()) {
            out.push(t.to_string());
        }
    }
    out
}

/// `String(value)` para los valores que puede mandar la interfaz.
pub(crate) fn js_string(v: &serde_json::Value) -> String {
    use serde_json::Value::*;
    match v {
        String(s) => s.clone(),
        Null => "null".into(),
        Bool(b) => b.to_string(),
        Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// Mensaje de un error de sistema como lo daba Node (`ENOENT: no such file or directory, stat '<path>'`).
pub(crate) fn node_io_error(e: &std::io::Error, syscall: &str, path: &str) -> String {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound => format!("ENOENT: no such file or directory, {syscall} '{path}'"),
        PermissionDenied => format!("EACCES: permission denied, {syscall} '{path}'"),
        _ => e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pretty_model_cases() {
        assert_eq!(pretty_model(Some("claude-opus-5-5")).as_deref(), Some("Opus 5.5"));
        assert_eq!(pretty_model(Some("claude-sonnet-4-5-20250929")).as_deref(), Some("Sonnet 4.5"));
        assert_eq!(pretty_model(Some("claude-opus-4-20250514")).as_deref(), Some("Opus 4"));
        assert_eq!(pretty_model(Some("claude-opus-4-1[1m]")).as_deref(), Some("Opus 4.1 (1M)"));
        assert_eq!(pretty_model(Some("gpt-x")).as_deref(), Some("gpt-x"));
        assert_eq!(pretty_model(Some("")), None);
        assert_eq!(pretty_model(None), None);
    }

    #[test]
    fn node_path_helpers() {
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("/"), "");
        assert_eq!(basename("x"), "x");
        assert_eq!(extname("/a/b.MD"), ".MD");
        assert_eq!(extname("/a/.md"), "");
        assert_eq!(extname("/a/b."), ".");
        assert_eq!(extname("/a.d/b"), "");
    }

    #[test]
    fn clean_extra_normalizes() {
        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(clean_extra(&p(&[" /a/ ", "/a", "/m", "", "  ", "/b//"]), Some("/m")), p(&["/a", "/b"]));
    }

    #[test]
    fn js_trim_semantics() {
        assert_eq!(js_trim("\u{FEFF} x \u{85}"), "x \u{85}");
    }
}
