// Diferencias con el código TS halladas en la revisión adversarial; cada prueba fija el comportamiento de JS.
mod common;
use betools_transcripts::claude_paths::{find_transcript_in, project_dir_in};
use betools_transcripts::{DailyTokenCounter, TabTitles, TranscriptParser};
use std::fs;
use std::sync::{Arc, Mutex};

fn parse(raw: &str) -> TranscriptParser {
    let mut p = TranscriptParser::new();
    p.push(raw.as_bytes());
    p
}

// JSON.stringify escribe los sustitutos sueltos como \udXXX y JSON.parse los acepta; la línea no se descarta.
#[test]
fn lone_surrogate_escape_does_not_drop_the_line() {
    let p = parse("{\"type\":\"user\",\"timestamp\":\"t\",\"message\":{\"content\":\"hola \\ud83d fin\"}}\n");
    assert_eq!(p.items().len(), 1);
    assert_eq!(p.items()[0].text, "hola \u{FFFD} fin");
}

#[test]
fn valid_surrogate_pair_escape_is_kept() {
    let p = parse("{\"type\":\"user\",\"timestamp\":\"t\",\"message\":{\"content\":\"a \\ud83d\\ude00 b \\\\ud83d\"}}\n");
    assert_eq!(p.items()[0].text, "a \u{1F600} b \\ud83d");
}

#[test]
fn lone_low_surrogate_escape_does_not_drop_the_line() {
    let p = parse("{\"type\":\"custom-title\",\"customTitle\":\"x\\ude00y\"}\n");
    assert_eq!(p.title(), Some("x\u{FFFD}y"));
}

// Las claves con forma de índice van primero y en orden numérico (Object.entries / JSON.stringify).
#[test]
fn answers_orders_integer_like_keys_first() {
    let p = parse("{\"type\":\"user\",\"timestamp\":\"t\",\"toolUseResult\":{\"answers\":{\"b\":\"1\",\"10\":\"x\",\"2\":\"y\"}},\"message\":{\"content\":[]}}\n");
    assert_eq!(p.items()[0].text, r#"[{"q":"2","a":"y"},{"q":"10","a":"x"},{"q":"b","a":"1"}]"#);
}

#[test]
fn tool_input_json_matches_json_stringify() {
    let p = parse("{\"type\":\"assistant\",\"timestamp\":\"t\",\"message\":{\"id\":\"m\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Foo\",\"input\":{\"b\":1.0,\"9\":2e2,\"1\":[1.0,{\"z\":-0.0}]}}]}}\n");
    let input = &p.items()[0].tool.as_ref().unwrap().input;
    assert_eq!(input, "{\n  \"1\": [\n    1,\n    {\n      \"z\": 0\n    }\n  ],\n  \"9\": 200,\n  \"b\": 1\n}");
}

#[test]
fn usage_line_with_lone_surrogate_is_counted() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("p");
    fs::create_dir_all(&dir).unwrap();
    let ts = chrono::Utc::now().to_rfc3339();
    let line = format!("{{\"type\":\"assistant\",\"timestamp\":\"{ts}\",\"message\":{{\"id\":\"m1\",\"x\":\"\\ud83d\",\"usage\":{{\"input_tokens\":5,\"output_tokens\":7}}}}}}\n");
    fs::write(dir.join("s.jsonl"), line).unwrap();
    let c = DailyTokenCounter::with_options(|_| {}, tmp.path().to_path_buf(), Arc::new(|| chrono::Utc::now().timestamp_millis()));
    c.scan();
    assert_eq!(c.get().total, 12);
}

#[test]
fn usage_line_with_invalid_utf8_is_counted() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("p");
    fs::create_dir_all(&dir).unwrap();
    let ts = chrono::Utc::now().to_rfc3339();
    let mut line = format!("{{\"type\":\"assistant\",\"timestamp\":\"{ts}\",\"message\":{{\"id\":\"m1\",\"x\":\"").into_bytes();
    line.push(0xff);
    line.extend(b"\",\"usage\":{\"input_tokens\":5}}}\n");
    fs::write(dir.join("s.jsonl"), line).unwrap();
    let c = DailyTokenCounter::with_options(|_| {}, tmp.path().to_path_buf(), Arc::new(|| chrono::Utc::now().timestamp_millis()));
    c.scan();
    assert_eq!(c.get().total, 5);
}

// readdirSync de Node (scandir + alphasort) devuelve los nombres ordenados.
#[test]
fn find_transcript_scans_project_dirs_in_sorted_order() {
    let tmp = tempfile::tempdir().unwrap();
    for d in ["zeta", "alpha", "mid", "beta"] {
        fs::create_dir_all(tmp.path().join(d)).unwrap();
        fs::write(tmp.path().join(d).join("sid.jsonl"), "").unwrap();
    }
    for _ in 0..3 {
        assert_eq!(find_transcript_in(tmp.path(), "/nada", "sid"), Some(tmp.path().join("alpha").join("sid.jsonl")));
    }
}

// join(root, "") es root, sin barra final.
#[test]
fn project_dir_of_empty_cwd_has_no_trailing_slash() {
    let root = std::path::Path::new("/r/projects");
    assert_eq!(project_dir_in(root, "").to_str().unwrap(), "/r/projects");
}

// readFileSync(.., 'utf8') reemplaza los bytes inválidos en vez de fallar.
#[test]
fn title_file_with_invalid_utf8_is_read_lossily() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("id1"), b"ab\xffcd\n").unwrap();
    let seen = Arc::new(Mutex::new(vec![]));
    let s = seen.clone();
    let t = TabTitles::with_dir(tmp.path().to_path_buf(), move |id, t| s.lock().unwrap().push((id.to_string(), t)));
    t.watch("id1");
    assert_eq!(t.get("id1").as_deref(), Some("ab\u{FFFD}cd"));
}
