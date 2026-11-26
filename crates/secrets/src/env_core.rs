//! Lógica de variables de entorno sin dependencias de la app (src/main/env-core.ts): la usan el
//! escritorio y la versión web.

use anyhow::{anyhow, Result};
use betools_types::{EnvScope, EnvScopeKind, EnvSource, EnvVarMeta};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeMap, fmt, path::Path, process::Stdio, sync::OnceLock, time::Duration};
use tokio::process::Command;

fn name_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap())
}

// Variables que no se pueden pisar: romperían la sesión o el seguimiento de estado.
fn reserved_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^(PATH|HOME|USER|SHELL|TERM|COLORTERM|PWD|CLAWHIP_.*|BETOOLS.*|CLAUDE_CODE_.*|CLAUDECODE)$").unwrap()
    })
}

pub fn validate_name(name: &str) -> Result<()> {
    if !name_re().is_match(name) {
        return Err(anyhow!("Invalid name: only letters, numbers and \"_\", not starting with a number."));
    }
    if reserved_re().is_match(name) {
        return Err(anyhow!("{name} is reserved and cannot be overridden."));
    }
    Ok(())
}

/// Almacén de valores secretos "local" (escritorio: llavero del sistema; web: clave maestra).
pub trait LocalStore: Send + Sync {
    fn get(&self, scope: &EnvScope, name: &str) -> Result<Option<String>>;
}

const AWS_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BUFFER: usize = 1024 * 1024;

// Lectura desde AWS con el CLI y el perfil indicado. Sin shell: los argumentos van separados.
async fn aws(bin: &str, args: &[&str], profile: &str, region: Option<&str>) -> Result<String> {
    let mut full: Vec<&str> = args.to_vec();
    full.extend(["--profile", profile, "--output", "text"]);
    if let Some(r) = region.filter(|r| !r.is_empty()) {
        full.extend(["--region", r]);
    }
    let child = Command::new(bin)
        .args(&full)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let child = child.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { anyhow!("spawn {bin} ENOENT") } else { anyhow!("spawn {bin} {e}") }
    })?;
    let failed = || format!("Command failed: {bin} {}", full.join(" "));
    let out = match tokio::time::timeout(AWS_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(anyhow!("{e}")),
        Err(_) => return Err(anyhow!(failed())),
    };
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if stdout.len() > MAX_BUFFER || stderr.len() > MAX_BUFFER {
        return Err(anyhow!("stdout maxBuffer length exceeded"));
    }
    if !out.status.success() {
        // El stderr del CLI no incluye el valor del secreto; se recorta para el mensaje.
        let msg = if stderr.is_empty() { failed() } else { stderr };
        let last = msg.trim().split('\n').next_back().unwrap_or("error");
        return Err(anyhow!(last.chars().take(300).collect::<String>()));
    }
    Ok(stdout.strip_suffix('\n').unwrap_or(&stdout).to_string())
}

// Número de JS (`Number#toString`): todo número JSON es f64 y se imprime con las reglas de ECMAScript.
fn js_number(f: f64) -> String {
    if f == 0.0 {
        return "0".into();
    }
    if !f.is_finite() {
        return "null".into(); // JSON.stringify(Infinity)
    }
    let sci = format!("{:e}", f.abs());
    let (mant, exp) = sci.split_once('e').expect("formato científico");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("exponente") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        let rest = if k == 1 { String::new() } else { format!(".{}", &digits[1..]) };
        format!("{}{rest}e{sign}{}", &digits[..1], e.abs())
    };
    if f < 0.0 { format!("-{body}") } else { body }
}

// Clave tipo índice de array: JS las ordena primero y en orden numérico.
fn array_index(k: &str) -> Option<u32> {
    let n: u32 = k.parse().ok()?;
    (n != u32::MAX && n.to_string() == k).then_some(n)
}

