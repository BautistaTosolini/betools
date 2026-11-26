// Verificación manual contra una instalación real; imprime solo conteos, nunca valores:
// BETOOLS_REAL_DIR=~/.config/betools cargo test -p betools-secrets --test real_keyring -- --ignored --nocapture
#[test]
#[ignore]
fn real_secrets_json_decrypts() {
    let dir = std::env::var("BETOOLS_REAL_DIR").expect("BETOOLS_REAL_DIR");
    let ls = betools_secrets::LocalSecrets::new(std::path::Path::new(&dir), "betools");
    let (ok, total) = ls.count_decryptable();
    println!("decryptable {ok}/{total}");
    assert_eq!(ok, total);
}
