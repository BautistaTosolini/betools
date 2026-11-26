// Puerto de test/unit/titles.test.ts
mod common;
use betools_transcripts::TabTitles;
use common::{sleep, wait_for};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

type Calls = Arc<Mutex<Vec<(String, Option<String>)>>>;

struct Fx {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    calls: Calls,
    tt: TabTitles,
}

fn fx() -> Fx {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join(".claude").join("tab-titles");
    let calls: Calls = Arc::default();
    let c = calls.clone();
    let tt = TabTitles::with_dir(dir.clone(), move |id, t| c.lock().unwrap().push((id.to_string(), t)));
    Fx { _tmp: tmp, dir, calls, tt }
}

impl Fx {
    fn file(&self, id: &str) -> PathBuf {
        self.dir.join(id)
    }
    fn calls(&self) -> Vec<(String, Option<String>)> {
        self.calls.lock().unwrap().clone()
    }
}
fn c(id: &str, t: Option<&str>) -> (String, Option<String>) {
    (id.to_string(), t.map(String::from))
}

#[test]
fn set_before_watch_still_polls_external_changes() {
    let f = fx();
    f.tt.set("a", "PROJ-1 desde la app").unwrap();
    f.tt.watch("a");
    sleep(250);
    fs::write(f.file("a"), "PROJ-2 desde el hook\n").unwrap();
    assert!(wait_for(6000, || f.tt.get("a").as_deref() == Some("PROJ-2 desde el hook")));
    assert_eq!(f.calls().last().unwrap(), &c("a", Some("PROJ-2 desde el hook")));
}

#[test]
fn set_with_same_title_does_not_notify_again() {
    let f = fx();
    f.tt.set("a", "PROJ-1 x").unwrap();
    f.tt.set("a", "  PROJ-1   x ").unwrap();
    assert_eq!(f.calls(), [c("a", Some("PROJ-1 x"))]);
}

#[test]
fn set_writes_file_with_trailing_newline_creating_dir() {
    let f = fx();
    f.tt.set("a", "PROJ-1 Arreglar login").unwrap();
    assert_eq!(fs::read_to_string(f.file("a")).unwrap(), "PROJ-1 Arreglar login\n");
    assert_eq!(f.tt.get("a").as_deref(), Some("PROJ-1 Arreglar login"));
    assert_eq!(f.calls(), [c("a", Some("PROJ-1 Arreglar login"))]);
}

#[test]
fn set_normalizes_whitespace_and_newlines() {
    let f = fx();
    f.tt.set("a", "  PROJ-1 \n\t  muchos   espacios \n").unwrap();
    assert_eq!(fs::read_to_string(f.file("a")).unwrap(), "PROJ-1 muchos espacios\n");
    assert_eq!(f.tt.get("a").as_deref(), Some("PROJ-1 muchos espacios"));
}

#[test]
fn blank_title_clears() {
    let f = fx();
    f.tt.set("a", "algo").unwrap();
    f.tt.set("a", "   \n ").unwrap();
    assert!(!f.file("a").exists());
    assert_eq!(f.tt.get("a"), None);
    assert_eq!(f.calls().last().unwrap(), &c("a", None));
}

#[test]
fn clearing_a_title_that_never_existed_does_not_fail() {
    let f = fx();
    f.tt.set("a", "").unwrap();
    assert_eq!(f.tt.get("a"), None);
}

#[test]
fn get_of_unknown_id_is_none() {
    assert_eq!(fx().tt.get("zzz"), None);
}

#[test]
fn set_overwrites_previous_title() {
    let f = fx();
    f.tt.set("a", "uno").unwrap();
    f.tt.set("a", "dos").unwrap();
    assert_eq!(fs::read_to_string(f.file("a")).unwrap(), "dos\n");
    assert_eq!(f.calls().into_iter().map(|c| c.1).collect::<Vec<_>>(), [Some("uno".to_string()), Some("dos".to_string())]);
}

