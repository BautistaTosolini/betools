// Puerto de test/unit/transcript-parser.test.ts
use betools_transcripts::{TranscriptParser, INTERRUPTED};
use betools_types::{ArtifactSource as S, ConversationItem, ConversationKind as K, NoticeLevel as L};
use serde_json::{json, Value};
use std::fs;
use std::time::{Duration, SystemTime};

const TS: &str = "2026-01-01T10:00:00.000Z";

fn jl(objs: &[Value]) -> String {
    objs.iter().map(|o| o.to_string()).collect::<Vec<_>>().join("\n") + "\n"
}
fn merge(mut base: Value, extra: Value) -> Value {
    if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    base
}
fn user(content: Value) -> Value {
    user_x(content, json!({}))
}
fn user_x(content: Value, extra: Value) -> Value {
    merge(json!({"type":"user","timestamp":TS,"message":{"role":"user","content":content}}), extra)
}
fn asst(content: Value) -> Value {
    asst_x(content, json!({}), json!({}))
}
fn asst_x(content: Value, extra: Value, msg: Value) -> Value {
    merge(json!({"type":"assistant","timestamp":TS,"message":merge(json!({"id":"m1","role":"assistant","content":content}), msg)}), extra)
}
fn sys(subtype: &str, extra: Value) -> Value {
    merge(json!({"type":"system","subtype":subtype,"timestamp":TS}), extra)
}
fn parse(objs: &[Value]) -> TranscriptParser {
    let mut p = TranscriptParser::new();
    p.push(jl(objs).as_bytes());
    p
}
fn texts(p: &TranscriptParser) -> Vec<String> {
    p.items().iter().map(|i| i.text.clone()).collect()
}
fn it(kind: K, text: &str) -> ConversationItem {
    ConversationItem { kind, text: text.into(), at: TS.into(), msg_id: None, tool: None, level: None }
}
fn notice(level: L, text: &str) -> ConversationItem {
    ConversationItem { level: Some(level), ..it(K::Notice, text) }
}
fn kinds(p: &TranscriptParser) -> Vec<K> {
    p.items().iter().map(|i| i.kind).collect()
}

mod chunking {
    use super::*;

    #[test]
    fn false_for_empty_chunks_invalid_json_and_blank_lines() {
        let mut p = TranscriptParser::new();
        assert!(!p.push(b""));
        assert!(!p.push(b"not json\n\n{broken\n"));
        assert!(p.items().is_empty());
    }

    #[test]
    fn line_split_across_chunks() {
        let mut p = TranscriptParser::new();
        let data = jl(&[user(json!("hola mundo"))]).into_bytes();
        p.push(&data[..20]);
        assert_eq!(p.items().len(), 0);
        p.push(&data[20..]);
        assert_eq!(texts(&p), ["hola mundo"]);
    }

    #[test]
    fn split_in_the_middle_of_a_multibyte_char() {
        let mut p = TranscriptParser::new();
        let data = jl(&[user(json!("canción 日本 😀"))]).into_bytes();
        let emoji = "😀".as_bytes();
        let idx = data.windows(4).position(|w| w == emoji).unwrap() + 2;
        p.push(&data[..idx]);
        p.push(&data[idx..]);
        assert_eq!(p.items()[0].text, "canción 日本 😀");
    }

    #[test]
    fn trailing_incomplete_line_waits_for_newline() {
        let mut p = TranscriptParser::new();
        p.push(user(json!("uno")).to_string().as_bytes());
        assert_eq!(p.items().len(), 0);
        p.push(b"\n");
        assert_eq!(p.items().len(), 1);
    }

    #[test]
    fn several_lines_in_one_chunk() {
        let p = parse(&[user(json!("a")), user(json!("b")), user(json!("c"))]);
        assert_eq!(texts(&p), ["a", "b", "c"]);
    }

    #[test]
    fn true_when_something_changed() {
        let mut p = TranscriptParser::new();
        assert!(p.push(jl(&[json!({"type":"ai-title","aiTitle":"x"})]).as_bytes()));
        assert!(p.push(jl(&[asst_x(json!([]), json!({}), json!({"model":"claude-x"}))]).as_bytes()));
        assert!(!p.push(jl(&[asst_x(json!([]), json!({}), json!({"model":"claude-x"}))]).as_bytes()));
    }
}

mod user_messages {
    use super::*;

    #[test]
    fn string_content() {
        assert_eq!(parse(&[user(json!("  hola  "))]).items(), [it(K::User, "hola")]);
    }

    #[test]
    fn array_content_with_text_and_image() {
        let p = parse(&[user(json!([{"type":"text","text":"mira esto"},{"type":"image","source":{}}]))]);
        assert_eq!(texts(&p), ["mira esto", "[image]"]);
        assert_eq!(kinds(&p), [K::User, K::User]);
    }

    #[test]
    fn skips_empty_text() {
        assert!(parse(&[user(json!("   "))]).items().is_empty());
    }

    #[test]
    fn skips_is_meta() {
        assert!(parse(&[user_x(json!("meta"), json!({"isMeta":true}))]).items().is_empty());
    }

