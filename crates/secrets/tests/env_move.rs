use anyhow::{anyhow, Result};
use betools_secrets::*;
use betools_types::{EnvScope, EnvScopeKind, EnvSource, EnvVarMeta};
use std::{cell::RefCell, collections::HashMap};

fn key(s: &EnvScope) -> String {
    format!("{:?}:{}", s.kind, s.id)
}
fn s() -> EnvScope {
    EnvScope { kind: EnvScopeKind::Session, id: "s1".into() }
}
fn f() -> EnvScope {
    EnvScope { kind: EnvScopeKind::Folder, id: "f1".into() }
}

#[derive(Default)]
struct Meta(HashMap<String, Vec<EnvVarMeta>>);
impl EnvMetaStore for Meta {
    fn env_of(&self, scope: &EnvScope) -> Vec<EnvVarMeta> {
        self.0.get(&key(scope)).cloned().unwrap_or_default()
    }
    fn set_env(&mut self, scope: &EnvScope, m: EnvVarMeta) {
        let e = self.0.entry(key(scope)).or_default();
        e.retain(|x| x.name != m.name);
        e.push(m);
    }
    fn delete_env(&mut self, scope: &EnvScope, name: &str) {
        self.0.entry(key(scope)).or_default().retain(|x| x.name != name);
    }
}

struct Vals {
    vals: RefCell<HashMap<String, String>>,
    fail_set: bool,
}
impl LocalStore for Vals {
    fn get(&self, scope: &EnvScope, name: &str) -> Result<Option<String>> {
        Ok(self.vals.borrow().get(&format!("{}:{name}", key(scope))).cloned())
    }
}
impl LocalStoreRW for Vals {
    fn set(&self, scope: &EnvScope, name: &str, value: &str) -> Result<()> {
        if self.fail_set {
            return Err(anyhow!("No system keyring"));
        }
        self.vals.borrow_mut().insert(format!("{}:{name}", key(scope)), value.into());
        Ok(())
    }
    fn delete(&self, scope: &EnvScope, name: &str) -> Result<()> {
        self.vals.borrow_mut().remove(&format!("{}:{name}", key(scope)));
        Ok(())
    }
}
// RefCell no es Sync: el trait LocalStore lo exige, así que se declara a mano (pruebas de un solo hilo).
unsafe impl Sync for Vals {}

fn stores(fail_set: bool) -> (Meta, Vals) {
    (Meta::default(), Vals { vals: RefCell::new(HashMap::new()), fail_set })
}
fn plain(name: &str, value: &str) -> EnvVarMeta {
    EnvVarMeta { name: name.into(), source: EnvSource::Plain { value: value.into() }, updated_at: "2026-01-01T00:00:00.000Z".into() }
}
fn local(name: &str) -> EnvVarMeta {
    EnvVarMeta { name: name.into(), source: EnvSource::Local {}, updated_at: "2026-01-01T00:00:00.000Z".into() }
}

#[test]
fn moves_plain_session_to_folder() {
    let (mut m, l) = stores(false);
    m.set_env(&s(), plain("AWS_PROFILE", "client-prd"));
    move_env(&mut m, &l, &s(), &f(), "AWS_PROFILE", false).unwrap();
    assert!(m.env_of(&s()).is_empty());
    let dest = m.env_of(&f());
    assert_eq!(dest[0].source, EnvSource::Plain { value: "client-prd".into() });
    assert_ne!(dest[0].updated_at, "2026-01-01T00:00:00.000Z");
    assert!(dest[0].updated_at.ends_with('Z') && dest[0].updated_at.len() == 24);
}

