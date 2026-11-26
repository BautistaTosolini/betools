//! Secretos y variables de entorno: equivalente a src/main/secrets.ts, src/main/env-core.ts y
//! web/server/master-secrets.ts.

mod env_core;
mod local;
mod master;
pub mod os_crypt;

use betools_types::EnvScope;
use std::{fs, io::Write, os::unix::fs::PermissionsExt, path::Path};

pub use env_core::{
    aws_profiles, aws_profiles_in, move_env, resolve_env, resolve_env_with, resolve_ref, resolve_ref_with,
    validate_name, EnvExistsError, EnvLayer, EnvMetaStore, LocalStore, LocalStoreRW, ResolvedEnv,
};
pub use local::{Keyring, LocalSecrets, SecretServiceKeyring};
pub use master::{read_master_key, MasterKeySecrets};

/// Clave de un valor dentro de secrets.json: `kind:id:name`.
pub(crate) fn key_of(scope: &EnvScope, name: &str) -> String {
    let kind = match scope.kind {
        betools_types::EnvScopeKind::Folder => "folder",
        betools_types::EnvScopeKind::Session => "session",
    };
    format!("{kind}:{}:{name}", scope.id)
}

pub(crate) fn scope_prefix(scope: &EnvScope) -> String {
    key_of(scope, "")
}

/// Escritura atómica con permisos 0600 (archivo temporal + rename), como el `save()` de TS.
pub(crate) fn save_private(file: &Path, json: &str) -> anyhow::Result<()> {
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(json.as_bytes())?;
    }
    fs::rename(&tmp, file)?;
    fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// JSON con sangría de 2 espacios, igual que `JSON.stringify(x, null, 2)`.
pub(crate) fn pretty<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string_pretty(v).expect("serializable")
}
