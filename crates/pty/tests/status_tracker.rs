//! Port de test/unit/status-tracker.test.ts.

use betools_pty::status_tracker::user_status_line_from;
use betools_pty::{build_settings, StatusTracker};
use betools_types::SessionStatus::{self, *};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};
use tempfile::TempDir;

fn settings(secrets: bool) -> Value {
    serde_json::from_str(&build_settings(secrets)).unwrap()
}

// Ejecuta un comando de hook como lo hace Claude Code: sh -c con el payload por stdin.
fn run_hook(command: &str, stdin: &str, env: &[(&str, &str)]) -> std::io::Result<String> {
    let mut cmd = Command::new("sh");
    cmd.args(["-c", command]).env_clear().env("PATH", std::env::var("PATH").unwrap());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
    let mut input = child.stdin.take().unwrap();
    let data = stdin.to_string();
    let w = std::thread::spawn(move || {
        let _ = input.write_all(data.as_bytes());
    });
    let out = child.wait_with_output()?;
    w.join().unwrap();
    assert!(out.status.success(), "hook exited with {:?}", out.status);
    Ok(String::from_utf8(out.stdout).unwrap())
}

fn hook_cmd(event: &str) -> String {
    settings(false)["hooks"][event][0]["hooks"][0]["command"].as_str().unwrap().to_string()
}

