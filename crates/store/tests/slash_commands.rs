mod common;
use betools_store::*;
use betools_types::{SlashCommand, SlashSource};
use common::*;
use serde_json::json;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

fn n() -> u64 {
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::SeqCst) + 1
}
// cwd único dentro del HOME temporal
fn project(sub: &[&str]) -> String {
    let mut p = home().join(format!("proj{}", n()));
    for s in sub {
        p.push(s);
    }
    fs::create_dir_all(&p).unwrap();
    p.to_string_lossy().into_owned()
}
fn skill(root: &Path, dir: &str, fm: &str) {
    put(&root.join("skills").join(dir).join("SKILL.md"), fm);
}
fn find<'a>(l: &'a [SlashCommand], name: &str) -> Option<&'a SlashCommand> {
    l.iter().find(|c| c.name == name)
}
fn names(l: &[SlashCommand]) -> Vec<&str> {
    l.iter().map(|c| c.name.as_str()).collect()
}
fn cmd(name: &str, description: &str, source: SlashSource) -> SlashCommand {
    SlashCommand { name: name.into(), description: description.into(), source }
}
fn list(cwd: &str) -> Vec<SlashCommand> {
    SlashCommands::new().list(cwd)
}

// frontmatter parsing (through skills)
fn desc(fm: &str, dir: &str, lookup: &str) -> Option<SlashCommand> {
    skill(&claude(), dir, fm);
    find(&list(&project(&[])), lookup).cloned()
}

#[test]
fn fm_name_and_description_plain() {
    let _g = guard();
    skill(&claude(), "dir1", "---\nname: nice-name\ndescription: Does a thing\n---\nbody");
    let l = list(&project(&[]));
    assert_eq!(find(&l, "nice-name"), Some(&cmd("nice-name", "Does a thing", SlashSource::User)));
    assert!(find(&l, "dir1").is_none());
}

#[test]
fn fm_falls_back_to_dir_name() {
    let _g = guard();
    let c = desc("---\ndescription: x\n---\n", "by-dir", "by-dir").unwrap();
    assert_eq!((c.name.as_str(), c.description.as_str()), ("by-dir", "x"));
}

#[test]
fn fm_skill_without_frontmatter_uses_first_non_heading_line() {
    let _g = guard();
    let c = desc("# Título\n\nPrimera línea real\notra", "nofm", "nofm").unwrap();
    assert_eq!(c.description, "Primera línea real");
}

#[test]
fn fm_without_description_and_name_override() {
    let _g = guard();
    assert!(desc("---\nname: z\n---\n", "zz", "zz").is_none());
    let c = find(&list(&project(&[])), "z").unwrap().clone();
    assert_eq!(c.description, "");
}

#[test]
fn fm_folded_block_scalar_joins_with_spaces() {
    let _g = guard();
    let c = desc("---\ndescription: >\n  primera linea\n  segunda linea\nname: foo\n---\n", "blk", "foo").unwrap();
    assert_eq!(c.description, "primera linea segunda linea");
}

#[test]
fn fm_block_scalar_indicators() {
    let _g = guard();
    for (i, ind) in ["|", ">-", "|-"].iter().enumerate() {
        let c = desc(&format!("---\nname: bs{i}\ndescription: {ind}\n  uno\n  dos\n---\n"), &format!("bsdir{i}"), &format!("bs{i}")).unwrap();
        assert_eq!(c.description, "uno dos");
    }
}

#[test]
fn fm_empty_value_followed_by_indented_block() {
    let _g = guard();
    let c = desc("---\nname: eb\ndescription:\n  contenido\n  indentado\n---\n", "ebdir", "eb").unwrap();
    assert_eq!(c.description, "contenido indentado");
}

#[test]
fn fm_strips_surrounding_quotes() {
    let _g = guard();
    skill(&claude(), "q1", "---\nname: \"quoted\"\ndescription: 'Has: colon'\n---\n");
    assert_eq!(find(&list(&project(&[])), "quoted").unwrap().description, "Has: colon");
}

#[test]
fn fm_crlf_line_endings() {
    let _g = guard();
    skill(&claude(), "crlf", "---\r\nname: crlf-skill\r\ndescription: con crlf\r\n---\r\nbody");
    assert_eq!(find(&list(&project(&[])), "crlf-skill").unwrap().description, "con crlf");
}

#[test]
fn fm_ignores_other_keys() {
    let _g = guard();
    skill(&claude(), "k", "---\nallowed-tools: Bash\nname: k-skill\nmodel: opus\ndescription: d\n---\n");
    assert_eq!(find(&list(&project(&[])), "k-skill").unwrap().description, "d");
}

