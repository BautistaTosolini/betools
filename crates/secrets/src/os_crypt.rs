//! Formato `os_crypt` de Chromium en Linux, el que usa `safeStorage` de Electron.
//! Fuente: https://source.chromium.org/chromium/chromium/src/+/main:components/os_crypt/sync/os_crypt_linux.cc
//! Cifrado: prefijo "v11" (clave del llavero) o "v10" (clave fija "peanuts") + AES-128-CBC con
//! clave PBKDF2-HMAC-SHA1(contraseña, "saltysalt", 1 iteración, 16 bytes), IV de 16 espacios, PKCS7.

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use anyhow::{anyhow, Result};

type Enc = cbc::Encryptor<aes::Aes128>;
type Dec = cbc::Decryptor<aes::Aes128>;

const SALT: &[u8] = b"saltysalt";
const IV: [u8; 16] = [b' '; 16];
const PEANUTS: &str = "peanuts";
pub(crate) const DECRYPT_ERR: &str = "Error while decrypting the ciphertext provided to safeStorage.decryptString.";

pub fn derive_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, SALT, 1, &mut key);
    key
}

/// Cifra con el prefijo v11. Igual que Electron, el texto vacío da un buffer vacío.
pub fn encrypt(password: &[u8], plain: &str) -> Vec<u8> {
    if plain.is_empty() {
        return Vec::new();
    }
    let ct = Enc::new(&derive_key(password).into(), &IV.into()).encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
    [b"v11".as_slice(), &ct].concat()
}

/// Descifra "v10" (contraseña fija) o "v11" (contraseña del llavero, pedida solo si hace falta).
pub fn decrypt(blob: &[u8], keyring_password: impl FnOnce() -> Result<Vec<u8>>) -> Result<String> {
    // Electron devuelve "" para un buffer vacío.
    if blob.is_empty() {
        return Ok(String::new());
    }
    let (prefix, ct) = blob.split_at_checked(3).unwrap_or((blob, &[]));
    let password = match prefix {
        b"v10" => PEANUTS.as_bytes().to_vec(),
        b"v11" => keyring_password()?,
        _ => return Err(anyhow!("{DECRYPT_ERR} Ciphertext does not appear to be encrypted.")),
    };
    let plain = Dec::new(&derive_key(&password).into(), &IV.into())
        .decrypt_padded_vec_mut::<Pkcs7>(ct)
        .map_err(|_| anyhow!(DECRYPT_ERR))?;
    // Electron decodifica con reemplazo (U+FFFD) en vez de fallar con UTF-8 inválido.
    Ok(String::from_utf8_lossy(&plain).into_owned())
}
