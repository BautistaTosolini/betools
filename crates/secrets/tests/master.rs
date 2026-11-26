use betools_secrets::MasterKeySecrets;
use betools_types::{EnvScope, EnvScopeKind};

fn sc(id: &str) -> EnvScope {
    EnvScope { kind: EnvScopeKind::Folder, id: id.into() }
}

#[test]
fn roundtrip_persist_and_format() {
    let d = tempfile::tempdir().unwrap();
    let m = MasterKeySecrets::new(d.path(), Some("master"));
    assert!(m.available().is_ok());
    m.set(&sc("f"), "A", "ñandú").unwrap();
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(d.path().join("secrets.json")).unwrap()).unwrap();
    assert!(raw["salt"].is_string());
    assert_eq!(raw["values"]["folder:f:A"].as_str().unwrap().split('.').count(), 3);
    let again = MasterKeySecrets::new(d.path(), Some("master"));
    assert_eq!(again.get(&sc("f"), "A").unwrap().as_deref(), Some("ñandú"));
    assert_eq!(again.get(&sc("f"), "B").unwrap(), None);
}

#[test]
fn wrong_master_key_fails_cleanly() {
    let d = tempfile::tempdir().unwrap();
    MasterKeySecrets::new(d.path(), Some("one")).set(&sc("f"), "A", "v").unwrap();
    let e = MasterKeySecrets::new(d.path(), Some("two")).get(&sc("f"), "A").unwrap_err().to_string();
    assert_eq!(e, "no se pudo descifrar (¿cambió la clave maestra?)");
    let e = MasterKeySecrets::new(d.path(), None).get(&sc("f"), "A").unwrap_err().to_string();
    assert_eq!(e, "falta la clave maestra para descifrar");
}

#[test]
fn no_master_key_refuses_to_store() {
    let d = tempfile::tempdir().unwrap();
    let m = MasterKeySecrets::new(d.path(), None);
    assert!(m.available().unwrap_err().contains("clawhip_master_key"));
    assert!(m.set(&sc("f"), "A", "v").is_err());
}

#[test]
fn delete_and_delete_scope() {
    let d = tempfile::tempdir().unwrap();
    let m = MasterKeySecrets::new(d.path(), Some("k"));
    m.set(&sc("f"), "A", "1").unwrap();
    m.set(&sc("f"), "B", "2").unwrap();
    m.set(&sc("g"), "A", "3").unwrap();
    m.delete(&sc("f"), "A").unwrap();
    assert_eq!(m.get(&sc("f"), "A").unwrap(), None);
    m.delete_scope(&sc("f")).unwrap();
    assert_eq!(m.get(&sc("f"), "B").unwrap(), None);
    assert_eq!(m.get(&sc("g"), "A").unwrap().as_deref(), Some("3"));
}

// Vector de Node: scryptSync('master', salt de 16 ceros, 32) + AES-256-GCM, formato iv.tag.ct.
#[test]
fn reads_file_written_by_node() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("secrets.json"), include_str!("node-master.json")).unwrap();
    let m = MasterKeySecrets::new(d.path(), Some("master-de-prueba"));
    assert_eq!(m.get(&sc("f"), "A").unwrap().as_deref(), Some("valor-ñ"));
}
