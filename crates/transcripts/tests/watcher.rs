// Puerto de test/unit/transcript-watcher.test.ts
mod common;
use betools_transcripts::claude_paths::{project_dir_in, transcript_path_in};
use betools_transcripts::{Callbacks, TranscriptWatcher};
use betools_types::{Artifact, ConversationItem, ConversationKind as K, Session};
use common::{sleep, wait_for};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const TS: &str = "2026-01-01T10:00:00.000Z";
const WAIT: u64 = 6000;

fn jl(objs: &[Value]) -> String {
    objs.iter().map(|o| o.to_string()).collect::<Vec<_>>().join("\n") + "\n"
}
fn user(t: &str) -> Value {
    json!({"type":"user","timestamp":TS,"message":{"content":t}})
}
fn tool_use(id: &str) -> Value {
    json!({"type":"assistant","timestamp":TS,"message":{"id":format!("m-{id}"),"model":"claude-x","content":[{"type":"tool_use","id":id,"name":"Bash","input":{"command":"echo"}}]}})
}
fn tool_result(id: &str, c: &str) -> Value {
    json!({"type":"user","timestamp":TS,"message":{"content":[{"type":"tool_result","tool_use_id":id,"content":c}]}})
}

static N: AtomicUsize = AtomicUsize::new(0);
fn new_session(cwd: Option<&str>) -> Session {
    let n = N.fetch_add(1, Ordering::SeqCst) + 1;
    Session {
        id: format!("sess-{}-{n}", std::process::id()),
        name: "x".into(),
        cwd: cwd.map(String::from).unwrap_or(format!("/proj/w{n}")),
        created_at: TS.into(),
        last_active_at: TS.into(),
        env: None,
    }
}

type Pairs = Vec<(String, Option<String>)>;
type Changes = Vec<(String, Vec<Artifact>)>;
type Conv = Vec<(String, usize, Vec<ConversationItem>)>;
struct Fx {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    w: TranscriptWatcher,
    conv: Arc<Mutex<Conv>>,
    titles: Arc<Mutex<Pairs>>,
    models: Arc<Mutex<Pairs>>,
    changes: Arc<Mutex<Changes>>,
}

fn setup() -> Fx {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join(".claude").join("projects");
    let (conv, titles, models, changes) = (Arc::new(Mutex::new(vec![])), Arc::new(Mutex::new(vec![])), Arc::new(Mutex::new(vec![])), Arc::new(Mutex::new(vec![])));
    let (c1, c2, c3, c4) = (conv.clone(), titles.clone(), models.clone(), changes.clone());
    let cb = Callbacks::new(move |id, a| c4.lock().unwrap().push((id.to_string(), a)), move |id, t| c2.lock().unwrap().push((id.to_string(), t)))
        .on_model(move |id, m| c3.lock().unwrap().push((id.to_string(), m)))
        .on_conversation(move |id, s, items| c1.lock().unwrap().push((id.to_string(), s, items)));
    Fx { w: TranscriptWatcher::with_root(cb, root.clone()), _tmp: tmp, root, conv, titles, models, changes }
}

impl Fx {
    fn create(&self, s: &Session, content: &str) -> PathBuf {
        let p = transcript_path_in(&self.root, &s.cwd, &s.id);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, content).unwrap();
        p
    }
    fn conv_len(&self) -> usize {
        self.conv.lock().unwrap().len()
    }
    fn conv_for(&self, id: &str) -> Conv {
        self.conv.lock().unwrap().iter().filter(|c| c.0 == id).cloned().collect()
    }
    fn conv_at(&self, i: usize) -> (String, usize, Vec<ConversationItem>) {
        self.conv.lock().unwrap()[i].clone()
    }
    fn texts(&self, id: &str) -> Vec<String> {
        self.w.conversation(id).iter().map(|i| i.text.clone()).collect()
    }
}
fn append(p: &PathBuf, s: &str) {
    OpenOptions::new().append(true).open(p).unwrap().write_all(s.as_bytes()).unwrap();
}
fn tx(items: &[ConversationItem]) -> Vec<&str> {
    items.iter().map(|i| i.text.as_str()).collect()
}

