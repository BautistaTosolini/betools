// Puerto de test/unit/usage.test.ts
mod common;
use betools_transcripts::{merge_window, DailyTokenCounter, StatusLineWatcher};
use betools_types::{DailyTokens, PlanLimits, PlanWindow, SessionMeta};
use common::{sleep, wait_for};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

const NOW: f64 = 1_800_000_000.0;
fn w(pct: f64, resets_at: Option<f64>) -> PlanWindow {
    PlanWindow { pct, resets_at: resets_at.map(|r| r as i64) }
}
fn mw(cur: Option<&PlanWindow>, next: Option<&PlanWindow>) -> Option<PlanWindow> {
    merge_window(cur, next, NOW)
}

mod merge {
    use super::*;

    #[test]
    fn returns_cur_when_next_is_none() {
        assert_eq!(mw(None, None), None);
        let cur = w(10.0, Some(NOW + 1000.0));
        assert_eq!(mw(Some(&cur), None), Some(cur));
    }

    #[test]
    fn returns_next_without_cur() {
        let n = w(5.0, Some(NOW + 1000.0));
        assert_eq!(mw(None, Some(&n)), Some(n));
    }

    #[test]
    fn later_window_replaces_even_if_lower() {
        let (c, n) = (w(90.0, Some(NOW + 1000.0)), w(3.0, Some(NOW + 1000.0 + 18_000.0)));
        assert_eq!(mw(Some(&c), Some(&n)), Some(n));
    }

    #[test]
    fn stale_next_is_ignored() {
        let c = w(10.0, Some(NOW + 1000.0));
        assert_eq!(mw(Some(&c), Some(&w(99.0, Some(NOW - 1.0)))), Some(c));
    }

    #[test]
    fn stale_cur_is_replaced() {
        let n = w(1.0, Some(NOW + 5000.0));
        assert_eq!(mw(Some(&w(99.0, Some(NOW - 10.0))), Some(&n)), Some(n));
    }

    #[test]
    fn older_window_beyond_tolerance_is_ignored() {
        let c = w(10.0, Some(NOW + 10_000.0));
        assert_eq!(mw(Some(&c), Some(&w(80.0, Some(NOW + 10_000.0 - 301.0)))), Some(c));
    }

    #[test]
    fn same_window_keeps_max() {
        let (lo, hi) = (w(10.0, Some(NOW + 1000.0)), w(40.0, Some(NOW + 1000.0)));
        assert_eq!(mw(Some(&lo), Some(&hi)), Some(hi.clone()));
        assert_eq!(mw(Some(&hi), Some(&lo)), Some(hi));
    }

    #[test]
    fn equal_percentage_prefers_next() {
        let (c, n) = (w(10.0, Some(NOW + 1000.0)), w(10.0, Some(NOW + 1010.0)));
        assert_eq!(mw(Some(&c), Some(&n)), Some(n));
    }

    #[test]
    fn tolerance_is_inclusive_on_both_sides() {
        let c = w(50.0, Some(NOW + 10_000.0));
        assert_eq!(mw(Some(&c), Some(&w(20.0, Some(NOW + 10_300.0)))), Some(c.clone()));
        assert_eq!(mw(Some(&c), Some(&w(60.0, Some(NOW + 10_300.0)))), Some(w(60.0, Some(NOW + 10_300.0))));
        assert_eq!(mw(Some(&c), Some(&w(20.0, Some(NOW + 10_000.0 - 300.0)))), Some(c.clone()));
        assert_eq!(mw(Some(&c), Some(&w(60.0, Some(NOW + 10_000.0 - 300.0)))), Some(w(60.0, Some(NOW + 10_000.0 - 300.0))));
        let later = w(20.0, Some(NOW + 10_301.0));
        assert_eq!(mw(Some(&c), Some(&later)), Some(later));
    }

    #[test]
    fn null_resets_at_compares_only_percentages() {
        assert_eq!(mw(Some(&w(10.0, None)), Some(&w(5.0, Some(NOW + 1000.0)))), Some(w(10.0, None)));
        assert_eq!(mw(Some(&w(10.0, None)), Some(&w(20.0, Some(NOW + 1000.0)))), Some(w(20.0, Some(NOW + 1000.0))));
        assert_eq!(mw(Some(&w(10.0, Some(NOW + 1000.0))), Some(&w(5.0, None))), Some(w(10.0, Some(NOW + 1000.0))));
        assert_eq!(mw(Some(&w(10.0, Some(NOW + 1000.0))), Some(&w(10.0, None))), Some(w(10.0, None)));
        assert_eq!(mw(Some(&w(10.0, None)), Some(&w(10.0, None))), Some(w(10.0, None)));
    }

