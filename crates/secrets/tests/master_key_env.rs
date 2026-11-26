// Prueba única en su archivo: modifica variables de entorno del proceso.
use betools_secrets::read_master_key;

#[test]
fn read_master_key_trims_like_js_and_prefers_env() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("k");
    std::env::remove_var("CLAWHIP_MASTER_KEY");
    std::env::set_var("CLAWHIP_MASTER_KEY_FILE", &f);
    assert_eq!(read_master_key(), None); // sin archivo
    // String#trim de JS quita el BOM (U+FEFF) y no quita NEL (U+0085).
    std::fs::write(&f, "\u{feff} clave\u{85} \n").unwrap();
    assert_eq!(read_master_key().as_deref(), Some("clave\u{85}"));
    std::fs::write(&f, " \n\t").unwrap();
    assert_eq!(read_master_key(), None);
    std::fs::write(&f, "del-archivo\n").unwrap();
    std::env::set_var("CLAWHIP_MASTER_KEY", "de-entorno");
    assert_eq!(read_master_key().as_deref(), Some("de-entorno")); // el entorno no se recorta
}
