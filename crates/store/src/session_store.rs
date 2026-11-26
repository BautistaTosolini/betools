use crate::util::now_iso;
use crate::{Error, Result};
use betools_types::{EnvScope, EnvScopeKind, EnvVarMeta, Folder, Session, StoreState};
use serde::Deserialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

/// `Partial<Omit<Folder, 'id'>>`: solo se pisan los campos presentes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FolderPatch {
    pub name: Option<String>,
    pub color: Option<String>,
    pub path: Option<String>,
    pub extra_paths: Option<Vec<String>>,
    pub collapsed: Option<bool>,
    pub env: Option<Vec<EnvVarMeta>>,
    pub commands: Option<Vec<betools_types::SavedCommand>>,
}

// Archivo parcial: lo que falte se completa como hacía `raw.folders ?? []`.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawState {
    folders: Vec<Folder>,
    sessions: Vec<Session>,
    selected_id: Option<String>,
}

/// Persiste la lista de sesiones en `<userData>/sessions.json`.
/// Una sesión solo se elimina cuando el usuario la cierra desde la UI.
pub struct SessionStore {
    file: PathBuf,
    state: StoreState,
}

impl SessionStore {
    pub fn new(user_data_dir: &Path) -> Result<Self> {
        fs::create_dir_all(user_data_dir)?;
        let file = user_data_dir.join("sessions.json");
        // Primer arranque o archivo ilegible: se empieza vacío.
        let text = fs::read_to_string(&file).ok();
        let raw: RawState = match text.as_deref().map(serde_json::from_str::<RawState>) {
            Some(Ok(r)) => r,
            Some(Err(_)) => {
                // Serde es más estricto que el JS original con campos mal tipados: antes de que el
                // próximo guardado pise el archivo, se deja una copia para no perder datos.
                let bak = user_data_dir.join("sessions.json.bak");
                if !bak.exists() {
                    let _ = fs::copy(&file, &bak);
                }
                RawState::default()
            }
            None => RawState::default(),
        };
        let state = StoreState { folders: raw.folders, sessions: raw.sessions, selected_id: raw.selected_id };
        Ok(Self { file, state })
    }

    pub fn get(&self) -> StoreState {
        self.state.clone()
    }

