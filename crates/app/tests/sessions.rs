//! Sesiones, carpetas, ajustes, documentos y utilidades (todo lo que no es un proceso).

mod common;

use common::*;
use serde_json::{json, Value};

#[test]
fn create_session_validates_folder_and_names_it() {
    let e = env();
    assert_eq!(e.err("sessions:create", vec![json!("/nope/nope"), json!("x")]), "Folder not found: /nope/nope");
    // Un archivo no es carpeta.
    let file = e.tmp.path().join("f.txt");
    std::fs::write(&file, "x").unwrap();
    let f = file.to_string_lossy().into_owned();
    assert_eq!(e.err("sessions:create", vec![json!(f), json!("x")]), format!("Folder not found: {f}"));

    let cwd = e.dir("proj/");
    let s = e.ok("sessions:create", vec![json!(cwd), json!("   ")]);
    assert_eq!(s["name"], "proj", "sin nombre usa el de la carpeta");
    assert_eq!(s["cwd"], json!(cwd));
    assert!(s["id"].as_str().unwrap().len() == 36);
    assert_eq!(s["createdAt"], s["lastActiveAt"]);
    assert!(s["createdAt"].as_str().unwrap().ends_with('Z'));
    let named = e.ok("sessions:create", vec![json!(cwd), json!("  Mi sesión  ")]);
    assert_eq!(named["name"], "Mi sesión");
}

#[test]
fn list_has_state_status_and_titles_in_that_shape() {
    let e = env();
    let id = e.session("uno");
    let list = e.ok("sessions:list", vec![]);
    let keys: Vec<_> = list.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["folders", "sessions", "selectedId", "status", "titles"]);
    assert_eq!(list["selectedId"], json!(id));
    assert_eq!(list["status"][&id], "stopped");
    assert_eq!(list["titles"][&id], Value::Null);
    // Se persiste en sessions.json con el mismo formato.
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(e.user_data.join("sessions.json")).unwrap()).unwrap();
    assert_eq!(saved["sessions"][0]["id"], json!(id));
}

#[test]
fn session_title_is_stored_in_tab_titles_and_announced() {
    let e = env();
    let cwd = e.dir("t");
    let s = e.ok("sessions:create", vec![json!(cwd), json!("n"), json!("TKT-1   resumen  largo")]);
    let id = s["id"].as_str().unwrap();
    let file = home().join(".claude/tab-titles").join(id);
    assert_eq!(std::fs::read_to_string(file).unwrap(), "TKT-1 resumen largo\n");
    assert_eq!(e.ok("sessions:list", vec![])["titles"][id], "TKT-1 resumen largo");
    let titles = e.host.named("session:title");
    assert!(titles.contains(&vec![json!(id), Value::Null]), "aviso inicial");
    assert!(titles.contains(&vec![json!(id), json!("TKT-1 resumen largo")]));
    // setTitle: solo si la sesión existe.
    e.ok("sessions:setTitle", vec![json!("ghost"), json!("x")]);
    assert!(!home().join(".claude/tab-titles/ghost").exists());
    e.ok("sessions:setTitle", vec![json!(id), json!("")]);
    assert_eq!(e.ok("sessions:list", vec![])["titles"][id], Value::Null);
}

