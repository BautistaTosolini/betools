use anyhow::{anyhow, Result};
use betools_secrets::*;
use betools_types::{EnvScope, EnvScopeKind, EnvSource, EnvVarMeta};
use std::{collections::HashMap, os::unix::fs::PermissionsExt, path::PathBuf};

#[test]
fn validate_name_accepts() {
    for n in ["FOO", "foo", "_x", "A1_b2", "MY_API_KEY", "PATHX", "HOMEDIR", "BETOOL", "CLAUDE_CODE", "CLAUDECODEX"] {
        assert!(validate_name(n).is_ok(), "{n}");
    }
}

#[test]
fn validate_name_rejects_invalid() {
    for n in ["", "1ABC", "A-B", "A B", "A.B", "Ñu", "A=B", "A$B", "-x", "A\n"] {
        let e = validate_name(n).unwrap_err().to_string();
        assert!(e.contains("Invalid name"), "{n:?}");
    }
}

#[test]
fn validate_name_rejects_reserved() {
    for n in [
        "PATH", "HOME", "USER", "SHELL", "TERM", "COLORTERM", "PWD", "CLAWHIP_STATUS_FILE", "CLAWHIP_", "CLAWHIP_X", "BETOOLS",
        "BETOOLS_USER_STATUSLINE", "BETOOLSX", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_X", "CLAUDECODE",
    ] {
        let e = validate_name(n).unwrap_err().to_string();
        assert!(e.contains("reserved"), "{n}");
    }
}

#[test]
fn reserved_names_are_case_sensitive() {
    assert!(validate_name("path").is_ok());
    assert!(validate_name("home").is_ok());
}

// aws falso: registra los argumentos (uno por línea) y responde con lo configurado en esta prueba.
struct FakeAws {
    dir: tempfile::TempDir,
}
impl FakeAws {
    fn new(out: &str, err: &str, rc: i32) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::write(p.join("out"), out).unwrap();
        std::fs::write(p.join("err"), err).unwrap();
        std::fs::write(p.join("calls.log"), "").unwrap();
        let script = format!(
            "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> \"{d}/calls.log\"; done\nprintf -- '--END--\\n' >> \"{d}/calls.log\"\ncat \"{d}/out\"\n[ -s \"{d}/err\" ] && {{ cat \"{d}/err\" >&2; printf '\\n' >&2; }}\nexit {rc}\n",
            d = p.display()
        );
        std::fs::write(p.join("aws"), script).unwrap();
        std::fs::set_permissions(p.join("aws"), std::fs::Permissions::from_mode(0o755)).unwrap();
        Self { dir }
    }
    fn bin(&self) -> String {
        self.dir.path().join("aws").to_string_lossy().into_owned()
    }
    fn calls(&self) -> Vec<Vec<String>> {
        std::fs::read_to_string(self.dir.path().join("calls.log"))
            .unwrap()
            .split("\n--END--\n")
            .filter(|c| !c.is_empty())
            .map(|c| c.split('\n').map(String::from).collect())
            .collect()
    }
}
fn ok(out: &str) -> FakeAws {
    FakeAws::new(out, "", 0)
}
fn sm(key: Option<&str>) -> EnvSource {
    EnvSource::AwsSm { profile: "p".into(), region: None, secret_id: "x".into(), json_key: key.map(Into::into) }
}
fn ssm(profile: &str, region: Option<&str>, name: &str) -> EnvSource {
    EnvSource::AwsSsm { profile: profile.into(), region: region.map(Into::into), name: name.into() }
}
fn v(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn plain_returns_value_without_calling_aws() {
    let f = ok("");
    assert_eq!(resolve_ref_with(&f.bin(), &EnvSource::Plain { value: "x".into() }).await.unwrap(), "x");
    assert!(f.calls().is_empty());
}

#[tokio::test]
async fn aws_ssm_args_profile_output_text_and_region() {
    let f = ok("valor-ssm\n");
    let r = resolve_ref_with(&f.bin(), &ssm("cli-prod", Some("us-east-1"), "/app/token")).await.unwrap();
    assert_eq!(r, "valor-ssm");
    assert_eq!(
        f.calls(),
        vec![v(&["ssm", "get-parameter", "--name", "/app/token", "--with-decryption", "--query", "Parameter.Value", "--profile", "cli-prod", "--output", "text", "--region", "us-east-1"])]
    );
}

#[tokio::test]
async fn aws_ssm_without_region_omits_region() {
    let f = ok("v");
    resolve_ref_with(&f.bin(), &ssm("p", None, "n")).await.unwrap();
    assert!(!f.calls()[0].contains(&"--region".to_string()));
    assert!(f.calls()[0].contains(&"--output".to_string()));
}

#[tokio::test]
async fn removes_only_one_trailing_newline() {
    let f = ok("a\n\n");
    assert_eq!(resolve_ref_with(&f.bin(), &ssm("p", None, "n")).await.unwrap(), "a\n");
}

#[tokio::test]
async fn aws_sm_without_json_key_returns_raw() {
    let f = ok("plain-secret\n");
    let s = EnvSource::AwsSm { profile: "p".into(), region: Some("eu-west-1".into()), secret_id: "prod/db".into(), json_key: None };
    assert_eq!(resolve_ref_with(&f.bin(), &s).await.unwrap(), "plain-secret");
    assert_eq!(
        f.calls(),
        vec![v(&["secretsmanager", "get-secret-value", "--secret-id", "prod/db", "--query", "SecretString", "--profile", "p", "--output", "text", "--region", "eu-west-1"])]
    );
}

#[tokio::test]
async fn aws_sm_json_key_extracts_string() {
    let f = ok("{\"user\":\"admin\",\"pass\":\"s3cr3t\"}\n");
    assert_eq!(resolve_ref_with(&f.bin(), &sm(Some("pass"))).await.unwrap(), "s3cr3t");
}

#[tokio::test]
async fn aws_sm_json_key_stringifies_non_strings() {
    let f = ok("{\"n\":5,\"b\":false,\"o\":{\"a\":1},\"l\":[1,2],\"z\":null,\"f\":1.0}");
    let r = |k: &'static str| {
        let bin = f.bin();
        async move { resolve_ref_with(&bin, &sm(Some(k))).await.unwrap() }
    };
    assert_eq!(r("n").await, "5");
    assert_eq!(r("b").await, "false");
    assert_eq!(r("o").await, "{\"a\":1}");
    assert_eq!(r("l").await, "[1,2]");
    assert_eq!(r("z").await, "null");
    assert_eq!(r("f").await, "1");
}

