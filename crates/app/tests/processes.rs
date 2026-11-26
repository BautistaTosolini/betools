//! Procesos: pty de Claude (falso) y de la terminal, reinicios por variables, estado, avisos y cierre.

mod common;

use common::*;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::time::Duration;

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

#[test]
fn attach_starts_lazily_reports_status_and_replays_buffer_once() {
    let e = env();
    let id = e.session("lazy");
    // Perezoso: crear la sesión no lanza nada.
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(e.ok("sessions:running", vec![json!(id)]), false);
    assert_eq!(e.status(&id), "stopped");

    e.attach(&id);
    wait_for("salida del proceso", || e.host.output(&id).contains("fake-ready"));
    assert_eq!(e.ok("sessions:running", vec![json!(id)]), true);
    assert_eq!(e.status(&id), "idle");
    assert!(e.host.named("session:status").contains(&vec![json!(id), json!("idle")]));

    // Segundo attach: lo acumulado vuelve en un solo pty:data, antes de cualquier salida posterior.
    let before = e.host.count("pty:data");
    e.attach(&id);
    assert_eq!(e.host.count("pty:data"), before + 1);
    let replay = e.host.named("pty:data").pop().unwrap();
    assert_eq!(replay[0], json!(id));
    assert!(s(&replay[1]).contains("fake-ready"));

    // Entrada y eco (el pty traduce \r en \n).
    e.input(&id, "hola\r");
    wait_for("eco", || e.host.output(&id).contains("echo:hola"));
}

#[test]
fn claude_gets_session_args_and_settings() {
    // Este "claude" imprime sus argumentos, uno por línea.
    let e = env_script("#!/bin/sh\nfor a in \"$@\"; do echo \"ARG:$a\"; done\nsleep 5\n", |_| {});
    let id = e.ok("sessions:create", vec![json!(e.dir("a1")), json!("Nombre")])["id"].as_str().unwrap().to_string();
    e.attach(&id);
    wait_for("args", || e.host.output(&id).contains("ARG:--remote-control"));
    let out = e.host.output(&id);
    let args: Vec<&str> = out.lines().filter_map(|l| l.trim_end().strip_prefix("ARG:")).collect();
    // Sesión nueva sin transcript: --session-id <id> --name <nombre>, luego --settings y --remote-control
    // (activo por defecto; sin título va sin nombre).
    assert_eq!(&args[..4], ["--session-id", id.as_str(), "--name", "Nombre"]);
    assert_eq!(args[4], "--settings");
    assert!(args[5].contains("\"statusLine\""));
    assert_eq!(&args[6..], ["--remote-control"]);
}

#[test]
fn claude_resumes_when_a_transcript_exists_and_names_remote_control_after_the_title() {
    let e = env_script("#!/bin/sh\nfor a in \"$@\"; do echo \"ARG:$a\"; done\nsleep 5\n", |_| {});
    let cwd = e.dir("a3");
    let id = e.ok("sessions:create", vec![json!(cwd), json!("N"), json!("TKT-9 titulo")])["id"].as_str().unwrap().to_string();
    let enc: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let dir = home().join(".claude/projects").join(enc);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{id}.jsonl")), "{}\n").unwrap();
    e.attach(&id);
    wait_for("args", || e.host.output(&id).contains("TKT-9 titulo"));
    let out = e.host.output(&id);
    let args: Vec<&str> = out.lines().filter_map(|l| l.trim_end().strip_prefix("ARG:")).collect();
    assert_eq!(&args[..2], ["--resume", id.as_str()]);
    assert_eq!(&args[args.len() - 2..], ["--remote-control", "TKT-9 titulo"]);
}