#[test]
fn fm_dirs_without_skill_md_are_not_skills() {
    let _g = guard();
    fs::create_dir_all(claude().join("skills").join("empty-dir")).unwrap();
    put(&claude().join("skills").join("a-file.md"), "x");
    let l = list(&project(&[]));
    assert!(find(&l, "empty-dir").is_none() && find(&l, "a-file").is_none());
}

// commands
#[test]
fn user_commands_with_and_without_frontmatter() {
    let _g = guard();
    put(&claude().join("commands/deploy.md"), "---\ndescription: Deploy it\n---\nrun");
    put(&claude().join("commands/plain.md"), "# Heading\n\nSolo texto\n");
    put(&claude().join("commands/ignored.txt"), "x");
    let l = list(&project(&[]));
    assert_eq!(find(&l, "deploy"), Some(&cmd("deploy", "Deploy it", SlashSource::User)));
    assert_eq!(find(&l, "plain"), Some(&cmd("plain", "Solo texto", SlashSource::User)));
    assert!(find(&l, "ignored").is_none());
}

#[test]
fn nested_directories_form_colon_names() {
    let _g = guard();
    put(&claude().join("commands/frontend/test.md"), "---\ndescription: FE test\n---\n");
    put(&claude().join("commands/frontend/deep/lint.md"), "lint");
    let l = list(&project(&[]));
    assert_eq!(find(&l, "frontend:test"), Some(&cmd("frontend:test", "FE test", SlashSource::User)));
    assert_eq!(find(&l, "frontend:deep:lint").unwrap().source, SlashSource::User);
}

#[test]
fn does_not_go_deeper_than_3_levels() {
    let _g = guard();
    put(&claude().join("commands/a/b/c/ok.md"), "x");
    put(&claude().join("commands/a/b/c/d/too-deep.md"), "x");
    let l = list(&project(&[]));
    assert!(find(&l, "a:b:c:ok").is_some());
    assert!(find(&l, "a:b:c:d:too-deep").is_none());
}

// project directories
#[test]
fn reads_claude_from_cwd_and_each_parent_up_to_home() {
    let _g = guard();
    let cwd = project(&["a", "b"]);
    let cwd_p = PathBuf::from(&cwd);
    let mid = cwd_p.parent().unwrap();
    let top = mid.parent().unwrap();
    put(&cwd_p.join(".claude/commands/inner.md"), "inner");
    put(&mid.join(".claude/commands/middle.md"), "middle");
    put(&top.join(".claude/commands/outer.md"), "outer");
    skill(&mid.join(".claude"), "proj-skill", "---\ndescription: ps\n---\n");
    let l = list(&cwd);
    for name in ["inner", "middle", "outer", "proj-skill"] {
        assert_eq!(find(&l, name).unwrap().source, SlashSource::Project, "{name}");
    }
}

#[test]
fn home_claude_is_the_user_dir_not_a_project_dir() {
    let _g = guard();
    put(&claude().join("commands/mine.md"), "x");
    assert_eq!(find(&list(&project(&[])), "mine").unwrap().source, SlashSource::User);
}

#[test]
fn sibling_folder_starting_with_home_is_not_inside_home() {
    let _g = guard();
    let sibling = format!("{}2", home().display());
    put(&Path::new(&sibling).join(".claude/commands/sibling-cmd.md"), "x");
    let cwd = format!("{sibling}/proj");
    fs::create_dir_all(&cwd).unwrap();
    let l = list(&cwd);
    let _ = fs::remove_dir_all(&sibling);
    assert!(find(&l, "sibling-cmd").is_none());
}

#[test]
fn does_not_go_beyond_home() {
    let _g = guard();
    let outside = tempfile::tempdir().unwrap();
    put(&outside.path().join(".claude/commands/outside-cmd.md"), "x");
    let cwd = outside.path().join("sub");
    fs::create_dir(&cwd).unwrap();
    assert!(find(&list(&cwd.to_string_lossy()), "outside-cmd").is_none());
}

#[test]
fn nonexistent_cwd_does_not_fail() {
    let _g = guard();
    let cwd = project(&[]);
    assert!(!list(&format!("{cwd}/no-existe")).is_empty());
}

