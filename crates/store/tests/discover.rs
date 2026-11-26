mod common;
use betools_store::*;
use common::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn root() -> PathBuf {
    home().join(".claude").join("projects")
}
fn encode(cwd: &str) -> String {
    cwd.chars().flat_map(|c| std::iter::repeat_n(if c.is_ascii_alphanumeric() { c } else { '-' }, c.len_utf16().max(1))).collect()
}
fn jl(objs: &[Value]) -> String {
    objs.iter().map(|o| o.to_string()).collect::<Vec<_>>().join("\n") + "\n"
}
fn user_msg(text: Value, cwd: Option<&str>, extra: Value) -> Value {
    let mut v = json!({"type":"user","message":{"content":text}});
    if let Some(c) = cwd {
        v["cwd"] = c.into();
    }
    if let Value::Object(m) = extra {
        for (k, x) in m {
            v[k] = x;
        }
    }
    v
}
fn um(text: &str, cwd: &str) -> Value {
    user_msg(json!(text), Some(cwd), json!({}))
}
fn asst(cwd: &str) -> Value {
    json!({"type":"assistant","cwd":cwd,"message":{"content":"a"}})
}

// Crea un directorio real (sin symlinks: /tmp puede serlo en algunas plataformas)
fn real_dir(parts: &[&str]) -> String {
    let base = fs::canonicalize(tempfile::Builder::new().prefix("disc-").tempdir().unwrap().keep()).unwrap();
    let mut p = base;
    for x in parts {
        p.push(x);
    }
    fs::create_dir_all(&p).unwrap();
    p.to_string_lossy().into_owned()
}

fn set_mtime(p: &Path, secs: u64) {
    File::options().write(true).open(p).unwrap().set_modified(UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
}

fn session_raw(proj: &str, id: &str, content: &str, mtime: Option<u64>) -> PathBuf {
    let dir = root().join(proj);
    fs::create_dir_all(&dir).unwrap();
    let p = dir.join(format!("{id}.jsonl"));
    fs::write(&p, content).unwrap();
    let m = mtime.unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() - 10_000 + next());
    set_mtime(&p, m);
    p
}
fn next() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static T: AtomicU64 = AtomicU64::new(0);
    T.fetch_add(10, Ordering::SeqCst) + 10
}
fn session(proj: &str, id: &str, lines: &[Value], mtime: Option<u64>) -> PathBuf {
    session_raw(proj, id, &jl(lines), mtime)
}

fn setup() -> std::sync::MutexGuard<'static, ()> {
    let g = guard();
    fs::create_dir_all(root()).unwrap();
    g
}
fn ids(r: &[betools_types::DiscoveredSession]) -> Vec<&str> {
    r.iter().map(|s| s.id.as_str()).collect()
}
fn none() -> HashSet<String> {
    HashSet::new()
}
fn set(v: &[&str]) -> HashSet<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn empty_when_projects_dir_missing_or_empty() {
    let _g = guard();
    assert!(discover_sessions(&none()).is_empty());
    fs::create_dir_all(root()).unwrap();
    assert!(discover_sessions(&none()).is_empty());
}

#[test]
fn orders_most_recent_first_and_reports_modified_at_and_size() {
    let _g = setup();
    let cwd = real_dir(&["p"]);
    let d = encode(&cwd);
    session(&d, "old", &[um("viejo", &cwd)], Some(1_700_000_000));
    session(&d, "new", &[um("nuevo", &cwd)], Some(1_700_001_000));
    session(&d, "mid", &[um("medio", &cwd)], Some(1_700_000_500));
    let r = discover_sessions(&none());
    assert_eq!(ids(&r), ["new", "mid", "old"]);
    assert_eq!(r[0].modified_at, "2023-11-14T22:30:00.000Z");
    assert_eq!(r[0].size_kb, 0);
}

