//! Variables de entorno: capas por sesión, destinos de movimiento, validación de orígenes y reinicio
//! automático al cambiar variables.

use crate::app::{after, Inner};
use crate::util::{js_trim, lock};
use anyhow::anyhow;
use betools_secrets::{EnvLayer, EnvMetaStore, LocalStore, LocalStoreRW};
use betools_store::SessionStore;
use betools_types::{EnvScope, EnvScopeKind, EnvVarMeta, Folder, Session, SessionStatus};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const RESTART_DEBOUNCE: Duration = Duration::from_millis(1500);

fn scope_is(a: &EnvScope, kind: EnvScopeKind, id: &str) -> bool {
    a.kind == kind && a.id == id
}

/// Valida una referencia de AWS antes de guardarla (sin shell; perfil y región obligatorios donde aplica).
/// Trabaja sobre el JSON crudo como el TS: los mensajes no dependen de la forma exacta del valor.
pub(crate) fn check_source(src: &Value) -> Result<Value, String> {
    let text = |k: &str| src.get(k).and_then(Value::as_str);
    let kind = text("kind");
    if kind == Some("local") {
        return Ok(json!({ "kind": "local" }));
    }
    if kind == Some("plain") {
        return match src.get("value") {
            Some(Value::String(v)) => Ok(json!({ "kind": "plain", "value": v })),
            _ => Err("Enter the value.".into()),
        };
    }
    let profile = text("profile").map(js_trim).filter(|p| !p.is_empty()).ok_or("Choose the AWS profile.")?;
    let region = text("region").map(js_trim).filter(|r| !r.is_empty());
    let mut out = json!({ "kind": "", "profile": profile });
    if let Some(r) = region {
        out["region"] = json!(r);
    }
    if kind == Some("aws-sm") {
        let secret = text("secretId").map(js_trim).filter(|s| !s.is_empty()).ok_or("Enter the secret name or ARN.")?;
        out["kind"] = json!("aws-sm");
        out["secretId"] = json!(secret);
        if let Some(k) = text("jsonKey").map(js_trim).filter(|k| !k.is_empty()) {
            out["jsonKey"] = json!(k);
        }
        return Ok(out);
    }
    // Cualquier otro tipo se trata como parámetro SSM, igual que el TS.
    let name = text("name").map(js_trim).filter(|n| !n.is_empty()).ok_or("Enter the parameter name.")?;
    out["kind"] = json!("aws-ssm");
    out["name"] = json!(name);
    Ok(out)
}

// Adaptadores para `move_env`: el store y los secretos devuelven errores y el crate de secretos
// espera operaciones que no fallan. Tras el primer error no se borra nada del origen.
struct MetaAdapter<'a> {
    store: &'a mut SessionStore,
    err: &'a Mutex<Option<String>>,
}

impl MetaAdapter<'_> {
    fn note(&self, r: betools_store::Result<()>) {
        if let Err(e) = r {
            lock(self.err).get_or_insert(e.to_string());
        }
    }
}

impl EnvMetaStore for MetaAdapter<'_> {
    fn env_of(&self, scope: &EnvScope) -> Vec<EnvVarMeta> {
        self.store.env_of(scope)
    }
    fn set_env(&mut self, scope: &EnvScope, meta: EnvVarMeta) {
        let r = self.store.set_env(scope, meta);
        self.note(r);
    }
    fn delete_env(&mut self, scope: &EnvScope, name: &str) {
        let r = self.store.delete_env(scope, name);
        self.note(r);
    }
}

struct LocalGuard<'a> {
    inner: &'a betools_secrets::LocalSecrets,
    err: &'a Mutex<Option<String>>,
}

impl LocalStore for LocalGuard<'_> {
    fn get(&self, scope: &EnvScope, name: &str) -> anyhow::Result<Option<String>> {
        self.inner.get(scope, name)
    }
}

impl LocalStoreRW for LocalGuard<'_> {
    fn set(&self, scope: &EnvScope, name: &str, value: &str) -> anyhow::Result<()> {
        self.inner.set(scope, name, value)
    }
    fn delete(&self, scope: &EnvScope, name: &str) -> anyhow::Result<()> {
        // Si falló guardar el destino, el valor del origen no se toca: queda duplicado, nunca perdido.
        if let Some(e) = lock(self.err).clone() {
            return Err(anyhow!(e));
        }
        self.inner.delete(scope, name)
    }
}

