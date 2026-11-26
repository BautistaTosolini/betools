//! Importa el localStorage de la interfaz Electron (LevelDB de Chromium) al webview de Tauri.
//!
//! Formato de Chromium (components/services/storage/dom_storage): cada entrada es
//! `_<origen>\0<tipo><clave>` -> `<tipo><valor>`, donde `<tipo>` es 0x01 si el texto es Latin-1
//! (un byte por carácter) y 0x00 si es UTF-16LE. La app empaquetada carga `file://`, así que ese es
//! el origen. Las claves `META:` y `METAACCESS:` son metadatos y no se importan.

use rusty_leveldb::{LdbIterator, Options, DB};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Origen de la app Electron empaquetada (`win.loadFile`).
pub const ORIGIN: &str = "file://";
/// Marca en localStorage: evita pisar datos si el script se ejecuta más de una vez.
const FLAG: &str = "__betools_ls_imported";

fn leveldb_dir(user_data: &Path) -> PathBuf {
    user_data.join("Local Storage").join("leveldb")
}

fn marker(user_data: &Path) -> PathBuf {
    user_data.join("webview").join(".ls-imported")
}

/// Falta importar: hay un LevelDB de Electron y todavía no se marcó como importado.
pub fn pending(user_data: &Path) -> bool {
    leveldb_dir(user_data).is_dir() && !marker(user_data).exists()
}

/// Se llama cuando la página ya cargó con el script de importación (ver `init_script`).
pub fn mark_imported(user_data: &Path) -> io::Result<()> {
    let m = marker(user_data);
    if let Some(dir) = m.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(m, b"")
}

/// Texto de un valor/clave de Chromium: prefijo 0x01 = Latin-1, 0x00 = UTF-16LE.
fn decode(bytes: &[u8]) -> Option<String> {
    let (kind, data) = bytes.split_first()?;
    match kind {
        1 => Some(data.iter().map(|&b| b as char).collect()),
        0 => {
            let units: Vec<u16> = data.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            Some(String::from_utf16_lossy(&units))
        }
        _ => None,
    }
}

/// Lee todas las entradas del origen. Trabaja sobre una copia: Electron puede tener el LevelDB abierto
/// (candado `LOCK`) y abrirlo escribe (reproduce el log).
pub fn read_entries(user_data: &Path) -> io::Result<Vec<(String, String)>> {
    let src = leveldb_dir(user_data);
    let tmp = tempfile::tempdir()?;
    copy_dir(&src, tmp.path())?;
    read_copy(tmp.path())
}

fn copy_dir(src: &Path, dst: &Path) -> io::Result<()> {
    for e in fs::read_dir(src)? {
        let e = e?;
        if e.file_name() == "LOCK" || !e.file_type()?.is_file() {
            continue;
        }
        fs::copy(e.path(), dst.join(e.file_name()))?;
    }
    Ok(())
}

fn read_copy(dir: &Path) -> io::Result<Vec<(String, String)>> {
    let opts = Options { create_if_missing: false, ..Options::default() };
    let mut db = DB::open(dir, opts).map_err(|e| io::Error::other(e.to_string()))?;
    let mut it = db.new_iter().map_err(|e| io::Error::other(e.to_string()))?;
    let prefix = format!("_{ORIGIN}\0").into_bytes();
    let mut out = Vec::new();
    while it.advance() {
        let Some((k, v)) = it.current() else { continue };
        let Some(key) = k.strip_prefix(prefix.as_slice()) else { continue };
        if let (Some(key), Some(val)) = (decode(key), decode(&v)) {
            out.push((key, val));
        }
    }
    Ok(out)
}

/// Script que corre antes de la página: siembra el localStorage con las entradas, sin pisar claves
/// que ya existan. Los valores van como literales JSON (comillas y escapes de JS), byte a byte.
pub fn init_script(entries: &[(String, String)]) -> String {
    let data = serde_json::to_string(entries).unwrap_or_else(|_| "[]".into());
    format!(
        "(function(){{try{{if(localStorage.getItem('{FLAG}'))return;var e={data};\
         for(var i=0;i<e.length;i++){{if(localStorage.getItem(e[i][0])===null)localStorage.setItem(e[i][0],e[i][1]);}}\
         localStorage.setItem('{FLAG}','1');}}catch(_){{}}}})();"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Escribe una entrada como lo hace Chromium: clave y valor con prefijo de tipo.
    fn put(db: &mut DB, origin: &str, key: &str, value: &str) {
        let mut k = format!("_{origin}\0").into_bytes();
        k.push(1);
        k.extend(key.bytes());
        let mut v = Vec::new();
        if value.is_ascii() {
            v.push(1);
            v.extend(value.bytes());
        } else {
            v.push(0);
            for u in value.encode_utf16() {
                v.extend(u.to_le_bytes());
            }
        }
        db.put(&k, &v).unwrap();
    }

    fn fixture() -> tempfile::TempDir {
        let ud = tempfile::tempdir().unwrap();
        let dir = leveldb_dir(ud.path());
        fs::create_dir_all(&dir).unwrap();
        let opts = Options { create_if_missing: true, ..Options::default() };
        let mut db = DB::open(&dir, opts).unwrap();
        put(&mut db, ORIGIN, "zoomApp", "1.1");
        put(&mut db, ORIGIN, "drafts", r#"{"a":"hola ñandú \"x\" 🙂\n"}"#);
        put(&mut db, "http://localhost:5173", "zoomApp", "9");
        db.put(b"META:file://", b"meta").unwrap();
        db.put(b"VERSION", b"1").unwrap();
        db.flush().unwrap();
        drop(db);
        ud
    }

    #[test]
    fn reads_only_the_packaged_origin_byte_identical() {
        let ud = fixture();
        assert!(pending(ud.path()));
        let got = read_entries(ud.path()).unwrap();
        assert_eq!(
            got,
            vec![
                ("drafts".to_string(), r#"{"a":"hola ñandú \"x\" 🙂\n"}"#.to_string()),
                ("zoomApp".to_string(), "1.1".to_string()),
            ]
        );
    }

    #[test]
    fn does_not_touch_the_original() {
        let ud = fixture();
        let names = |p: &Path| {
            let mut v: Vec<_> = fs::read_dir(p).unwrap().map(|e| e.unwrap().file_name()).collect();
            v.sort();
            v
        };
        let before = names(&leveldb_dir(ud.path()));
        read_entries(ud.path()).unwrap();
        assert_eq!(before, names(&leveldb_dir(ud.path())));
    }

    #[test]
    fn marker_stops_pending() {
        let ud = fixture();
        mark_imported(ud.path()).unwrap();
        assert!(!pending(ud.path()));
        assert!(!pending(tempfile::tempdir().unwrap().path()));
    }

    #[test]
    fn script_embeds_entries_as_json() {
        let s = init_script(&[("k".into(), "va\"l\\ue\n".into())]);
        assert!(s.contains(r#"[["k","va\"l\\ue\n"]]"#));
        assert!(s.contains("__betools_ls_imported"));
    }

    #[test]
    fn decode_formats() {
        assert_eq!(decode(&[1, b'a', 0xE9]).unwrap(), "a\u{e9}");
        assert_eq!(decode(&[0, 0x41, 0x00, 0x3D, 0xD8, 0x42, 0xDE]).unwrap(), "A\u{1F642}");
        assert_eq!(decode(&[7, 1]), None);
        assert_eq!(decode(&[]), None);
    }
}