#[test]
fn orders_across_project_dirs() {
    let _g = setup();
    let (a, b) = (real_dir(&["a"]), real_dir(&["b"]));
    session(&encode(&a), "a1", &[um("A", &a)], Some(1_700_000_000));
    session(&encode(&b), "b1", &[um("B", &b)], Some(1_700_000_900));
    assert_eq!(ids(&discover_sessions(&none())), ["b1", "a1"]);
}

#[test]
fn rounds_size_kb() {
    let _g = setup();
    let cwd = real_dir(&["p"]);
    session(&encode(&cwd), "s", &[um(&"x".repeat(5000), &cwd)], None);
    assert_eq!(discover_sessions(&none())[0].size_kb, 5);
}

#[test]
fn exclude_set_removes_sessions_by_id() {
    let _g = setup();
    let cwd = real_dir(&["p"]);
    let d = encode(&cwd);
    session(&d, "keep", &[um("a", &cwd)], None);
    session(&d, "drop", &[um("b", &cwd)], None);
    assert_eq!(ids(&discover_sessions(&set(&["drop"]))), ["keep"]);
}

#[test]
fn limit_is_applied_after_sorting_by_recency() {
    let _g = setup();
    let cwd = real_dir(&["p"]);
    let d = encode(&cwd);
    for i in 0..5u64 {
        session(&d, &format!("s{i}"), &[um(&format!("m{i}"), &cwd)], Some(1_700_000_000 + i * 100));
    }
    assert_eq!(ids(&discover_sessions_limit(&none(), 2)), ["s4", "s3"]);
}

#[test]
fn limit_counts_only_non_excluded_sessions() {
    let _g = setup();
    let cwd = real_dir(&["p"]);
    let d = encode(&cwd);
    for i in 0..4u64 {
        session(&d, &format!("s{i}"), &[um(&format!("m{i}"), &cwd)], Some(1_700_000_000 + i * 100));
    }
    assert_eq!(ids(&discover_sessions_limit(&set(&["s3"]), 2)), ["s2", "s1"]);
}

#[test]
fn skips_empty_non_jsonl_stray_and_no_cwd_files() {
    let _g = setup();
    let cwd = real_dir(&["p"]);
    let d = encode(&cwd);
    session_raw(&d, "empty", "", None);
    session(&d, "nocwd", &[user_msg(json!("hola"), None, json!({}))], None);
    session(&d, "ok", &[um("hola", &cwd)], None);
    fs::write(root().join(&d).join("notes.txt"), "x").unwrap();
    fs::write(root().join("stray.jsonl"), jl(&[um("x", &cwd)])).unwrap();
    assert_eq!(ids(&discover_sessions(&none())), ["ok"]);
}

// title and first prompt
fn one(lines: Vec<Value>) -> betools_types::DiscoveredSession {
    let cwd = real_dir(&["p"]);
    let lines: Vec<Value> = lines
        .into_iter()
        .map(|mut l| {
            if l["cwd"] == "@" {
                l["cwd"] = cwd.clone().into();
            }
            l
        })
        .collect();
    session(&encode(&cwd), "s", &lines, None);
    discover_sessions(&none()).remove(0)
}
fn u(text: Value) -> Value {
    user_msg(text, Some("@"), json!({}))
}
fn ux(text: Value, extra: Value) -> Value {
    user_msg(text, Some("@"), extra)
}
fn title(lines: Vec<Value>) -> String {
    one(lines).title
}

#[test]
fn title_uses_first_prompt_normalized_and_cut_to_140() {
    let _g = setup();
    assert_eq!(title(vec![u(json!("  hola\n\n  mundo  "))]), "hola mundo");
    assert_eq!(title(vec![u(json!("x".repeat(300)))]), "x".repeat(140));
}

#[test]
fn title_takes_first_text_of_array_content() {
    let _g = setup();
    assert_eq!(title(vec![u(json!([{"type":"image"},{"type":"text","text":"desde array"}]))]), "desde array");
}