    pub fn find(&self, id: &str) -> Option<&Session> {
        self.state.sessions.iter().find(|s| s.id == id)
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut Session> {
        self.state.sessions.iter_mut().find(|s| s.id == id)
    }

    pub fn add(&mut self, session: Session) -> Result<()> {
        self.state.selected_id = Some(session.id.clone());
        self.state.sessions.push(session);
        self.save()
    }

    pub fn remove(&mut self, id: &str) -> Result<()> {
        let Some(idx) = self.state.sessions.iter().position(|s| s.id == id) else { return Ok(()) };
        self.state.sessions.remove(idx);
        if self.state.selected_id.as_deref() == Some(id) {
            let list = &self.state.sessions;
            self.state.selected_id = list.get(idx.min(list.len().saturating_sub(1))).map(|s| s.id.clone());
        }
        self.save()
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<()> {
        let Some(s) = self.find_mut(id) else { return Ok(()) };
        s.name = name.to_string();
        self.save()
    }

    pub fn select(&mut self, id: &str) -> Result<()> {
        let Some(s) = self.find_mut(id) else { return Ok(()) };
        s.last_active_at = now_iso();
        self.state.selected_id = Some(id.to_string());
        self.save()
    }

    pub fn add_folder(&mut self, folder: Folder) -> Result<()> {
        self.state.folders.push(folder);
        self.save()
    }

    pub fn update_folder(&mut self, id: &str, patch: FolderPatch) -> Result<Option<Folder>> {
        let Some(f) = self.state.folders.iter_mut().find(|x| x.id == id) else { return Ok(None) };
        if let Some(v) = patch.name {
            f.name = v;
        }
        if let Some(v) = patch.color {
            f.color = v;
        }
        if let Some(v) = patch.path {
            f.path = v;
        }
        f.extra_paths = patch.extra_paths.or(f.extra_paths.take());
        f.collapsed = patch.collapsed.or(f.collapsed.take());
        f.env = patch.env.or(f.env.take());
        f.commands = patch.commands.or(f.commands.take());
        let out = f.clone();
        self.save()?;
        Ok(Some(out))
    }

    /// `delta` es -1 o 1; fuera de rango o con id desconocido no hace nada.
    pub fn move_folder(&mut self, id: &str, delta: i32) -> Result<()> {
        let list = &mut self.state.folders;
        let Some(i) = list.iter().position(|f| f.id == id) else { return Ok(()) };
        let j = i as i64 + i64::from(delta);
        if j < 0 || j >= list.len() as i64 {
            return Ok(());
        }
        list.swap(i, j as usize);
        self.save()
    }

    /// Borrar una carpeta no cierra sus sesiones: pasan a "Sin carpeta".
    pub fn remove_folder(&mut self, id: &str) -> Result<()> {
        self.state.folders.retain(|f| f.id != id);
        self.save()
    }

    pub fn env_of(&self, scope: &EnvScope) -> Vec<EnvVarMeta> {
        let env = match scope.kind {
            EnvScopeKind::Folder => self.state.folders.iter().find(|f| f.id == scope.id).and_then(|f| f.env.as_ref()),
            EnvScopeKind::Session => self.find(&scope.id).and_then(|s| s.env.as_ref()),
        };
        env.cloned().unwrap_or_default()
    }

    // El campo `env` del dueño (carpeta o sesión), o None si no existe.
    fn env_slot(&mut self, scope: &EnvScope) -> Option<&mut Option<Vec<EnvVarMeta>>> {
        match scope.kind {
            EnvScopeKind::Folder => self.state.folders.iter_mut().find(|f| f.id == scope.id).map(|f| &mut f.env),
            EnvScopeKind::Session => self.find_mut(&scope.id).map(|s| &mut s.env),
        }
    }

    pub fn set_env(&mut self, scope: &EnvScope, meta: EnvVarMeta) -> Result<()> {
        let slot = self.env_slot(scope).ok_or_else(|| Error::Msg("Folder or session not found".into()))?;
        let mut list: Vec<EnvVarMeta> = slot.take().unwrap_or_default().into_iter().filter(|e| e.name != meta.name).collect();
        list.push(meta);
        list.sort_by(|a, b| locale_cmp(&a.name, &b.name));
        *slot = Some(list);
        self.save()
    }

    pub fn delete_env(&mut self, scope: &EnvScope, name: &str) -> Result<()> {
        let Some(Some(list)) = self.env_slot(scope) else { return Ok(()) };
        list.retain(|e| e.name != name);
        self.save()
    }

    // Escritura atómica: tmp + rename, para no corromper el archivo si se corta la luz.
    fn save(&self) -> Result<()> {
        let mut tmp = self.file.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, serde_json::to_string_pretty(&self.state)?)?;
        fs::rename(&tmp, &self.file)?;
        Ok(())
    }
}

// Aproxima String.prototype.localeCompare (ICU): puntuación < dígitos < letras, sin distinguir
// mayúsculas en el primer criterio, y a igualdad la minúscula va primero.
fn locale_cmp(a: &str, b: &str) -> Ordering {
    let key = |c: char| {
        let class = if c.is_alphabetic() { 2 } else if c.is_numeric() { 1 } else { 0 };
        (class, c.to_lowercase().next().unwrap_or(c))
    };
    a.chars()
        .map(key)
        .cmp(b.chars().map(key))
        .then_with(|| {
            let case = |s: &str| s.chars().map(|c| c.is_uppercase()).collect::<Vec<_>>();
            case(a).cmp(&case(b))
        })
        .then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use betools_types::EnvSource;

    fn session(id: &str) -> Session {
        Session {
            id: id.into(),
            name: format!("n-{id}"),
            cwd: "/tmp".into(),
            created_at: "2024-01-01T00:00:00.000Z".into(),
            last_active_at: "2024-01-01T00:00:00.000Z".into(),
            env: None,
        }
    }

    fn folder(id: &str) -> Folder {
        Folder { id: id.into(), name: id.into(), color: "#fff".into(), path: "/p".into(), extra_paths: None, collapsed: None, env: None, commands: None }
    }

    fn meta(name: &str) -> EnvVarMeta {
        EnvVarMeta { name: name.into(), source: EnvSource::Plain { value: "v".into() }, updated_at: "t".into() }
    }

    fn store() -> (tempfile::TempDir, SessionStore) {
        let d = tempfile::tempdir().unwrap();
        let s = SessionStore::new(d.path()).unwrap();
        (d, s)
    }

    fn reload(d: &tempfile::TempDir) -> SessionStore {
        SessionStore::new(d.path()).unwrap()
    }

    #[test]
    fn starts_empty_and_creates_the_dir() {
        let d = tempfile::tempdir().unwrap();
        let sub = d.path().join("a").join("b");
        let s = SessionStore::new(&sub).unwrap();
        assert!(sub.is_dir());
        assert_eq!(s.get(), StoreState { folders: vec![], sessions: vec![], selected_id: None });
    }

    #[test]
    fn corrupt_file_starts_empty_and_partial_file_is_completed() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("sessions.json"), "{no").unwrap();
        assert!(SessionStore::new(d.path()).unwrap().get().sessions.is_empty());
        fs::write(d.path().join("sessions.json"), r#"{"sessions":[{"id":"a","name":"A","cwd":"/","createdAt":"x","lastActiveAt":"y"}]}"#).unwrap();
        let st = SessionStore::new(d.path()).unwrap().get();
        assert_eq!(st.sessions.len(), 1);
        assert!(st.folders.is_empty());
        assert_eq!(st.selected_id, None);
    }

