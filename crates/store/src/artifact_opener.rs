use crate::{Error, Result};
use serde_json::{json, Map, Value};
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

// Reglas de apertura por extensión en <userData>/openers.json.
// "{path}" se reemplaza por la ruta del archivo. "default" aplica al resto.
type Openers = Map<String, Value>;

fn defaults() -> Openers {
    let Value::Object(m) = json!({
        ".html": ["firefox", "{path}"],
        ".htm": ["firefox", "{path}"],
        "default": ["xdg-open", "{path}"]
    }) else {
        unreachable!()
    };
    m
}

fn load_openers(user_data: &Path) -> Result<Openers> {
    let file = user_data.join("openers.json");
    if !file.exists() {
        fs::create_dir_all(user_data)?;
        fs::write(&file, serde_json::to_string_pretty(&defaults())?)?;
        return Ok(defaults());
    }
    let mut merged = defaults();
    match fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(Value::Object(user)) => merged.extend(user),
        _ => return Ok(defaults()),
    }
    Ok(merged)
}

// Como path.extname de Node: ".bashrc" no tiene extensión y "a." la tiene vacía pero con punto.
fn extname(path: &str) -> String {
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match name.rfind('.') {
        Some(i) if i > 0 && name != ".." => name[i..].to_string(),
        _ => String::new(),
    }
}

fn command_for(openers: &Openers, path: &str) -> Vec<String> {
    // `??` de JS: un null cuenta como ausente y cae al "default".
    let cmd = openers.get(&extname(path).to_lowercase()).filter(|v| !v.is_null()).or_else(|| openers.get("default"));
    match cmd {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(|p| p.replace("{path}", path)).collect(),
        _ => vec![],
    }
}

// Lanza el comando separado de la app y no espera a que termine. Sin shell: la ruta viaja como
// argumento y no se interpreta.
fn run(cmd: &[String]) -> std::io::Result<()> {
    let (bin, args) = cmd.split_first().ok_or_else(|| std::io::Error::other("empty command"))?;
    let mut child = Command::new(bin).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn()?;
    // Se recoge el estado en segundo plano para no dejar zombis.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

// App predeterminada del sistema (lo que hacía shell.openPath de Electron en Linux).
fn system_open(path: &str) -> std::result::Result<(), String> {
    let status = Command::new("xdg-open").arg(path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("xdg-open exited with {status}"))
    }
}

pub fn open_artifact(user_data: &Path, path: &str) -> Result<()> {
    open_artifact_with(user_data, path, system_open)
}

pub(crate) fn open_artifact_with(user_data: &Path, path: &str, fallback: impl FnOnce(&str) -> std::result::Result<(), String>) -> Result<()> {
    if !Path::new(path).exists() {
        return Err(Error::Msg(format!("The file no longer exists: {path}")));
    }
    let cmd = command_for(&load_openers(user_data)?, path);
    if run(&cmd).is_err() {
        // Si el comando configurado no está instalado, se usa la app predeterminada del sistema.
        fallback(path).map_err(Error::Msg)?;
    }
    Ok(())
}

/// Muestra el archivo en el gestor de archivos (FileManager1.ShowItems por D-Bus; si no, abre la carpeta).
pub fn reveal_artifact(path: &str) {
    let mut uri = String::from("file://");
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    let shown = Command::new("dbus-send")
        .args(["--session", "--print-reply", "--dest=org.freedesktop.FileManager1", "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems"])
        .arg(format!("array:string:{uri}"))
        .arg("string:")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !shown {
        let dir = Path::new(path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| ".".into());
        let _ = run(&["xdg-open".to_string(), dir]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    fn wait_for(f: impl Fn() -> bool) -> bool {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn extname_like_node() {
        assert_eq!(extname("/a/b.HTML"), ".HTML");
        assert_eq!(extname("/a/b.tar.gz"), ".gz");
        assert_eq!(extname("/a/.bashrc"), "");
        assert_eq!(extname("/a/noext"), "");
        assert_eq!(extname("/a/x."), ".");
    }

    #[test]
    fn creates_default_openers_file_and_merges_user_rules() {
        let d = tempfile::tempdir().unwrap();
        let o = load_openers(d.path()).unwrap();
        assert_eq!(o, defaults());
        let saved = fs::read_to_string(d.path().join("openers.json")).unwrap();
        assert!(saved.starts_with("{\n  \".html\": [\n    \"firefox\","));
        fs::write(d.path().join("openers.json"), r#"{".md":["code","{path}"],".html":["chromium","{path}"]}"#).unwrap();
        let o = load_openers(d.path()).unwrap();
        assert_eq!(command_for(&o, "/x/a.md"), ["code", "/x/a.md"]);
        assert_eq!(command_for(&o, "/x/a.HTML"), ["chromium", "/x/a.HTML"]);
        assert_eq!(command_for(&o, "/x/a.htm"), ["firefox", "/x/a.htm"]);
        assert_eq!(command_for(&o, "/x/a.pdf"), ["xdg-open", "/x/a.pdf"]);
    }

    #[test]
    fn null_rule_falls_back_to_default_like_nullish_coalescing() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("openers.json"), r#"{".md":null}"#).unwrap();
        let o = load_openers(d.path()).unwrap();
        assert_eq!(command_for(&o, "/x/a.md"), ["xdg-open", "/x/a.md"]);
    }

    #[test]
    fn invalid_openers_file_falls_back_to_defaults() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("openers.json"), "{no").unwrap();
        assert_eq!(load_openers(d.path()).unwrap(), defaults());
    }

    #[test]
    fn missing_file_error_message() {
        let d = tempfile::tempdir().unwrap();
        let err = open_artifact(d.path(), "/definitely/not/here.html").unwrap_err();
        assert_eq!(err.to_string(), "The file no longer exists: /definitely/not/here.html");
    }

    #[test]
    fn runs_the_configured_command_with_the_path_as_a_single_argument() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("out");
        let script = d.path().join("opener.sh");
        fs::write(&script, format!("#!/bin/sh\nprintf '%s' \"$1\" > \"{}\"\n", out.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        // Ruta con espacios y metacaracteres de shell: no se interpreta.
        let file = d.path().join("a b; $(x).txt");
        fs::write(&file, "").unwrap();
        let cfg = json!({ ".txt": [script.to_string_lossy(), "{path}"] });
        fs::write(d.path().join("openers.json"), cfg.to_string()).unwrap();
        open_artifact_with(d.path(), &file.to_string_lossy(), |_| panic!("no debe usar el respaldo")).unwrap();
        assert!(wait_for(|| out.exists() && !fs::read_to_string(&out).unwrap().is_empty()));
        assert_eq!(fs::read_to_string(&out).unwrap(), file.to_string_lossy());
    }

    #[test]
    fn uninstalled_command_uses_the_system_fallback() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("a.txt");
        fs::write(&file, "").unwrap();
        fs::write(d.path().join("openers.json"), r#"{".txt":["/no/such/bin","{path}"]}"#).unwrap();
        let mut got = None;
        open_artifact_with(d.path(), &file.to_string_lossy(), |p| {
            got = Some(p.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(got.as_deref(), Some(&*file.to_string_lossy()));
        let err = open_artifact_with(d.path(), &file.to_string_lossy(), |_| Err("boom".into())).unwrap_err();
        assert_eq!(err.to_string(), "boom");
    }
}