#[test]
fn rename_select_close_and_selection_after_close() {
    let e = env();
    let (a, b, c) = (e.session("a"), e.session("b"), e.session("c"));
    assert_eq!(e.ok("sessions:list", vec![])["selectedId"], json!(c));
    e.ok("sessions:rename", vec![json!(b), json!("  nuevo  ")]);
    e.ok("sessions:select", vec![json!(a)]);
    let list = e.ok("sessions:list", vec![]);
    assert_eq!(list["selectedId"], json!(a));
    assert_eq!(list["sessions"][1]["name"], "nuevo");
    e.ok("sessions:close", vec![json!(a)]);
    let list = e.ok("sessions:list", vec![]);
    assert_eq!(list["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(list["selectedId"], json!(b), "al cerrar la seleccionada pasa a la que ocupa su lugar");
    assert!(e.host.tray.lock().unwrap().last().unwrap().entries.iter().all(|t| t.session_id != a));
}

#[test]
fn import_session_checks() {
    let e = env();
    let cwd = e.dir("imp");
    let id = "11111111-2222-3333-4444-555555555555";
    assert_eq!(
        e.err("sessions:import", vec![json!(id), json!("/gone/dir"), json!("x")]),
        "The session folder no longer exists: /gone/dir"
    );
    let s = e.ok("sessions:import", vec![json!(id), json!(cwd), json!("")]);
    assert_eq!(s["id"], id);
    assert_eq!(s["name"], "imp");
    assert_eq!(e.err("sessions:import", vec![json!(id), json!(cwd), json!("x")]), "The session is already in the list");
}

#[test]
fn folders_crud() {
    let e = env();
    let path = e.dir("clients/acme");
    let missing = e.err("folders:create", vec![json!({"name":"x","color":"#fff","path":"/nope"})]);
    assert_eq!(missing, "Folder not found: /nope");
    let f = e.ok(
        "folders:create",
        vec![json!({"name":"  ","color":"#abc","path":path,"extraPaths":[" /x/y/ ", "/x/y", &path, "", "/z"], "collapsed": true})],
    );
    assert_eq!(f["name"], "acme");
    assert_eq!(f["extraPaths"], json!(["/x/y", "/z"]), "sin duplicados ni el principal");
    assert!(f.get("collapsed").is_none(), "solo se copian los campos conocidos");
    let id = f["id"].as_str().unwrap().to_string();

    assert_eq!(e.err("folders:update", vec![json!(id), json!({"path": "/nope"})]), "Folder not found: /nope");
    let u = e.ok("folders:update", vec![json!(id), json!({"name":"Acme","extraPaths":["/q/","/q"]})]);
    assert_eq!(u["name"], "Acme");
    assert_eq!(u["extraPaths"], json!(["/q"]));
    assert_eq!(e.ok("folders:update", vec![json!("ghost"), json!({"name":"x"})]), Value::Null);

    let other = e.ok("folders:create", vec![json!({"name":"B","color":"#000","path":e.dir("clients/b")})]);
    e.ok("folders:move", vec![json!(other["id"]), json!(-1)]);
    let list = e.ok("sessions:list", vec![]);
    assert_eq!(list["folders"][0]["name"], "B");
    e.ok("folders:move", vec![json!(other["id"]), json!(-1)]); // ya es la primera: no pasa nada
    assert_eq!(e.ok("sessions:list", vec![])["folders"][0]["name"], "B");

    e.ok("folders:delete", vec![json!(id)]);
    assert_eq!(e.ok("sessions:list", vec![])["folders"].as_array().unwrap().len(), 1);
}

#[test]
fn folder_commands_are_cleaned() {
    let e = env();
    let f = e.ok("folders:create", vec![json!({"name":"A","color":"#fff","path":e.dir("fa")})]);
    let id = f["id"].as_str().unwrap();
    let r = e.ok(
        "folders:setCommands",
        vec![json!(id), json!([
            {"id":"keep","name":"  sso ","command":" aws sso login "},
            {"id":"","name":"x","command":"ls"},
            {"id":"drop","name":"vacío","command":"   "}
        ])],
    );
    let cmds = r["commands"].as_array().unwrap();
    assert_eq!(cmds.len(), 2);
    assert_eq!(cmds[0], json!({"id":"keep","name":"sso","command":"aws sso login"}));
    assert_eq!(cmds[1]["id"].as_str().unwrap().len(), 36, "id nuevo si falta");
    assert_eq!(e.ok("folders:setCommands", vec![json!("ghost"), json!([])]), Value::Null);
}

#[test]
fn suggest_folders_and_extra_paths() {
    let e = env();
    let work = home().join("workdir");
    for d in ["areaA/clients/Alfa", "areaA/clients/archived", "areaA/clients/.hidden", "areaB/clients/Beta", ".dot/clients/Nope"] {
        std::fs::create_dir_all(work.join(d)).unwrap();
    }
    std::fs::write(work.join("areaA/clients/file.txt"), "x").unwrap();
    let names = |v: &Value| v.as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let s = e.ok("folders:suggest", vec![]);
    assert_eq!(names(&s), ["Alfa", "Beta"], "ordenado, sin archived, ocultos ni archivos");
    assert_eq!(s[0]["path"], json!(work.join("areaA/clients/Alfa").to_string_lossy()));
    // Las ya agregadas no se sugieren.
    e.ok("folders:create", vec![json!({"name":"Alfa","color":"#fff","path":work.join("areaA/clients/Alfa")})]);
    assert_eq!(names(&e.ok("folders:suggest", vec![])), ["Beta"]);

    // Paths adicionales: cwd de sesiones de Claude con ".../clients/<nombre>".
    let cwd = work.join("areaB/clients/Beta/sub");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd_s = cwd.to_string_lossy().into_owned();
    let enc: String = cwd_s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let proj = home().join(".claude/projects").join(enc);
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(proj.join("aaaa.jsonl"), format!("{}\n", json!({"type":"user","cwd":cwd_s,"message":{"content":"hola"}}))).unwrap();
    let beta = work.join("areaB/clients/Beta").to_string_lossy().into_owned();
    assert_eq!(e.ok("folders:suggestExtra", vec![json!(" beta "), json!([])]), json!([beta]));
    assert_eq!(e.ok("folders:suggestExtra", vec![json!("beta"), json!([beta])]), json!([]));
    assert_eq!(e.ok("folders:suggestExtra", vec![json!("  "), json!([])]), json!([]));
    assert_eq!(e.ok("folders:suggestExtra", vec![json!("otro"), json!([])]), json!([]));
    // sessions:discover ve esa misma sesión salvo que ya esté en la lista.
    let found = e.ok("sessions:discover", vec![]);
    assert!(found.as_array().unwrap().iter().any(|d| d["id"] == "aaaa"));
}

#[test]
fn settings_clipboard_dialog_external_and_artifacts() {
    let e = env();
    let s = e.ok("settings:get", vec![]);
    assert_eq!(s["closeToTray"], true);
    let u = e.ok("settings:update", vec![json!({"notifications": false})]);
    assert_eq!(u["notifications"], false);
    assert_eq!(e.ok("settings:get", vec![])["notifications"], false);

    e.ok("clipboard:write", vec![json!("hola")]);
    assert_eq!(e.ok("clipboard:read", vec![]), "hola");
    e.ok("clipboard:write", vec![json!(42)]);
    assert_eq!(e.ok("clipboard:read", vec![]), "42", "String(text)");

    assert_eq!(e.ok("dialog:pickFolder", vec![]), Value::Null);
    *e.host.pick.lock().unwrap() = Some("/elegida".into());
    assert_eq!(e.ok("dialog:pickFolder", vec![]), "/elegida");

    for url in ["https://a.b/c", "HTTP://x", "mailto:a@b.c"] {
        e.ok("shell:openExternal", vec![json!(url)]);
    }
    for url in ["file:///etc/passwd", "javascript:alert(1)", "ftp://x"] {
        e.ok("shell:openExternal", vec![json!(url)]);
    }
    assert_eq!(*e.host.urls.lock().unwrap(), ["https://a.b/c", "HTTP://x", "mailto:a@b.c"]);

    e.ok("artifacts:open", vec![json!("/a/b.md")]);
    e.ok("artifacts:reveal", vec![json!("/a/c.md")]);
    assert_eq!(*e.host.opened.lock().unwrap(), ["/a/b.md"]);
    assert_eq!(*e.host.revealed.lock().unwrap(), ["/a/c.md"]);
    assert_eq!(e.ok("artifacts:list", vec![json!("ghost")]), json!([]));
    assert_eq!(e.ok("conversation:get", vec![json!("ghost")]), json!([]));
    assert_eq!(e.ok("slash:list", vec![json!("ghost")]), json!([]));
    assert_eq!(e.ok("sessions:running", vec![json!("ghost")]), false);
}

#[test]
fn slash_list_returns_disk_commands_in_quick_mode() {
    let e = env();
    let id = e.session("sl");
    let cmds = e.ok("slash:list", vec![json!(id), json!(true)]);
    assert!(cmds.as_array().unwrap().iter().any(|c| c["name"] == "compact" && c["source"] == "builtin"));
}

#[test]
fn usage_has_limits_daily_and_meta() {
    let e = env();
    let id = e.session("u");
    let u = e.ok("usage:get", vec![]);
    assert_eq!(u["limits"], Value::Null);
    assert!(u["daily"]["day"].as_str().unwrap().ends_with("T00:00:00.000Z") || u["daily"]["day"].is_string());
    assert_eq!(u["daily"]["total"], 0);
    assert_eq!(u["meta"][&id], json!({"model": null, "contextPct": null}));
}

#[test]
fn doc_read_rules() {
    let e = env();
    let dir = e.tmp.path();
    let md = dir.join("a.MD");
    std::fs::write(&md, "# hola\n").unwrap();
    let r = e.ok("doc:read", vec![json!(md)]);
    assert_eq!(r["text"], "# hola\n");
    assert!(r["mtime"].as_f64().unwrap() > 1.0e12);
    assert_eq!(e.err("doc:read", vec![json!(dir.join("a.txt"))]), "Only Markdown files can be opened in betools.");
    assert!(e.err("doc:read", vec![json!(dir.join("no.md"))]).starts_with("ENOENT: no such file or directory, stat '"));
    let d = dir.join("dir.md");
    std::fs::create_dir(&d).unwrap();
    assert_eq!(e.err("doc:read", vec![json!(d)]), format!("Not a file: {}", d.display()));
    let big = dir.join("big.mdx");
    std::fs::write(&big, vec![b'a'; 5 * 1024 * 1024 + 1]).unwrap();
    assert_eq!(e.err("doc:read", vec![json!(big)]), "The file is too large to preview (over 5 MB).");
    std::fs::write(dir.join("ok.markdown"), vec![b'a'; 5 * 1024 * 1024]).unwrap();
    e.ok("doc:read", vec![json!(dir.join("ok.markdown"))]);
}

#[test]
fn doc_watch_emits_changes_and_null_on_delete() {
    let e = env();
    let md = e.tmp.path().join("w.md");
    std::fs::write(&md, "uno").unwrap();
    let p = md.to_string_lossy().into_owned();
    e.ok("doc:watch", vec![json!(p)]);
    e.ok("doc:watch", vec![json!(p)]); // dos visores del mismo documento: un solo sondeo
    std::thread::sleep(std::time::Duration::from_millis(1100));
    std::fs::write(&md, "dos!").unwrap();
    wait_for("doc:changed", || e.host.count("doc:changed") >= 1);
    let ev = &e.host.named("doc:changed")[0];
    assert_eq!(ev[0], json!(p));
    assert_eq!(ev[1]["text"], "dos!");

    e.ok("doc:unwatch", vec![json!(p)]); // sigue vigilado por el otro visor
    std::fs::remove_file(&md).unwrap();
    wait_for("doc:changed null", || e.host.named("doc:changed").iter().any(|a| a[1].is_null()));
    let n = e.host.count("doc:changed");
    e.ok("doc:unwatch", vec![json!(p)]);
    std::fs::write(&md, "tres").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2300));
    assert_eq!(e.host.count("doc:changed"), n, "sin vigilancia no hay eventos");
}

#[test]
fn bad_arguments_are_reported_not_panicked() {
    let e = env();
    assert_eq!(e.err("sessions:rename", vec![json!(5), json!("x")]), "Invalid argument 1 for sessions:rename");
    assert_eq!(e.err("env:list", vec![json!({"kind":"x","id":"1"})]), "Invalid argument 1 for env:list");
    assert!(e.app.send("pty:resize", vec![json!("a")]).is_err());
}

#[test]
fn shell_open_external_missing_arg_is_an_error_but_non_matching_is_silent() {
    let e = env();
    assert!(e.invoke("shell:openExternal", vec![]).is_err());
    assert_eq!(e.ok("shell:openExternal", vec![json!("nada")]), Value::Null);
}
