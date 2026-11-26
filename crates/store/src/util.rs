use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Equivale a os.homedir() de Node: $HOME y, si no está, el passwd.
pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// userData de Electron para productName "betools": $XDG_CONFIG_HOME o ~/.config, más "betools".
pub fn default_user_data_dir() -> PathBuf {
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home_dir().join(".config"),
    };
    base.join("betools")
}

/// Como readdirSync de Node: libuv ordena las entradas por nombre (strcmp), no en el orden crudo del sistema.
pub(crate) fn read_dir_sorted(p: &std::path::Path) -> std::io::Result<Vec<std::fs::DirEntry>> {
    let mut v: Vec<_> = std::fs::read_dir(p)?.flatten().collect();
    v.sort_by_key(|e| e.file_name());
    Ok(v)
}

/// Espacios en blanco de JS (String.prototype.trim y \s): como los de Unicode salvo NEL, más el BOM.
pub(crate) fn is_js_ws(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// `new Date(ms).toISOString()`: UTC con milisegundos.
pub fn iso_from_millis(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    // Días desde 1970-01-01 a fecha civil (algoritmo de H. Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

pub fn now_iso() -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    iso_from_millis(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_js() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_700_001_000_000), "2023-11-14T22:30:00.000Z");
        assert_eq!(iso_from_millis(951_782_400_123), "2000-02-29T00:00:00.123Z");
        assert_eq!(iso_from_millis(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn js_trim_semantics() {
        assert_eq!(js_trim("\u{FEFF} a \u{85}"), "a \u{85}");
        assert_eq!(js_trim("\u{A0}x\n"), "x");
    }
}