// plugins
fn plugin(key: &str, install_path: Option<&Path>, enabled: Option<bool>) {
    let f = claude().join("plugins/installed_plugins.json");
    let mut cur: serde_json::Value = fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({"plugins":{}}));
    cur["plugins"][key] = match install_path {
        Some(p) => json!([{"installPath":"/old/ignored"},{"installPath":p.to_string_lossy()}]),
        None => json!([]),
    };
    put(&f, &cur.to_string());
    if let Some(e) = enabled {
        let s = claude().join("settings.json");
        let mut ss: serde_json::Value = fs::read_to_string(&s).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
        ss["enabledPlugins"][key] = e.into();
        put(&s, &ss.to_string());
    }
}
fn mk_plugin(name: &str) -> PathBuf {
    let dir = tempfile::Builder::new().prefix(&format!("plug-{name}-")).tempdir().unwrap().keep();
    skill(&dir, "build", "---\ndescription: Plugin skill\n---\n");
    put(&dir.join("commands/ship.md"), "---\ndescription: Plugin cmd\n---\n");
    put(&dir.join("commands/grp/sub.md"), "x");
    dir
}

#[test]
fn lists_plugin_skills_and_commands_last_install_path_wins() {
    let _g = guard();
    plugin("craft@market", Some(&mk_plugin("craft")), None);
    let l = list(&project(&[]));
    assert_eq!(find(&l, "craft:build"), Some(&cmd("craft:build", "Plugin skill", SlashSource::Plugin)));
    assert_eq!(find(&l, "craft:ship").unwrap().description, "Plugin cmd");
    assert_eq!(find(&l, "craft:grp:sub").unwrap().source, SlashSource::Plugin);
}

#[test]
fn enabled_plugins_false_disables_true_or_missing_enables() {
    let _g = guard();
    plugin("off@m", Some(&mk_plugin("off")), Some(false));
    plugin("on@m", Some(&mk_plugin("on")), Some(true));
    plugin("unset@m", Some(&mk_plugin("unset")), None);
    let l = list(&project(&[]));
    let ns = names(&l);
    assert!(!ns.contains(&"off:build"));
    assert!(ns.contains(&"on:build"));
    assert!(ns.contains(&"unset:build"));
}

#[test]
fn skips_plugins_with_missing_or_empty_install_path() {
    let _g = guard();
    plugin("gone@m", Some(Path::new("/definitely/not/here")), None);
    plugin("empty@m", None, None);
    let l = list(&project(&[]));
    assert!(!names(&l).iter().any(|x| x.starts_with("gone:") || x.starts_with("empty:")));
}

#[test]
fn invalid_json_files_do_not_break_listing() {
    let _g = guard();
    put(&claude().join("plugins/installed_plugins.json"), "{no");
    put(&claude().join("settings.json"), "{no");
    assert!(find(&list(&project(&[])), "resume").is_some());
}

// precedence and builtins
#[test]
fn project_beats_user_beats_plugin_beats_builtin() {
    let _g = guard();
    let cwd = project(&[]);
    put(&Path::new(&cwd).join(".claude/commands/dup.md"), "---\ndescription: from project\n---\n");
    put(&claude().join("commands/dup.md"), "---\ndescription: from user\n---\n");
    put(&claude().join("commands/dup2.md"), "---\ndescription: user dup2\n---\n");
    put(&claude().join("commands/model.md"), "---\ndescription: user shadows builtin\n---\n");
    let plug = tempfile::tempdir().unwrap().keep();
    put(&plug.join("commands/x.md"), "x");
    put(&claude().join("plugins/installed_plugins.json"), &json!({"plugins":{"dup2@m":[{"installPath":plug.to_string_lossy()}]}}).to_string());
    skill(&claude(), "dup2:x", "---\nname: dup2:x\ndescription: user wins\n---\n");
    let l = list(&cwd);
    assert_eq!(l.iter().filter(|c| c.name == "dup").count(), 1);
    assert_eq!(find(&l, "dup"), Some(&cmd("dup", "from project", SlashSource::Project)));
    assert_eq!(find(&l, "dup2").unwrap().source, SlashSource::User);
    assert_eq!(find(&l, "model"), Some(&cmd("model", "user shadows builtin", SlashSource::User)));
    assert_eq!(l.iter().filter(|c| c.name == "dup2:x").count(), 1);
    assert_eq!(find(&l, "dup2:x"), Some(&cmd("dup2:x", "user wins", SlashSource::User)));
}