    #[test]
    fn compact_summary() {
        let p = parse(&[user_x(json!("long summary..."), json!({"isCompactSummary":true}))]);
        assert_eq!(p.items(), [it(K::Summary, "Conversation compacted")]);
    }

    #[test]
    fn command_with_args() {
        let p = parse(&[user(json!("<command-message>x</command-message><command-name>/model</command-name><command-args> opus </command-args>"))]);
        assert_eq!(p.items(), [it(K::Command, "/model opus")]);
    }

    #[test]
    fn command_without_args() {
        let p = parse(&[user(json!("<command-name>/clear</command-name><command-args></command-args>"))]);
        assert_eq!(p.items()[0].text, "/clear");
    }

    #[test]
    fn bash_input() {
        let p = parse(&[user(json!("<bash-input>ls -la</bash-input>"))]);
        assert_eq!(p.items(), [it(K::Command, "! ls -la")]);
    }

    #[test]
    fn skips_internal_tags() {
        for t in ["<local-command-stdout>x</local-command-stdout>", "<bash-stdout>x</bash-stdout>", "<system-reminder>x</system-reminder>", "<command-foo>x"] {
            assert!(parse(&[user(json!(t))]).items().is_empty(), "{t}");
        }
    }

    #[test]
    fn interruption_becomes_summary() {
        let p = parse(&[user(json!([{"type":"text","text":"[Request interrupted by user for tool use]"}]))]);
        assert_eq!(p.items(), [it(K::Summary, INTERRUPTED)]);
        assert_eq!(INTERRUPTED, "Interrupted by user");
    }

    #[test]
    fn queued_command_with_human_origin() {
        let p = parse(&[json!({"type":"attachment","timestamp":TS,"attachment":{"type":"queued_command","prompt":"  sigue  ","origin":{"kind":"human"}}})]);
        assert_eq!(p.items(), [it(K::User, "sigue")]);
    }

    #[test]
    fn queued_command_human_turn_counts_other_origins_do_not() {
        let p = parse(&[
            json!({"type":"attachment","timestamp":TS,"attachment":{"type":"queued_command","prompt":"a","humanTurn":true}}),
            json!({"type":"attachment","timestamp":TS,"attachment":{"type":"queued_command","prompt":"b","origin":{"kind":"task-notification"}}}),
        ]);
        assert_eq!(texts(&p), ["a"]);
    }

    #[test]
    fn task_notification_done_by_default() {
        let p = parse(&[user(json!("<task-notification><status>completed</status><summary>Build ok</summary></task-notification>"))]);
        assert_eq!(p.items(), [notice(L::Done, "Build ok")]);
    }

    #[test]
    fn task_notification_failures_are_errors() {
        for status in ["failed", "error", "killed", "stopped"] {
            let p = parse(&[user(json!(format!("<task-notification><status>{status}</status><summary>Algo</summary></task-notification>")))]);
            assert_eq!(p.items(), [notice(L::Error, "Algo")], "{status}");
        }
    }

    #[test]
    fn task_notification_without_summary_yields_nothing() {
        assert!(parse(&[user(json!("<task-notification><status>completed</status></task-notification>"))]).items().is_empty());
    }

    #[test]
    fn uses_current_time_without_timestamp() {
        let p = parse(&[json!({"type":"user","message":{"content":"x"}})]);
        let at = chrono::DateTime::parse_from_rfc3339(&p.items()[0].at).unwrap().timestamp_millis();
        assert!(at > chrono::Utc::now().timestamp_millis() - 5000);
    }
}

mod answers {
    use super::*;

    #[test]
    fn tool_use_result_answers() {
        let p = parse(&[user_x(
            json!([{"type":"tool_result","tool_use_id":"zz","content":"ok"}]),
            json!({"toolUseResult":{"answers":{"¿Color?":"rojo","¿N?":3}}}),
        )]);
        let item = p.items().iter().find(|i| i.kind == K::Answers).unwrap();
        let v: Value = serde_json::from_str(&item.text).unwrap();
        assert_eq!(v, json!([{"q":"¿Color?","a":"rojo"},{"q":"¿N?","a":"3"}]));
    }

    #[test]
    fn empty_or_array_answers_are_ignored() {
        for a in [json!({}), json!(["a"])] {
            let p = parse(&[user_x(json!("x"), json!({"toolUseResult":{"answers":a}}))]);
            assert!(p.items().iter().all(|i| i.kind != K::Answers));
        }
    }
}

mod local_command {
    use super::*;
    fn lc(c: &str) -> Value {
        sys("local_command", json!({"content": c}))
    }

    #[test]
    fn command_entry() {
        let p = parse(&[lc("<command-name>/context</command-name><command-args>a b</command-args>")]);
        assert_eq!(p.items(), [it(K::Command, "/context a b")]);
    }

    #[test]
    fn stdout_attached_with_nul_and_ansi_stripped() {
        let p = parse(&[lc("<command-name>/context</command-name>"), lc("<local-command-stdout>\x1b[1mHola\x1b[0m mundo</local-command-stdout>")]);
        assert_eq!(p.items().len(), 1);
        assert_eq!(p.items()[0].text, "/context\u{0}Hola mundo");
    }