    #[test]
    fn resets_at_equal_to_now_is_not_stale() {
        let n = w(50.0, Some(NOW));
        assert_eq!(mw(None, Some(&n)), Some(n.clone()));
        assert_eq!(mw(Some(&w(10.0, Some(NOW + 100.0))), Some(&n)), Some(n.clone()));
        let c = w(10.0, Some(NOW + 400.0));
        assert_eq!(mw(Some(&c), Some(&n)), Some(c));
    }
}

mod status_line {
    use super::*;

    const WAIT: u64 = 5000;
    struct Fx {
        _tmp: tempfile::TempDir,
        dir: PathBuf,
        status_file: String,
        limits_file: PathBuf,
        metas: Arc<Mutex<Vec<(String, SessionMeta)>>>,
        limits: Arc<Mutex<Vec<PlanLimits>>>,
        sw: StatusLineWatcher,
    }
    fn now_s() -> f64 {
        (chrono::Utc::now().timestamp()) as f64
    }
    fn mk_sw(limits_file: &PathBuf, metas: &Arc<Mutex<Vec<(String, SessionMeta)>>>, limits: &Arc<Mutex<Vec<PlanLimits>>>) -> StatusLineWatcher {
        let (m, l) = (metas.clone(), limits.clone());
        StatusLineWatcher::new(limits_file, move |id, meta| m.lock().unwrap().push((id.to_string(), meta)), move |lim| l.lock().unwrap().push(lim))
    }
    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let limits_file = dir.join("sub").join("limits.json");
        let (metas, limits) = (Arc::default(), Arc::default());
        let sw = mk_sw(&limits_file, &metas, &limits);
        Fx { status_file: dir.join("s.status").to_str().unwrap().to_string(), dir, limits_file, metas, limits, sw, _tmp: tmp }
    }
    impl Fx {
        fn write_line(&self, o: Value) {
            fs::write(format!("{}.line", self.status_file), o.to_string()).unwrap();
        }
        fn metas(&self) -> Vec<(String, SessionMeta)> {
            self.metas.lock().unwrap().clone()
        }
        fn limits(&self) -> Vec<PlanLimits> {
            self.limits.lock().unwrap().clone()
        }
        fn other(&self, o: Value) -> String {
            let f = self.dir.join("o.status").to_str().unwrap().to_string();
            fs::write(format!("{f}.line"), o.to_string()).unwrap();
            f
        }
    }
    fn meta(model: Option<&str>, pct: Option<f64>) -> SessionMeta {
        SessionMeta { model: model.map(String::from), context_pct: pct }
    }

    #[test]
    fn starts_with_no_data() {
        let f = fx();
        assert_eq!(f.sw.get_limits(), None);
        assert_eq!(f.sw.get_meta("a"), None);
    }

    #[test]
    fn loads_saved_limits_at_construction() {
        let f = fx();
        let saved = PlanLimits { five_hour: Some(w(30.0, Some(now_s() + 1000.0))), seven_day: None, updated_at: 1 };
        fs::create_dir_all(f.dir.join("sub")).unwrap();
        fs::write(&f.limits_file, serde_json::to_string(&saved).unwrap()).unwrap();
        assert_eq!(mk_sw(&f.limits_file, &f.metas, &f.limits).get_limits(), Some(saved));
    }

    #[test]
    fn invalid_limits_file_is_empty() {
        let f = fx();
        fs::create_dir_all(f.dir.join("sub")).unwrap();
        fs::write(&f.limits_file, "{no").unwrap();
        assert_eq!(mk_sw(&f.limits_file, &f.metas, &f.limits).get_limits(), None);
    }

    #[test]
    fn watch_reads_existing_line_file_and_reports_meta() {
        let f = fx();
        f.write_line(json!({"model":{"id":"claude-x","display_name":"Opus 5"},"context_window":{"used_percentage":42}}));
        f.sw.watch("a", &f.status_file);
        assert_eq!(f.metas(), [("a".to_string(), meta(Some("Opus 5"), Some(42.0)))]);
        assert_eq!(f.sw.get_meta("a"), Some(meta(Some("Opus 5"), Some(42.0))));
    }

    #[test]
    fn model_falls_back_to_id_missing_data_gives_nulls() {
        let f = fx();
        f.write_line(json!({"model":{"id":"claude-x"}}));
        f.sw.watch("a", &f.status_file);
        assert_eq!(f.sw.get_meta("a"), Some(meta(Some("claude-x"), None)));
        f.write_line(json!({"context_window":{"used_percentage":null}}));
        f.sw.unwatch("a");
        f.sw.watch("a", &f.status_file);
        assert_eq!(f.sw.get_meta("a"), Some(meta(None, None)));
    }

    #[test]
    fn ignores_missing_file_or_invalid_json() {
        let f = fx();
        f.sw.watch("a", &f.status_file);
        assert!(f.metas().is_empty());
        fs::write(format!("{}.line", f.status_file), "{trunc").unwrap();
        f.sw.unwatch("a");
        f.sw.watch("a", &f.status_file);
        assert!(f.metas().is_empty());
    }

    #[test]
    fn picks_up_later_changes_and_only_notifies_on_changes() {
        let f = fx();
        f.write_line(json!({"model":{"display_name":"A"},"context_window":{"used_percentage":1}}));
        f.sw.watch("a", &f.status_file);
        sleep(250);
        f.write_line(json!({"model":{"display_name":"A"},"context_window":{"used_percentage":2}}));
        assert!(wait_for(WAIT, || f.metas().len() == 2));
        assert_eq!(f.metas()[1].1, meta(Some("A"), Some(2.0)));
        f.write_line(json!({"model":{"display_name":"A"},"context_window":{"used_percentage":2}}));
        sleep(1500);
        assert_eq!(f.metas().len(), 2);
    }

    #[test]
    fn computes_plan_limits_persists_atomically_and_notifies() {
        let f = fx();
        let (r5, r7) = (now_s() + 3600.0, now_s() + 86_400.0);
        f.write_line(json!({"rate_limits":{"five_hour":{"used_percentage":25,"resets_at":r5 as i64},"seven_day":{"used_percentage":5,"resets_at":r7 as i64}}}));
        f.sw.watch("a", &f.status_file);
        let l = f.limits();
        assert_eq!(l.len(), 1);
        assert_eq!((l[0].five_hour.clone(), l[0].seven_day.clone()), (Some(w(25.0, Some(r5))), Some(w(5.0, Some(r7)))));
        assert_eq!(f.sw.get_limits(), Some(l[0].clone()));
        let raw = fs::read_to_string(&f.limits_file).unwrap();
        let stored: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(stored["fiveHour"], json!({"pct":25,"resetsAt":r5 as i64}));
        // Sin ".0": igual que JSON.stringify en la versión Electron.
        assert!(raw.contains("\"pct\":25,"));
        assert!(!f.limits_file.with_extension("json.tmp").exists());
    }

    #[test]
    fn only_five_hour_present_seven_day_stays_null() {
        let f = fx();
        f.write_line(json!({"rate_limits":{"five_hour":{"used_percentage":7,"resets_at":now_s() as i64 + 100}}}));
        f.sw.watch("a", &f.status_file);
        assert_eq!(f.limits()[0].seven_day, None);
    }

    #[test]
    fn no_rate_limits_or_empty_means_no_notification() {
        let f = fx();
        f.write_line(json!({"model":{"id":"m"}}));
        f.sw.watch("a", &f.status_file);
        f.write_line(json!({"rate_limits":{}}));
        f.sw.unwatch("a");
        f.sw.watch("a", &f.status_file);
        assert!(f.limits().is_empty());
    }

    #[test]
    fn window_without_numeric_percentage_is_ignored() {
        let f = fx();
        f.write_line(json!({"rate_limits":{"five_hour":{"resets_at":now_s() as i64 + 100}}}));
        f.sw.watch("a", &f.status_file);
        assert!(f.limits().first().and_then(|l| l.five_hour.clone()).is_none());
    }

    #[test]
    fn stale_lower_reading_from_other_session_does_not_lower() {
        let f = fx();
        let r = now_s() as i64 + 3600;
        f.write_line(json!({"rate_limits":{"five_hour":{"used_percentage":60,"resets_at":r}}}));
        f.sw.watch("a", &f.status_file);
        let other = f.other(json!({"rate_limits":{"five_hour":{"used_percentage":20,"resets_at":r + 5}}}));
        f.sw.watch("b", &other);
        assert_eq!(f.sw.get_limits().unwrap().five_hour, Some(w(60.0, Some(r as f64))));
        assert_eq!(f.limits().len(), 1);
    }

    #[test]
    fn new_window_replaces_stored_even_when_lower() {
        let f = fx();
        let r = now_s() as i64 + 3600;
        f.write_line(json!({"rate_limits":{"five_hour":{"used_percentage":60,"resets_at":r}}}));
        f.sw.watch("a", &f.status_file);
        let other = f.other(json!({"rate_limits":{"five_hour":{"used_percentage":2,"resets_at":r + 18_000}}}));
        f.sw.watch("b", &other);
        assert_eq!(f.sw.get_limits().unwrap().five_hour, Some(w(2.0, Some((r + 18_000) as f64))));
        assert_eq!(f.limits().len(), 2);
    }

    #[test]
    fn stored_limits_survive_restart_and_merge() {
        let f = fx();
        let r = now_s() as i64 + 3600;
        f.write_line(json!({"rate_limits":{"five_hour":{"used_percentage":60,"resets_at":r}}}));
        f.sw.watch("a", &f.status_file);
        f.sw.forget("a");
        let sw2 = mk_sw(&f.limits_file, &f.metas, &f.limits);
        assert_eq!(sw2.get_limits().unwrap().five_hour, Some(w(60.0, Some(r as f64))));
        f.write_line(json!({"rate_limits":{"five_hour":{"used_percentage":10,"resets_at":r}}}));
        sw2.watch("a", &f.status_file);
        assert_eq!(sw2.get_limits().unwrap().five_hour.unwrap().pct, 60.0);
        sw2.forget("a");
    }

    #[test]
    fn unwatch_stops_reading_forget_drops_meta() {
        let f = fx();
        f.write_line(json!({"model":{"display_name":"A"}}));
        f.sw.watch("a", &f.status_file);
        f.sw.unwatch("a");
        assert!(f.sw.get_meta("a").is_some());
        f.write_line(json!({"model":{"display_name":"B"}}));
        sleep(1500);
        assert_eq!(f.metas().len(), 1);
        f.sw.forget("a");
        assert_eq!(f.sw.get_meta("a"), None);
    }

    #[test]
    fn rewatch_of_same_id_replaces_previous_file() {
        let f = fx();
        f.write_line(json!({"model":{"display_name":"A"}}));
        f.sw.watch("a", &f.status_file);
        let other = f.other(json!({"model":{"display_name":"Z"}}));
        f.sw.watch("a", &other);
        assert_eq!(f.sw.get_meta("a").unwrap().model.as_deref(), Some("Z"));
    }
}