#[test]
fn watch_loads_existing_title_without_notifying() {
    let f = fx();
    fs::create_dir_all(&f.dir).unwrap();
    fs::write(f.file("a"), "  PROJ-2   hola\n").unwrap();
    f.tt.watch("a");
    sleep(250);
    assert_eq!(f.tt.get("a").as_deref(), Some("PROJ-2 hola"));
    assert!(f.calls().is_empty());
}

#[test]
fn watch_missing_file_is_none() {
    let f = fx();
    f.tt.watch("a");
    sleep(250);
    assert_eq!(f.tt.get("a"), None);
}

#[test]
fn watch_empty_file_is_none() {
    let f = fx();
    fs::create_dir_all(&f.dir).unwrap();
    fs::write(f.file("a"), "\n").unwrap();
    f.tt.watch("a");
    sleep(250);
    assert_eq!(f.tt.get("a"), None);
}

#[test]
fn picks_up_external_write_of_new_file() {
    let f = fx();
    f.tt.watch("a");
    sleep(250);
    fs::create_dir_all(&f.dir).unwrap();
    fs::write(f.file("a"), "PROJ-3 externo\n").unwrap();
    assert!(wait_for(6000, || f.calls() == [c("a", Some("PROJ-3 externo"))]));
    assert_eq!(f.tt.get("a").as_deref(), Some("PROJ-3 externo"));
}

#[test]
fn picks_up_external_changes_and_removals() {
    let f = fx();
    fs::create_dir_all(&f.dir).unwrap();
    fs::write(f.file("a"), "uno\n").unwrap();
    f.tt.watch("a");
    sleep(250);
    fs::write(f.file("a"), "dos dos\n").unwrap();
    assert!(wait_for(6000, || f.tt.get("a").as_deref() == Some("dos dos")));
    fs::remove_file(f.file("a")).unwrap();
    assert!(wait_for(6000, || f.tt.get("a").is_none()));
    assert_eq!(f.calls(), [c("a", Some("dos dos")), c("a", None)]);
}

#[test]
fn no_notification_when_normalized_content_is_unchanged() {
    let f = fx();
    fs::create_dir_all(&f.dir).unwrap();
    fs::write(f.file("a"), "igual\n").unwrap();
    f.tt.watch("a");
    sleep(250);
    fs::write(f.file("a"), "  igual  \n\n").unwrap();
    sleep(2500);
    assert!(f.calls().is_empty());
}

#[test]
fn no_double_notification_after_set() {
    let f = fx();
    f.tt.watch("a");
    sleep(250);
    f.tt.set("a", "desde app").unwrap();
    sleep(2500);
    assert_eq!(f.calls(), [c("a", Some("desde app"))]);
}

#[test]
fn watch_twice_is_a_noop() {
    let f = fx();
    f.tt.watch("a");
    sleep(250);
    f.tt.watch("a");
    sleep(250);
    fs::create_dir_all(&f.dir).unwrap();
    fs::write(f.file("a"), "x\n").unwrap();
    assert!(wait_for(6000, || f.calls().len() == 1));
    sleep(1800);
    assert_eq!(f.calls().len(), 1);
}

#[test]
fn unwatch_stops_notifications_and_forgets_value() {
    let f = fx();
    fs::create_dir_all(&f.dir).unwrap();
    fs::write(f.file("a"), "uno\n").unwrap();
    f.tt.watch("a");
    sleep(250);
    f.tt.unwatch("a");
    assert_eq!(f.tt.get("a"), None);
    fs::write(f.file("a"), "dos\n").unwrap();
    sleep(2500);
    assert!(f.calls().is_empty());
}

#[test]
fn tracks_several_ids_independently() {
    let f = fx();
    f.tt.watch("a");
    sleep(250);
    f.tt.watch("b");
    sleep(250);
    fs::create_dir_all(&f.dir).unwrap();
    fs::write(f.file("b"), "solo b\n").unwrap();
    assert!(wait_for(6000, || f.calls() == [c("b", Some("solo b"))]));
    assert_eq!(f.tt.get("a"), None);
}