#[test]
fn reads_existing_transcript_on_watch() {
    let (f, s) = (setup(), new_session(None));
    f.create(&s, &jl(&[user("hola")]));
    f.w.watch(&s);
    assert_eq!(f.conv_len(), 1);
    let (id, start, items) = f.conv_at(0);
    assert_eq!((id.as_str(), start, tx(&items)), (s.id.as_str(), 0, vec!["hola"]));
    assert_eq!(f.texts(&s.id), ["hola"]);
}

#[test]
fn missing_transcript_then_picked_up_after_creation() {
    let (f, s) = (setup(), new_session(None));
    f.w.watch(&s);
    sleep(250);
    assert_eq!(f.conv_len(), 0);
    assert!(f.w.conversation(&s.id).is_empty());
    f.create(&s, &jl(&[user("nueva")]));
    assert!(wait_for(WAIT, || f.conv_len() == 1));
    let (_, start, items) = f.conv_at(0);
    assert_eq!((start, items[0].text.as_str()), (0, "nueva"));
}

#[test]
fn emits_appended_lines_with_index_of_first_new_item() {
    let (f, s) = (setup(), new_session(None));
    let p = f.create(&s, &jl(&[user("a")]));
    f.w.watch(&s);
    sleep(250);
    append(&p, &jl(&[user("b"), user("c")]));
    assert!(wait_for(WAIT, || f.conv_len() == 2));
    let (_, start, items) = f.conv_at(1);
    assert_eq!((start, tx(&items)), (1, vec!["b", "c"]));
}

#[test]
fn partial_line_split_between_two_appends() {
    let (f, s) = (setup(), new_session(None));
    let p = f.create(&s, "");
    f.w.watch(&s);
    sleep(250);
    let line = user("partida").to_string();
    append(&p, &line[..15]);
    sleep(1500);
    assert_eq!(f.conv_len(), 0);
    append(&p, &format!("{}\n", &line[15..]));
    assert!(wait_for(WAIT, || f.conv_len() == 1));
    assert_eq!(f.conv_at(0).2[0].text, "partida");
}

#[test]
fn sends_from_earlier_index_when_tool_result_updates_earlier_item() {
    let (f, s) = (setup(), new_session(None));
    let p = f.create(&s, &jl(&[user("x"), tool_use("t1"), user("y")]));
    f.w.watch(&s);
    assert_eq!(f.conv_at(0).2.len(), 3);
    append(&p, &jl(&[tool_result("t1", "listo"), user("z")]));
    assert!(wait_for(WAIT, || f.conv_len() == 2));
    let (_, start, items) = f.conv_at(1);
    assert_eq!(start, 1);
    assert_eq!(items.iter().map(|i| i.kind).collect::<Vec<_>>(), [K::Tool, K::User, K::User]);
    let t = items[0].tool.as_ref().unwrap();
    assert_eq!((t.done, t.result.as_deref()), (true, Some("listo")));
    assert_eq!(f.w.conversation(&s.id).len(), 4);
}

#[test]
fn sends_only_updated_item_when_tool_result_arrives_alone() {
    let (f, s) = (setup(), new_session(None));
    let p = f.create(&s, &jl(&[tool_use("t1")]));
    f.w.watch(&s);
    append(&p, &jl(&[tool_result("t1", "ok")]));
    assert!(wait_for(WAIT, || f.conv_len() == 2));
    let (_, start, items) = f.conv_at(1);
    assert_eq!((start, items.len(), items[0].tool.as_ref().unwrap().done), (0, 1, true));
}