#[test]
fn moves_local_secret_rekeying_value() {
    let (mut m, l) = stores(false);
    m.set_env(&f(), local("GITHUB_TOKEN"));
    l.set(&f(), "GITHUB_TOKEN", "tok-123").unwrap();
    move_env(&mut m, &l, &f(), &s(), "GITHUB_TOKEN", false).unwrap();
    assert_eq!(l.get(&s(), "GITHUB_TOKEN").unwrap().as_deref(), Some("tok-123"));
    assert_eq!(l.get(&f(), "GITHUB_TOKEN").unwrap(), None);
    assert_eq!(l.vals.borrow().keys().cloned().collect::<Vec<_>>(), vec!["Session:s1:GITHUB_TOKEN"]);
    assert!(m.env_of(&f()).is_empty());
}

#[test]
fn keeps_aws_references() {
    let (mut m, l) = stores(false);
    let src = EnvSource::AwsSm { profile: "p".into(), region: None, secret_id: "x".into(), json_key: Some("k".into()) };
    m.set_env(&s(), EnvVarMeta { name: "DB_PASS".into(), source: src.clone(), updated_at: "t".into() });
    move_env(&mut m, &l, &s(), &f(), "DB_PASS", false).unwrap();
    assert_eq!(m.env_of(&f())[0].source, src);
}

#[test]
fn refuses_overwrite_unless_asked() {
    let (mut m, l) = stores(false);
    m.set_env(&s(), plain("REGION", "us-east-1"));
    m.set_env(&f(), plain("REGION", "sa-east-1"));
    let e = move_env(&mut m, &l, &s(), &f(), "REGION", false).unwrap_err();
    assert!(e.downcast_ref::<EnvExistsError>().is_some());
    assert_eq!(e.to_string(), "REGION already exists in the destination.");
    assert_eq!(m.env_of(&s()).len(), 1);
    assert_eq!(m.env_of(&f())[0].source, EnvSource::Plain { value: "sa-east-1".into() });
    move_env(&mut m, &l, &s(), &f(), "REGION", true).unwrap();
    assert_eq!(m.env_of(&f())[0].source, EnvSource::Plain { value: "us-east-1".into() });
    assert!(m.env_of(&s()).is_empty());
}

#[test]
fn drops_stale_encrypted_value_when_plain_replaces_local() {
    let (mut m, l) = stores(false);
    m.set_env(&f(), local("X"));
    l.set(&f(), "X", "old-secret").unwrap();
    m.set_env(&s(), plain("X", "new"));
    move_env(&mut m, &l, &s(), &f(), "X", true).unwrap();
    assert_eq!(l.get(&f(), "X").unwrap(), None);
    assert_eq!(m.env_of(&f())[0].source, EnvSource::Plain { value: "new".into() });
}

#[test]
fn fails_without_changes_when_variable_or_value_missing() {
    let (mut m, l) = stores(false);
    assert!(move_env(&mut m, &l, &s(), &f(), "NOPE", false).unwrap_err().to_string().contains("does not exist"));
    m.set_env(&s(), local("ORPHAN"));
    assert!(move_env(&mut m, &l, &s(), &f(), "ORPHAN", false).unwrap_err().to_string().contains("no stored value"));
    assert_eq!(m.env_of(&s()).len(), 1);
    assert!(m.env_of(&f()).is_empty());
}

#[test]
fn rejects_same_scope() {
    let (mut m, l) = stores(false);
    m.set_env(&s(), plain("A", "1"));
    assert!(move_env(&mut m, &l, &s(), &s(), "A", false).unwrap_err().to_string().contains("same"));
}

#[test]
fn never_loses_variable_when_destination_write_fails() {
    let (mut m, l) = stores(true);
    m.set_env(&s(), local("TOKEN"));
    l.vals.borrow_mut().insert("Session:s1:TOKEN".into(), "v".into());
    let e = move_env(&mut m, &l, &s(), &f(), "TOKEN", false).unwrap_err();
    assert!(e.to_string().contains("keyring"));
    assert_eq!(m.env_of(&s()).len(), 1);
    assert_eq!(l.get(&s(), "TOKEN").unwrap().as_deref(), Some("v"));
    assert!(m.env_of(&f()).is_empty());
}