#[test]
fn nearest_project_claude_wins_over_parent() {
    let _g = guard();
    let cwd = project(&["a"]);
    let p = PathBuf::from(&cwd);
    put(&p.join(".claude/commands/same.md"), "---\ndescription: near\n---\n");
    put(&p.parent().unwrap().join(".claude/commands/same.md"), "---\ndescription: far\n---\n");
    assert_eq!(find(&list(&cwd), "same").unwrap().description, "near");
}

#[test]
fn project_skill_beats_project_command_with_same_name() {
    let _g = guard();
    let cwd = project(&[]);
    let c = Path::new(&cwd).join(".claude");
    skill(&c, "both", "---\ndescription: skill\n---\n");
    put(&c.join("commands/both.md"), "---\ndescription: command\n---\n");
    assert_eq!(find(&list(&cwd), "both").unwrap().description, "skill");
}

#[test]
fn builtin_list_has_interactive_commands_and_not_cost_vim_review() {
    let _g = guard();
    let l = list(&project(&[]));
    for name in ["resume", "theme", "login", "copy", "clear", "compact", "model", "help", "exit"] {
        let c = find(&l, name).unwrap_or_else(|| panic!("{name}"));
        assert_eq!(c.source, SlashSource::Builtin);
        assert!(!c.description.is_empty());
    }
    for name in ["cost", "vim", "review"] {
        assert!(find(&l, name).is_none(), "{name}");
    }
}

#[test]
fn builtin_names_are_unique() {
    let _g = guard();
    let l = list(&project(&[]));
    let ns = names(&l);
    assert_eq!(ns.iter().collect::<std::collections::HashSet<_>>().len(), ns.len());
}

#[test]
fn caches_the_result_per_cwd_for_a_while() {
    let _g = guard();
    let cwd = project(&[]);
    let sc = SlashCommands::new();
    let first = sc.list(&cwd);
    put(&claude().join("commands/late.md"), "x");
    assert_eq!(sc.list(&cwd), first);
    assert!(find(&sc.list(&project(&[])), "late").is_some()); // otro cwd: no usa la caché
}

// listSlashCommandsFull
struct Fx {
    work: PathBuf,
    count: PathBuf,
    env: PathBuf,
    args: PathBuf,
    saved: Option<String>,
}
impl Fx {
    fn new() -> Self {
        let work = tempfile::Builder::new().prefix("fake-claude-").tempdir().unwrap().keep();
        Fx { count: work.join("count"), env: work.join("env"), args: work.join("args"), work, saved: std::env::var("CLAWHIP_CLAUDE_BIN").ok() }
    }
    // claude falso: cuenta invocaciones, vuelca entorno y argumentos y, con -p ... stream-json, imprime el init.
    fn fake(&self, body: &str) {
        let script = format!(
            "#!/bin/sh\necho x >> \"{}\"\nenv > \"{}\"\nprintf '%s\\n' \"$@\" > \"{}\"\n{}\n",
            self.count.display(),
            self.env.display(),
            self.args.display(),
            body
        );
        let p = self.work.join("claude");
        // Se escribe con un nombre temporal y se renombra: evita ETXTBSY si otro hilo hace fork.
        let tmp = self.work.join("claude.tmp");
        fs::write(&tmp, script).unwrap();
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).unwrap();
        fs::rename(&tmp, &p).unwrap();
        std::env::set_var("CLAWHIP_CLAUDE_BIN", &p);
    }
    fn spawns(&self) -> usize {
        fs::read_to_string(&self.count).map(|t| t.lines().filter(|l| !l.is_empty()).count()).unwrap_or(0)
    }
}
impl Drop for Fx {
    fn drop(&mut self) {
        match &self.saved {
            Some(v) => std::env::set_var("CLAWHIP_CLAUDE_BIN", v),
            None => std::env::remove_var("CLAWHIP_CLAUDE_BIN"),
        }
    }
}
fn init_script(cmds: &[&str]) -> String {
    let j = json!({"type":"system","subtype":"init","slash_commands":cmds}).to_string();
    format!("case \" $* \" in *\" --output-format stream-json \"*) printf '%s\\n' '{j}'; exec sleep 30;; esac\nexit 1")
}

#[test]
fn quick_returns_disk_list_without_spawning() {
    let _g = guard();
    let fx = Fx::new();
    fx.fake(&init_script(&["foo"]));
    let l = SlashCommands::new().list_full(&project(&[]), true);
    assert!(find(&l, "resume").is_some());
    assert!(find(&l, "foo").is_none());
    assert_eq!(fx.spawns(), 0);
}

