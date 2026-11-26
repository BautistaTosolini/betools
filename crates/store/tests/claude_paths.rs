mod common;
use betools_store::*;
use common::*;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

fn root() -> PathBuf {
    home().join(".claude").join("projects")
}

#[test]
fn project_dir_replaces_every_non_alphanumeric_with_dash() {
    let _g = guard();
    assert_eq!(project_dir("/home/user/my.project_v2"), root().join("-home-user-my-project-v2"));
}

#[test]
fn project_dir_handles_spaces_accents_dots_and_symbols() {
    let _g = guard();
    assert_eq!(project_dir("/a b/ñandú/@x#1"), root().join("-a-b--and---x-1"));
    // Fuera del plano básico, JS cuenta dos unidades UTF-16.
    assert_eq!(project_dir("/a😀"), root().join("-a--"));
}

#[test]
fn project_dir_keeps_letters_and_digits() {
    let _g = guard();
    assert_eq!(project_dir("Abc123"), root().join("Abc123"));
}

#[test]
fn project_dir_is_under_the_temp_home() {
    let _g = guard();
    assert!(project_dir("/x").starts_with(std::env::var("HOME").unwrap()));
}

#[test]
fn transcript_path_is_project_dir_plus_id() {
    let _g = guard();
    assert_eq!(transcript_path("/a/b", "abc-1"), root().join("-a-b").join("abc-1.jsonl"));
}

#[test]
fn find_returns_expected_path_when_it_exists() {
    let _g = guard();
    let p = transcript_path("/a/b", "id1");
    fs::create_dir_all(project_dir("/a/b")).unwrap();
    fs::write(&p, "").unwrap();
    assert_eq!(find_transcript("/a/b", "id1"), Some(p));
    assert!(transcript_exists("/a/b", "id1"));
}

#[test]
fn find_prefers_expected_over_other_projects() {
    let _g = guard();
    for c in ["/a/b", "/other"] {
        fs::create_dir_all(project_dir(c)).unwrap();
        fs::write(transcript_path(c, "id1"), "").unwrap();
    }
    assert_eq!(find_transcript("/a/b", "id1"), Some(transcript_path("/a/b", "id1")));
}

#[test]
fn find_searches_other_project_dirs_by_id() {
    let _g = guard();
    fs::create_dir_all(project_dir("/moved/here")).unwrap();
    let p = transcript_path("/moved/here", "id2");
    fs::write(&p, "").unwrap();
    assert_eq!(find_transcript("/old/place", "id2"), Some(p));
    assert!(transcript_exists("/old/place", "id2"));
}

#[test]
fn find_returns_none_when_missing_anywhere() {
    let _g = guard();
    fs::create_dir_all(project_dir("/x")).unwrap();
    assert_eq!(find_transcript("/x", "nope"), None);
    assert!(!transcript_exists("/x", "nope"));
}

#[test]
fn find_returns_none_without_projects_dir() {
    let _g = guard();
    assert_eq!(find_transcript("/x", "nope"), None);
}

// claudeBin: cada caso usa una instancia nueva (equivale a vi.resetModules).
struct Saved(Option<String>, Option<String>);
impl Saved {
    fn new() -> Self {
        Saved(std::env::var("CLAWHIP_CLAUDE_BIN").ok(), std::env::var("SHELL").ok())
    }
}
impl Drop for Saved {
    fn drop(&mut self) {
        for (k, v) in [("CLAWHIP_CLAUDE_BIN", &self.0), ("SHELL", &self.1)] {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
    }
}

#[test]
fn claude_bin_honors_env_var() {
    let _g = guard();
    let _s = Saved::new();
    std::env::set_var("CLAWHIP_CLAUDE_BIN", "/opt/fake/claude");
    assert_eq!(ClaudeBin::new().get(), "/opt/fake/claude");
}

#[test]
fn claude_bin_caches_first_value() {
    let _g = guard();
    let _s = Saved::new();
    std::env::set_var("CLAWHIP_CLAUDE_BIN", "/opt/one/claude");
    let bin = ClaudeBin::new();
    assert_eq!(bin.get(), "/opt/one/claude");
    std::env::set_var("CLAWHIP_CLAUDE_BIN", "/opt/two/claude");
    assert_eq!(bin.get(), "/opt/one/claude");
    assert_eq!(ClaudeBin::new().get(), "/opt/two/claude");
}

#[test]
fn claude_bin_resolves_with_a_login_shell() {
    let _g = guard();
    let _s = Saved::new();
    std::env::remove_var("CLAWHIP_CLAUDE_BIN");
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("claude");
    fs::write(&fake, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    // shell falso: ignora los argumentos e imprime la ruta (con ruido previo, como un perfil ruidoso)
    let shell = dir.path().join("fakeshell");
    fs::write(&shell, format!("#!/bin/sh\necho \"banner\"\necho \"{}\"\n", fake.display())).unwrap();
    fs::set_permissions(&shell, fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("SHELL", &shell);
    assert_eq!(ClaudeBin::new().get(), fake.to_string_lossy());
}

#[test]
fn claude_bin_falls_back_to_local_bin_then_plain_name() {
    let _g = guard();
    let _s = Saved::new();
    std::env::remove_var("CLAWHIP_CLAUDE_BIN");
    std::env::set_var("SHELL", "/nonexistent/shell");
    assert_eq!(ClaudeBin::new().get(), "claude");
    let local = home().join(".local").join("bin").join("claude");
    put(&local, "");
    assert_eq!(ClaudeBin::new().get(), local.to_string_lossy());
    let _ = fs::remove_dir_all(home().join(".local"));
}

#[test]
fn find_transcript_scans_project_dirs_in_name_order() {
    let _g = guard();
    for i in 0..24 {
        let d = root().join(format!("p{:02}", (i * 7) % 24));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("dup.jsonl"), "x").unwrap();
    }
    assert_eq!(find_transcript("/no/such/cwd", "dup"), Some(root().join("p00").join("dup.jsonl")));
}