    #[test]
    fn stderr_attached_too() {
        let p = parse(&[lc("<command-name>/x</command-name>"), lc("<local-command-stderr>boom</local-command-stderr>")]);
        assert_eq!(p.items()[0].text, "/x\u{0}boom");
    }

    #[test]
    fn second_output_not_attached_again() {
        let p = parse(&[lc("<command-name>/x</command-name>"), lc("<local-command-stdout>uno</local-command-stdout>"), lc("<local-command-stdout>dos</local-command-stdout>")]);
        assert_eq!(p.items()[0].text, "/x\u{0}uno");
    }

    #[test]
    fn stdout_without_previous_command_dropped() {
        assert!(parse(&[lc("<local-command-stdout>huérfano</local-command-stdout>")]).items().is_empty());
    }

    #[test]
    fn empty_stdout_ignored() {
        let p = parse(&[lc("<command-name>/x</command-name>"), lc("<local-command-stdout>  </local-command-stdout>")]);
        assert_eq!(p.items()[0].text, "/x");
    }

    #[test]
    fn stdout_after_non_command_dropped() {
        let p = parse(&[user(json!("hola")), lc("<local-command-stdout>x</local-command-stdout>")]);
        assert_eq!(texts(&p), ["hola"]);
    }
}

mod notices {
    use super::*;

    #[test]
    fn away_summary_becomes_recap() {
        let p = parse(&[sys("away_summary", json!({"content":"Trabajaste en X. (turn off recaps in /config)"}))]);
        assert_eq!(p.items()[0], notice(L::Info, "Recap: Trabajaste en X."));
    }

    #[test]
    fn informational() {
        let p = parse(&[sys("informational", json!({"content":"Aviso"}))]);
        assert_eq!(p.items()[0], notice(L::Info, "Aviso"));
    }

    #[test]
    fn turn_duration() {
        for (ms, text) in [
            (13_000, "Worked for 13s"),
            (400, "Worked for 0s"),
            (59_400, "Worked for 59s"),
            (60_000, "Worked for 1m 0s"),
            (125_000, "Worked for 2m 5s"),
            (3_600_000, "Worked for 1h 0m"),
            (3_725_000, "Worked for 1h 2m"),
        ] {
            let p = parse(&[sys("turn_duration", json!({"durationMs": ms}))]);
            assert_eq!(p.items()[0], notice(L::Done, text), "{ms}");
        }
    }

    #[test]
    fn stop_hook_summary_with_errors() {
        let p = parse(&[sys("stop_hook_summary", json!({"hookErrors":["fallo uno","fallo dos"]}))]);
        assert_eq!(p.items()[0], notice(L::Error, "Stop hook error: fallo uno · fallo dos"));
    }

    #[test]
    fn stop_hook_summary_without_errors() {
        assert!(parse(&[sys("stop_hook_summary", json!({"hookErrors":[]}))]).items().is_empty());
        assert!(parse(&[sys("stop_hook_summary", json!({}))]).items().is_empty());
    }

    #[test]
    fn model_refusal_fallback_is_a_warning() {
        let p = parse(&[sys("model_refusal_fallback", json!({"content":"Cambio de modelo"}))]);
        assert_eq!(p.items()[0], notice(L::Warn, "Cambio de modelo"));
    }

    #[test]
    fn subtype_containing_error() {
        let p = parse(&[sys("api_error", json!({"content":"Rate limit"}))]);
        assert_eq!(p.items()[0], notice(L::Error, "Rate limit"));
    }

    #[test]
    fn unknown_subtype_produces_nothing() {
        assert!(parse(&[sys("whatever", json!({"content":"x"}))]).items().is_empty());
    }
}

mod assistant {
    use super::*;
    fn text(t: &str) -> Value {
        json!([{"type":"text","text":t}])
    }

    #[test]
    fn same_message_id_merges() {
        let p = parse(&[asst(text("Uno")), asst(text("Dos"))]);
        assert_eq!(p.items().len(), 1);
        assert_eq!(p.items()[0].kind, K::Assistant);
        assert_eq!(p.items()[0].text, "Uno\n\nDos");
        assert_eq!(p.items()[0].msg_id.as_deref(), Some("m1"));
    }

    #[test]
    fn different_message_id_not_merged() {
        let p = parse(&[asst_x(text("Uno"), json!({}), json!({"id":"a"})), asst_x(text("Dos"), json!({}), json!({"id":"b"}))]);
        assert_eq!(p.items().len(), 2);
    }

    #[test]
    fn no_msg_id_not_merged() {
        let p = parse(&[
            json!({"type":"assistant","timestamp":TS,"message":{"content":[{"type":"text","text":"a"}]}}),
            json!({"type":"assistant","timestamp":TS,"message":{"content":[{"type":"text","text":"b"}]}}),
        ]);
        assert_eq!(p.items().len(), 2);
    }

    #[test]
    fn ignores_blank_text() {
        assert!(parse(&[asst(text("  "))]).items().is_empty());
    }

