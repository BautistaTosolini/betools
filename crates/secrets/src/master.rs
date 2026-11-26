//! Secretos de la versión web (web/server/master-secrets.ts). En la Raspberry no hay llavero: los
//! valores "local" se cifran con AES-256-GCM usando una clave derivada (scrypt) de la clave maestra
//! que llega como Docker secret. Sin clave maestra no se guarda ningún valor cifrado.

use crate::{env_core::{LocalStore, LocalStoreRW}, key_of, pretty, save_private, scope_prefix};
use aes_gcm::{aead::{generic_array::GenericArray, Aead, KeyInit}, Aes256Gcm};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use betools_types::EnvScope;
use indexmap::IndexMap;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, sync::Mutex};

#[derive(Serialize, Deserialize)]
struct FileFormat {
    salt: String,
    values: IndexMap<String, String>, // "iv.tag.ciphertext" en base64
}

const NO_MASTER: &str =
    "No hay clave maestra (Docker secret clawhip_master_key): no se pueden guardar valores cifrados.";

pub struct MasterKeySecrets {
    file: PathBuf,
    data: Mutex<FileFormat>,
    key: Option<[u8; 32]>,
}

impl MasterKeySecrets {
    pub fn new(data_dir: &Path, master: Option<&str>) -> Self {
        let file = data_dir.join("secrets.json");
        let data = fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str::<FileFormat>(&s).ok()).unwrap_or_else(|| {
            let mut salt = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut salt);
            FileFormat { salt: B64.encode(salt), values: IndexMap::new() }
        });
        // scrypt de Node: N=16384, r=8, p=1.
        let key = master.filter(|m| !m.is_empty()).map(|m| {
            let salt = B64.decode(&data.salt).unwrap_or_default();
            let mut k = [0u8; 32];
            let params = scrypt::Params::new(14, 8, 1, 32).expect("params válidos");
            scrypt::scrypt(m.as_bytes(), &salt, &params, &mut k).expect("salida de 32 bytes");
            k
        });
        Self { file, data: Mutex::new(data), key }
    }

    /// `Ok(())` si hay clave maestra; si no, el motivo.
    pub fn available(&self) -> std::result::Result<(), &'static str> {
        self.key.map(|_| ()).ok_or(NO_MASTER)
    }

    fn cipher(&self) -> Option<Aes256Gcm> {
        self.key.map(|k| Aes256Gcm::new(GenericArray::from_slice(&k)))
    }

    pub fn set(&self, scope: &EnvScope, name: &str, value: &str) -> Result<()> {
        let cipher = self.cipher().ok_or_else(|| anyhow!(NO_MASTER))?;
        let mut iv = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut iv);
        let mut sealed = cipher.encrypt(GenericArray::from_slice(&iv), value.as_bytes()).map_err(|_| anyhow!("encrypt"))?;
        let tag = sealed.split_off(sealed.len() - 16);
        let raw = [iv.as_slice(), &tag, &sealed].map(|b| B64.encode(b)).join(".");
        let mut data = self.data.lock().unwrap();
        data.values.insert(key_of(scope, name), raw);
        self.save(&data)
    }

    pub fn get(&self, scope: &EnvScope, name: &str) -> Result<Option<String>> {
        let raw = match self.data.lock().unwrap().values.get(&key_of(scope, name)) {
            Some(r) if !r.is_empty() => r.clone(),
            _ => return Ok(None),
        };
        let cipher = self.cipher().ok_or_else(|| anyhow!("falta la clave maestra para descifrar"))?;
        let fail = || anyhow!("no se pudo descifrar (¿cambió la clave maestra?)");
        let parts: Vec<Vec<u8>> = raw.split('.').map(|p| B64.decode(p).unwrap_or_default()).collect();
        if parts.len() < 3 || parts[0].len() != 12 || parts[1].len() != 16 {
            return Err(fail());
        }
        let sealed = [parts[2].as_slice(), &parts[1]].concat();
        let plain = cipher.decrypt(GenericArray::from_slice(&parts[0]), sealed.as_slice()).map_err(|_| fail())?;
        Ok(Some(String::from_utf8_lossy(&plain).into_owned()))
    }

    pub fn delete(&self, scope: &EnvScope, name: &str) -> Result<()> {
        let mut data = self.data.lock().unwrap();
        if data.values.shift_remove(&key_of(scope, name)).is_some() {
            self.save(&data)?;
        }
        Ok(())
    }

    pub fn delete_scope(&self, scope: &EnvScope) -> Result<()> {
        let prefix = scope_prefix(scope);
        let mut data = self.data.lock().unwrap();
        let before = data.values.len();
        data.values.retain(|k, _| !k.starts_with(&prefix));
        if data.values.len() != before {
            self.save(&data)?;
        }
        Ok(())
    }

    fn save(&self, data: &FileFormat) -> Result<()> {
        save_private(&self.file, &pretty(data))
    }
}

impl LocalStore for MasterKeySecrets {
    fn get(&self, scope: &EnvScope, name: &str) -> Result<Option<String>> {
        MasterKeySecrets::get(self, scope, name)
    }
}

impl LocalStoreRW for MasterKeySecrets {
    fn set(&self, scope: &EnvScope, name: &str, value: &str) -> Result<()> {
        MasterKeySecrets::set(self, scope, name, value)
    }
    fn delete(&self, scope: &EnvScope, name: &str) -> Result<()> {
        MasterKeySecrets::delete(self, scope, name)
    }
}

pub fn read_master_key() -> Option<String> {
    if let Some(k) = std::env::var("CLAWHIP_MASTER_KEY").ok().filter(|k| !k.is_empty()) {
        return Some(k);
    }
    let file = std::env::var("CLAWHIP_MASTER_KEY_FILE").ok().filter(|f| !f.is_empty()).unwrap_or_else(|| "/run/secrets/clawhip_master_key".into());
    // `String#trim` de JS: quita el BOM y no quita NEL (U+0085), al revés que `str::trim`.
    let v = fs::read_to_string(file).ok()?.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').to_string();
    (!v.is_empty()).then_some(v)
}
