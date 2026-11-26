//! Edición de .md desde el visor (doc:write): solo en la versión Rust.

mod common;

use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;

fn mtime(v: &Value) -> f64 {
    v["mtime"].as_f64().unwrap()
}

#[test]
fn saves_and_returns_the_new_version() {
    let e = common::env();
    let p = format!("{}/notes.md", e.dir("docs"));
    std::fs::write(&p, "# old\n").unwrap();
    let before = e.ok("doc:read", vec![json!(p)]);
    let after = e.ok("doc:write", vec![json!(p), json!("# new\nñ 日本\n"), json!(mtime(&before))]);
    assert_eq!(after["text"], "# new\nñ 日本\n");
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "# new\nñ 日本\n");
    assert_eq!(mtime(&after), mtime(&e.ok("doc:read", vec![json!(p)])));
}

#[test]
fn refuses_to_overwrite_a_file_changed_on_disk() {
    let e = common::env();
    let p = format!("{}/plan.md", e.dir("docs"));
    std::fs::write(&p, "v1").unwrap();
    let stale = mtime(&e.ok("doc:read", vec![json!(p)]));
    // Otro proceso (p. ej. Claude) lo cambia después de abrirlo.
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(&p, "v2 from claude").unwrap();
    let err = e.err("doc:write", vec![json!(p), json!("mine"), json!(stale)]);
    assert!(err.starts_with("CONFLICT:"), "{err}");
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "v2 from claude");
    // Con mtime nulo (el usuario eligió reemplazar) se guarda igual.
    e.ok("doc:write", vec![json!(p), json!("mine"), Value::Null]);
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "mine");
}

#[test]
fn keeps_permissions_and_symlinks() {
    let e = common::env();
    let dir = e.dir("docs");
    let real = format!("{dir}/real.md");
    let link = format!("{dir}/link.md");
    std::fs::write(&real, "a").unwrap();
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o640)).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    e.ok("doc:write", vec![json!(link), json!("b"), Value::Null]);
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read_to_string(&real).unwrap(), "b");
    assert_eq!(std::fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o640);
    // No quedan temporales en la carpeta.
    let left: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|d| d.ok()).map(|d| d.file_name()).collect();
    assert_eq!(left.len(), 2, "{left:?}");
}

#[test]
fn only_existing_markdown_files() {
    let e = common::env();
    let dir = e.dir("docs");
    let txt = format!("{dir}/a.txt");
    std::fs::write(&txt, "x").unwrap();
    assert_eq!(e.err("doc:write", vec![json!(txt), json!("y"), Value::Null]), "Only Markdown files can be edited in betools.");
    assert_eq!(std::fs::read_to_string(&txt).unwrap(), "x");
    let missing = format!("{dir}/missing.md");
    assert!(e.err("doc:write", vec![json!(missing), json!("y"), Value::Null]).starts_with("ENOENT"));
    assert!(!std::path::Path::new(&missing).exists());
    assert!(e.err("doc:write", vec![json!(format!("{dir}/x.md"))]).starts_with("Invalid argument"));
}
