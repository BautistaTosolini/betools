//! Despachador de canales: `invoke` equivale a los `ipcMain.handle` y `send` a los `ipcMain.on` de
//! src/main/index.ts, con los mismos nombres, orden de argumentos y JSON de respuesta.

use crate::app::{block_on, App, Inner};
use crate::docs::read_doc;
use crate::util::{clean_extra, js_string, js_trim, lock};
use betools_pty::SHELL_PREFIX;
use betools_store::{FolderPatch, SettingsPatch};
use betools_types::{EnvScope, EnvSource, EnvVarMeta, Folder, FolderSuggestion, Session};
use regex::Regex;
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, OnceLock};

/// Canales de `ipcMain.handle` (los que devuelven una promesa a la interfaz).
pub const INVOKE_CHANNELS: &[&str] = &[
    "sessions:list", "sessions:create", "sessions:setTitle", "folders:create", "folders:update", "folders:move",
    "folders:suggestExtra", "folders:delete", "env:list", "env:layers", "env:set", "env:delete", "env:moveTargets",
    "env:move", "env:test", "env:awsProfiles", "env:secureStorage", "sessions:restart", "sessions:pendingRestart",
    "conversation:get", "shell:openExternal", "sessions:running", "folders:suggest", "sessions:discover",
    "sessions:import", "sessions:close", "sessions:rename", "sessions:select", "usage:get", "clipboard:read",
    "clipboard:write", "settings:get", "settings:update", "slash:list", "doc:read", "doc:watch", "doc:unwatch",
    "artifacts:list", "artifacts:open", "artifacts:reveal", "dialog:pickFolder", "shell:run", "folders:setCommands",
];

/// Canales de `ipcMain.on` (sin respuesta).
pub const SEND_CHANNELS: &[&str] = &["pty:attach", "pty:restart", "pty:input", "pty:resize"];

/// Eventos que la lógica emite hacia la interfaz (`webContents.send`).
pub const EVENT_CHANNELS: &[&str] = &[
    "pty:data", "pty:exit", "pty:reset", "session:status", "session:title", "session:meta", "session:pendingRestart",
    "usage:limits", "usage:daily", "artifacts:changed", "conversation:changed", "doc:changed", "ui:select",
];

type R = Result<Value, String>;

// Argumentos posicionales de un canal.
struct Args<'a> {
    channel: &'a str,
    v: Vec<Value>,
}

impl Args<'_> {
    fn bad(&self, i: usize) -> String {
        format!("Invalid argument {} for {}", i + 1, self.channel)
    }
    fn get(&self, i: usize) -> Option<&Value> {
        self.v.get(i).filter(|v| !v.is_null())
    }
    fn str(&self, i: usize) -> Result<&str, String> {
        self.get(i).and_then(Value::as_str).ok_or_else(|| self.bad(i))
    }
    fn opt_str(&self, i: usize) -> Option<&str> {
        self.get(i).and_then(Value::as_str)
    }
    fn u16(&self, i: usize) -> Result<u16, String> {
        let n = self.get(i).and_then(Value::as_f64).ok_or_else(|| self.bad(i))?;
        Ok(n.clamp(0.0, f64::from(u16::MAX)) as u16)
    }
    fn truthy(&self, i: usize) -> bool {
        match self.v.get(i) {
            None | Some(Value::Null) | Some(Value::Bool(false)) => false,
            Some(Value::String(s)) => !s.is_empty(),
            Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
            Some(_) => true,
        }
    }
    fn parse<T: DeserializeOwned>(&self, i: usize) -> Result<T, String> {
        serde_json::from_value(self.get(i).cloned().ok_or_else(|| self.bad(i))?).map_err(|_| self.bad(i))
    }
}