    #[test]
    fn keeps_only_non_empty_thinking() {
        let p = parse(&[asst(json!([{"type":"thinking","thinking":""},{"type":"thinking","thinking":" pienso "}]))]);
        assert_eq!(p.items().len(), 1);
        let i = &p.items()[0];
        assert_eq!((i.kind, i.text.as_str(), i.msg_id.as_deref()), (K::Thinking, "pienso", Some("m1")));
    }

    #[test]
    fn thinking_then_text_stay_separate() {
        let p = parse(&[asst(json!([{"type":"thinking","thinking":"a"},{"type":"text","text":"b"}]))]);
        assert_eq!(kinds(&p), [K::Thinking, K::Assistant]);
    }
}

mod tools {
    use super::*;
    fn tu(id: &str, name: &str, input: Value) -> Value {
        asst_x(json!([{"type":"tool_use","id":id,"name":name,"input":input}]), json!({}), json!({"id": format!("m-{id}")}))
    }
    fn tr(id: &str, content: Value) -> Value {
        tr_x(id, content, json!({}), false)
    }
    fn tr_x(id: &str, content: Value, extra: Value, is_error: bool) -> Value {
        let mut c = json!({"type":"tool_result","tool_use_id":id,"content":content});
        if is_error {
            c["is_error"] = json!(true);
        }
        user_x(json!([c]), extra)
    }

    #[test]
    fn tool_use_creates_item_not_done() {
        let p = parse(&[tu("t1", "Read", json!({"file_path":"/a/b.ts"}))]);
        assert_eq!(p.items()[0].kind, K::Tool);
        assert_eq!(p.items()[0].text, "Read: /a/b.ts");
        let t = p.items()[0].tool.as_ref().unwrap();
        assert_eq!((t.id.as_str(), t.name.as_str(), t.input.as_str(), t.done), ("t1", "Read", "/a/b.ts", false));
        assert!(t.edits.is_none() && t.result.is_none() && t.error.is_none());
    }

    #[test]
    fn bash_input_has_description_header() {
        let p = parse(&[tu("t1", "Bash", json!({"command":"ls -la","description":"Lista"}))]);
        assert_eq!(p.items()[0].tool.as_ref().unwrap().input, "# Lista\nls -la");
        assert_eq!(p.items()[0].text, "Bash: ls -la");
    }

    #[test]
    fn bash_without_description() {
        assert_eq!(parse(&[tu("t1", "Bash", json!({"command":"pwd"}))]).items()[0].tool.as_ref().unwrap().input, "pwd");
    }

    #[test]
    fn other_tools_show_json_input() {
        let p = parse(&[tu("t1", "Grep", json!({"pattern":"foo"})), tu("t2", "Foo", json!({}))]);
        let v: Value = serde_json::from_str(&p.items()[0].tool.as_ref().unwrap().input).unwrap();
        assert_eq!(v, json!({"pattern":"foo"}));
        assert_eq!(p.items()[0].text, "Grep: foo");
        assert_eq!(p.items()[1].text, "Foo");
    }

    #[test]
    fn pretty_json_matches_js_stringify() {
        let p = parse(&[tu("t1", "Grep", json!({"pattern":"foo","n":[1,2]}))]);
        assert_eq!(p.items()[0].tool.as_ref().unwrap().input, "{\n  \"pattern\": \"foo\",\n  \"n\": [\n    1,\n    2\n  ]\n}");
    }

    #[test]
    fn summary_collapses_whitespace_and_truncates() {
        let cmd = format!("a\n  b{}", "x".repeat(300));
        let p = parse(&[tu("t1", "Bash", json!({"command": cmd}))]);
        let t = &p.items()[0].text;
        assert!(t.starts_with("Bash: a bxxx"));
        assert!(t.ends_with('…'));
        assert_eq!(t.chars().count(), "Bash: ".len() + 241);
    }

    #[test]
    fn server_tool_use_also_creates_item() {
        let p = parse(&[asst(json!([{"type":"server_tool_use","id":"s1","name":"web_search","input":{"query":"q"}}]))]);
        assert_eq!(p.items()[0].tool.as_ref().unwrap().name, "web_search");
    }

    #[test]
    fn edit_multiedit_write_produce_edits() {
        let p = parse(&[
            tu("e", "Edit", json!({"file_path":"/x","old_string":"a","new_string":"b"})),
            tu("m", "MultiEdit", json!({"file_path":"/x","edits":[{"old_string":"1","new_string":"2"},{"old_string":"3","new_string":"4"}]})),
            tu("w", "Write", json!({"file_path":"/y","content":"hola"})),
        ]);
        let e = |i: usize| serde_json::to_value(p.items()[i].tool.as_ref().unwrap().edits.as_ref().unwrap()).unwrap();
        assert_eq!(e(0), json!([{"old":"a","new":"b"}]));
        assert_eq!(e(1), json!([{"old":"1","new":"2"},{"old":"3","new":"4"}]));
        assert_eq!(e(2), json!([{"old":"","new":"hola"}]));
    }