#[test]
fn title_skips_system_meta_and_sidechain() {
    let _g = setup();
    let r = title(vec![
        u(json!("<command-name>/x</command-name>")),
        u(json!("Caveat: The messages below were generated")),
        u(json!("   ")),
        ux(json!("meta"), json!({"isMeta":true})),
        ux(json!("sub"), json!({"isSidechain":true})),
        json!({"type":"assistant","cwd":"@","message":{"content":"respuesta"}}),
        u(json!(42)),
        u(json!("el verdadero")),
    ]);
    assert_eq!(r, "el verdadero");
}

#[test]
fn title_no_prompt() {
    let _g = setup();
    assert_eq!(title(vec![json!({"type":"assistant","cwd":"@","message":{"content":"x"}})]), "(no prompt)");
}

#[test]
fn ai_title_beats_prompt_and_last_wins() {
    let _g = setup();
    assert_eq!(title(vec![u(json!("prompt")), json!({"type":"ai-title","aiTitle":"Uno"}), json!({"type":"ai-title","aiTitle":"Dos"})]), "Dos");
}

#[test]
fn custom_title_beats_ai_title_regardless_of_order() {
    let _g = setup();
    let c = json!({"type":"custom-title","customTitle":"Mío"});
    let a = json!({"type":"ai-title","aiTitle":"IA"});
    assert_eq!(title(vec![u(json!("p")), c.clone(), a.clone()]), "Mío");
    assert_eq!(title(vec![u(json!("p")), a, c]), "Mío");
}

#[test]
fn titles_come_from_the_tail_of_big_files() {
    let _g = setup();
    let cwd = real_dir(&["p"]);
    let filler = "z".repeat(1000);
    let mut lines = vec![um("primero", &cwd)];
    for _ in 0..400 {
        lines.push(json!({"type":"assistant","message":{"content":filler}}));
    }
    lines.push(json!({"type":"custom-title","customTitle":"Título final"}));
    session(&encode(&cwd), "big", &lines, None);
    let r = discover_sessions(&none());
    assert_eq!(r[0].title, "Título final");
    assert!(r[0].size_kb > 256);
}

#[test]
fn big_file_without_titles_falls_back_to_first_prompt_from_head() {
    let _g = setup();
    let cwd = real_dir(&["p"]);
    let mut lines = vec![um("primer prompt", &cwd)];
    for _ in 0..400 {
        lines.push(json!({"type":"assistant","message":{"content":"z".repeat(1000)}}));
    }
    session(&encode(&cwd), "big", &lines, None);
    assert_eq!(discover_sessions(&none())[0].title, "primer prompt");
}

#[test]
fn tolerates_corrupt_lines() {
    let _g = setup();
    let cwd = real_dir(&["p"]);
    session_raw(&encode(&cwd), "s", &format!("{{roto\n{}{{cortada", jl(&[um("ok", &cwd)])), None);
    assert_eq!(discover_sessions(&none())[0].title, "ok");
}

// cwd resolution
#[test]
fn uses_project_dir_cwd_when_it_exists_and_matches() {
    let _g = setup();
    let cwd = real_dir(&["work", "app"]);
    session(&encode(&cwd), "s", &[um("x", &cwd)], None);
    let r = discover_sessions(&none());
    assert_eq!((r[0].cwd.as_str(), r[0].cwd_exists), (cwd.as_str(), true));
}

#[test]
fn prefers_launch_dir_over_deep_cd_at_tail() {
    let _g = setup();
    let cwd = real_dir(&["work", "app"]);
    let deep = format!("{cwd}/src/deep");
    fs::create_dir_all(&deep).unwrap();
    session(&encode(&cwd), "s", &[um("x", &cwd), asst(&deep)], None);
    assert_eq!(discover_sessions(&none())[0].cwd, cwd);
}

#[test]
fn ambiguous_encoding_still_resolves_launch_dir_from_tail() {
    let _g = setup();
    let cwd = real_dir(&["work", "app"]);
    let gone = format!("{}/no-existe-{}/app", std::env::temp_dir().display(), std::process::id());
    session(&encode(&cwd), "s", &[um("x", &gone), asst(&cwd)], None);
    let r = discover_sessions(&none());
    assert_eq!((r[0].cwd.as_str(), r[0].cwd_exists), (cwd.as_str(), true));
}