#[tokio::test]
async fn aws_sm_json_key_on_non_json_does_not_leak() {
    let f = ok("esto-es-secreto");
    let e = resolve_ref_with(&f.bin(), &sm(Some("k"))).await.unwrap_err().to_string();
    assert!(e.contains("not JSON"));
    assert!(!e.contains("esto-es-secreto"));
}

#[tokio::test]
async fn aws_sm_missing_key_names_key_only() {
    let f = ok("{\"a\":\"valor-secreto\"}");
    let e = resolve_ref_with(&f.bin(), &sm(Some("b"))).await.unwrap_err().to_string();
    assert_eq!(e, "The secret has no key \"b\".");
}

#[tokio::test]
async fn aws_sm_json_that_is_not_an_object_has_no_key() {
    for out in ["null", "\"texto\""] {
        let f = ok(out);
        let e = resolve_ref_with(&f.bin(), &sm(Some("a"))).await.unwrap_err().to_string();
        assert!(e.contains("no key"), "{out}");
    }
}

#[tokio::test]
async fn aws_failure_uses_last_stderr_line_truncated_to_300() {
    let f = FakeAws::new("", &format!("linea 1\n{}", "E".repeat(500)), 254);
    let e = resolve_ref_with(&f.bin(), &ssm("p", None, "n")).await.unwrap_err().to_string();
    assert_eq!(e, "E".repeat(300));
}

#[tokio::test]
async fn aws_failure_without_stderr_uses_error_message() {
    let f = FakeAws::new("", "", 3);
    let e = resolve_ref_with(&f.bin(), &ssm("p", None, "n")).await.unwrap_err().to_string();
    assert!(e.contains("Command failed"));
}

#[tokio::test]
async fn no_shell_special_characters_are_literal() {
    let f = ok("v");
    let name = "/a b/$(touch pwned);`x`";
    resolve_ref_with(&f.bin(), &ssm("p", None, name)).await.unwrap();
    assert_eq!(f.calls()[0][3], name);
}

#[tokio::test]
async fn unsupported_source_errors() {
    let e = resolve_ref_with("aws", &EnvSource::Local {}).await.unwrap_err().to_string();
    assert_eq!(e, "Unsupported source");
}

// --- resolve_env ---