    #[test]
    fn multiedit_limited_to_20_and_long_strings_clipped() {
        let edits: Vec<Value> = (0..25).map(|i| json!({"old_string": i.to_string(), "new_string": "z".repeat(3500)})).collect();
        let p = parse(&[tu("m", "MultiEdit", json!({"file_path":"/x","edits":edits}))]);
        let e = p.items()[0].tool.as_ref().unwrap().edits.as_ref().unwrap();
        assert_eq!(e.len(), 20);
        assert!(e[0].new.contains("… (500 more characters)"));
    }

    #[test]
    fn tool_input_clipped_at_4000() {
        let p = parse(&[tu("t", "Bash", json!({"command":"x".repeat(4100)}))]);
        assert!(p.items()[0].tool.as_ref().unwrap().input.contains("… (100 more characters)"));
    }

    #[test]
    fn clip_counts_utf16_units() {
        // Cada emoji son 2 unidades UTF-16: 2100 emojis son 4200 unidades, 200 de más.
        let p = parse(&[tu("t", "Bash", json!({"command":"😀".repeat(2100)}))]);
        assert!(p.items()[0].tool.as_ref().unwrap().input.contains("… (200 more characters)"));
    }

    #[test]
    fn tool_result_completes_item() {
        let p = parse(&[tu("t1", "Bash", json!({"command":"echo"})), tr("t1", json!("salida"))]);
        assert_eq!(p.items().len(), 1);
        let t = p.items()[0].tool.as_ref().unwrap();
        assert_eq!((t.done, t.result.as_deref(), t.error), (true, Some("salida"), Some(false)));
    }

    #[test]
    fn tool_result_array_content() {
        let p = parse(&[tu("t1", "Read", json!({"file_path":"/a"})), tr("t1", json!([{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]))]);
        assert_eq!(p.items()[0].tool.as_ref().unwrap().result.as_deref(), Some("a\n[image]\nb"));
    }

    #[test]
    fn is_error_sets_error() {
        let p = parse(&[tu("t1", "Bash", json!({"command":"false"})), tr_x("t1", json!("fail"), json!({}), true)]);
        let t = p.items()[0].tool.as_ref().unwrap();
        assert_eq!((t.done, t.error, t.result.as_deref()), (true, Some(true), Some("fail")));
    }

    #[test]
    fn bash_stdout_stderr_preferred() {
        let p = parse(&[tu("t1", "Bash", json!({"command":"x"})), tr_x("t1", json!("contenido crudo"), json!({"toolUseResult":{"stdout":"out","stderr":"err"}}), false)]);
        assert_eq!(p.items()[0].tool.as_ref().unwrap().result.as_deref(), Some("out\nerr"));
    }

    #[test]
    fn empty_stdout_stderr_dropped() {
        let p = parse(&[tu("t1", "Bash", json!({"command":"x"})), tr_x("t1", json!("raw"), json!({"toolUseResult":{"stdout":"  ","stderr":"solo err"}}), false)]);
        assert_eq!(p.items()[0].tool.as_ref().unwrap().result.as_deref(), Some("solo err"));
    }

    #[test]
    fn tool_use_result_without_stdout_falls_back() {
        let p = parse(&[tu("t1", "Read", json!({"file_path":"/a"})), tr_x("t1", json!("raw"), json!({"toolUseResult":{"file":{}}}), false)]);
        assert_eq!(p.items()[0].tool.as_ref().unwrap().result.as_deref(), Some("raw"));
    }

    #[test]
    fn strips_system_reminder_and_ansi() {
        let p = parse(&[tu("t1", "Read", json!({"file_path":"/a"})), tr("t1", json!("dato\n<system-reminder>\nsecreto\n</system-reminder>\x1b[31m rojo\x1b[0m"))]);
        assert_eq!(p.items()[0].tool.as_ref().unwrap().result.as_deref(), Some("dato\n rojo"));
    }

    #[test]
    fn clips_results_at_6000() {
        let p = parse(&[tu("t1", "Bash", json!({"command":"x"})), tr("t1", json!("y".repeat(6050)))]);
        let r = p.items()[0].tool.as_ref().unwrap().result.clone().unwrap();
        assert!(r.starts_with(&"y".repeat(6000)));
        assert!(r.ends_with("… (50 more characters)"));
    }

    #[test]
    fn result_without_matching_tool_ignored() {
        assert!(parse(&[tr("nada", json!("x"))]).items().is_empty());
    }

    #[test]
    fn second_result_changes_nothing() {
        let p = parse(&[tu("t1", "Bash", json!({"command":"x"})), tr("t1", json!("primero")), tr("t1", json!("segundo"))]);
        assert_eq!(p.items()[0].tool.as_ref().unwrap().result.as_deref(), Some("primero"));
    }

    #[test]
    fn tool_result_creates_no_user_item() {
        let p = parse(&[tu("t1", "Bash", json!({"command":"x"})), tr("t1", json!("ok"))]);
        assert_eq!(kinds(&p), [K::Tool]);
    }
}

mod sidechain {
    use super::*;

    #[test]
    fn ignored_for_the_conversation() {
        let p = parse(&[
            user_x(json!("subagente"), json!({"isSidechain":true})),
            asst_x(json!([{"type":"text","text":"x"}]), json!({"isSidechain":true}), json!({})),
            user(json!("real")),
        ]);
        assert_eq!(texts(&p), ["real"]);
    }