#[test]
fn rereads_from_zero_when_truncated_or_replaced_by_smaller() {
    let (f, s) = (setup(), new_session(None));
    let p = f.create(&s, &jl(&[user("uno"), user("dos"), user("tres")]));
    f.w.watch(&s);
    assert_eq!(f.w.conversation(&s.id).len(), 3);
    fs::write(&p, jl(&[user("solo")])).unwrap();
    assert!(wait_for(WAIT, || f.conv_len() == 2));
    let (_, start, items) = f.conv_at(1);
    assert_eq!((start, tx(&items)), (0, vec!["solo"]));
    assert_eq!(f.texts(&s.id), ["solo"]);
}

#[test]
fn truncation_resets_artifacts_title_and_model() {
    let (f, s) = (setup(), new_session(None));
    let p = f.create(&s, &(jl(&[json!({"type":"ai-title","aiTitle":"Viejo"}), tool_use("t1")]) + &"x".repeat(300) + "\n"));
    f.w.watch(&s);
    assert_eq!(f.w.title(&s.id).as_deref(), Some("Viejo"));
    assert_eq!(f.w.model(&s.id).as_deref(), Some("claude-x"));
    fs::write(&p, jl(&[user("a")])).unwrap();
    assert!(wait_for(WAIT, || f.conv_len() == 2));
    assert_eq!(f.w.title(&s.id), None);
    assert_eq!(f.w.model(&s.id), None);
}

#[test]
fn title_and_model_callbacks_only_on_changes() {
    let (f, s) = (setup(), new_session(None));
    let p = f.create(&s, &jl(&[json!({"type":"ai-title","aiTitle":"T1"}), tool_use("t1")]));
    f.w.watch(&s);
    assert_eq!(*f.titles.lock().unwrap(), [(s.id.clone(), Some("T1".to_string()))]);
    assert_eq!(*f.models.lock().unwrap(), [(s.id.clone(), Some("claude-x".to_string()))]);
    assert_eq!(f.w.title(&s.id).as_deref(), Some("T1"));
    append(&p, &jl(&[user("algo")]));
    assert!(wait_for(WAIT, || f.conv_len() == 2));
    assert_eq!(f.titles.lock().unwrap().len(), 1);
    assert_eq!(f.models.lock().unwrap().len(), 1);
    let mut t2 = tool_use("t2");
    t2["message"] = json!({"id":"m2","model":"claude-y","content":[]});
    append(&p, &jl(&[json!({"type":"custom-title","customTitle":"Renombrada"}), t2]));
    assert!(wait_for(WAIT, || f.titles.lock().unwrap().len() == 2));
    assert_eq!(f.titles.lock().unwrap()[1], (s.id.clone(), Some("Renombrada".to_string())));
    assert!(wait_for(WAIT, || f.models.lock().unwrap().len() == 2));
    assert_eq!(f.models.lock().unwrap()[1], (s.id.clone(), Some("claude-y".to_string())));
}

#[test]
fn on_change_delivers_artifacts() {
    let (f, s) = (setup(), new_session(None));
    let p = f.create(&s, "");
    f.w.watch(&s);
    sleep(250);
    assert!(f.changes.lock().unwrap().is_empty());
    let write = json!({"type":"assistant","timestamp":TS,"cwd":"/proj","message":{"id":"mw","content":[{"type":"tool_use","id":"w1","name":"Write","input":{"file_path":"/proj/out/informe.md"}}]}});
    append(&p, &jl(&[write]));
    assert!(wait_for(WAIT, || f.changes.lock().unwrap().len() == 1));
    let ch = f.changes.lock().unwrap()[0].clone();
    assert_eq!(ch.0, s.id);
    assert_eq!(ch.1.len(), 1);
    assert_eq!((ch.1[0].path.as_str(), ch.1[0].is_document), ("/proj/out/informe.md", true));
    assert_eq!(f.w.list(&s.id).len(), 1);
}

#[test]
fn no_on_change_for_lines_that_change_nothing() {
    let (f, s) = (setup(), new_session(None));
    let p = f.create(&s, &jl(&[user("a")]));
    f.w.watch(&s);
    sleep(250);
    append(&p, &jl(&[user("b")]));
    assert!(wait_for(WAIT, || f.conv_len() == 2));
    assert!(f.changes.lock().unwrap().is_empty());
}