impl Inner {
    /// Capas de variables de una sesión: primero las de su carpeta, después las propias (pisan).
    /// La carpeta se calcula igual que en la interfaz: el path (principal o adicional) más largo.
    pub(crate) fn env_layers(&self, session: &Session) -> Vec<EnvLayer> {
        let store = lock(&self.store);
        let mut folder: Option<Folder> = None;
        let mut best: i64 = -1;
        for f in &store.get().folders {
            for p in std::iter::once(&f.path).chain(f.extra_paths.iter().flatten()) {
                let base = p.trim_end_matches('/');
                let inside = session.cwd == base || session.cwd.strip_prefix(base).is_some_and(|r| r.starts_with('/'));
                let len = base.encode_utf16().count() as i64;
                if inside && len > best {
                    folder = Some(f.clone());
                    best = len;
                }
            }
        }
        let mut layers = Vec::new();
        if let Some(f) = folder {
            let scope = EnvScope { kind: EnvScopeKind::Folder, id: f.id };
            layers.push(EnvLayer { vars: store.env_of(&scope), scope });
        }
        let scope = EnvScope { kind: EnvScopeKind::Session, id: session.id.clone() };
        layers.push(EnvLayer { vars: store.env_of(&scope), scope });
        layers
    }

    /// Sesiones que usan las variables de un ámbito: la sesión misma, o las de la carpeta.
    pub(crate) fn sessions_using(&self, scope: &EnvScope) -> Vec<Session> {
        let sessions = self.state().sessions;
        match scope.kind {
            EnvScopeKind::Session => sessions.into_iter().filter(|s| s.id == scope.id).collect(),
            EnvScopeKind::Folder => sessions
                .into_iter()
                .filter(|s| self.env_layers(s).iter().any(|l| scope_is(&l.scope, EnvScopeKind::Folder, &scope.id)))
                .collect(),
        }
    }

    pub(crate) fn env_move_targets(&self, scope: &EnvScope) -> Vec<Value> {
        if scope.kind == EnvScopeKind::Session {
            let Some(session) = self.find_session(&scope.id) else { return vec![] };
            let Some(layer) = self.env_layers(&session).into_iter().find(|l| l.scope.kind == EnvScopeKind::Folder) else {
                return vec![];
            };
            let name = self.state().folders.into_iter().find(|f| f.id == layer.scope.id).map(|f| f.name).unwrap_or_default();
            return vec![json!({ "scope": layer.scope, "label": format!("folder {name}") })];
        }
        self.sessions_using(scope)
            .into_iter()
            .map(|s| json!({ "scope": { "kind": "session", "id": s.id }, "label": format!("session {}", s.name) }))
            .collect()
    }

    pub(crate) fn move_env(&self, from: &EnvScope, to: &EnvScope, name: &str, overwrite: bool) -> Result<(), String> {
        let err = Mutex::new(None);
        let mut store = lock(&self.store);
        let result = {
            let mut meta = MetaAdapter { store: &mut store, err: &err };
            betools_secrets::move_env(&mut meta, &LocalGuard { inner: &self.secrets, err: &err }, from, to, name, overwrite)
        };
        drop(store);
        match result {
            // El renderer distingue este caso por el prefijo para ofrecer reemplazar.
            Err(e) if e.downcast_ref::<betools_secrets::EnvExistsError>().is_some() => Err(format!("EXISTS: {e}")),
            Err(e) => Err(e.to_string()),
            Ok(()) => lock(&err).take().map_or(Ok(()), Err),
        }
    }

    // Reinicio automático al cambiar variables. Si la sesión está trabajando o esperando una respuesta tuya
    // (permiso, pregunta, selección), se espera a que termine. Debounce para que agregar varias variables
    // seguidas reinicie una sola vez.
    pub(crate) fn env_changed(self: &Arc<Self>, scope: &EnvScope) {
        for s in self.sessions_using(scope) {
            // Sin proceso no hay nada que reiniciar: toma las variables al arrancar.
            if !self.ptys.is_running(&s.id) {
                continue;
            }
            let token = self.next_timer();
            lock(&self.restart_timers).insert(s.id.clone(), token);
            let (inner, id) = (self.clone(), s.id);
            after(RESTART_DEBOUNCE, move || {
                let mine = {
                    let mut t = lock(&inner.restart_timers);
                    let mine = t.get(&id) == Some(&token);
                    if mine {
                        t.remove(&id);
                    }
                    mine
                };
                if mine {
                    inner.apply_restart(&id);
                }
            });
        }
    }

    pub(crate) fn restart_now(&self, id: &str) {
        let Some(session) = self.find_session(id) else { return };
        let (cols, rows) = self.ptys.size(id).unwrap_or((120, 40));
        self.ptys.kill(id);
        self.emit("pty:reset", vec![json!(id)]);
        self.ptys.attach(&session, cols, rows);
    }

    pub(crate) fn set_pending(&self, id: &str, on: bool) {
        {
            let mut p = lock(&self.pending);
            let has = p.iter().any(|x| x == id);
            if on == has {
                return;
            }
            if on {
                p.push(id.to_string());
            } else {
                p.retain(|x| x != id);
            }
        }
        self.emit("session:pendingRestart", vec![json!(id), json!(on)]);
    }

    pub(crate) fn apply_restart(&self, id: &str) {
        if !self.ptys.is_running(id) {
            return self.set_pending(id, false);
        }
        if matches!(self.status.get(id), SessionStatus::Working | SessionStatus::Waiting) {
            return self.set_pending(id, true);
        }
        self.set_pending(id, false);
        self.restart_now(id);
    }
}