#[test]
fn remote_control_off_omits_the_flag() {
    let e = env_script("#!/bin/sh\nfor a in \"$@\"; do echo \"ARG:$a\"; done\nsleep 5\n", |ud| {
        std::fs::write(ud.join("settings.json"), r#"{"remoteControl": false}"#).unwrap();
    });
    let id = e.session("rc");
    e.attach(&id);
    wait_for("args", || e.host.output(&id).contains("ARG:--settings"));
    std::thread::sleep(Duration::from_millis(200));
    assert!(!e.host.output(&id).contains("--remote-control"));
}

#[test]
fn exit_code_and_status_exited() {
    let e = env();
    let id = e.session("exit");
    e.attach(&id);
    wait_for("arranque", || e.host.output(&id).contains("fake-ready"));
    e.input(&id, "quit\r");
    wait_for("pty:exit", || e.host.count("pty:exit") == 1);
    assert_eq!(e.host.named("pty:exit")[0], vec![json!(id), json!(3)]);
    assert_eq!(e.status(&id), "exited");
    assert_eq!(e.ok("sessions:running", vec![json!(id)]), false);
    // Volver a mirarla la relanza.
    e.attach(&id);
    wait_for("relanzado", || e.ok("sessions:running", vec![json!(id)]) == json!(true));
}

#[test]
fn missing_cwd_shows_a_warning_and_exits_1() {
    let e = env();
    let id = e.session("gone");
    let cwd = e.ok("sessions:list", vec![])["sessions"][0]["cwd"].as_str().unwrap().to_string();
    std::fs::remove_dir_all(&cwd).unwrap();
    e.attach(&id);
    wait_for("aviso", || e.host.count("pty:exit") == 1);
    assert!(e.host.output(&id).contains(&format!("The working directory no longer exists: {cwd}")));
    assert_eq!(e.host.named("pty:exit")[0], vec![json!(id), json!(1)]);
}

#[test]
fn attach_to_unknown_session_and_bad_keys_do_nothing() {
    let e = env();
    e.attach("ghost");
    e.attach("shell:ghost");
    e.app.send("pty:input", vec![json!("ghost"), json!("x")]).unwrap();
    e.app.send("pty:resize", vec![json!("ghost"), json!(10), json!(10)]).unwrap();
    e.app.send("pty:restart", vec![json!("ghost"), json!(10), json!(10)]).unwrap();
    assert_eq!(e.host.count("pty:data"), 0);
}

#[test]
fn pty_restart_relaunches_the_process() {
    let e = env();
    let id = e.session("rs");
    e.attach(&id);
    wait_for("arranque", || e.host.output(&id).contains("fake-ready"));
    e.app.send("pty:restart", vec![json!(id), json!(90), json!(20)]).unwrap();
    wait_for("segundo arranque", || e.host.output(&id).matches("fake-ready").count() == 2);
    // Reiniciar a propósito no cuenta como salida.
    assert_eq!(e.host.count("pty:exit"), 0);
}

#[test]
fn env_vars_reach_the_process_and_session_overrides_folder() {
    let e = env();
    let root = e.dir("proj");
    let sub = e.dir("proj/sub");
    let f = e.ok("folders:create", vec![json!({"name":"P","color":"#fff","path":root})]);
    let fid = s(&f["id"]).to_string();
    let sid = e.ok("sessions:create", vec![json!(sub), json!("sub")])["id"].as_str().unwrap().to_string();
    let plain = |v: &str| json!({"kind":"plain","value":v});
    e.ok("env:set", vec![json!({"kind":"folder","id":fid}), json!("FOO"), plain("de-carpeta")]);
    e.ok("env:set", vec![json!({"kind":"folder","id":fid}), json!("BAR"), plain("b-carpeta")]);
    e.ok("env:set", vec![json!({"kind":"session","id":sid}), json!("FOO"), plain("de-sesion")]);
    e.attach(&sid);
    wait_for("env", || e.host.output(&sid).contains("fake-ready"));
    assert!(e.host.output(&sid).contains("FOO=de-sesion BAR=b-carpeta"), "{}", e.host.output(&sid));
}

#[test]
fn env_layers_and_move_targets() {
    let e = env();
    let root = e.dir("lp");
    let nested = e.dir("lp/deep");
    let outside = e.dir("other");
    let f_short = e.ok("folders:create", vec![json!({"name":"Corta","color":"#fff","path":root})]);
    let f_long = e.ok("folders:create", vec![json!({"name":"Larga","color":"#fff","path":nested,"extraPaths":[format!("{outside}/")]})]);
    let in_nested = e.ok("sessions:create", vec![json!(format!("{nested}/x").replace("/x", "")), json!("n")]);
    let in_outside = e.ok("sessions:create", vec![json!(outside), json!("o")]);
    let free = e.ok("sessions:create", vec![json!(e.dir("free")), json!("free")]);

    let layers = e.ok("env:layers", vec![in_nested["id"].clone()]);
    assert_eq!(layers[0]["scope"], json!({"kind":"folder","id":f_long["id"]}), "gana el path más largo");
    assert_eq!(layers[0]["label"], "Larga");
    assert_eq!(layers[1], json!({"scope":{"kind":"session","id":in_nested["id"]},"label":"session","vars":[]}));
    // Path adicional de una carpeta: la sesión de ese cwd cae en ella.
    assert_eq!(e.ok("env:layers", vec![in_outside["id"].clone()])[0]["label"], "Larga");
    // Sin carpeta: una sola capa. Sesión desconocida: lista vacía.
    assert_eq!(e.ok("env:layers", vec![free["id"].clone()]).as_array().unwrap().len(), 1);
    assert_eq!(e.ok("env:layers", vec![json!("ghost")]), json!([]));

    let to_folder = e.ok("env:moveTargets", vec![json!({"kind":"session","id":in_nested["id"]})]);
    assert_eq!(to_folder, json!([{"scope":{"kind":"folder","id":f_long["id"]},"label":"folder Larga"}]));
    assert_eq!(e.ok("env:moveTargets", vec![json!({"kind":"session","id":free["id"]})]), json!([]));
    let to_sessions = e.ok("env:moveTargets", vec![json!({"kind":"folder","id":f_long["id"]})]);
    let labels: Vec<_> = to_sessions.as_array().unwrap().iter().map(|t| s(&t["label"]).to_string()).collect();
    assert_eq!(labels, ["session n", "session o"]);
    assert_eq!(e.ok("env:moveTargets", vec![json!({"kind":"folder","id":f_short["id"]})]), json!([]));
}

#[test]
fn env_set_validation_and_messages() {
    let e = env();
    let id = e.session("v");
    let sc = json!({"kind":"session","id":id});
    let plain = json!({"kind":"plain","value":"x"});
    assert_eq!(e.err("env:set", vec![sc.clone(), json!("1BAD"), plain.clone()]), "Invalid name: only letters, numbers and \"_\", not starting with a number.");
    assert_eq!(e.err("env:set", vec![sc.clone(), json!("PATH"), plain.clone()]), "PATH is reserved and cannot be overridden.");
    assert_eq!(e.err("env:set", vec![sc.clone(), json!("A"), json!({"kind":"plain"})]), "Enter the value.");
    assert_eq!(e.err("env:set", vec![sc.clone(), json!("A"), json!({"kind":"local"})]), "Enter the value.");
    assert_eq!(e.err("env:set", vec![sc.clone(), json!("A"), json!({"kind":"local"}), json!("")]), "Enter the value.");
    assert_eq!(e.err("env:set", vec![sc.clone(), json!("A"), json!({"kind":"aws-sm","profile":" "})]), "Choose the AWS profile.");
    assert_eq!(e.err("env:set", vec![sc.clone(), json!("A"), json!({"kind":"aws-sm","profile":"p","secretId":" "})]), "Enter the secret name or ARN.");
    assert_eq!(e.err("env:set", vec![sc.clone(), json!("A"), json!({"kind":"aws-ssm","profile":"p"})]), "Enter the parameter name.");
    assert_eq!(e.err("env:test", vec![json!({"kind":"aws-ssm","profile":"p"})]), "Enter the parameter name.");

    // Se normaliza y se guarda sin campos vacíos.
    e.ok("env:set", vec![sc.clone(), json!("SM"), json!({"kind":"aws-sm","profile":" dev ","region":" ","secretId":" arn:x ","jsonKey":" "})]);
    e.ok("env:set", vec![sc.clone(), json!("SSM"), json!({"kind":"aws-ssm","profile":"dev","region":" us-east-1 ","name":" /a/b "})]);
    let list = e.ok("env:list", vec![sc.clone()]);
    assert_eq!(list[0]["name"], "SM", "ordenadas por nombre");
    assert_eq!(list[0]["source"], json!({"kind":"aws-sm","profile":"dev","secretId":"arn:x"}));
    assert_eq!(list[1]["source"], json!({"kind":"aws-ssm","profile":"dev","region":"us-east-1","name":"/a/b"}));
    assert!(list[0]["updatedAt"].as_str().unwrap().ends_with('Z'));
    e.ok("env:delete", vec![sc.clone(), json!("SM")]);
    assert_eq!(e.ok("env:list", vec![sc]).as_array().unwrap().len(), 1);
}

#[test]
fn local_secrets_are_encrypted_never_returned_and_movable() {
    let e = env();
    let f = e.ok("folders:create", vec![json!({"name":"S","color":"#fff","path":e.dir("sec")})]);
    let fid = f["id"].clone();
    let sid = e.ok("sessions:create", vec![json!(e.dir("sec/x")), json!("x")])["id"].clone();
    let (fs, ss) = (json!({"kind":"folder","id":fid}), json!({"kind":"session","id":sid}));
    assert_eq!(e.ok("env:secureStorage", vec![]), json!({"ok": true}));

    e.ok("env:set", vec![ss.clone(), json!("TOKEN"), json!({"kind":"local"}), json!("super-secreto-123")]);
    let on_disk = std::fs::read_to_string(e.user_data.join("secrets.json")).unwrap();
    assert!(!on_disk.contains("super-secreto-123"));
    assert!(on_disk.contains(&format!("session:{}:TOKEN", s(&sid))));
    // Ninguna respuesta lleva el valor.
    for ch in ["env:list", "env:layers", "sessions:list"] {
        let r = e.ok(ch, vec![if ch == "env:list" { ss.clone() } else if ch == "env:layers" { sid.clone() } else { json!(null) }].into_iter().filter(|v| !v.is_null()).collect());
        assert!(!r.to_string().contains("super-secreto-123"), "{ch}");
    }

    // Mover a la carpeta re-cifra; si ya existe pide confirmación con el prefijo EXISTS.
    e.ok("env:move", vec![ss.clone(), fs.clone(), json!("TOKEN")]);
    assert_eq!(e.ok("env:list", vec![ss.clone()]), json!([]));
    assert_eq!(e.ok("env:list", vec![fs.clone()])[0]["name"], "TOKEN");
    let disk: Value = serde_json::from_str(&std::fs::read_to_string(e.user_data.join("secrets.json")).unwrap()).unwrap();
    assert!(disk.get(format!("folder:{}:TOKEN", s(&fid))).is_some());
    assert!(disk.get(format!("session:{}:TOKEN", s(&sid))).is_none());

    e.ok("env:set", vec![ss.clone(), json!("TOKEN"), json!({"kind":"local"}), json!("otro")]);
    let err = e.err("env:move", vec![fs.clone(), ss.clone(), json!("TOKEN")]);
    assert_eq!(err, "EXISTS: TOKEN already exists in the destination.");
    e.ok("env:move", vec![fs.clone(), ss.clone(), json!("TOKEN"), json!(true)]);
    assert_eq!(e.err("env:move", vec![ss.clone(), fs.clone(), json!("NOPE")]), "NOPE does not exist in the source.");
    // Pares sin relación: sesión con sesión, o carpeta con una sesión que no usa.
    let other = e.session("otra");
    assert_eq!(
        e.err("env:move", vec![ss.clone(), json!({"kind":"session","id":other}), json!("TOKEN")]),
        "The variable can only move between a session and its folder."
    );
    // Borrar la carpeta borra sus secretos cifrados.
    e.ok("env:set", vec![fs.clone(), json!("K2"), json!({"kind":"local"}), json!("v2")]);
    e.ok("folders:delete", vec![fid.clone()]);
    let disk: Value = serde_json::from_str(&std::fs::read_to_string(e.user_data.join("secrets.json")).unwrap()).unwrap();
    assert!(!disk.as_object().unwrap().keys().any(|k| k.starts_with("folder:")));
    // Cerrar la sesión, los de la sesión.
    e.ok("sessions:close", vec![sid]);
    let disk: Value = serde_json::from_str(&std::fs::read_to_string(e.user_data.join("secrets.json")).unwrap()).unwrap();
    assert!(!disk.as_object().unwrap().keys().any(|k| k.starts_with("session:")));
}

#[test]
fn local_secret_reaches_the_process() {
    let e = env();
    let id = e.session("lp2");
    let sc = json!({"kind":"session","id":id});
    e.ok("env:set", vec![sc, json!("FOO"), json!({"kind":"local"}), json!("valor-local")]);
    e.attach(&id);
    wait_for("env local", || e.host.output(&id).contains("FOO=valor-local"));
}

#[test]
fn unresolvable_variable_warns_in_the_terminal_and_starts_anyway() {
    let e = env();
    let id = e.session("bad");
    let sc = json!({"kind":"session","id":id});
    // aws no existe en el PATH de la prueba con este perfil: la lectura falla y la sesión arranca igual.
    e.ok("env:set", vec![sc, json!("SECRETO"), json!({"kind":"aws-ssm","profile":"no-such-profile-xyz","name":"/x"})]);
    e.attach(&id);
    wait_for("arranque", || e.host.output(&id).contains("fake-ready"));
    let out = e.host.output(&id);
    assert!(out.contains("Some environment variables could not be loaded (the session starts without them):"));
    assert!(out.contains("  · SECRETO: "));
}

#[test]
fn env_change_restarts_a_running_idle_session_after_debounce() {
    let e = env();
    let id = e.session("rst");
    e.attach(&id);
    wait_for("arranque", || e.host.output(&id).contains("fake-ready"));
    let sc = json!({"kind":"session","id":id});
    e.ok("env:set", vec![sc.clone(), json!("FOO"), json!({"kind":"plain","value":"uno"})]);
    e.ok("env:set", vec![sc, json!("BAR"), json!({"kind":"plain","value":"dos"})]);
    assert_eq!(e.host.count("pty:reset"), 0, "debounce: nada antes de 1,5 s");
    wait_for("reinicio", || e.host.output(&id).contains("FOO=uno BAR=dos"));
    assert_eq!(e.host.named("pty:reset"), vec![vec![json!(id)]], "una sola vez");
    assert_eq!(e.host.count("session:pendingRestart"), 0);
}

#[test]
fn env_change_without_process_does_not_start_anything() {
    let e = env();
    let id = e.session("np");
    e.ok("env:set", vec![json!({"kind":"session","id":id}), json!("FOO"), json!({"kind":"plain","value":"x"})]);
    std::thread::sleep(Duration::from_millis(2000));
    assert_eq!(e.host.count("pty:reset"), 0);
    assert_eq!(e.ok("sessions:running", vec![json!(id)]), false);
}

#[test]
fn working_session_defers_restart_until_the_turn_ends() {
    let e = env();
    let id = e.session("pend");
    e.attach(&id);
    wait_for("arranque", || e.host.output(&id).contains("fake-ready"));
    e.input(&id, "work\r");
    wait_for("working", || e.status(&id) == "working");
    e.ok("env:set", vec![json!({"kind":"session","id":id}), json!("FOO"), json!({"kind":"plain","value":"tarde"})]);
    wait_for("pendiente", || e.host.named("session:pendingRestart").contains(&vec![json!(id), json!(true)]));
    assert_eq!(e.ok("sessions:pendingRestart", vec![]), json!([id]));
    assert_eq!(e.host.count("pty:reset"), 0);

    e.input(&id, "done\r");
    wait_for("reinicio al terminar", || e.host.output(&id).contains("FOO=tarde"));
    assert!(e.host.named("session:pendingRestart").contains(&vec![json!(id), json!(false)]));
    assert_eq!(e.ok("sessions:pendingRestart", vec![]), json!([]));
    assert_eq!(e.host.count("pty:reset"), 1);
}

#[test]
fn explicit_restart_resets_the_terminal_and_clears_pending() {
    let e = env();
    let id = e.session("exp");
    e.attach(&id);
    wait_for("arranque", || e.host.output(&id).contains("fake-ready"));
    e.ok("sessions:restart", vec![json!(id)]);
    assert_eq!(e.host.named("pty:reset"), vec![vec![json!(id)]]);
    wait_for("segundo arranque", || e.host.output(&id).matches("fake-ready").count() == 2);
    assert_eq!(e.ok("sessions:running", vec![json!(id)]), true);
    // Una sesión desconocida no hace nada, ni siquiera avisa.
    e.ok("sessions:restart", vec![json!("ghost")]);
    assert_eq!(e.host.count("pty:reset"), 1);
}

#[test]
fn notifications_on_waiting_and_done_with_suppression_rules() {
    let e = env();
    let id = e.session("Mi sesión");
    e.attach(&id);
    wait_for("arranque", || e.host.output(&id).contains("fake-ready"));

    e.input(&id, "wait\r");
    wait_for("aviso waiting", || e.host.notices.lock().unwrap().len() == 1);
    {
        let n = &e.host.notices.lock().unwrap()[0];
        assert_eq!((n.title.as_str(), n.body.as_str(), n.urgent), ("Mi sesión", "Needs your input", true));
        assert_eq!(n.session_id, id);
    }
    assert_eq!(e.host.tray.lock().unwrap().last().unwrap().tooltip, "betools \u{2014} 1 waiting for input");
    assert_eq!(e.host.tray.lock().unwrap().last().unwrap().entries[0].label, "\u{2757} Mi sesión");

    // Mirando esa misma sesión con la ventana en foco: no se avisa.
    e.host.focused.store(true, Ordering::SeqCst);
    e.input(&id, "done\r");
    wait_for("done", || e.status(&id) == "done");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(e.host.notices.lock().unwrap().len(), 1);
    // El foco de la ventana pasa "done" a idle (seen).
    e.app.on_window_focus();
    assert_eq!(e.status(&id), "idle");

    // Sin foco, "done" avisa con otro cuerpo y sin urgencia.
    e.host.focused.store(false, Ordering::SeqCst);
    e.input(&id, "work\r");
    wait_for("working", || e.status(&id) == "working");
    e.input(&id, "done\r");
    wait_for("aviso done", || e.host.notices.lock().unwrap().len() == 2);
    let n = e.host.notices.lock().unwrap()[1].clone();
    assert_eq!((n.body.as_str(), n.urgent), ("Done", false));

    // Con avisos desactivados, nada.
    e.ok("settings:update", vec![json!({"notifications": false})]);
    e.input(&id, "wait\r");
    wait_for("waiting", || e.status(&id) == "waiting");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(e.host.notices.lock().unwrap().len(), 2);
}

#[test]
fn select_from_outside_selects_marks_seen_and_shows_the_window() {
    let e = env();
    let a = e.session("a");
    let _b = e.session("b");
    e.app.select_from_outside(&a);
    assert_eq!(e.ok("sessions:list", vec![])["selectedId"], json!(a));
    assert_eq!(e.host.named("ui:select"), vec![vec![json!(a)]]);
    assert_eq!(*e.host.shown.lock().unwrap(), 1);
}

#[test]
fn interruption_in_the_transcript_returns_a_working_session_to_idle() {
    let e = env();
    let id = e.session("int");
    let cwd = e.ok("sessions:list", vec![])["sessions"][0]["cwd"].as_str().unwrap().to_string();
    let enc: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let dir = home().join(".claude/projects").join(enc);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(format!("{id}.jsonl"));
    let line = |text: &str, at: &str| format!("{}\n", json!({"type":"user","timestamp":at,"message":{"role":"user","content":[{"type":"text","text":text}]}}));
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    std::fs::write(&file, line("hola", &now)).unwrap();
    wait_for("primer mensaje", || e.host.count("conversation:changed") >= 1);
    e.attach(&id);
    wait_for("arranque", || e.host.output(&id).contains("fake-ready"));
    e.input(&id, "work\r");
    wait_for("working", || e.status(&id) == "working");
    use std::io::Write;
    std::fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(line("[Request interrupted by user]", &now).as_bytes()).unwrap();
    wait_for("idle por interrupción", || e.status(&id) == "idle");
    let ev = e.host.named("conversation:changed");
    assert_eq!(ev.last().unwrap()[1], json!(1), "start = ítems previos");
    assert_eq!(ev.last().unwrap()[2][0]["text"], "Interrupted by user");
}

#[test]
fn old_interruptions_and_initial_load_do_not_touch_the_status() {
    let e = env();
    let id = e.session("old");
    let cwd = e.ok("sessions:list", vec![])["sessions"][0]["cwd"].as_str().unwrap().to_string();
    let enc: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let dir = home().join(".claude/projects").join(enc);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(format!("{id}.jsonl"));
    let line = |text: &str, at: &str| format!("{}\n", json!({"type":"user","timestamp":at,"message":{"role":"user","content":[{"type":"text","text":text}]}}));
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let old = (chrono::Utc::now() - chrono::Duration::minutes(10)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    std::fs::write(&file, line("hola", &now)).unwrap();
    wait_for("primer mensaje", || e.host.count("conversation:changed") >= 1);
    e.attach(&id);
    wait_for("arranque", || e.host.output(&id).contains("fake-ready"));
    e.input(&id, "work\r");
    wait_for("working", || e.status(&id) == "working");
    use std::io::Write;
    std::fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(line("[Request interrupted by user]", &old).as_bytes()).unwrap();
    wait_for("llegó el ítem", || e.host.count("conversation:changed") >= 2);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(e.status(&id), "working", "una interrupción de hace 10 minutos no cuenta");
}

#[test]
fn shell_terminal_runs_in_the_session_folder_with_the_session_env() {
    let e = env();
    let id = e.session("sh");
    e.ok("env:set", vec![json!({"kind":"session","id":id}), json!("FOO"), json!({"kind":"plain","value":"desde-shell"})]);
    let key = format!("shell:{id}");
    e.attach(&key);
    // El pty del shell y el de Claude son independientes.
    assert_eq!(e.ok("sessions:running", vec![json!(id)]), false);
    std::thread::sleep(Duration::from_millis(400));
    e.input(&key, "echo \"v=$FOO d=$(basename $PWD)\"\r");
    wait_for("shell", || e.host.output(&key).contains("v=desde-shell d=cwd-sh"));
    // shell:run: escribe el comando en la terminal de la sesión.
    e.ok("shell:run", vec![json!(id), json!("  echo corrido-$((20+22))  ")]);
    wait_for("shell:run", || e.host.output(&key).contains("corrido-42"));
    e.ok("shell:run", vec![json!(id), json!("   ")]);
    e.ok("shell:run", vec![json!("ghost"), json!("echo x")]);
    // Reiniciar la terminal.
    e.app.send("pty:restart", vec![json!(key), json!(80), json!(24)]).unwrap();
    // El shell nuevo arranca en segundo plano: lo escrito antes de que exista se descarta, se reintenta.
    wait_for("salida del shell", || {
        e.input(&key, "exit 7\r");
        e.host.named("pty:exit").iter().any(|a| a[0] == json!(key) && a[1] == json!(7))
    });
}

#[test]
fn closing_a_session_kills_its_processes_and_forgets_it() {
    let e = env();
    let id = e.session("cl");
    e.attach(&id);
    e.attach(&format!("shell:{id}"));
    wait_for("arranque", || e.host.output(&id).contains("fake-ready"));
    e.ok("env:set", vec![json!({"kind":"session","id":id}), json!("FOO"), json!({"kind":"plain","value":"x"})]);
    e.ok("sessions:close", vec![json!(id)]);
    assert_eq!(e.ok("sessions:running", vec![json!(id)]), false);
    assert_eq!(e.ok("sessions:list", vec![])["sessions"], json!([]));
    // El temporizador de reinicio quedó cancelado y matar a propósito no emite salida.
    std::thread::sleep(Duration::from_millis(1900));
    assert_eq!(e.host.count("pty:reset"), 0);
    assert_eq!(e.host.count("pty:exit"), 0);
    assert_eq!(e.ok("sessions:pendingRestart", vec![]), json!([]));
}

#[test]
fn shutdown_kills_everything_and_eager_start_launches_all_sessions() {
    let e = env_with(|ud| {
        std::fs::write(ud.join("settings.json"), r#"{"eagerStart": true}"#).unwrap();
    });
    let (a, b) = (e.session("e1"), e.session("e2"));
    // Lazy hasta que se llama a start.
    assert_eq!(e.ok("sessions:running", vec![json!(a)]), false);
    e.app.start();
    wait_for("ambas", || e.host.output(&a).contains("fake-ready") && e.host.output(&b).contains("fake-ready"));
    assert_eq!(e.ok("sessions:running", vec![json!(b)]), true);
    e.app.shutdown();
    assert_eq!(e.ok("sessions:running", vec![json!(a)]), false);
    assert_eq!(e.ok("sessions:running", vec![json!(b)]), false);
    // Sesiones intactas para el próximo arranque.
    assert_eq!(e.ok("sessions:list", vec![])["sessions"].as_array().unwrap().len(), 2);
}

#[test]
fn restart_of_state_on_boot_rewatches_existing_sessions() {
    // Segundo arranque sobre el mismo userData: las sesiones guardadas se cargan y siguen detenidas.
    let e = env();
    let id = e.session("persist");
    let host2 = std::sync::Arc::new(FakeHost::default());
    let app2 = betools_app::App::new(host2, betools_app::AppConfig { user_data: e.user_data.clone(), claude_bin: None, keyring: None }).unwrap();
    let list = app2.invoke("sessions:list", vec![]).unwrap();
    assert_eq!(list["sessions"][0]["id"], json!(id));
    assert_eq!(list["status"][&id], "stopped");
    assert_eq!(list["selectedId"], json!(id));
}