    #[test]
    fn still_contributes_to_artifacts_and_model() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let file = dir.path().join("a.md");
        let p = parse(&[asst_x(
            json!([{"type":"tool_use","id":"w","name":"Write","input":{"file_path":file}}]),
            json!({"isSidechain":true,"cwd":cwd}),
            json!({"model":"claude-sub"}),
        )]);
        assert!(p.items().is_empty());
        assert_eq!(p.list().len(), 1);
        assert_eq!(p.model(), Some("claude-sub"));
    }
}

mod take_changed_from {
    use super::*;

    #[test]
    fn none_initially_and_after_being_taken() {
        let mut p = TranscriptParser::new();
        assert_eq!(p.take_changed_from(), None);
        p.push(jl(&[user(json!("a"))]).as_bytes());
        assert_eq!(p.take_changed_from(), Some(0));
        assert_eq!(p.take_changed_from(), None);
    }

    #[test]
    fn index_of_first_new_item() {
        let mut p = parse(&[user(json!("a")), user(json!("b"))]);
        p.take_changed_from();
        p.push(jl(&[user(json!("c")), user(json!("d"))]).as_bytes());
        assert_eq!(p.take_changed_from(), Some(2));
    }

    #[test]
    fn earlier_index_when_tool_result_updates_earlier_item() {
        let mut p = parse(&[asst(json!([{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"x"}}])), user(json!("b")), user(json!("c"))]);
        p.take_changed_from();
        p.push(jl(&[user(json!([{"type":"tool_result","tool_use_id":"t1","content":"ok"}])), user(json!("d"))]).as_bytes());
        assert_eq!(p.items().len(), 4);
        assert_eq!(p.take_changed_from(), Some(0));
    }

    #[test]
    fn merged_assistant_text_touches_existing_index() {
        let mut p = parse(&[user(json!("a")), asst(json!([{"type":"text","text":"x"}]))]);
        p.take_changed_from();
        p.push(jl(&[asst(json!([{"type":"text","text":"y"}]))]).as_bytes());
        assert_eq!(p.take_changed_from(), Some(1));
    }
}

mod title_and_model {
    use super::*;

    #[test]
    fn ai_title_alone() {
        assert_eq!(parse(&[json!({"type":"ai-title","aiTitle":"  Titulo IA "})]).title(), Some("Titulo IA"));
    }

    #[test]
    fn custom_title_beats_ai_title_in_any_order() {
        let (c, a) = (json!({"type":"custom-title","customTitle":"Mío"}), json!({"type":"ai-title","aiTitle":"IA"}));
        assert_eq!(parse(&[c.clone(), a.clone()]).title(), Some("Mío"));
        assert_eq!(parse(&[a, c]).title(), Some("Mío"));
    }

    #[test]
    fn empty_custom_title_falls_back() {
        let p = parse(&[json!({"type":"ai-title","aiTitle":"IA"}), json!({"type":"custom-title","customTitle":"  "})]);
        assert_eq!(p.title(), Some("IA"));
        assert_eq!(TranscriptParser::new().title(), None);
    }

    #[test]
    fn model_tracks_last_assistant_model() {
        let p = parse(&[asst_x(json!([]), json!({}), json!({"model":"claude-a"})), asst_x(json!([]), json!({}), json!({"model":"claude-b"}))]);
        assert_eq!(p.model(), Some("claude-b"));
    }

    #[test]
    fn model_ignores_synthetic() {
        let p = parse(&[asst_x(json!([]), json!({}), json!({"model":"claude-a"})), asst_x(json!([]), json!({}), json!({"model":"<synthetic>"}))]);
        assert_eq!(p.model(), Some("claude-a"));
        assert_eq!(TranscriptParser::new().model(), None);
    }

    #[test]
    fn model_only_from_assistant() {
        assert_eq!(parse(&[json!({"type":"user","timestamp":TS,"message":{"model":"x","content":"a"}})]).model(), None);
    }
}

mod artifacts {
    use super::*;
    use std::path::{Path, PathBuf};

    fn w(dir: &Path, id: &str, name: &str, input: Value, at: &str) -> Value {
        asst_x(json!([{"type":"tool_use","id":id,"name":name,"input":input}]), json!({"cwd":dir,"timestamp":at}), json!({"id": format!("m-{id}")}))
    }
    fn wd(dir: &Path, id: &str, name: &str, input: Value) -> Value {
        w(dir, id, name, input, TS)
    }
    fn home() -> PathBuf {
        dirs::home_dir().unwrap()
    }
    fn paths(p: &TranscriptParser) -> Vec<String> {
        p.list().into_iter().map(|a| a.path).collect()
    }
    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn file_tools_register_paths_with_source() {
        let d = tmp();
        let p = parse(&[
            wd(d.path(), "1", "Write", json!({"file_path":"/p/a.md"})),
            wd(d.path(), "2", "Edit", json!({"file_path":"/p/b.ts"})),
            wd(d.path(), "3", "MultiEdit", json!({"file_path":"/p/c.json"})),
            wd(d.path(), "4", "NotebookEdit", json!({"notebook_path":"/p/d.ipynb"})),
        ]);
        let by = |path: &str| p.list().into_iter().find(|a| a.path == path).unwrap();
        let a = by("/p/a.md");
        assert_eq!((a.name.as_str(), a.ext.as_str(), a.sources.clone(), a.is_document, a.exists), ("a.md", ".md", vec![S::Write], true, false));
        let b = by("/p/b.ts");
        assert_eq!((b.sources.clone(), b.is_document), (vec![S::Edit], false));
        assert_eq!(by("/p/c.json").sources, [S::MultiEdit]);
        assert_eq!(by("/p/d.ipynb").sources, [S::NotebookEdit]);
    }

