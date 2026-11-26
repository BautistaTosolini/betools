use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use betools_secrets::{os_crypt, Keyring, LocalSecrets};
use betools_types::{EnvScope, EnvScopeKind};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("electron-vectors.json")).unwrap()
}

#[test]
fn decrypts_vectors_made_by_electron() {
    let v = vectors();
    let pw = v["password"].as_str().unwrap().as_bytes().to_vec();
    for (plain, enc) in v["v"].as_object().unwrap() {
        let blob = B64.decode(enc.as_str().unwrap()).unwrap();
        if plain.is_empty() {
            assert!(blob.is_empty());
            continue;
        }
        assert_eq!(os_crypt::decrypt(&blob, || Ok(pw.clone())).unwrap(), *plain);
    }
}

#[test]
fn encrypts_byte_for_byte_like_electron() {
    let v = vectors();
    let pw = v["password"].as_str().unwrap().as_bytes();
    for (plain, enc) in v["v"].as_object().unwrap() {
        assert_eq!(B64.encode(os_crypt::encrypt(pw, plain)), enc.as_str().unwrap());
    }
}

#[test]
fn v10_uses_fixed_peanuts_password() {
    let key = os_crypt::derive_key(b"peanuts");
    assert_eq!(key.len(), 16);
    let mut blob = os_crypt::encrypt(b"peanuts", "hola");
    blob[2] = b'0'; // v11 -> v10
    assert_eq!(os_crypt::decrypt(&blob, || Err(anyhow!("no debe pedirse"))).unwrap(), "hola");
}

#[test]
fn rejects_unknown_prefix_and_bad_padding() {
    let e = os_crypt::decrypt(b"abc123", || Ok(vec![])).unwrap_err().to_string();
    assert!(e.contains("does not appear to be encrypted"));
    assert!(os_crypt::decrypt(b"v11\x01\x02", || Ok(b"a".to_vec())).is_err());
}

struct FakeKeyring(Option<String>);
impl Keyring for FakeKeyring {
    fn password(&self, _create: bool) -> Result<Option<String>> {
        self.0.clone().map(Some).ok_or_else(|| anyhow!("sin servicio"))
    }
}
const S: fn() -> EnvScope = || EnvScope { kind: EnvScopeKind::Session, id: "s1".into() };

#[test]
fn local_secrets_roundtrip_and_file_format() {
    let dir = tempfile::tempdir().unwrap();
    let ls = LocalSecrets::with_keyring(dir.path(), Box::new(FakeKeyring(Some("pw".into()))));
    ls.set(&S(), "TOKEN", "tok-123").unwrap();
    assert_eq!(ls.get(&S(), "TOKEN").unwrap().as_deref(), Some("tok-123"));
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("secrets.json")).unwrap()).unwrap();
    let b = B64.decode(raw["session:s1:TOKEN"].as_str().unwrap()).unwrap();
    assert_eq!(&b[..3], b"v11");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(dir.path().join("secrets.json")).unwrap().permissions().mode() & 0o777, 0o600);
    // Se relee desde disco.
    let again = LocalSecrets::with_keyring(dir.path(), Box::new(FakeKeyring(Some("pw".into()))));
    assert_eq!(again.get(&S(), "TOKEN").unwrap().as_deref(), Some("tok-123"));
    assert_eq!(again.get(&S(), "OTRO").unwrap(), None);
    again.delete_scope(&S()).unwrap();
    assert_eq!(again.get(&S(), "TOKEN").unwrap(), None);
}

#[test]
fn empty_value_reads_back_as_absent_like_ts() {
    let dir = tempfile::tempdir().unwrap();
    let ls = LocalSecrets::with_keyring(dir.path(), Box::new(FakeKeyring(Some("pw".into()))));
    ls.set(&S(), "E", "").unwrap();
    assert_eq!(ls.get(&S(), "E").unwrap(), None);
}

#[test]
fn refuses_to_store_without_a_real_keyring() {
    let dir = tempfile::tempdir().unwrap();
    let ls = LocalSecrets::with_keyring(dir.path(), Box::new(FakeKeyring(None)));
    let e = ls.set(&S(), "T", "v").unwrap_err().to_string();
    // Electron sin llavero cae a basic_text: isEncryptionAvailable() es false (verificado con Electron 45).
    assert_eq!(e, "System encryption is not available.");
    assert!(!dir.path().join("secrets.json").exists());
}

#[test]
fn invalid_utf8_plaintext_decodes_lossy_like_electron() {
    // Electron 45: decryptString devuelve U+FFFD por cada byte inválido en vez de fallar.
    let pw = b"peanuts";
    let mut blob = os_crypt::encrypt(pw, "xx");
    // Cifra a mano [0xff, 0xfe, 0x41] con la misma clave.
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    let ct = cbc::Encryptor::<aes::Aes128>::new(&os_crypt::derive_key(pw).into(), &[b' '; 16].into())
        .encrypt_padded_vec_mut::<Pkcs7>(&[0xff, 0xfe, 0x41]);
    blob.clear();
    blob.extend_from_slice(b"v10");
    blob.extend_from_slice(&ct);
    assert_eq!(os_crypt::decrypt(&blob, || Err(anyhow!("no"))).unwrap(), "\u{fffd}\u{fffd}A");
}

#[test]
fn empty_blob_decrypts_to_empty_string() {
    assert_eq!(os_crypt::decrypt(&[], || Err(anyhow!("no"))).unwrap(), "");
}

#[test]
fn reading_without_keyring_reports_decryption_not_available() {
    let dir = tempfile::tempdir().unwrap();
    let ok = LocalSecrets::with_keyring(dir.path(), Box::new(FakeKeyring(Some("pw".into()))));
    ok.set(&S(), "T", "v").unwrap();
    let ls = LocalSecrets::with_keyring(dir.path(), Box::new(FakeKeyring(None)));
    let e = ls.get(&S(), "T").unwrap_err().to_string();
    assert_eq!(e, "Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.");
}