    #[test]
    fn unreadable_file_is_backed_up_before_being_overwritten() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("sessions.json"), r#"{"sessions":[{"id":"a"}]}"#).unwrap();
        let mut s = SessionStore::new(d.path()).unwrap();
        s.add(session("b")).unwrap();
        assert_eq!(fs::read_to_string(d.path().join("sessions.json.bak")).unwrap(), r#"{"sessions":[{"id":"a"}]}"#);
    }

    #[test]
    fn add_selects_and_persists_with_two_space_json() {
        let (d, mut s) = store();
        s.add(session("a")).unwrap();
        s.add(session("b")).unwrap();
        assert_eq!(s.get().selected_id.as_deref(), Some("b"));
        let text = fs::read_to_string(d.path().join("sessions.json")).unwrap();
        assert!(text.starts_with("{\n  \"folders\": []"));
        assert!(text.contains("\"selectedId\": \"b\""));
        assert!(!d.path().join("sessions.json.tmp").exists());
        assert_eq!(reload(&d).get(), s.get());
    }

    #[test]
    fn remove_moves_selection_to_the_neighbour() {
        let (_d, mut s) = store();
        for id in ["a", "b", "c"] {
            s.add(session(id)).unwrap();
        }
        s.select("b").unwrap();
        s.remove("b").unwrap();
        assert_eq!(s.get().selected_id.as_deref(), Some("c"));
        s.remove("c").unwrap();
        assert_eq!(s.get().selected_id.as_deref(), Some("a"));
        s.remove("zzz").unwrap();
        s.remove("a").unwrap();
        assert_eq!(s.get().selected_id, None);
    }

    #[test]
    fn remove_unselected_keeps_selection() {
        let (_d, mut s) = store();
        s.add(session("a")).unwrap();
        s.add(session("b")).unwrap();
        s.remove("a").unwrap();
        assert_eq!(s.get().selected_id.as_deref(), Some("b"));
    }

    #[test]
    fn rename_and_select() {
        let (d, mut s) = store();
        s.add(session("a")).unwrap();
        s.add(session("b")).unwrap();
        s.rename("a", "nuevo").unwrap();
        s.rename("nope", "x").unwrap();
        s.select("a").unwrap();
        s.select("nope").unwrap();
        let st = reload(&d).get();
        assert_eq!(st.selected_id.as_deref(), Some("a"));
        assert_eq!(st.sessions[0].name, "nuevo");
        assert_ne!(st.sessions[0].last_active_at, "2024-01-01T00:00:00.000Z");
        assert!(st.sessions[0].last_active_at.ends_with('Z'));
        assert_eq!(st.sessions[1].last_active_at, "2024-01-01T00:00:00.000Z");
    }