// `JSON.stringify(v)` de JS (compacto, números como f64, claves índice primero).
fn js_stringify(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => serde_json::to_string(s).expect("string"),
        Value::Array(a) => format!("[{}]", a.iter().map(js_stringify).collect::<Vec<_>>().join(",")),
        Value::Object(o) => {
            let mut idx: Vec<(u32, &String, &Value)> = Vec::new();
            let mut rest: Vec<(&String, &Value)> = Vec::new();
            for (k, v) in o {
                match array_index(k) {
                    Some(n) => idx.push((n, k, v)),
                    None => rest.push((k, v)),
                }
            }
            idx.sort_by_key(|(n, _, _)| *n);
            let items = idx.into_iter().map(|(_, k, v)| (k, v)).chain(rest);
            let parts: Vec<String> =
                items.map(|(k, v)| format!("{}:{}", serde_json::to_string(k).expect("string"), js_stringify(v))).collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

// `parsed[key]` de JS: además de objetos, indexa arrays y strings (`length`, índices).
fn js_get(parsed: &Value, key: &str) -> Option<Value> {
    match parsed {
        Value::Object(o) => o.get(key).cloned(),
        Value::Array(a) if key == "length" => Some(Value::from(a.len())),
        Value::Array(a) => array_index(key).and_then(|i| a.get(i as usize).cloned()),
        Value::String(s) if key == "length" => Some(Value::from(s.encode_utf16().count())),
        Value::String(s) => array_index(key)
            .and_then(|i| s.encode_utf16().nth(i as usize))
            .map(|u| Value::String(String::from_utf16_lossy(&[u]))),
        _ => None,
    }
}

pub async fn resolve_ref(source: &EnvSource) -> Result<String> {
    resolve_ref_with("aws", source).await
}

/// Igual que `resolve_ref` con otro ejecutable del CLI (lo usan las pruebas con un `aws` falso).
pub async fn resolve_ref_with(aws_bin: &str, source: &EnvSource) -> Result<String> {
    match source {
        EnvSource::Plain { value } => Ok(value.clone()),
        EnvSource::AwsSsm { profile, region, name } => {
            aws(
                aws_bin,
                &["ssm", "get-parameter", "--name", name, "--with-decryption", "--query", "Parameter.Value"],
                profile,
                region.as_deref(),
            )
            .await
        }
        EnvSource::AwsSm { profile, region, secret_id, json_key } => {
            let raw = aws(
                aws_bin,
                &["secretsmanager", "get-secret-value", "--secret-id", secret_id, "--query", "SecretString"],
                profile,
                region.as_deref(),
            )
            .await?;
            let Some(key) = json_key.as_deref().filter(|k| !k.is_empty()) else { return Ok(raw) };
            let parsed: Value = serde_json::from_str(&raw)
                .map_err(|_| anyhow!("The secret is not JSON: the given key cannot be extracted."))?;
            match js_get(&parsed, key) {
                None => Err(anyhow!("The secret has no key \"{key}\".")),
                Some(Value::String(s)) => Ok(s),
                Some(v) => Ok(js_stringify(&v)),
            }
        }
        EnvSource::Local {} => Err(anyhow!("Unsupported source")),
    }
}

/// Perfiles de ~/.aws/config, para elegir en la interfaz.
pub fn aws_profiles() -> Vec<String> {
    dirs::home_dir().map(|h| aws_profiles_in(&h)).unwrap_or_default()
}

pub fn aws_profiles_in(home: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(home.join(".aws").join("config")) else { return Vec::new() };
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| Regex::new(r"(?m)^\[(?:profile\s+)?([^\]\s]+)\]").unwrap());
    let set: std::collections::BTreeSet<String> = re.captures_iter(&text).map(|c| c[1].to_string()).collect();
    set.into_iter().collect()
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct ResolvedEnv {
    pub env: BTreeMap<String, String>,
    /// Solo las secretas (local / AWS): son las que se mencionan en la instrucción a Claude.
    pub names: Vec<String>,
    /// Solo nombres y motivo, nunca valores.
    pub errors: Vec<String>,
}

pub struct EnvLayer {
    pub scope: EnvScope,
    pub vars: Vec<EnvVarMeta>,
}

pub async fn resolve_env(layers: &[EnvLayer], local: &dyn LocalStore) -> ResolvedEnv {
    resolve_env_with("aws", layers, local).await
}

/// Variables efectivas de una sesión: las de su carpeta y, encima, las propias.
pub async fn resolve_env_with(aws_bin: &str, layers: &[EnvLayer], local: &dyn LocalStore) -> ResolvedEnv {
    // Como un Map de JS: pisar un nombre conserva su posición original.
    let mut effective: Vec<(&EnvScope, &EnvVarMeta)> = Vec::new();
    for layer in layers {
        for meta in &layer.vars {
            match effective.iter_mut().find(|(_, m)| m.name == meta.name) {
                Some(slot) => *slot = (&layer.scope, meta),
                None => effective.push((&layer.scope, meta)),
            }
        }
    }
    let results = futures::future::join_all(effective.iter().map(|(scope, meta)| async move {
        let v = match &meta.source {
            EnvSource::Plain { value } => Ok(Some(value.clone())),
            EnvSource::Local {} => local.get(scope, &meta.name),
            other => resolve_ref_with(aws_bin, other).await.map(Some),
        };
        match v {
            Ok(Some(v)) => Ok(v),
            Ok(None) => Err("no stored value".to_string()),
            Err(e) => Err(e.to_string()),
        }
    }))
    .await;

    let mut out = ResolvedEnv::default();
    for ((_, meta), r) in effective.iter().zip(results) {
        match r {
            Ok(v) => {
                out.env.insert(meta.name.clone(), v);
            }
            Err(e) => out.errors.push(format!("{}: {e}", meta.name)),
        }
    }
    out.names = effective
        .iter()
        .filter(|(_, m)| !matches!(m.source, EnvSource::Plain { .. }))
        .map(|(_, m)| m.name.clone())
        .filter(|n| out.env.contains_key(n))
        .collect();
    out.names.sort();
    out
}

/// Lo mínimo que necesita `move_env` del almacén de metadatos.
pub trait EnvMetaStore {
    fn env_of(&self, scope: &EnvScope) -> Vec<EnvVarMeta>;
    fn set_env(&mut self, scope: &EnvScope, meta: EnvVarMeta);
    fn delete_env(&mut self, scope: &EnvScope, name: &str);
}

/// Almacén de valores cifrados con escritura (interior mutable, como `LocalSecrets`).
pub trait LocalStoreRW: LocalStore {
    fn set(&self, scope: &EnvScope, name: &str, value: &str) -> Result<()>;
    fn delete(&self, scope: &EnvScope, name: &str) -> Result<()>;
}

#[derive(Debug)]
pub struct EnvExistsError(pub String);

impl fmt::Display for EnvExistsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} already exists in the destination.", self.0)
    }
}
impl std::error::Error for EnvExistsError {}