struct Store(HashMap<String, String>, bool);
impl LocalStore for Store {
    fn get(&self, scope: &EnvScope, name: &str) -> Result<Option<String>> {
        if self.1 {
            return Err(anyhow!("keychain locked"));
        }
        Ok(self.0.get(&format!("{:?}:{}:{name}", scope.kind, scope.id)).cloned())
    }
}
fn store(items: &[(&EnvScope, &str, &str)]) -> Store {
    Store(items.iter().map(|(s, n, v)| (format!("{:?}:{}:{n}", s.kind, s.id), v.to_string())).collect(), false)
}
fn meta(name: &str, source: EnvSource) -> EnvVarMeta {
    EnvVarMeta { name: name.into(), source, updated_at: "t".into() }
}
fn plain(v: &str) -> EnvSource {
    EnvSource::Plain { value: v.into() }
}
fn folder() -> EnvScope {
    EnvScope { kind: EnvScopeKind::Folder, id: "/f".into() }
}
fn session() -> EnvScope {
    EnvScope { kind: EnvScopeKind::Session, id: "s1".into() }
}
fn layer(scope: EnvScope, vars: Vec<EnvVarMeta>) -> EnvLayer {
    EnvLayer { scope, vars }
}
fn envmap(p: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
    p.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

#[tokio::test]
async fn empty_layers() {
    assert_eq!(resolve_env(&[], &store(&[])).await, ResolvedEnv::default());
}

#[tokio::test]
async fn plain_values_are_in_env_but_not_names() {
    let r = resolve_env(&[layer(folder(), vec![meta("AWS_PROFILE", plain("prod"))])], &store(&[])).await;
    assert_eq!(r, ResolvedEnv { env: envmap(&[("AWS_PROFILE", "prod")]), names: vec![], errors: vec![] });
}

#[tokio::test]
async fn session_overrides_folder() {
    let r = resolve_env(
        &[
            layer(folder(), vec![meta("A", plain("folder")), meta("B", plain("b-folder"))]),
            layer(session(), vec![meta("A", plain("session"))]),
        ],
        &store(&[]),
    )
    .await;
    assert_eq!(r.env, envmap(&[("A", "session"), ("B", "b-folder")]));
}

#[tokio::test]
async fn override_changes_kind_plain_to_local_is_secret() {
    let (f, s) = (folder(), session());
    let r = resolve_env(
        &[layer(f, vec![meta("A", plain("x"))]), layer(s.clone(), vec![meta("A", EnvSource::Local {})])],
        &store(&[(&s, "A", "sec")]),
    )
    .await;
    assert_eq!(r.env["A"], "sec");
    assert_eq!(r.names, vec!["A"]);
}

#[tokio::test]
async fn local_values_use_scope_of_winning_layer() {
    let (f, s) = (folder(), session());
    let r = resolve_env(
        &[
            layer(f.clone(), vec![meta("TOKEN", EnvSource::Local {}), meta("OTHER", EnvSource::Local {})]),
            layer(s.clone(), vec![meta("TOKEN", EnvSource::Local {})]),
        ],
        &store(&[(&f, "TOKEN", "de-carpeta"), (&s, "TOKEN", "de-sesion"), (&f, "OTHER", "o")]),
    )
    .await;
    assert_eq!(r.env, envmap(&[("TOKEN", "de-sesion"), ("OTHER", "o")]));
    assert_eq!(r.names, vec!["OTHER", "TOKEN"]);
}

#[tokio::test]
async fn missing_local_value_is_error_without_value() {
    let r = resolve_env(&[layer(folder(), vec![meta("MISSING", EnvSource::Local {})])], &store(&[])).await;
    assert!(r.env.is_empty() && r.names.is_empty());
    assert_eq!(r.errors, vec!["MISSING: no stored value"]);
}

#[tokio::test]
async fn empty_string_stored_locally_is_valid() {
    let f = folder();
    let r = resolve_env(&[layer(f.clone(), vec![meta("E", EnvSource::Local {})])], &store(&[(&f, "E", "")])).await;
    assert_eq!(r.env, envmap(&[("E", "")]));
    assert_eq!(r.names, vec!["E"]);
}

#[tokio::test]
async fn store_that_throws_is_reported() {
    let r = resolve_env(&[layer(folder(), vec![meta("X", EnvSource::Local {})])], &Store(HashMap::new(), true)).await;
    assert_eq!(r.errors, vec!["X: keychain locked"]);
}

#[tokio::test]
async fn aws_refs_resolved_and_errors_never_include_values() {
    let f = ok("valor-super-secreto\n");
    let r = resolve_env_with(&f.bin(), &[layer(folder(), vec![meta("DB", ssm("p", None, "/db"))])], &store(&[])).await;
    assert_eq!(r.env, envmap(&[("DB", "valor-super-secreto")]));
    assert_eq!(r.names, vec!["DB"]);

    let f = ok("{\"a\":\"valor-super-secreto\"}");
    let src = EnvSource::AwsSm { profile: "p".into(), region: None, secret_id: "s".into(), json_key: Some("zzz".into()) };
    let r = resolve_env_with(&f.bin(), &[layer(folder(), vec![meta("DB", src)])], &store(&[])).await;
    assert!(r.env.is_empty());
    assert_eq!(r.errors, vec!["DB: The secret has no key \"zzz\"."]);
    assert!(!format!("{r:?}").contains("valor-super-secreto"));
}

#[tokio::test]
async fn failing_variable_does_not_block_others_and_names_sorted() {
    let f = ok("v");
    let r = resolve_env_with(
        &f.bin(),
        &[layer(
            folder(),
            vec![
                meta("ZED", ssm("p", None, "n")),
                meta("BAD", EnvSource::Local {}),
                meta("ALPHA", ssm("p", None, "n2")),
                meta("PLAIN", plain("p")),
            ],
        )],
        &store(&[]),
    )
    .await;
    assert_eq!(r.env.keys().cloned().collect::<Vec<_>>(), vec!["ALPHA", "PLAIN", "ZED"]);
    assert_eq!(r.names, vec!["ALPHA", "ZED"]);
    assert_eq!(r.errors, vec!["BAD: no stored value"]);
}

// --- aws_profiles (sobre un HOME temporal: nunca toca ~/.aws real) ---

fn home_with(cfg: Option<&str>) -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    if let Some(c) = cfg {
        std::fs::create_dir_all(d.path().join(".aws")).unwrap();
        std::fs::write(d.path().join(".aws/config"), c).unwrap();
    }
    let p = d.path().to_path_buf();
    (d, p)
}