fn by_id(r: Vec<betools_types::DiscoveredSession>) -> HashMap<String, betools_types::DiscoveredSession> {
    r.into_iter().map(|s| (s.id.clone(), s)).collect()
}

#[test]
fn moved_folder_infers_prefix_rewrite_but_unmatched_stays_missing() {
    let _g = setup();
    let base = real_dir(&[]);
    let old_root = format!("{base}/workdir");
    let new_app = format!("{base}/workdir/infra/clients/vemo");
    fs::create_dir_all(&new_app).unwrap();
    let old_app = format!("{old_root}/clients/vemo");
    session(&encode(&old_app), "a", &[um("x", &old_app), asst(&new_app)], None);
    session(&encode(&old_app), "b", &[um("y", &old_app)], None);
    let r = by_id(discover_sessions(&none()));
    assert_eq!((r["a"].cwd.as_str(), r["a"].cwd_exists), (new_app.as_str(), true));
    assert_eq!((r["b"].cwd.as_str(), r["b"].cwd_exists), (old_app.as_str(), false));
}

#[test]
fn moved_folder_rewrite_accepted_when_it_matches_project_dir() {
    let _g = setup();
    let base = real_dir(&[]);
    let new_app = format!("{base}/infra/clients/vemo");
    fs::create_dir_all(format!("{new_app}/sub")).unwrap();
    let old_app = format!("{base}/clients/vemo");
    session(&encode(&old_app), "teach", &[um("x", &old_app), asst(&new_app)], None);
    let old_sub = format!("{old_app}/sub");
    session(&encode(&new_app), "target", &[um("y", &old_app), asst(&old_sub)], None);
    let r = by_id(discover_sessions(&none()));
    assert_eq!((r["target"].cwd.as_str(), r["target"].cwd_exists), (new_app.as_str(), true));
}

#[test]
fn falls_back_to_last_then_first_recorded_cwd_that_exists() {
    let _g = setup();
    let first = real_dir(&["first"]);
    let gone = format!("{}/nope-{}", std::env::temp_dir().display(), std::process::id());
    session("-some-unrelated-dir", "s", &[um("x", &first), asst(&gone)], None);
    let r = discover_sessions(&none());
    assert_eq!((r[0].cwd.as_str(), r[0].cwd_exists), (first.as_str(), true));

    let last = real_dir(&["last"]);
    session("-other-unrelated", "s2", &[um("x", &first), asst(&last)], None);
    let r = by_id(discover_sessions(&none()));
    assert_eq!((r["s2"].cwd.as_str(), r["s2"].cwd_exists), (last.as_str(), true));
}

#[test]
fn no_existing_cwd_returns_last_recorded_with_exists_false() {
    let _g = setup();
    session("-x", "s", &[um("a", "/definitely/not/here/one"), asst("/definitely/not/here/two")], None);
    let r = discover_sessions(&none());
    assert_eq!((r[0].cwd.as_str(), r[0].cwd_exists), ("/definitely/not/here/two", false));
}

#[test]
fn only_head_cwd_is_used_as_is() {
    let _g = setup();
    session("-x", "s", &[um("a", "/gone/head")], None);
    let r = discover_sessions(&none());
    assert_eq!((r[0].cwd.as_str(), r[0].cwd_exists), ("/gone/head", false));
}

// Con la misma fecha de modificación, Node conserva el orden de readdir (alfabético): el orden
// del resultado no puede depender del orden crudo del sistema de archivos.
#[test]
fn ties_in_mtime_keep_name_order() {
    let _g = setup();
    let cwd = real_dir(&["tie"]);
    for i in 0..24 {
        session("p", &format!("id{:02}", (i * 7) % 24), &[um("hi", &cwd)], Some(5000));
    }
    let want: Vec<String> = (0..24).map(|i| format!("id{i:02}")).collect();
    let r = discover_sessions(&none());
    assert_eq!(ids(&r), want.iter().map(String::as_str).collect::<Vec<_>>());
}
