// Equivalencias con JavaScript que el formato de los transcripts y los archivos de betools dan por hechas
// (longitudes en unidades UTF-16, `trim`, truthiness, `path.resolve`, `Date.parse`).
use chrono::{DateTime, Local, LocalResult, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use serde_json::Value;
use std::path::Path;

// `null` cuenta como ausente, igual que con `?.` y `??`.
pub(crate) fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key).filter(|x| !x.is_null())
}

pub(crate) fn get_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    get(v, key).and_then(Value::as_str)
}

pub(crate) fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

// `String(v)` de JS.
pub(crate) fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

// Clave de un Map de JS a partir de un valor del JSON (`undefined` si falta).
pub(crate) fn key_of(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".to_string(), js_string)
}

fn is_js_space(c: char) -> bool {
    // U+0085 es espacio para Rust pero no para JS; U+FEFF lo es para JS pero no para Rust.
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

// `s.replace(/\s+/g, ' ').trim()`
pub(crate) fn collapse_ws(s: &str) -> String {
    s.split(is_js_space).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ")
}

pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

// `s.slice(0, n)` en unidades UTF-16; un par sustituto cortado se reemplaza por U+FFFD.
pub(crate) fn slice_utf16(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&u)
}

// Ruta absoluta y normalizada léxicamente (`path.resolve` de Node en POSIX).
pub(crate) fn resolve(base: &str, p: &str) -> String {
    let full: String = if p.starts_with('/') {
        p.to_string()
    } else {
        let b = if base.starts_with('/') {
            base.to_string()
        } else {
            let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
            format!("{cwd}/{base}")
        };
        format!("{b}/{p}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in full.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("/{}", parts.join("/"))
}

pub(crate) fn home() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

pub(crate) fn basename(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

// `path.extname`: vacío si el nombre no tiene punto o solo lo tiene al principio.
pub(crate) fn extname(p: &str) -> &str {
    let b = basename(p);
    match b.rfind('.') {
        Some(i) if i > 0 => &b[i..],
        _ => "",
    }
}

pub(crate) fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn iso_ms(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default().to_rfc3339_opts(SecondsFormat::Millis, true)
}

// `Date.parse`: RFC 3339, fecha y hora sin zona (local) o solo fecha (UTC). None equivale a NaN.
pub(crate) fn parse_date(s: &str) -> Option<i64> {
    let s = trim(s);
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.timestamp_millis());
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, f) {
            return local_ms(n);
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis())
}

fn local_ms(n: NaiveDateTime) -> Option<i64> {
    match Local.from_local_datetime(&n) {
        LocalResult::Single(d) => Some(d.timestamp_millis()),
        LocalResult::Ambiguous(a, _) => Some(a.timestamp_millis()),
        // Hueco por cambio de hora: JS salta hacia adelante.
        LocalResult::None => Local.from_local_datetime(&(n + chrono::Duration::hours(1))).earliest().map(|d| d.timestamp_millis()),
    }
}

// Medianoche local del día de `ms`.
pub(crate) fn start_of_day(ms: i64) -> i64 {
    let d = DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default().with_timezone(&Local).date_naive();
    local_ms(d.and_hms_opt(0, 0, 0).unwrap()).unwrap_or(ms)
}

pub(crate) fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

pub(crate) fn mtime_ms(p: &Path) -> Option<f64> {
    let m = std::fs::metadata(p).ok()?.modified().ok()?;
    let d = m.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_secs_f64() * 1000.0)
}

// `JSON.stringify` imprime los enteros sin ".0"; serde imprime así los f64 enteros. Se normaliza antes de
// escribir archivos que lee la versión Electron.
pub(crate) fn to_js_json<T: serde::Serialize>(v: &T) -> String {
    fn walk(v: &mut Value) {
        match v {
            Value::Number(n) => {
                if let Some(f) = n.as_f64() {
                    if n.is_f64() && f.fract() == 0.0 && f.abs() < 9e15 {
                        *v = Value::from(f as i64);
                    }
                }
            }
            Value::Array(a) => a.iter_mut().for_each(walk),
            Value::Object(o) => o.values_mut().for_each(walk),
            _ => {}
        }
    }
    let mut val = serde_json::to_value(v).unwrap_or(Value::Null);
    walk(&mut val);
    val.to_string()
}


// `JSON.parse` acepta sustitutos UTF-16 sueltos escritos como \udXXX (JSON.stringify los genera al cortar un
// emoji); serde_json los rechaza y la línea entera se perdería. Se reintenta con U+FFFD en su lugar.
pub(crate) fn parse_json(text: &str) -> Option<Value> {
    match serde_json::from_str(text) {
        Ok(v) => Some(v),
        Err(_) if text.contains("\\u") => serde_json::from_str(&fix_surrogates(text)?).ok(),
        Err(_) => None,
    }
}

pub(crate) fn parse_json_bytes(raw: &[u8]) -> Option<Value> {
    parse_json(&String::from_utf8_lossy(raw))
}

fn hex4(b: &[u8]) -> Option<u32> {
    let s = std::str::from_utf8(b.get(..4)?).ok()?;
    if !s.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(s, 16).ok()
}

// None si no había nada que corregir.
fn fix_surrogates(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut last, mut fixed) = (0, 0, false);
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        if b.get(i + 1) == Some(&b'u') {
            if let Some(c) = hex4(&b[i + 2..]) {
                let low_next = b.get(i + 6) == Some(&b'\\')
                    && b.get(i + 7) == Some(&b'u')
                    && hex4(&b[(i + 8).min(b.len())..]).is_some_and(|n| (0xDC00..0xE000).contains(&n));
                if (0xD800..0xDC00).contains(&c) && low_next {
                    i += 12;
                    continue;
                }
                if (0xD800..0xE000).contains(&c) {
                    out.push_str(&text[last..i]);
                    out.push_str("\\ufffd");
                    fixed = true;
                    i += 6;
                    last = i;
                    continue;
                }
            }
        }
        i += 2;
    }
    out.push_str(&text[last..]);
    fixed.then_some(out)
}

// Orden y formato de números que tendría el valor tras `JSON.parse` + `JSON.stringify`: las claves con forma de
// índice de arreglo van primero y en orden numérico, y 1.0 / 2e2 / -0.0 se imprimen como enteros.
pub(crate) fn normalize(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if n.is_f64() && f.fract() == 0.0 && f.abs() < 9e15 {
                    *v = Value::from(f as i64);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(normalize),
        Value::Object(o) => {
            let mut entries: Vec<(String, Value)> = std::mem::take(o).into_iter().collect();
            entries.iter_mut().for_each(|(_, v)| normalize(v));
            let index = |k: &str| k.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == k);
            entries.sort_by_key(|(k, _)| index(k).map_or((1, 0), |n| (0, n)));
            o.extend(entries);
        }
        _ => {}
    }
}

// `JSON.stringify(v, null, 2)`.
pub(crate) fn pretty(v: &Value) -> String {
    let mut c = v.clone();
    normalize(&mut c);
    serde_json::to_string_pretty(&c).unwrap_or_default()
}

pub(crate) fn read_lossy(p: &Path) -> Option<String> {
    Some(String::from_utf8_lossy(&std::fs::read(p).ok()?).into_owned())
}