    #[test]
    fn relative_paths_resolve_against_cwd() {
        let d = tmp();
        let l = parse(&[wd(d.path(), "1", "Write", json!({"file_path":"sub/../informe.pdf"}))]).list();
        assert_eq!(l[0].path, d.path().join("informe.pdf").to_str().unwrap());
    }

    #[test]
    fn relative_path_without_cwd_ignored() {
        let l = parse(&[asst(json!([{"type":"tool_use","id":"1","name":"Write","input":{"file_path":"x.md"}}]))]).list();
        assert!(l.is_empty());
    }

    #[test]
    fn tilde_expands_to_home() {
        let d = tmp();
        let l = parse(&[wd(d.path(), "1", "Write", json!({"file_path":"~/docs/x.md"}))]).list();
        assert_eq!(l[0].path, home().join("docs").join("x.md").to_str().unwrap());
    }

    #[test]
    fn paths_under_claude_projects_ignored() {
        let d = tmp();
        let l = parse(&[
            wd(d.path(), "1", "Write", json!({"file_path": home().join(".claude/projects/p/memory/m.md")})),
            wd(d.path(), "2", "Write", json!({"file_path":"~/.claude/projects/z.md"})),
            wd(d.path(), "3", "Write", json!({"file_path": home().join(".claude/other.md")})),
        ]);
        assert_eq!(paths(&l), [home().join(".claude/other.md").to_str().unwrap()]);
    }