fn same_scope(a: &EnvScope, b: &EnvScope) -> bool {
    matches!((a.kind, b.kind), (EnvScopeKind::Folder, EnvScopeKind::Folder) | (EnvScopeKind::Session, EnvScopeKind::Session))
        && a.id == b.id
}

/// Mueve una variable entre ámbitos (sesión <-> carpeta). El valor cifrado se re-cifra con la clave
/// del destino sin pasar por la interfaz. Primero se escribe el destino y recién después se borra
/// el origen: si algo falla a mitad de camino, la variable queda duplicada, nunca perdida.
pub fn move_env(
    meta: &mut dyn EnvMetaStore,
    local: &dyn LocalStoreRW,
    from: &EnvScope,
    to: &EnvScope,
    name: &str,
    overwrite: bool,
) -> Result<()> {
    if same_scope(from, to) {
        return Err(anyhow!("Source and destination are the same."));
    }
    let v = meta
        .env_of(from)
        .into_iter()
        .find(|e| e.name == name)
        .ok_or_else(|| anyhow!("{name} does not exist in the source."))?;
    if !overwrite && meta.env_of(to).iter().any(|e| e.name == name) {
        return Err(EnvExistsError(name.to_string()).into());
    }
    if matches!(v.source, EnvSource::Local {}) {
        let value = local.get(from, name)?.ok_or_else(|| anyhow!("{name} has no stored value to move."))?;
        local.set(to, name, &value)?;
    } else {
        local.delete(to, name)?; // si el destino tenía una local con ese nombre, su valor cifrado sobra
    }
    let updated_at = chrono_now();
    meta.set_env(to, EnvVarMeta { name: name.to_string(), source: v.source.clone(), updated_at });
    local.delete(from, name)?;
    meta.delete_env(from, name);
    Ok(())
}

// `new Date().toISOString()`: UTC con milisegundos, sin depender de chrono.
fn chrono_now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Algoritmo civil de Howard Hinnant.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}