fn to<T: serde::Serialize>(v: T) -> R {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn assert_dir(path: &str) -> Result<(), String> {
    if Path::new(path).is_dir() {
        Ok(())
    } else {
        Err(format!("Folder not found: {path}"))
    }
}

fn is_shell(key: &str) -> bool {
    key.starts_with(SHELL_PREFIX)
}

fn external_url_ok(url: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(https?:|mailto:)").unwrap()).is_match(url)
}

impl App {
    /// Equivale a `ipcMain.handle(channel, ...)`. Bloquea (diálogos, AWS, probe de Claude): desde un
    /// contexto async hay que llamarlo en un hilo de bloqueo. El error es el `message` de la excepción.
    pub fn invoke(&self, channel: &str, args: Vec<Value>) -> Result<Value, String> {
        self.0.invoke(channel, Args { channel, v: args })
    }

    /// Equivale a `ipcMain.on(channel, ...)`: sin respuesta.
    pub fn send(&self, channel: &str, args: Vec<Value>) -> Result<(), String> {
        self.0.send(channel, Args { channel, v: args })
    }
}

impl Inner {
    fn add_session(&self, session: Session) -> Result<Session, String> {
        lock(&self.store).add(session.clone()).map_err(|e| e.to_string())?;
        self.watcher.watch(&session);
        self.titles.watch(&session.id);
        // Las sesiones importadas ya pueden tener título (Warp, /rename o ai-title): se avisa enseguida.
        self.emit_title(&session.id);
        Ok(session)
    }

    fn new_session(id: String, name: &str, cwd: &str) -> Session {
        let now = betools_store::now_iso();
        Session { id, name: Self::name_or_base(name, cwd), cwd: cwd.into(), created_at: now.clone(), last_active_at: now, env: None }
    }

    // Paths adicionales sugeridos a partir de tus sesiones: cwd con ".../clients/<nombre>".
    fn suggest_extra_paths(&self, name: &str, taken: &[String]) -> Vec<String> {
        let n = js_trim(name).to_lowercase();
        if n.is_empty() {
            return vec![];
        }
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"^(.*/clients/([^/]+))(/|$)").unwrap());
        let mut out: Vec<String> = Vec::new();
        for s in betools_store::discover_sessions_limit(&HashSet::new(), 2000) {
            if let Some(m) = re.captures(&s.cwd) {
                if m[2].to_lowercase() == n && !out.contains(&m[1].to_string()) {
                    out.push(m[1].to_string());
                }
            }
        }
        out.retain(|p| !taken.contains(p));
        // Orden por unidades UTF-16, como el sort por defecto de JS.
        out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        out
    }

    // Sugerencias para carpetas nuevas: ~/workdir/<área>/clients/<cliente>.
    fn suggest_folders(&self) -> Vec<FolderSuggestion> {
        let root = betools_store::home_dir().join("workdir");
        let taken: HashSet<String> = self.state().folders.into_iter().map(|f| f.path).collect();
        // readdir de Node ordena por nombre; los ocultos y lo que no es carpeta (sin seguir enlaces) se descartan.
        let dirs = |p: &Path| -> Vec<String> {
            let Ok(rd) = std::fs::read_dir(p) else { return vec![] };
            let mut v: Vec<_> = rd.flatten().filter(|d| d.file_type().is_ok_and(|t| t.is_dir())).map(|d| d.file_name()).collect();
            v.sort();
            v.into_iter().filter_map(|n| n.into_string().ok()).filter(|n| !n.starts_with('.')).collect()
        };
        let mut out = Vec::new();
        for area in dirs(&root) {
            let clients = root.join(&area).join("clients");
            for client in dirs(&clients) {
                if client == "archived" {
                    continue;
                }
                let path = clients.join(&client).to_string_lossy().into_owned();
                if !taken.contains(&path) {
                    out.push(FolderSuggestion { name: client, path });
                }
            }
        }
        out
    }

    fn session_of(&self, key: &str) -> Option<Session> {
        self.find_session(key.strip_prefix(SHELL_PREFIX).unwrap_or(key))
    }

    fn invoke(self: &Arc<Self>, channel: &str, a: Args) -> R {
        match channel {
            "sessions:list" => {
                let st = self.state();
                let (mut status, mut titles) = (Map::new(), Map::new());
                for s in &st.sessions {
                    status.insert(s.id.clone(), to(self.status.get(&s.id))?);
                    titles.insert(s.id.clone(), json!(self.display_title(&s.id)));
                }
                Ok(json!({ "folders": st.folders, "sessions": st.sessions, "selectedId": st.selected_id, "status": status, "titles": titles }))
            }
            // title: "<TICKET> <resumen>" opcional; se guarda en ~/.claude/tab-titles como hace el script de Warp.
            "sessions:create" => {
                let (cwd, name) = (a.str(0)?, a.str(1)?);
                assert_dir(cwd)?;
                let session = self.add_session(Self::new_session(uuid::Uuid::new_v4().to_string(), name, cwd))?;
                if let Some(title) = a.opt_str(2).filter(|t| !js_trim(t).is_empty()) {
                    self.titles.set(&session.id, title).map_err(|e| e.to_string())?;
                }
                to(session)
            }
            "sessions:setTitle" => {
                let (id, title) = (a.str(0)?, a.str(1)?);
                if self.find_session(id).is_some() {
                    self.titles.set(id, title).map_err(|e| e.to_string())?;
                }
                Ok(Value::Null)
            }
            "folders:create" => {
                let f = a.get(0).ok_or_else(|| a.bad(0))?;
                let text = |k: &str| f.get(k).and_then(Value::as_str);
                let path = text("path").ok_or_else(|| a.bad(0))?;
                assert_dir(path)?;
                let extra: Vec<String> = f.get("extraPaths").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
                let folder = Folder {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: Self::name_or_base(text("name").unwrap_or(""), path),
                    color: text("color").ok_or_else(|| a.bad(0))?.to_string(),
                    path: path.to_string(),
                    extra_paths: Some(clean_extra(&extra, Some(path))),
                    collapsed: None,
                    env: None,
                    commands: None,
                };
                lock(&self.store).add_folder(folder.clone()).map_err(|e| e.to_string())?;
                to(folder)
            }
            "folders:update" => {
                let id = a.str(0)?;
                let mut patch: FolderPatch = a.parse(1)?;
                if let Some(p) = patch.path.as_deref().filter(|p| !p.is_empty()) {
                    assert_dir(p)?;
                }
                if let Some(extra) = &patch.extra_paths {
                    patch.extra_paths = Some(clean_extra(extra, patch.path.as_deref()));
                }
                to(lock(&self.store).update_folder(id, patch).map_err(|e| e.to_string())?)
            }
            "folders:move" => {
                let delta = a.get(1).and_then(Value::as_f64).ok_or_else(|| a.bad(1))? as i32;
                lock(&self.store).move_folder(a.str(0)?, delta).map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "folders:suggestExtra" => {
                let taken: Vec<String> = a.parse(1)?;
                to(self.suggest_extra_paths(a.str(0)?, &taken))
            }
            "folders:delete" => {
                let id = a.str(0)?;
                self.secrets.delete_scope(&EnvScope { kind: betools_types::EnvScopeKind::Folder, id: id.into() }).map_err(|e| e.to_string())?;
                lock(&self.store).remove_folder(id).map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }

            // Variables de entorno. Ningún handler devuelve valores: solo nombre, origen y fecha.
            "env:list" => to(lock(&self.store).env_of(&a.parse::<EnvScope>(0)?)),
            "env:layers" => {
                let Some(session) = self.find_session(a.str(0)?) else { return Ok(json!([])) };
                let folders = self.state().folders;
                let layers: Vec<Value> = self
                    .env_layers(&session)
                    .into_iter()
                    .map(|l| {
                        let label = match l.scope.kind {
                            betools_types::EnvScopeKind::Folder => folders.iter().find(|f| f.id == l.scope.id).map(|f| f.name.clone()).unwrap_or_default(),
                            _ => "session".into(),
                        };
                        json!({ "scope": l.scope, "label": label, "vars": l.vars })
                    })
                    .collect();
                Ok(Value::Array(layers))
            }
            "env:set" => {
                let scope: EnvScope = a.parse(0)?;
                let name = a.str(1)?;
                betools_secrets::validate_name(name).map_err(|e| e.to_string())?;
                let src = crate::env::check_source(a.get(2).ok_or_else(|| a.bad(2))?)?;
                let source: EnvSource = serde_json::from_value(src).map_err(|e| e.to_string())?;
                if matches!(source, EnvSource::Local {}) {
                    // Reemplazar el origen sin valor nuevo no está permitido para "local": hace falta el valor.
                    let value = a.opt_str(3).filter(|v| !v.is_empty()).ok_or("Enter the value.")?;
                    self.secrets.set(&scope, name, value).map_err(|e| e.to_string())?;
                } else {
                    // Si antes era local, se borra el valor cifrado.
                    self.secrets.delete(&scope, name).map_err(|e| e.to_string())?;
                }
                let meta = EnvVarMeta { name: name.into(), source, updated_at: betools_store::now_iso() };
                lock(&self.store).set_env(&scope, meta).map_err(|e| e.to_string())?;
                self.env_changed(&scope);
                Ok(Value::Null)
            }
            "env:delete" => {
                let (scope, name): (EnvScope, _) = (a.parse(0)?, a.str(1)?);
                self.secrets.delete(&scope, name).map_err(|e| e.to_string())?;
                lock(&self.store).delete_env(&scope, name).map_err(|e| e.to_string())?;
                self.env_changed(&scope);
                Ok(Value::Null)
            }
            // Destinos a los que se puede mover una variable: de una sesión, su carpeta; de una carpeta,
            // sus sesiones. Solo esos pares, para no mover valores a ámbitos sin relación.
            "env:moveTargets" => Ok(Value::Array(self.env_move_targets(&a.parse::<EnvScope>(0)?))),
            "env:move" => {
                let (from, to_scope): (EnvScope, EnvScope) = (a.parse(0)?, a.parse(1)?);
                let allowed = self.env_move_targets(&from).iter().any(|t| t["scope"] == json!(to_scope));
                if !allowed {
                    return Err("The variable can only move between a session and its folder.".into());
                }
                self.move_env(&from, &to_scope, a.str(2)?, a.truthy(3))?;
                self.env_changed(&from);
                self.env_changed(&to_scope);
                Ok(Value::Null)
            }
            // Prueba una referencia de AWS: solo informa si se pudo leer y el largo, nunca el valor.
            "env:test" => {
                let src = crate::env::check_source(a.get(0).ok_or_else(|| a.bad(0))?)?;
                let source: EnvSource = serde_json::from_value(src).map_err(|e| e.to_string())?;
                let v = block_on(|| async { betools_secrets::resolve_ref(&source).await })?.map_err(|e| e.to_string())?;
                // `length` de JS cuenta unidades UTF-16.
                Ok(json!({ "ok": true, "length": v.encode_utf16().count() }))
            }
            "env:awsProfiles" => to(betools_secrets::aws_profiles()),
            "env:secureStorage" => Ok(match self.secrets.assert_secure_backend() {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "reason": e.to_string() }),
            }),
            // Reinicia el proceso de la sesión para que tome las variables nuevas (retoma con --resume).
            "sessions:restart" => {
                let id = a.str(0)?;
                self.set_pending(id, false);
                self.restart_now(id);
                Ok(Value::Null)
            }
            "sessions:pendingRestart" => to(lock(&self.pending).clone()),
            "conversation:get" => to(self.watcher.conversation(a.str(0)?)),
            // Links de la vista Rendered: solo http(s) y mailto, en el navegador del sistema.
            "shell:openExternal" => {
                let url = a.str(0)?;
                if external_url_ok(url) {
                    self.host.open_external(url)?;
                }
                Ok(Value::Null)
            }
            "sessions:running" => Ok(json!(self.ptys.is_running(a.str(0)?))),
            "folders:suggest" => to(self.suggest_folders()),
            "sessions:discover" => {
                let ids = self.state().sessions.into_iter().map(|s| s.id).collect();
                to(betools_store::discover_sessions(&ids))
            }
            "sessions:import" => {
                let (id, cwd, name) = (a.str(0)?, a.str(1)?, a.str(2)?);
                if self.find_session(id).is_some() {
                    return Err("The session is already in the list".into());
                }
                if !Path::new(cwd).exists() {
                    return Err(format!("The session folder no longer exists: {cwd}"));
                }
                to(self.add_session(Self::new_session(id.into(), name, cwd))?)
            }
            "sessions:close" => {
                let id = a.str(0)?;
                self.ptys.kill(id);
                self.shells.kill(&format!("{SHELL_PREFIX}{id}"));
                self.secrets.delete_scope(&EnvScope { kind: betools_types::EnvScopeKind::Session, id: id.into() }).map_err(|e| e.to_string())?;
                self.watcher.unwatch(id);
                self.titles.unwatch(id);
                self.status.forget(id);
                self.lines.forget(id);
                lock(&self.restart_timers).remove(id);
                lock(&self.pending).retain(|p| p != id);
                lock(&self.store).remove(id).map_err(|e| e.to_string())?;
                self.update_tray();
                Ok(Value::Null)
            }
            "sessions:rename" => {
                lock(&self.store).rename(a.str(0)?, js_trim(a.str(1)?)).map_err(|e| e.to_string())?;
                self.update_tray();
                Ok(Value::Null)
            }
            "sessions:select" => {
                let id = a.str(0)?;
                lock(&self.store).select(id).map_err(|e| e.to_string())?;
                self.status.seen(id);
                Ok(Value::Null)
            }
            "usage:get" => {
                let mut meta = Map::new();
                for s in self.state().sessions {
                    meta.insert(s.id.clone(), to(self.meta_of(&s.id))?);
                }
                Ok(json!({ "limits": self.lines.get_limits(), "daily": self.daily.get(), "meta": meta }))
            }
            "clipboard:read" => self.host.clipboard_read().map(Value::String),
            "clipboard:write" => {
                self.host.clipboard_write(&js_string(a.v.first().unwrap_or(&Value::Null)))?;
                Ok(Value::Null)
            }
            "settings:get" => to(lock(&self.settings).get()),
            "settings:update" => {
                let patch: SettingsPatch = a.parse(0)?;
                to(lock(&self.settings).update(patch).map_err(|e| e.to_string())?)
            }
            "slash:list" => match self.find_session(a.str(0)?) {
                Some(s) => to(self.slash.list_full(&s.cwd, a.truthy(1))),
                None => Ok(json!([])),
            },
            "doc:read" => read_doc(a.str(0)?),
            "doc:watch" => {
                self.docs.watch(&self.host, a.str(0)?);
                Ok(Value::Null)
            }
            "doc:unwatch" => {
                self.docs.unwatch(a.str(0)?);
                Ok(Value::Null)
            }
            "artifacts:list" => to(self.watcher.list(a.str(0)?)),
            "artifacts:open" => {
                self.host.open_file(&self.user_data, a.str(0)?)?;
                Ok(Value::Null)
            }
            "artifacts:reveal" => {
                self.host.reveal_file(a.str(0)?);
                Ok(Value::Null)
            }
            "dialog:pickFolder" => Ok(json!(self.host.pick_folder())),
            "shell:run" => {
                let (id, command) = (a.str(0)?, a.str(1)?);
                let command = js_trim(command);
                if let Some(session) = self.find_session(id).filter(|_| !command.is_empty()) {
                    self.shells.run(&session, command);
                }
                Ok(Value::Null)
            }
            "folders:setCommands" => {
                let folder_id = a.str(0)?;
                let list = a.get(1).and_then(Value::as_array).ok_or_else(|| a.bad(1))?;
                let text = |c: &Value, k: &str| c.get(k).and_then(Value::as_str).map(js_trim).unwrap_or("").to_string();
                let commands: Vec<betools_types::SavedCommand> = list
                    .iter()
                    .map(|c| betools_types::SavedCommand {
                        id: Some(text(c, "id")).filter(|i| !i.is_empty()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                        name: text(c, "name"),
                        command: text(c, "command"),
                    })
                    .filter(|c| !c.command.is_empty())
                    .collect();
                let patch = FolderPatch { commands: Some(commands), ..Default::default() };
                to(lock(&self.store).update_folder(folder_id, patch).map_err(|e| e.to_string())?)
            }
            _ => Err(format!("Unknown channel: {channel}")),
        }
    }

    // attach: lanza el pty si no corre; si ya corría, reenvía lo acumulado como si fuera salida nueva.
    // Va por el mismo canal pty:data para mantener el orden con la salida posterior.
    // Las claves "shell:<id>" son la terminal de la sesión; el resto, el proceso de Claude.
    fn send(&self, channel: &str, a: Args) -> Result<(), String> {
        match channel {
            "pty:attach" => {
                let (key, cols, rows) = (a.str(0)?, a.u16(1)?, a.u16(2)?);
                let Some(session) = self.session_of(key) else { return Ok(()) };
                let deliver = |buf: &str| {
                    if !buf.is_empty() {
                        self.emit("pty:data", vec![json!(key), json!(buf)]);
                    }
                };
                if is_shell(key) {
                    self.shells.attach_with(&session, cols, rows, deliver);
                } else {
                    self.ptys.attach_with(&session, cols, rows, deliver);
                }
            }
            "pty:restart" => {
                let (key, cols, rows) = (a.str(0)?, a.u16(1)?, a.u16(2)?);
                let Some(session) = self.session_of(key) else { return Ok(()) };
                if is_shell(key) {
                    self.shells.kill(key);
                    self.shells.attach(&session, cols, rows);
                } else {
                    self.ptys.kill(key);
                    self.ptys.attach(&session, cols, rows);
                }
            }
            "pty:input" => {
                let (key, data) = (a.str(0)?, a.str(1)?);
                if is_shell(key) { self.shells.write(key, data) } else { self.ptys.write(key, data) }
            }
            "pty:resize" => {
                let (key, cols, rows) = (a.str(0)?, a.u16(1)?, a.u16(2)?);
                if is_shell(key) { self.shells.resize(key, cols, rows) } else { self.ptys.resize(key, cols, rows) }
            }
            _ => return Err(format!("Unknown channel: {channel}")),
        }
        Ok(())
    }
}