#[test]
fn merges_init_names_first_with_disk_descriptions() {
    let _g = guard();
    let fx = Fx::new();
    put(&claude().join("commands/mycmd.md"), "---\ndescription: Mi comando\n---\n");
    put(&claude().join("commands/unlisted.md"), "---\ndescription: No está en init\n---\n");
    fx.fake(&init_script(&[
        "mycmd", "compact", "unknown-skill", "plug:thing", "__internal", "__x", "workflow-launch-exec", "design-consent", "design-revoke", "extra-usage", "heapdump", "clear",
    ]));
    let l = SlashCommands::new().list_full(&project(&[]), false);
    let ns = names(&l);
    assert_eq!(&ns[..5], ["mycmd", "compact", "unknown-skill", "plug:thing", "clear"]);
    assert_eq!(l[0], cmd("mycmd", "Mi comando", SlashSource::User));
    assert_eq!((l[1].name.as_str(), l[1].source), ("compact", SlashSource::Builtin));
    assert!(l[1].description.to_lowercase().contains("context"));
    assert_eq!(l[2], cmd("unknown-skill", "", SlashSource::Builtin));
    assert_eq!(l[3], cmd("plug:thing", "", SlashSource::Plugin));
    for h in ["__internal", "__x", "workflow-launch-exec", "design-consent", "design-revoke", "extra-usage", "heapdump"] {
        assert!(!ns.contains(&h), "{h}");
    }
    let pos = |x: &str| ns.iter().position(|n| *n == x).unwrap();
    assert!(pos("unlisted") > 4 && pos("resume") > 4);
    assert_eq!(ns.iter().collect::<std::collections::HashSet<_>>().len(), ns.len());
}

#[test]
fn probes_with_closed_port_base_url_and_model_free_invocation() {
    let _g = guard();
    let fx = Fx::new();
    fx.fake(&init_script(&["a"]));
    SlashCommands::new().list_full(&project(&[]), false);
    let env = fs::read_to_string(&fx.env).unwrap();
    assert!(env.lines().any(|l| l == "ANTHROPIC_BASE_URL=http://127.0.0.1:9"));
    assert!(env.lines().any(|l| l == "DISABLE_AUTOUPDATER=1"));
    let raw = fs::read_to_string(&fx.args).unwrap();
    let args: Vec<&str> = raw.lines().collect();
    for a in ["-p", "--no-session-persistence", "--output-format", "stream-json", "--max-turns", "1"] {
        assert!(args.contains(&a), "{a}");
    }
    assert!(raw.contains("disableAllHooks"));
}

#[test]
fn runs_the_probe_in_the_requested_cwd() {
    let _g = guard();
    let fx = Fx::new();
    fx.fake(&format!("pwd > \"{}\"\n{}", fx.work.join("pwd").display(), init_script(&["a"])));
    let cwd = project(&[]);
    SlashCommands::new().list_full(&cwd, false);
    assert_eq!(fs::read_to_string(fx.work.join("pwd")).unwrap().trim(), cwd);
}

#[test]
fn does_not_leak_parent_anthropic_base_url() {
    let _g = guard();
    let fx = Fx::new();
    let saved = std::env::var("ANTHROPIC_BASE_URL").ok();
    std::env::set_var("ANTHROPIC_BASE_URL", "https://real.example.com");
    fx.fake(&init_script(&["a"]));
    SlashCommands::new().list_full(&project(&[]), false);
    match saved {
        Some(v) => std::env::set_var("ANTHROPIC_BASE_URL", v),
        None => std::env::remove_var("ANTHROPIC_BASE_URL"),
    }
    assert!(!fs::read_to_string(&fx.env).unwrap().contains("real.example.com"));
}

#[test]
fn strips_inherited_claude_session_vars_from_the_child() {
    let _g = guard();
    let fx = Fx::new();
    std::env::set_var("CLAUDECODE", "1");
    std::env::set_var("CLAUDE_CODE_USE_BEDROCK", "1");
    fx.fake(&init_script(&["a"]));
    SlashCommands::new().list_full(&project(&[]), false);
    std::env::remove_var("CLAUDECODE");
    std::env::remove_var("CLAUDE_CODE_USE_BEDROCK");
    let env = fs::read_to_string(&fx.env).unwrap();
    assert!(!env.lines().any(|l| l.starts_with("CLAUDECODE=")));
    assert!(env.lines().any(|l| l == "CLAUDE_CODE_USE_BEDROCK=1"));
}