fn words(f: &Path) -> Vec<String> {
    fs::read_to_string(f).map(|s| s.split('\n').filter(|w| !w.is_empty()).map(String::from).collect()).unwrap_or_default()
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

mod build_settings_tests {
    use super::*;

    #[test]
    fn has_the_expected_hooks() {
        let st = settings(false);
        let hooks = st["hooks"].as_object().unwrap();
        let mut keys: Vec<_> = hooks.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["Notification", "PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
        for (_, ev) in hooks {
            assert_eq!(ev.as_array().unwrap().len(), 1);
            assert_eq!(ev[0]["hooks"][0]["type"], "command");
        }
    }

    #[test]
    fn status_line_is_a_command_with_refresh_interval() {
        let sl = &settings(false)["statusLine"];
        assert_eq!(sl["type"], "command");
        assert_eq!(sl["refreshInterval"], 30);
        assert!(sl["command"].is_string());
    }

    #[test]
    fn permissions_deny_only_with_secrets() {
        assert!(settings(false).get("permissions").is_none());
        let st = settings(true);
        let deny: Vec<&str> = st["permissions"]["deny"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        for want in ["Bash(env)", "Bash(printenv)", "Bash(cat /proc/self/environ)"] {
            assert!(deny.contains(&want), "{want}");
        }
        assert!(deny.iter().all(|x| x.starts_with("Bash(")));
    }

    #[test]
    fn returns_valid_json_string() {
        assert!(serde_json::from_str::<Value>(&build_settings(true)).is_ok());
    }

    // Salida de `buildSettings` del TypeScript (JSON.stringify), byte por byte.
    #[test]
    fn is_byte_identical_to_the_typescript_output() {
        assert_eq!(build_settings(false), include_str!("golden/settings_no_secrets.json"));
        assert_eq!(build_settings(true), include_str!("golden/settings_secrets.json"));
    }

    #[test]
    fn keeps_the_key_order_of_the_typescript_version() {
        let v: Value = serde_json::from_str(&build_settings(true)).unwrap();
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["hooks", "statusLine", "permissions"]);
        let ev: Vec<_> = v["hooks"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(ev, ["SessionStart", "UserPromptSubmit", "PostToolUse", "Notification", "Stop"]);
    }
}

mod hook_commands {
    use super::*;

    fn setup() -> (TempDir, PathBuf) {
        let d = TempDir::new().unwrap();
        let f = d.path().join("s.status");
        (d, f)
    }

    #[test]
    fn simple_hooks_append_their_word() {
        for (event, word) in [("SessionStart", "idle"), ("UserPromptSubmit", "working"), ("PostToolUse", "working"), ("Stop", "done")] {
            let (_d, f) = setup();
            let env = [("CLAWHIP_STATUS_FILE", f.to_str().unwrap())];
            run_hook(&hook_cmd(event), "{\"hook_event_name\":\"x\"}", &env).unwrap();
            assert_eq!(words(&f), s(&[word]));
            run_hook(&hook_cmd(event), "", &env).unwrap();
            assert_eq!(words(&f), s(&[word, word]));
        }
    }

    fn notif(message: &str, extra: Value) -> String {
        let mut v = json!({ "hook_event_name": "Notification", "message": message });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v.to_string()
    }

    #[test]
    fn notification_cases() {
        let cases: Vec<(&str, String, Vec<&str>)> = vec![
            ("permission_prompt type", notif("Claude needs your attention", json!({"notification_type": "permission_prompt"})), vec!["waiting"]),
            ("elicitation_dialog type", notif("Pick one", json!({"notification_type": "elicitation_dialog"})), vec!["waiting"]),
            ("needs your permission message", notif("Claude needs your permission to use Bash", json!({})), vec!["waiting"]),
            ("idle_prompt type", notif("Claude is waiting for your input", json!({"notification_type": "idle_prompt"})), vec!["idle_prompt"]),
            ("unrelated notification", notif("Auth succeeded", json!({"notification_type": "auth_success"})), vec![]),
            ("empty payload", String::new(), vec![]),
        ];
        for (name, payload, expected) in cases {
            let (_d, f) = setup();
            let out = run_hook(&hook_cmd("Notification"), &payload, &[("CLAWHIP_STATUS_FILE", f.to_str().unwrap())]).unwrap();
            assert_eq!(out, "", "{name}");
            assert_eq!(words(&f), s(&expected), "{name}");
        }
    }

    #[test]
    fn notification_exits_0_even_on_an_unrelated_payload() {
        let (_d, f) = setup();
        run_hook(&hook_cmd("Notification"), "basura", &[("CLAWHIP_STATUS_FILE", f.to_str().unwrap())]).unwrap();
    }

    #[test]
    fn notification_with_a_big_payload_does_not_break_the_pipe() {
        let (_d, f) = setup();
        let big = notif(&"x".repeat(500_000), json!({"notification_type": "permission_prompt"}));
        run_hook(&hook_cmd("Notification"), &big, &[("CLAWHIP_STATUS_FILE", f.to_str().unwrap())]).unwrap();
        assert_eq!(words(&f), s(&["waiting"]));
    }

    #[test]
    fn hooks_work_when_the_status_file_path_contains_spaces() {
        let d = TempDir::new().unwrap();
        let f = d.path().join("dir con espacios").join("s.status");
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        run_hook(&hook_cmd("Stop"), "", &[("CLAWHIP_STATUS_FILE", f.to_str().unwrap())]).unwrap();
        assert_eq!(words(&f), s(&["done"]));
    }
}

mod status_line_command {
    use super::*;

    fn cmd() -> String {
        settings(false)["statusLine"]["command"].as_str().unwrap().to_string()
    }

    fn setup() -> (TempDir, String) {
        let d = TempDir::new().unwrap();
        let f = d.path().join("s.status").to_str().unwrap().to_string();
        (d, f)
    }

    #[test]
    fn writes_the_stdin_json_to_status_file_line_atomically() {
        let (_d, f) = setup();
        let payload = json!({"model": {"display_name": "Opus"}, "context_window": {"used_percentage": 12}}).to_string();
        let out = run_hook(&cmd(), &payload, &[("CLAWHIP_STATUS_FILE", &f)]).unwrap();
        assert_eq!(out, "");
        assert_eq!(fs::read_to_string(format!("{f}.line")).unwrap(), payload);
        assert!(!Path::new(&format!("{f}.line.tmp")).exists());
    }

    #[test]
    fn overwrites_the_previous_content() {
        let (_d, f) = setup();
        run_hook(&cmd(), "{\"a\":1}", &[("CLAWHIP_STATUS_FILE", &f)]).unwrap();
        run_hook(&cmd(), "{\"b\":2}", &[("CLAWHIP_STATUS_FILE", &f)]).unwrap();
        assert_eq!(fs::read_to_string(format!("{f}.line")).unwrap(), "{\"b\":2}");
    }

    #[test]
    fn does_not_run_a_user_status_line_when_unset_or_empty() {
        let (_d, f) = setup();
        let out = run_hook(&cmd(), "{}", &[("CLAWHIP_STATUS_FILE", &f), ("BETOOLS_USER_STATUSLINE", "")]).unwrap();
        assert_eq!(out, "");
    }

    #[test]
    fn runs_the_user_status_line_with_betools_1_and_the_same_stdin() {
        let (d, f) = setup();
        let marker = d.path().join("marker");
        let user = format!("cat > \"{}\"; printf 'B=%s' \"$BETOOLS\"", marker.display());
        let payload = "{\"model\":{\"id\":\"m\"}}";
        let out = run_hook(&cmd(), payload, &[("CLAWHIP_STATUS_FILE", &f), ("BETOOLS_USER_STATUSLINE", &user)]).unwrap();
        assert_eq!(out, "B=1");
        assert_eq!(fs::read_to_string(marker).unwrap(), payload);
        assert_eq!(fs::read_to_string(format!("{f}.line")).unwrap(), payload);
    }

    #[test]
    fn exits_0_even_when_the_user_status_line_fails() {
        let (_d, f) = setup();
        run_hook(&cmd(), "{}", &[("CLAWHIP_STATUS_FILE", &f), ("BETOOLS_USER_STATUSLINE", "exit 3")]).unwrap();
    }

    #[test]
    fn betools_1_is_visible_to_the_user_command() {
        let (_d, f) = setup();
        let out = run_hook(&cmd(), "{}", &[("CLAWHIP_STATUS_FILE", &f), ("BETOOLS_USER_STATUSLINE", "echo \"[${BETOOLS:-no}]\"")]).unwrap();
        assert_eq!(out.trim(), "[1]");
    }
}

mod user_status_line_tests {
    use super::*;

    fn write(home: &Path, content: &str) {
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(home.join(".claude").join("settings.json"), content).unwrap();
    }

    #[test]
    fn returns_the_command_from_claude_settings() {
        let h = TempDir::new().unwrap();
        write(h.path(), &json!({"statusLine": {"type": "command", "command": "echo hola"}}).to_string());
        assert_eq!(user_status_line_from(h.path()), "echo hola");
    }

    #[test]
    fn returns_empty_with_no_file_invalid_json_other_type_or_missing_command() {
        let h = TempDir::new().unwrap();
        assert_eq!(user_status_line_from(h.path()), "");
        for content in ["{ no json", r#"{"statusLine":{"type":"static","command":"x"}}"#, r#"{"statusLine":{"type":"command"}}"#, "{}"] {
            write(h.path(), content);
            assert_eq!(user_status_line_from(h.path()), "", "{content}");
        }
    }
}

mod tracker {
    use super::*;

    type Calls = Arc<Mutex<Vec<(String, SessionStatus, SessionStatus)>>>;

    struct Fx {
        _tmp: TempDir,
        dir: PathBuf,
        calls: Calls,
        tr: StatusTracker,
    }

    impl Fx {
        fn new() -> Fx {
            let tmp = TempDir::new().unwrap();
            let dir = tmp.path().join("nested").join("status");
            let calls: Calls = Arc::default();
            let c = calls.clone();
            let tr = StatusTracker::new(&dir, move |id, next, prev| c.lock().unwrap().push((id.to_string(), next, prev))).unwrap();
            Fx { _tmp: tmp, dir, calls, tr }
        }
        fn transitions(&self) -> Vec<(SessionStatus, SessionStatus)> {
            self.calls.lock().unwrap().iter().map(|c| (c.1, c.2)).collect()
        }
        fn nexts(&self) -> Vec<SessionStatus> {
            self.calls.lock().unwrap().iter().map(|c| c.1).collect()
        }
        fn wait_status(&self, id: &str, want: SessionStatus) {
            wait_for(|| self.tr.get(id) == want, &format!("{id} -> {want:?}, got {:?}", self.tr.get(id)));
        }
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            for id in ["a", "b"] {
                self.tr.forget(id);
            }
        }
    }

    fn wait_for(cond: impl Fn() -> bool, msg: &str) {
        let t = Instant::now();
        while !cond() {
            assert!(t.elapsed() < Duration::from_secs(5), "timeout: {msg}");
            sleep(Duration::from_millis(50));
        }
    }

    fn send(file: &Path, w: &[&str]) {
        let mut f = OpenOptions::new().append(true).open(file).unwrap();
        writeln!(f, "{}", w.join("\n")).unwrap();
    }

    // `word.trim()` de JS recorta U+FEFF y no recorta U+0085.
    #[test]
    fn words_are_trimmed_like_js_trim() {
        let fx = Fx::new();
        let f = fx.tr.start("a").unwrap();
        send(&f, &["\u{85}working"]);
        send(&f, &["\u{feff}\u{a0}done \r"]);
        fx.wait_status("a", Done);
        assert_eq!(fx.nexts(), [Idle, Done]);
    }

    #[test]
    fn creates_the_directory_unknown_sessions_are_stopped() {
        let fx = Fx::new();
        assert!(fx.dir.exists());
        assert_eq!(fx.tr.get("zzz"), Stopped);
    }

    #[test]
    fn start_creates_an_empty_file_returns_its_path_and_sets_idle() {
        let fx = Fx::new();
        let f = fx.tr.start("a").unwrap();
        assert_eq!(f, fx.dir.join("a.status"));
        assert_eq!(fs::read_to_string(&f).unwrap(), "");
        assert_eq!(fx.tr.get("a"), Idle);
        assert_eq!(fx.transitions(), [(Idle, Stopped)]);
    }

    #[test]
    fn transitions_working_waiting_working_done() {
        let fx = Fx::new();
        let f = fx.tr.start("a").unwrap();
        for st in [Working, Waiting, Working, Done] {
            let word = match st {
                Working => "working",
                Waiting => "waiting",
                _ => "done",
            };
            send(&f, &[word]);
            fx.wait_status("a", st);
        }
        assert_eq!(fx.transitions(), [(Idle, Stopped), (Working, Idle), (Waiting, Working), (Working, Waiting), (Done, Working)]);
    }

    #[test]
    fn processes_several_words_appended_at_once_and_ignores_unknown_ones() {
        let fx = Fx::new();
        let f = fx.tr.start("a").unwrap();
        send(&f, &["working", "basura", "done"]);
        fx.wait_status("a", Done);
        assert_eq!(fx.nexts(), [Idle, Working, Done]);
    }

    #[test]
    fn does_not_notify_when_the_state_does_not_change() {
        let fx = Fx::new();
        let f = fx.tr.start("a").unwrap();
        send(&f, &["working"]);
        fx.wait_status("a", Working);
        send(&f, &["working"]);
        send(&f, &["working", "done"]);
        fx.wait_status("a", Done);
        assert_eq!(fx.nexts(), [Idle, Working, Done]);
    }

    #[test]
    fn idle_prompt_resets_working_and_waiting_to_idle_only() {
        let fx = Fx::new();
        let f = fx.tr.start("a").unwrap();
        send(&f, &["working"]);
        fx.wait_status("a", Working);
        send(&f, &["idle_prompt"]);
        fx.wait_status("a", Idle);

        send(&f, &["waiting"]);
        fx.wait_status("a", Waiting);
        send(&f, &["idle_prompt"]);
        fx.wait_status("a", Idle);

        send(&f, &["done"]);
        fx.wait_status("a", Done);
        let n = fx.calls.lock().unwrap().len();
        send(&f, &["idle_prompt"]);
        sleep(Duration::from_millis(1000));
        assert_eq!(fx.tr.get("a"), Done);
        assert_eq!(fx.calls.lock().unwrap().len(), n);
    }

    #[test]
    fn seen_turns_done_into_idle_and_does_nothing_otherwise() {
        let fx = Fx::new();
        let f = fx.tr.start("a").unwrap();
        fx.tr.seen("a");
        assert_eq!(fx.calls.lock().unwrap().len(), 1);
        send(&f, &["working"]);
        fx.wait_status("a", Working);
        fx.tr.seen("a");
        assert_eq!(fx.tr.get("a"), Working);
        send(&f, &["done"]);
        fx.wait_status("a", Done);
        fx.tr.seen("a");
        assert_eq!(fx.tr.get("a"), Idle);
        assert_eq!(fx.calls.lock().unwrap().last().unwrap(), &("a".to_string(), Idle, Done));
    }

    #[test]
    fn interrupted_resets_working_waiting_to_idle_only() {
        let fx = Fx::new();
        let f = fx.tr.start("a").unwrap();
        send(&f, &["working"]);
        fx.wait_status("a", Working);
        fx.tr.interrupted("a");
        assert_eq!(fx.tr.get("a"), Idle);
        send(&f, &["waiting"]);
        fx.wait_status("a", Waiting);
        fx.tr.interrupted("a");
        assert_eq!(fx.tr.get("a"), Idle);
        send(&f, &["done"]);
        fx.wait_status("a", Done);
        fx.tr.interrupted("a");
        assert_eq!(fx.tr.get("a"), Done);
    }

    #[test]
    fn exited_stops_tracking_and_sets_exited_later_words_are_ignored() {
        let fx = Fx::new();
        let f = fx.tr.start("a").unwrap();
        fx.tr.exited("a");
        assert_eq!(fx.tr.get("a"), Exited);
        assert_eq!(fx.calls.lock().unwrap().last().unwrap(), &("a".to_string(), Exited, Idle));
        send(&f, &["working"]);
        sleep(Duration::from_millis(1000));
        assert_eq!(fx.tr.get("a"), Exited);
    }

    #[test]
    fn forget_drops_the_state_without_notifying() {
        let fx = Fx::new();
        fx.tr.start("a").unwrap();
        let n = fx.calls.lock().unwrap().len();
        fx.tr.forget("a");
        assert_eq!(fx.tr.get("a"), Stopped);
        assert_eq!(fx.calls.lock().unwrap().len(), n);
    }

    #[test]
    fn restart_via_start_truncates_the_file_and_resets_the_offset() {
        let fx = Fx::new();
        let f = fx.tr.start("a").unwrap();
        send(&f, &["working", "working", "done"]);
        fx.wait_status("a", Done);
        let f2 = fx.tr.start("a").unwrap();
        assert_eq!(f2, f);
        assert_eq!(fx.tr.get("a"), Idle);
        send(&f2, &["working"]);
        fx.wait_status("a", Working);
    }

    #[test]
    fn tracks_sessions_independently() {
        let fx = Fx::new();
        let fa = fx.tr.start("a").unwrap();
        let fb = fx.tr.start("b").unwrap();
        send(&fa, &["working"]);
        send(&fb, &["done"]);
        wait_for(|| fx.tr.get("a") == Working && fx.tr.get("b") == Done, "independent sessions");
    }

    #[test]
    fn works_end_to_end_with_the_real_hook_commands() {
        let fx = Fx::new();
        let f = fx.tr.start("a").unwrap();
        let env = [("CLAWHIP_STATUS_FILE", f.to_str().unwrap())];
        run_hook(&hook_cmd("UserPromptSubmit"), "", &env).unwrap();
        fx.wait_status("a", Working);
        run_hook(&hook_cmd("Notification"), "{\"notification_type\":\"permission_prompt\"}", &env).unwrap();
        fx.wait_status("a", Waiting);
        run_hook(&hook_cmd("Stop"), "", &env).unwrap();
        fx.wait_status("a", Done);
    }
}
