//! Cobertura de canales: lo que expone src/preload/index.ts y lo que registra src/main/index.ts
//! debe estar manejado por el despachador, y los eventos que se emiten deben ser los mismos.

mod common;

use betools_app::{EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS};
use serde_json::json;
use std::collections::BTreeSet;

fn read(rel: &str) -> String {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn grab(src: &str, re: &str) -> BTreeSet<String> {
    regex_lite(src, re)
}

// Sin dependencias extra: extrae el primer grupo de cada coincidencia del patrón `PREFIJO'canal'`.
fn regex_lite(src: &str, prefix: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut rest = src;
    while let Some(i) = rest.find(prefix) {
        rest = &rest[i + prefix.len()..];
        if let Some(end) = rest.find('\'') {
            out.insert(rest[..end].to_string());
        }
    }
    out
}

fn set(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn preload_invoke_and_send_channels_match_the_dispatcher() {
    let preload = read("src/preload/index.ts");
    assert_eq!(grab(&preload, "ipcRenderer.invoke('"), set(INVOKE_CHANNELS), "invoke");
    assert_eq!(grab(&preload, "ipcRenderer.send('"), set(SEND_CHANNELS), "send");
}

#[test]
fn preload_event_channels_match() {
    let preload = read("src/preload/index.ts");
    // on('canal', cb)
    assert_eq!(grab(&preload, "=> on('"), set(EVENT_CHANNELS));
}

#[test]
fn main_process_registrations_and_events_match() {
    let main = read("src/main/index.ts");
    assert_eq!(grab(&main, "ipcMain.handle('"), set(INVOKE_CHANNELS));
    assert_eq!(grab(&main, "ipcMain.on('"), set(SEND_CHANNELS));
    // send('canal', ...): todos los eventos hacia la interfaz.
    assert_eq!(grab(&main, " send('"), set(EVENT_CHANNELS));
}

#[test]
fn every_preload_channel_is_actually_handled() {
    let e = common::env();
    let preload = read("src/preload/index.ts");
    let unknown = |m: &str| m.starts_with("Unknown channel");
    for ch in grab(&preload, "ipcRenderer.invoke('") {
        // Sin argumentos: los que necesitan alguno fallan por argumentos, nunca por canal desconocido.
        if let Err(m) = e.invoke(&ch, vec![]) {
            assert!(!unknown(&m), "{ch} sin manejar: {m}");
        }
    }
    for ch in grab(&preload, "ipcRenderer.send('") {
        if let Err(m) = e.app.send(&ch, vec![]) {
            assert!(!unknown(&m), "{ch} sin manejar: {m}");
        }
    }
}

#[test]
fn unknown_channels_are_rejected() {
    let e = common::env();
    assert_eq!(e.err("nope:nope", vec![]), "Unknown channel: nope:nope");
    assert_eq!(e.app.send("nope:nope", vec![]).unwrap_err(), "Unknown channel: nope:nope");
    // Un canal de send no se invoca como handle y al revés.
    assert!(e.invoke("pty:input", vec![json!("a"), json!("b")]).is_err());
}

#[test]
fn tauri_api_uses_every_channel_including_rust_only_ones() {
    use betools_app::RUST_ONLY_INVOKE_CHANNELS;
    let api = read("src/renderer/src/tauri-api.ts");
    for ch in INVOKE_CHANNELS.iter().chain(RUST_ONLY_INVOKE_CHANNELS) {
        assert!(api.contains(&format!("'{ch}'")), "{ch} no está en tauri-api.ts");
    }
}
