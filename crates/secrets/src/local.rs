//! Valores "local" cifrados con el llavero del sistema (src/main/secrets.ts). El archivo solo tiene
//! texto cifrado (base64) y permisos 0600. Nunca se devuelven a la interfaz.

use crate::{env_core::{LocalStore, LocalStoreRW}, key_of, os_crypt, pretty, save_private, scope_prefix};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use betools_types::EnvScope;
use indexmap::IndexMap;
use rand::RngCore;
use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::Mutex};

// Sin llavero Electron cae a basic_text y isEncryptionAvailable() da false (verificado con Electron 45).
const NO_KEYRING: &str = "System encryption is not available.";
const NO_DECRYPT: &str =
    "Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.";

/// Acceso a la contraseña de `os_crypt` guardada en el llavero.
pub trait Keyring: Send + Sync {
    /// Contraseña guardada. Con `create`, si no existe se genera y se guarda (como Chromium).
    /// Error si no hay un servicio de llavero real.
    fn password(&self, create: bool) -> Result<Option<String>>;
}

/// Secret Service (GNOME Keyring/KWallet) con el esquema que usa Chromium/Electron. Verificado
/// inspeccionando los atributos de la entrada real: `application` = nombre de la app y
/// `xdg:schema` = `chrome_libsecret_os_crypt_password_v2`, con la contraseña como secreto text/plain.
/// Fuente: https://source.chromium.org/chromium/chromium/src/+/main:components/os_crypt/sync/libsecret_util_linux.cc
/// y keyring_util_linux (esquema `kKeyringSchema`).
pub struct SecretServiceKeyring {
    application: String,
}

impl SecretServiceKeyring {
    pub fn new(application: &str) -> Self {
        Self { application: application.to_string() }
    }

    fn attrs(&self) -> HashMap<&str, &str> {
        HashMap::from([("application", self.application.as_str()), ("xdg:schema", "chrome_libsecret_os_crypt_password_v2")])
    }
}

impl Keyring for SecretServiceKeyring {
    fn password(&self, create: bool) -> Result<Option<String>> {
        use secret_service::{blocking::SecretService, EncryptionType};
        let ss = SecretService::connect(EncryptionType::Dh).map_err(|e| anyhow!("secret service: {e}"))?;
        let found = ss.search_items(self.attrs()).map_err(|e| anyhow!("secret service: {e}"))?;
        let item = found.unlocked.into_iter().next().or_else(|| found.locked.into_iter().next());
        if let Some(item) = item {
            item.unlock().map_err(|e| anyhow!("secret service: {e}"))?;
            let secret = item.get_secret().map_err(|e| anyhow!("secret service: {e}"))?;
            return Ok(Some(String::from_utf8_lossy(&secret).into_owned()));
        }
        if !create {
            return Ok(None);
        }
        // Igual que Chromium: 16 bytes aleatorios en base64.
        let mut raw = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut raw);
        let password = B64.encode(raw);
        let col = ss.get_default_collection().map_err(|e| anyhow!("secret service: {e}"))?;
        col.unlock().map_err(|e| anyhow!("secret service: {e}"))?;
        col.create_item("Chromium Safe Storage", self.attrs(), password.as_bytes(), false, "text/plain")
            .map_err(|e| anyhow!("secret service: {e}"))?;
        Ok(Some(password))
    }
}

pub struct LocalSecrets {
    file: PathBuf,
    data: Mutex<IndexMap<String, String>>,
    keyring: Box<dyn Keyring>,
    // Como Electron, la contraseña se pide una vez y se guarda en memoria.
    password: Mutex<Option<String>>,
}

impl LocalSecrets {
    /// `user_data`: el `userData` de Electron (~/.config/betools). `application`: nombre de app con que
    /// Electron registró la entrada del llavero ("betools").
    pub fn new(user_data: &Path, application: &str) -> Self {
        Self::with_keyring(user_data, Box::new(SecretServiceKeyring::new(application)))
    }

    pub fn with_keyring(user_data: &Path, keyring: Box<dyn Keyring>) -> Self {
        let file = user_data.join("secrets.json");
        let data = fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { file, data: Mutex::new(data), keyring, password: Mutex::new(None) }
    }

    fn password(&self, create: bool) -> Result<Vec<u8>> {
        let mut cached = self.password.lock().unwrap();
        if cached.is_none() {
            *cached = self.keyring.password(create)?;
        }
        cached.clone().map(String::into_bytes).ok_or_else(|| anyhow!("System encryption is not available."))
    }

    /// Sin un llavero real no se guarda nada (Electron caería a "basic_text", equivalente a texto plano).
    pub fn assert_secure_backend(&self) -> Result<()> {
        self.password(true).map(|_| ()).map_err(|_| anyhow!(NO_KEYRING))
    }

    pub fn set(&self, scope: &EnvScope, name: &str, value: &str) -> Result<()> {
        self.assert_secure_backend()?;
        let enc = os_crypt::encrypt(&self.password(true)?, value);
        let mut data = self.data.lock().unwrap();
        data.insert(key_of(scope, name), B64.encode(enc));
        self.save(&data)
    }

    pub fn get(&self, scope: &EnvScope, name: &str) -> Result<Option<String>> {
        let enc = match self.data.lock().unwrap().get(&key_of(scope, name)) {
            // Igual que `if (!enc) return null`: un valor vacío (texto "" cifrado) se lee como ausente.
            Some(e) if !e.is_empty() => e.clone(),
            _ => return Ok(None),
        };
        let blob = B64.decode(enc.as_bytes()).unwrap_or_default();
        // Sin `create`: leer nunca crea entradas en el llavero.
        os_crypt::decrypt(&blob, || self.password(false).map_err(|_| anyhow!(NO_DECRYPT))).map(Some)
    }

    pub fn delete(&self, scope: &EnvScope, name: &str) -> Result<()> {
        let mut data = self.data.lock().unwrap();
        if data.shift_remove(&key_of(scope, name)).is_some() {
            self.save(&data)?;
        }
        Ok(())
    }

    pub fn delete_scope(&self, scope: &EnvScope) -> Result<()> {
        let prefix = scope_prefix(scope);
        let mut data = self.data.lock().unwrap();
        let before = data.len();
        data.retain(|k, _| !k.starts_with(&prefix));
        if data.len() != before {
            self.save(&data)?;
        }
        Ok(())
    }

    /// Cuántas entradas descifran bien (para verificar un secrets.json real sin ver valores).
    pub fn count_decryptable(&self) -> (usize, usize) {
        let data = self.data.lock().unwrap();
        let ok = data
            .values()
            .filter(|e| {
                let blob = B64.decode(e.as_bytes()).unwrap_or_default();
                e.is_empty() || os_crypt::decrypt(&blob, || self.password(false).map_err(|_| anyhow!(NO_DECRYPT))).is_ok()
            })
            .count();
        (ok, data.len())
    }

    fn save(&self, data: &IndexMap<String, String>) -> Result<()> {
        save_private(&self.file, &pretty(data))
    }
}

impl LocalStore for LocalSecrets {
    fn get(&self, scope: &EnvScope, name: &str) -> Result<Option<String>> {
        LocalSecrets::get(self, scope, name)
    }
}

impl LocalStoreRW for LocalSecrets {
    fn set(&self, scope: &EnvScope, name: &str, value: &str) -> Result<()> {
        LocalSecrets::set(self, scope, name, value)
    }
    fn delete(&self, scope: &EnvScope, name: &str) -> Result<()> {
        LocalSecrets::delete(self, scope, name)
    }
}