#[test]
fn profiles_empty_without_config() {
    let (_d, p) = home_with(None);
    assert!(aws_profiles_in(&p).is_empty());
}

#[test]
fn profiles_parse_dedupe_sort() {
    let cfg = ["[profile zeta]", "region = us-east-1", "", "[default]", "region = us-west-2", "", "[profile alpha]", "role_arn = arn:aws:iam::1:role/x", "", "[profile zeta]", "region = eu-west-1", "", "[profile  beta]", ""].join("\n");
    let (_d, p) = home_with(Some(&cfg));
    assert_eq!(aws_profiles_in(&p), vec!["alpha", "beta", "default", "zeta"]);
}

#[test]
fn profiles_ignore_sso_session_and_comments() {
    let (_d, p) = home_with(Some("[sso-session corp]\nsso_region = x\n# [profile commented]\n[profile real]\n"));
    assert_eq!(aws_profiles_in(&p), vec!["real"]);
}

#[test]
fn profiles_crlf() {
    let (_d, p) = home_with(Some("[profile a]\r\nregion=x\r\n[profile b]\r\n"));
    assert_eq!(aws_profiles_in(&p), vec!["a", "b"]);
}

#[test]
fn profiles_dots_dashes_colons() {
    let (_d, p) = home_with(Some("[profile cli-prod.admin]\n[profile a:b]\n"));
    assert_eq!(aws_profiles_in(&p), vec!["a:b", "cli-prod.admin"]);
}

#[tokio::test]
async fn aws_sm_json_key_numbers_follow_js_formatting() {
    // JSON.parse/stringify de JS: todo número es f64 y se imprime con Number#toString.
    let f = ok("{\"big\":12345678901234567890,\"e\":1e21,\"s\":1e-7,\"x\":1.5e3,\"neg\":-0.0,\"o\":{\"b\":2,\"1\":1,\"0\":0,\"a\":1e2}}");
    let r = |k: &'static str| {
        let bin = f.bin();
        async move { resolve_ref_with(&bin, &sm(Some(k))).await.unwrap() }
    };
    assert_eq!(r("big").await, "12345678901234567000");
    assert_eq!(r("e").await, "1e+21");
    assert_eq!(r("s").await, "1e-7");
    assert_eq!(r("x").await, "1500");
    assert_eq!(r("neg").await, "0");
    // Las claves tipo índice van primero y en orden numérico.
    assert_eq!(r("o").await, "{\"0\":0,\"1\":1,\"b\":2,\"a\":100}");
}

#[tokio::test]
async fn aws_sm_json_key_indexes_strings_and_arrays_like_js() {
    let f = ok("\"abc\"");
    assert_eq!(resolve_ref_with(&f.bin(), &sm(Some("1"))).await.unwrap(), "b");
    assert_eq!(resolve_ref_with(&f.bin(), &sm(Some("length"))).await.unwrap(), "3");
    let f = ok("[10,20]");
    assert_eq!(resolve_ref_with(&f.bin(), &sm(Some("length"))).await.unwrap(), "2");
    assert_eq!(resolve_ref_with(&f.bin(), &sm(Some("1"))).await.unwrap(), "20");
}