#[test]
fn unwatch_stops_notifications_and_clears_state() {
    let (f, s) = (setup(), new_session(None));
    let p = f.create(&s, &jl(&[user("a")]));
    f.w.watch(&s);
    sleep(250);
    f.w.unwatch(&s.id);
    assert!(f.w.conversation(&s.id).is_empty());
    assert!(f.w.list(&s.id).is_empty());
    assert_eq!(f.w.title(&s.id), None);
    assert_eq!(f.w.model(&s.id), None);
    append(&p, &jl(&[user("b")]));
    sleep(2300);
    assert_eq!(f.conv_len(), 1);
    f.w.unwatch(&s.id); // doble unwatch: no falla
}

#[test]
fn transcript_truncated_to_zero_empties_conversation() {
    let (f, s) = (setup(), new_session(None));
    let file = f.create(&s, &jl(&[user("a"), user("b")]));
    f.w.watch(&s);
    assert_eq!(f.conv_at(0).2.len(), 2);
    fs::write(&file, "").unwrap();
    assert!(wait_for(WAIT, || { let c = f.conv.lock().unwrap(); c.len() == 2 && c[1].1 == 0 && c[1].2.is_empty() }));
    assert!(f.w.conversation(&s.id).is_empty());
}

#[test]
fn watching_same_session_twice_is_noop() {
    let (f, s) = (setup(), new_session(None));
    f.create(&s, &jl(&[user("a")]));
    f.w.watch(&s);
    f.w.watch(&s);
    sleep(250);
    assert_eq!(f.conv_len(), 1);
}

#[test]
fn can_be_rewatched_after_unwatch_rereading_from_start() {
    let (f, s) = (setup(), new_session(None));
    f.create(&s, &jl(&[user("a")]));
    f.w.watch(&s);
    f.w.unwatch(&s.id);
    f.w.watch(&s);
    assert_eq!(f.conv_len(), 2);
    assert_eq!(f.conv_at(1).1, 0);
}

#[test]
fn finds_transcript_in_another_project_dir() {
    let (f, s) = (setup(), new_session(Some("/old/location")));
    let other = new_session(Some("/new/location"));
    let p = transcript_path_in(&f.root, &other.cwd, &s.id);
    fs::create_dir_all(project_dir_in(&f.root, &other.cwd)).unwrap();
    fs::write(&p, jl(&[user("movida")])).unwrap();
    f.w.watch(&s);
    assert_eq!(f.conv_at(0).2[0].text, "movida");
    append(&p, &jl(&[user("sigue")]));
    assert!(wait_for(WAIT, || f.conv_len() == 2));
    assert_eq!(f.conv_at(1).2[0].text, "sigue");
}

#[test]
fn tracks_several_sessions_independently() {
    let (f, a, b) = (setup(), new_session(None), new_session(None));
    let pa = f.create(&a, &jl(&[user("a1")]));
    f.create(&b, &jl(&[user("b1")]));
    f.w.watch(&a);
    f.w.watch(&b);
    sleep(250);
    append(&pa, &jl(&[user("a2")]));
    assert!(wait_for(WAIT, || f.conv_for(&a.id).len() == 2));
    assert_eq!(f.conv_for(&b.id).len(), 1);
}

#[test]
fn truncating_to_empty_and_writing_new_content_rereads() {
    let (f, s) = (setup(), new_session(None));
    let p = f.create(&s, &jl(&[user("a"), user("b")]));
    f.w.watch(&s);
    sleep(250);
    fs::File::options().write(true).open(&p).unwrap().set_len(0).unwrap();
    sleep(1500);
    append(&p, &jl(&[user("c")]));
    assert!(wait_for(WAIT, || f.conv.lock().unwrap().last().is_some_and(|c| tx(&c.2) == ["c"])));
    assert_eq!(f.conv.lock().unwrap().last().unwrap().1, 0);
}