    #[test]
    fn merges_sources_first_and_last_at() {
        let d = tmp();
        let l = parse(&[
            w(d.path(), "1", "Write", json!({"file_path":"/p/a.md"}), "2026-01-01T10:00:00.000Z"),
            w(d.path(), "2", "Edit", json!({"file_path":"/p/a.md"}), "2026-01-01T11:00:00.000Z"),
            w(d.path(), "3", "Edit", json!({"file_path":"/p/a.md"}), "2026-01-01T09:00:00.000Z"),
        ])
        .list();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].sources, [S::Write, S::Edit]);
        assert_eq!(l[0].first_at, "2026-01-01T10:00:00.000Z");
        assert_eq!(l[0].last_at, "2026-01-01T11:00:00.000Z");
    }

    #[test]
    fn sorts_by_last_at_descending() {
        let d = tmp();
        let l = parse(&[
            w(d.path(), "1", "Write", json!({"file_path":"/p/old.md"}), "2026-01-01T10:00:00.000Z"),
            w(d.path(), "2", "Write", json!({"file_path":"/p/new.md"}), "2026-01-03T10:00:00.000Z"),
            w(d.path(), "3", "Write", json!({"file_path":"/p/mid.md"}), "2026-01-02T10:00:00.000Z"),
        ])
        .list();
        assert_eq!(l.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["new.md", "mid.md", "old.md"]);
    }

    #[test]
    fn is_document_depends_on_extension() {
        let d = tmp();
        let l = parse(&[
            wd(d.path(), "1", "Write", json!({"file_path":"/p/A.PDF"})),
            wd(d.path(), "2", "Write", json!({"file_path":"/p/b.rs"})),
            wd(d.path(), "3", "Write", json!({"file_path":"/p/noext"})),
        ])
        .list();
        let by = |n: &str| l.iter().find(|a| a.name == n).unwrap().clone();
        assert_eq!((by("A.PDF").ext, by("A.PDF").is_document), (".pdf".to_string(), true));
        assert!(!by("b.rs").is_document);
        assert_eq!((by("noext").ext, by("noext").is_document), (String::new(), false));
    }

    #[test]
    fn exists_reflects_file_system() {
        let d = tmp();
        let f = d.path().join("real.md");
        fs::write(&f, "x").unwrap();
        let l = parse(&[wd(d.path(), "1", "Write", json!({"file_path":f}))]).list();
        assert!(l[0].exists);
    }

    #[test]
    fn erroring_result_undoes_operation() {
        let d = tmp();
        let p = parse(&[wd(d.path(), "1", "Write", json!({"file_path":"/p/a.md"})), user(json!([{"type":"tool_result","tool_use_id":"1","content":"denied","is_error":true}]))]);
        assert!(p.list().is_empty());
    }

    #[test]
    fn error_undoes_only_one_of_several_ops_on_same_path() {
        let d = tmp();
        let p = parse(&[
            wd(d.path(), "1", "Write", json!({"file_path":"/p/a.md"})),
            wd(d.path(), "2", "Edit", json!({"file_path":"/p/a.md"})),
            user(json!([{"type":"tool_result","tool_use_id":"2","content":"x","is_error":true}])),
        ]);
        assert_eq!(p.list().len(), 1);
    }

    #[test]
    fn successful_result_keeps_artifact() {
        let d = tmp();
        let p = parse(&[wd(d.path(), "1", "Write", json!({"file_path":"/p/a.md"})), user(json!([{"type":"tool_result","tool_use_id":"1","content":"ok"}]))]);
        assert_eq!(p.list().len(), 1);
    }

    mod bash_heuristic {
        use super::*;
        fn bash(dir: &Path, cmd: &str, at: &str) -> Value {
            w(dir, "b", "Bash", json!({"command": cmd}), at)
        }
        fn now() -> String {
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        }
        fn set_mtime(f: &Path, t: SystemTime) {
            fs::File::options().write(true).open(f).unwrap().set_modified(t).unwrap();
        }

        #[test]
        fn counts_document_modified_after_timestamp_minus_2s() {
            let d = tmp();
            let f = d.path().join("reporte.pdf");
            fs::write(&f, "x").unwrap();
            let l = parse(&[bash(d.path(), &format!("pandoc in.md -o {}", f.display()), &now())]).list();
            assert_eq!(l.len(), 1);
            assert_eq!((l[0].path.as_str(), l[0].sources.clone(), l[0].is_document, l[0].exists), (f.to_str().unwrap(), vec![S::Bash], true, true));
        }

        #[test]
        fn ignores_file_older_than_timestamp_minus_2s() {
            let d = tmp();
            let f = d.path().join("viejo.pdf");
            fs::write(&f, "x").unwrap();
            set_mtime(&f, SystemTime::now() - Duration::from_secs(60));
            assert!(parse(&[bash(d.path(), &format!("cat {}", f.display()), &now())]).list().is_empty());
        }

        #[test]
        fn tolerates_up_to_2s_of_difference() {
            let d = tmp();
            let f = d.path().join("justo.pdf");
            fs::write(&f, "x").unwrap();
            set_mtime(&f, SystemTime::now() - Duration::from_secs(1));
            assert_eq!(parse(&[bash(d.path(), &format!("cat {}", f.display()), &now())]).list().len(), 1);
        }

        #[test]
        fn ignores_files_that_do_not_exist() {
            let d = tmp();
            assert!(parse(&[bash(d.path(), &format!("pandoc -o {}", d.path().join("nada.pdf").display()), &now())]).list().is_empty());
        }

        #[test]
        fn resolves_relative_paths_with_quotes_and_dot_slash() {
            let d = tmp();
            let f = d.path().join("out.html");
            fs::write(&f, "x").unwrap();
            let l = parse(&[bash(d.path(), "node gen.js > \"./out.html\"", &now())]).list();
            assert_eq!(paths_of(&l), [f.to_str().unwrap()]);
        }

        fn paths_of(l: &[betools_types::Artifact]) -> Vec<&str> {
            l.iter().map(|a| a.path.as_str()).collect()
        }

        #[test]
        fn deduplicates_and_finds_several_files() {
            let d = tmp();
            let (a, b) = (d.path().join("a1.png"), d.path().join("b1.csv"));
            fs::write(&a, "x").unwrap();
            fs::write(&b, "x").unwrap();
            let l = parse(&[bash(d.path(), &format!("cp {} {} && cat {}", a.display(), a.display(), b.display()), &now())]).list();
            let mut got: Vec<String> = l.iter().map(|x| x.path.clone()).collect();
            got.sort();
            let mut want = vec![a.to_str().unwrap().to_string(), b.to_str().unwrap().to_string()];
            want.sort();
            assert_eq!(got, want);
        }

        #[test]
        fn extensions_outside_list_do_not_count() {
            let d = tmp();
            let f = d.path().join("code.ts");
            fs::write(&f, "x").unwrap();
            assert!(parse(&[bash(d.path(), &format!("cat {}", f.display()), &now())]).list().is_empty());
        }

        #[test]
        fn error_result_undoes_bash_artifacts() {
            let d = tmp();
            let f = d.path().join("err.pdf");
            fs::write(&f, "x").unwrap();
            let p = parse(&[bash(d.path(), &format!("cat {}", f.display()), &now()), user(json!([{"type":"tool_result","tool_use_id":"b","content":"x","is_error":true}]))]);
            assert!(p.list().is_empty());
        }

        #[test]
        fn bash_without_command_or_other_tools_produce_nothing() {
            let d = tmp();
            assert!(parse(&[w(d.path(), "b", "Bash", json!({}), TS), w(d.path(), "g", "Grep", json!({"pattern":"x.pdf"}), TS)]).list().is_empty());
        }
    }

    #[test]
    fn tool_use_inside_user_entry_registers_nothing() {
        let d = tmp();
        let l = parse(&[json!({"type":"user","timestamp":TS,"cwd":d.path(),"message":{"content":[{"type":"tool_use","id":"1","name":"Write","input":{"file_path":"/p/a.md"}}]}})]).list();
        assert!(l.is_empty());
    }
}