#[test]
fn caches_init_for_10_minutes_per_cwd() {
    let _g = guard();
    let fx = Fx::new();
    fx.fake(&init_script(&["only-in-init"]));
    let sc = SlashCommands::new();
    let cwd = project(&[]);
    let a = sc.list_full(&cwd, false);
    let b = sc.list_full(&cwd, false);
    assert_eq!(fx.spawns(), 1);
    assert_eq!(names(&a), names(&b));
    assert_eq!(sc.list_full(&cwd, true)[0].name, "only-in-init");
    assert_eq!(fx.spawns(), 1);
    sc.list_full(&project(&[]), false);
    assert_eq!(fx.spawns(), 2);
}

#[test]
fn probes_again_after_cache_expires() {
    let _g = guard();
    let fx = Fx::new();
    fx.fake(&init_script(&["a"]));
    let now = Arc::new(AtomicU64::new(1_000_000));
    let c = now.clone();
    let sc = SlashCommands::with_clock(ClaudeBin::new(), move || c.load(Ordering::SeqCst));
    let cwd = project(&[]);
    sc.list_full(&cwd, false);
    now.fetch_add(9 * 60_000, Ordering::SeqCst);
    sc.list_full(&cwd, false);
    assert_eq!(fx.spawns(), 1);
    now.fetch_add(2 * 60_000, Ordering::SeqCst);
    sc.list_full(&cwd, false);
    assert_eq!(fx.spawns(), 2);
}

#[test]
fn concurrent_calls_for_same_cwd_share_one_probe() {
    let _g = guard();
    let fx = Fx::new();
    fx.fake(&init_script(&["a"]));
    let sc = Arc::new(SlashCommands::new());
    let cwd = project(&[]);
    let hs: Vec<_> = (0..2)
        .map(|_| {
            let (sc, cwd) = (sc.clone(), cwd.clone());
            std::thread::spawn(move || sc.list_full(&cwd, false))
        })
        .collect();
    let rs: Vec<_> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(fx.spawns(), 1);
    assert_eq!(rs[0][0].name, "a");
    assert_eq!(rs[1][0].name, "a");
}

#[test]
fn falls_back_to_disk_when_probe_fails_and_does_not_cache_failure() {
    let _g = guard();
    let fx = Fx::new();
    fx.fake("exit 1");
    let sc = SlashCommands::new();
    let cwd = project(&[]);
    assert!(find(&sc.list_full(&cwd, false), "resume").is_some());
    sc.list_full(&cwd, false);
    assert_eq!(fx.spawns(), 2);
}

#[test]
fn falls_back_when_binary_cannot_be_executed() {
    let _g = guard();
    let fx = Fx::new();
    std::env::set_var("CLAWHIP_CLAUDE_BIN", fx.work.join("does-not-exist"));
    assert!(find(&SlashCommands::new().list_full(&project(&[]), false), "resume").is_some());
}

#[test]
fn falls_back_when_model_answers_instead_of_init() {
    let _g = guard();
    let fx = Fx::new();
    fx.fake("printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"error\"}'; exec sleep 30");
    assert!(find(&SlashCommands::new().list_full(&project(&[]), false), "resume").is_some());
    assert_eq!(fx.spawns(), 1);
}

#[test]
fn tolerates_noise_and_partial_lines_before_init() {
    let _g = guard();
    let fx = Fx::new();
    fx.fake("printf 'not json\\n{\"type\":\"system\",\"subtype\":\"hook\"}\\n'; printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"slash_commands\":[\"z-cmd\"]}'; exec sleep 30");
    assert_eq!(SlashCommands::new().list_full(&project(&[]), false)[0].name, "z-cmd");
}

// Node lista los directorios ordenados por nombre (libuv scandir + strcmp): el orden de los
// comandos del disco no puede depender del orden crudo del sistema de archivos.
#[test]
fn disk_listing_is_sorted_by_name_like_node_readdir() {
    let _g = guard();
    let names_in: Vec<String> = (0..24).map(|i| format!("s{:02}", (i * 7) % 24)).collect();
    for d in &names_in {
        skill(&claude(), d, "---\ndescription: x\n---");
        put(&claude().join("commands").join(format!("{d}.md")), "x");
    }
    let l = list(&project(&[]));
    let got: Vec<&str> = names(&l).into_iter().filter(|n| n.starts_with('s') && n.len() == 3).collect();
    let mut sorted: Vec<String> = names_in.clone();
    sorted.sort();
    // skills primero (ordenadas), después comandos (ordenados); los nombres repetidos se descartan.
    assert_eq!(got, sorted.iter().map(String::as_str).collect::<Vec<_>>());
}