    #[test]
    fn folders_crud_move_and_patch() {
        let (d, mut s) = store();
        for id in ["f1", "f2", "f3"] {
            s.add_folder(folder(id)).unwrap();
        }
        s.move_folder("f1", -1).unwrap();
        s.move_folder("f3", 1).unwrap();
        s.move_folder("nope", 1).unwrap();
        s.move_folder("f1", 1).unwrap();
        let ids = |s: &SessionStore| s.get().folders.iter().map(|f| f.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&s), ["f2", "f1", "f3"]);

        let out = s.update_folder("f1", FolderPatch { name: Some("Uno".into()), collapsed: Some(true), ..Default::default() }).unwrap().unwrap();
        assert_eq!((out.name.as_str(), out.collapsed, out.color.as_str()), ("Uno", Some(true), "#fff"));
        assert!(s.update_folder("nope", FolderPatch::default()).unwrap().is_none());
        // Un parche sin el campo no lo borra.
        let out = s.update_folder("f1", FolderPatch { path: Some("/q".into()), ..Default::default() }).unwrap().unwrap();
        assert_eq!((out.collapsed, out.path.as_str()), (Some(true), "/q"));

        s.add(session("a")).unwrap();
        s.remove_folder("f2").unwrap();
        assert_eq!(ids(&reload(&d)), ["f1", "f3"]);
        assert_eq!(reload(&d).get().sessions.len(), 1);
    }

    #[test]
    fn patch_deserializes_from_ui_json() {
        let p: FolderPatch = serde_json::from_str(r#"{"extraPaths":["/a"],"collapsed":false}"#).unwrap();
        assert_eq!(p.extra_paths, Some(vec!["/a".to_string()]));
        assert_eq!(p.collapsed, Some(false));
        assert!(p.name.is_none());
    }

    #[test]
    fn env_set_replace_sort_delete_for_both_scopes() {
        let (d, mut s) = store();
        s.add_folder(folder("f")).unwrap();
        s.add(session("a")).unwrap();
        let fs_ = EnvScope { kind: EnvScopeKind::Folder, id: "f".into() };
        let ss = EnvScope { kind: EnvScopeKind::Session, id: "a".into() };
        for n in ["ZED", "ALPHA", "MID_1", "MID"] {
            s.set_env(&fs_, meta(n)).unwrap();
        }
        let names = |s: &SessionStore, sc: &EnvScope| s.env_of(sc).into_iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names(&s, &fs_), ["ALPHA", "MID", "MID_1", "ZED"]);
        let mut m = meta("ALPHA");
        m.updated_at = "new".into();
        s.set_env(&fs_, m).unwrap();
        assert_eq!(s.env_of(&fs_).len(), 4);
        assert_eq!(s.env_of(&fs_)[0].updated_at, "new");

        assert!(s.env_of(&ss).is_empty());
        s.set_env(&ss, meta("X")).unwrap();
        s.delete_env(&fs_, "MID").unwrap();
        s.delete_env(&fs_, "nope").unwrap();
        s.delete_env(&EnvScope { kind: EnvScopeKind::Folder, id: "zz".into() }, "X").unwrap();
        let r = reload(&d);
        assert_eq!(names(&r, &fs_), ["ALPHA", "MID_1", "ZED"]);
        assert_eq!(names(&r, &ss), ["X"]);
    }

    #[test]
    fn set_env_on_missing_owner_fails_with_the_original_message() {
        let (_d, mut s) = store();
        let err = s.set_env(&EnvScope { kind: EnvScopeKind::Session, id: "no".into() }, meta("A")).unwrap_err();
        assert_eq!(err.to_string(), "Folder or session not found");
    }

    #[test]
    fn env_of_returns_a_copy() {
        let (_d, mut s) = store();
        s.add(session("a")).unwrap();
        let sc = EnvScope { kind: EnvScopeKind::Session, id: "a".into() };
        s.set_env(&sc, meta("A")).unwrap();
        let mut copy = s.env_of(&sc);
        copy[0].name = "B".into();
        assert_eq!(s.env_of(&sc)[0].name, "A");
    }

    #[test]
    fn locale_order_like_icu() {
        let mut v = vec!["b", "B", "a", "A", "_x", "1", "ab", "Aa"];
        v.sort_by(|a, b| locale_cmp(a, b));
        assert_eq!(v, ["_x", "1", "a", "A", "Aa", "ab", "b", "B"]);
    }
}