mod daily_tokens {
    use super::*;

    const U: fn() -> Value = || json!({"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":30,"cache_read_input_tokens":40});

    struct Fx {
        _tmp: tempfile::TempDir,
        projects: PathBuf,
        changes: Arc<Mutex<Vec<DailyTokens>>>,
        offset: Arc<AtomicI64>,
        c: DailyTokenCounter,
    }
    fn real_now() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join(".claude").join("projects");
        let changes: Arc<Mutex<Vec<DailyTokens>>> = Arc::default();
        let offset = Arc::new(AtomicI64::new(0));
        let (ch, off) = (changes.clone(), offset.clone());
        let c = DailyTokenCounter::with_options(move |t| ch.lock().unwrap().push(t), projects.clone(), Arc::new(move || real_now() + off.load(Ordering::SeqCst)));
        Fx { _tmp: tmp, projects, changes, offset, c }
    }
    fn iso(off: i64) -> String {
        chrono::DateTime::from_timestamp_millis(real_now() + off).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
    fn asst(id: Option<&str>, usage: Option<Value>, ts: String, extra: Value) -> Value {
        let mut msg = json!({});
        if let Some(id) = id {
            msg["id"] = json!(id);
        }
        if let Some(u) = usage {
            msg["usage"] = u;
        }
        let mut v = json!({"type":"assistant","timestamp":ts,"message":msg});
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }
    fn a(id: &str) -> Value {
        asst(Some(id), Some(U()), iso(0), json!({}))
    }
    fn jl(objs: &[Value]) -> String {
        objs.iter().map(|o| o.to_string()).collect::<Vec<_>>().join("\n") + "\n"
    }
    impl Fx {
        fn file(&self, rel: &str, content: &str) -> PathBuf {
            let p = self.projects.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, content).unwrap();
            p
        }
        fn changes(&self) -> Vec<DailyTokens> {
            self.changes.lock().unwrap().clone()
        }
    }
    fn append(p: &PathBuf, s: &str) {
        use std::io::Write;
        fs::OpenOptions::new().append(true).open(p).unwrap().write_all(s.as_bytes()).unwrap();
    }

    #[test]
    fn starts_at_zero_with_iso_day_start() {
        use chrono::{Local, TimeZone, Timelike};
        let f = fx();
        let t = f.c.get();
        assert_eq!((t.input, t.output, t.cache_write, t.cache_read, t.total, t.messages), (0, 0, 0, 0, 0, 0));
        let d = chrono::DateTime::parse_from_rfc3339(&t.day).unwrap().with_timezone(&Local);
        let now = Local::now();
        assert_eq!((d.hour(), d.minute()), (0, 0));
        assert_eq!(d.date_naive(), now.date_naive());
        assert!(t.day.ends_with(".000Z"));
        let _ = Local.timestamp_opt(0, 0);
    }

    #[test]
    fn no_projects_dir_scan_notifies_zero_once() {
        let f = fx();
        f.c.scan();
        assert_eq!(f.changes().len(), 1);
        assert_eq!(f.changes()[0].total, 0);
    }

    #[test]
    fn sums_four_usage_fields_and_total() {
        let f = fx();
        f.file("p1/s1.jsonl", &jl(&[a("m1")]));
        f.c.scan();
        let t = f.c.get();
        assert_eq!((t.input, t.output, t.cache_write, t.cache_read, t.total, t.messages), (10, 20, 30, 40, 100, 1));
        assert_eq!(f.changes().last().unwrap().total, 100);
    }

    #[test]
    fn counts_each_message_id_once_across_lines_and_files() {
        let f = fx();
        f.file("p1/s1.jsonl", &jl(&[a("m1"), a("m1"), a("m2")]));
        f.file("p1/s2.jsonl", &jl(&[a("m1")]));
        f.c.scan();
        assert_eq!((f.c.get().messages, f.c.get().total), (2, 200));
    }

    #[test]
    fn falls_back_to_request_id_then_uuid_no_key_always_counted() {
        let f = fx();
        let n = |extra: Value| asst(None, Some(U()), iso(0), extra);
        f.file(
            "p1/s1.jsonl",
            &jl(&[n(json!({"requestId":"r1"})), n(json!({"requestId":"r1"})), n(json!({"uuid":"u1"})), n(json!({"uuid":"u1"})), n(json!({})), n(json!({}))]),
        );
        f.c.scan();
        assert_eq!(f.c.get().messages, 4);
    }

    #[test]
    fn only_assistant_entries_with_usage() {
        let f = fx();
        f.file("p1/s1.jsonl", &jl(&[json!({"type":"user","timestamp":iso(0),"message":{"usage":U()}}), asst(Some("m1"), None, iso(0), json!({})), a("m2")]));
        f.c.scan();
        assert_eq!(f.c.get().messages, 1);
    }

    #[test]
    fn only_timestamps_from_today() {
        let f = fx();
        let start = chrono::DateTime::parse_from_rfc3339(&f.c.get().day).unwrap().timestamp_millis();
        let at = |ms: i64| chrono::DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        f.file(
            "p1/s1.jsonl",
            &jl(&[
                asst(Some("old"), Some(U()), at(start - 1000), json!({})),
                asst(Some("start"), Some(U()), at(start), json!({})),
                a("now"),
                asst(Some("bad"), Some(U()), "no-date".into(), json!({})),
            ]),
        );
        f.c.scan();
        assert_eq!(f.c.get().messages, 2);
    }

    #[test]
    fn missing_or_non_numeric_fields_count_as_zero() {
        let f = fx();
        f.file("p1/s1.jsonl", &jl(&[asst(Some("m1"), Some(json!({"input_tokens":5,"output_tokens":"x","cache_read_input_tokens":null})), iso(0), json!({}))]));
        f.c.scan();
        let t = f.c.get();
        assert_eq!((t.input, t.output, t.cache_write, t.cache_read, t.total), (5, 0, 0, 0, 5));
    }

    #[test]
    fn includes_subagent_files_but_not_deeper() {
        let f = fx();
        f.file("p1/sess/subagents/agent-1.jsonl", &jl(&[a("sub1")]));
        f.file("p1/a/b/c/too-deep.jsonl", &jl(&[a("deep")]));
        f.c.scan();
        assert_eq!(f.c.get().messages, 1);
    }

    #[test]
    fn ignores_files_not_modified_today_and_non_jsonl() {
        let f = fx();
        let p = f.file("p1/old.jsonl", &jl(&[a("m1")]));
        fs::File::options().write(true).open(&p).unwrap().set_modified(SystemTime::now() - Duration::from_secs(3 * 86_400)).unwrap();
        f.file("p1/notes.txt", &jl(&[a("m2")]));
        f.c.scan();
        assert_eq!(f.c.get().messages, 0);
    }

    #[test]
    fn reads_incrementally() {
        let f = fx();
        let p = f.file("p1/s1.jsonl", &jl(&[a("m1")]));
        f.c.scan();
        f.c.scan();
        assert_eq!(f.c.get().messages, 1);
        append(&p, &jl(&[a("m2")]));
        f.c.scan();
        assert_eq!((f.c.get().messages, f.c.get().total), (2, 200));
    }

    #[test]
    fn handles_line_split_across_scans() {
        let f = fx();
        let line = a("m1").to_string();
        let p = f.file("p1/s1.jsonl", &line[..30]);
        f.c.scan();
        assert_eq!(f.c.get().messages, 0);
        append(&p, &format!("{}\n", &line[30..]));
        f.c.scan();
        assert_eq!(f.c.get().messages, 1);
    }

    #[test]
    fn skips_invalid_json_lines() {
        let f = fx();
        f.file("p1/s1.jsonl", &format!("{{\"usage\": broken\n{}", jl(&[a("m1")])));
        f.c.scan();
        assert_eq!(f.c.get().messages, 1);
    }

    #[test]
    fn truncated_file_is_read_again_without_double_counting_seen() {
        let f = fx();
        let p = f.file("p1/s1.jsonl", &jl(&[a("m1"), a("m2")]));
        f.c.scan();
        fs::write(&p, jl(&[a("m3")])).unwrap();
        f.c.scan();
        assert_eq!((f.c.get().messages, f.c.get().total), (3, 300));
    }

    #[test]
    fn on_change_only_when_total_changes_plus_initial_zero() {
        let f = fx();
        f.c.scan();
        assert_eq!(f.changes().len(), 1);
        f.c.scan();
        assert_eq!(f.changes().len(), 2);
        let p = f.file("p1/s1.jsonl", &jl(&[a("m1")]));
        f.c.scan();
        assert_eq!(f.changes().len(), 3);
        f.c.scan();
        assert_eq!(f.changes().len(), 3);
        append(&p, &jl(&[a("m2")]));
        f.c.scan();
        assert_eq!(f.changes().len(), 4);
    }

    #[test]
    fn resets_on_day_change() {
        let f = fx();
        f.file("p1/s1.jsonl", &jl(&[a("m1")]));
        f.c.scan();
        assert_eq!(f.c.get().total, 100);
        f.offset.store(36 * 3_600_000, Ordering::SeqCst);
        f.c.scan();
        assert_eq!((f.c.get().total, f.c.get().messages), (0, 0));
        let day = chrono::DateTime::parse_from_rfc3339(&f.c.get().day).unwrap().timestamp_millis();
        assert!(day > real_now() + 12 * 3_600_000 - 24 * 3_600_000 && day <= real_now() + 36 * 3_600_000);
    }

    #[test]
    fn start_scans_immediately_then_on_interval_stop_halts() {
        let f = fx();
        let p = f.file("p1/s1.jsonl", &jl(&[a("m1")]));
        f.c.start(Duration::from_millis(100));
        assert_eq!(f.c.get().messages, 1);
        append(&p, &jl(&[a("m2")]));
        assert!(wait_for(3000, || f.c.get().messages == 2));
        f.c.stop();
        sleep(150);
        append(&p, &jl(&[a("m3")]));
        sleep(400);
        assert_eq!(f.c.get().messages, 2);
    }
}
