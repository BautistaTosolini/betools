use crate::claude_paths::ClaudeBin;
use crate::util::{home_dir, is_js_ws, js_trim, read_dir_sorted};
use betools_types::{SlashCommand, SlashSource};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// Comandos y skills para el autocompletado de Rendered.
// 1) Lista completa: la del mensaje "init" de Claude Code en modo stream-json (incluye skills propias del
//    binario, de claude.ai y prompts de MCP). Para que no haya llamada al modelo (costaría tokens), la API
//    apunta a un puerto local cerrado: Claude emite "init" antes de llamar, la llamada falla y se mata el
//    proceso. Sin guardar sesión ni correr hooks.
// 2) Descripciones (y respaldo si lo anterior falla), leyendo los mismos lugares que lee Claude Code:
// - comandos propios de Claude Code (lista fija, abajo)
// - skills y comandos del usuario (~/.claude) y del proyecto (.claude en el cwd y sus carpetas padre)
// - skills y comandos de los plugins habilitados (installed_plugins.json + enabledPlugins)
// Referencias: https://code.claude.com/docs/en/slash-commands · https://code.claude.com/docs/en/skills

// Comandos propios de Claude Code que se usan en la TUI. Sacados de las definiciones del binario 2.1.332
// (sin los ocultos ni los que dependen de una función experimental); los que solo existen en modo interactivo
// (resume, theme, login…) no vienen en el "init", así que esta lista es la única fuente para ellos.
const BUILTIN: [(&str, &str); 59] = [
    ("add-dir", "Add a working directory"),
    ("advisor", "Let Claude consult a stronger model at key moments"),
    ("agents", "Manage subagents"),
    ("artifacts", "Browse your published and shared artifacts"),
    ("autocompact", "Set how full the context gets before auto-summarizing"),
    ("background", "Send this session to the background and free the terminal"),
    ("branch", "Create a branch of the current conversation at this point"),
    ("btw", "Ask a side question without interrupting Claude"),
    ("cd", "Move this session to a new working directory"),
    ("clear", "Start a new session with empty context"),
    ("color", "Set the prompt bar color for this session"),
    ("compact", "Free up context by summarizing the conversation so far"),
    ("config", "Open settings"),
    ("context", "Show current context usage"),
    ("copy", "Copy the last response to clipboard (/copy 2 for the one before)"),
    ("diff", "Show the changes made in this session"),
    ("effort", "Set the model's effort level"),
    ("exit", "Exit Claude Code"),
    ("export", "Export this session to a file or clipboard"),
    ("fast", "Toggle fast mode"),
    ("feedback", "Send feedback to Anthropic or report a bug"),
    ("focus", "Toggle focus view: just your prompt, summary, and response"),
    ("fork", "Start a background agent with the full conversation"),
    ("goal", "Set a goal Claude checks before stopping"),
    ("help", "Show help and available commands"),
    ("hooks", "View hook configurations for tool events"),
    ("ide", "Manage IDE integrations and show status"),
    ("init", "Create a CLAUDE.md for the project"),
    ("insights", "Generate a report analyzing your Claude Code sessions"),
    ("install-github-app", "Set up Claude GitHub Actions for a repository"),
    ("login", "Sign in to your Anthropic account"),
    ("logout", "Sign out from your Anthropic account"),
    ("mcp", "Manage MCP servers"),
    ("memory", "Edit CLAUDE.md files and memory settings"),
    ("mobile", "Show QR code to download the Claude mobile app"),
    ("model", "Set the AI model for Claude Code"),
    ("output-style", "List output styles or switch to one"),
    ("permissions", "Manage allow and deny tool permission rules"),
    ("plan", "Turn on plan mode or view the plan"),
    ("plugin", "Manage Claude Code plugins"),
    ("privacy-settings", "View and update your privacy settings"),
    ("recap", "Generate a one-line session recap now"),
    ("reload-plugins", "Activate pending plugin changes in the current session"),
    ("reload-skills", "Pick up skills added or changed on disk during this session"),
    ("remote-control", "Use this session from claude.ai and the phone"),
    ("rename", "Rename the current conversation"),
    ("resume", "Resume another conversation"),
    ("security-review", "Security review of the pending changes"),
    ("session", "Show cloud session URL and QR code"),
    ("skills", "List available skills"),
    ("status", "Show version, account, model, MCP servers, and setup warnings"),
    ("tasks", "View and manage this session's background work"),
    ("terminal-setup", "Set up terminal key bindings"),
    ("theme", "Change the theme"),
    ("tui", "Set the terminal UI renderer (classic | fullscreen)"),
    ("upgrade", "Upgrade your plan for higher rate limits"),
    ("usage", "Show session cost, plan usage, and activity stats"),
    ("version", "Show this session's version"),
    ("workflows", "Browse running and completed workflows"),
];

// Ocultos en la TUI (internos o renombrados) aunque el init los liste.
const HIDDEN: [&str; 5] = ["workflow-launch-exec", "design-consent", "design-revoke", "extra-usage", "heapdump"];

const PROBE_TIMEOUT: Duration = Duration::from_secs(25);
const LIST_TTL_MS: u64 = 30_000;
const INIT_TTL_MS: u64 = 10 * 60_000;

// Variables que Claude Code define para sus procesos hijos. Si la app se lanza desde una sesión
// de Claude, se heredan y la sesión nueva se cree "hija": entre otras cosas, no guarda el transcript.
// Se quitan solo estas; las CLAUDE_CODE_* de configuración del usuario (Bedrock, etc.) se respetan.
const INHERITED_SESSION_VARS: [&str; 14] = [
    "AI_AGENT",
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_VERSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
];

/// Entorno del proceso sin las variables que Claude Code define para sus hijos.
pub fn clean_env() -> Vec<(String, String)> {
    std::env::vars().filter(|(k, _)| !INHERITED_SESSION_VARS.contains(&k.as_str())).collect()
}

#[derive(Default)]
struct Fm {
    name: Option<String>,
    description: Option<String>,
}

// name y description del frontmatter YAML (incluye descripciones en bloque con > o |).
fn frontmatter(file: &Path) -> Fm {
    let Ok(text) = fs::read_to_string(file) else { return Fm::default() };
    let mut out = Fm::default();
    let Some(block) = frontmatter_block(&text) else {
        // Comandos sin frontmatter: la primera línea con texto sirve de descripción.
        if let Some(first) = text.split('\n').find(|l| !js_trim(l).is_empty() && !l.starts_with('#')) {
            out.description = Some(js_trim(first).to_string());
        }
        return out;
    };
    let lines: Vec<&str> = block.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        let (key, rest) = if let Some(r) = line.strip_prefix("name:") {
            ("name", r)
        } else if let Some(r) = line.strip_prefix("description:") {
            ("description", r)
        } else {
            continue;
        };
        let mut v = js_trim(rest).to_string();
        if matches!(v.as_str(), ">" | "|" | ">-" | "|-" | "") {
            let mut parts = vec![];
            // Línea indentada con algo de texto.
            while i < lines.len() && lines[i].starts_with(is_js_ws) && !js_trim(lines[i]).is_empty() {
                parts.push(js_trim(lines[i]));
                i += 1;
            }
            v = parts.join(" ");
        }
        // Una comilla al principio y otra al final, cada una por su lado.
        let v = v.strip_prefix(['"', '\'']).unwrap_or(&v);
        let v = v.strip_suffix(['"', '\'']).unwrap_or(v).to_string();
        if key == "name" {
            out.name = Some(v);
        } else {
            out.description = Some(v);
        }
    }
    out
}

// Equivale a /^---\r?\n([\s\S]*?)\r?\n---/: el contenido entre el primer "---" y el siguiente.
fn frontmatter_block(text: &str) -> Option<&str> {
    let start = text.strip_prefix("---\r\n").or_else(|| text.strip_prefix("---\n"))?;
    (0..=start.len()).filter(|&p| start.is_char_boundary(p)).find_map(|p| {
        let rest = &start[p..];
        (rest.starts_with("\n---") || rest.starts_with("\r\n---")).then(|| &start[..p])
    })
}

// Subcarpetas (no enlaces simbólicos: Dirent.isDirectory de Node).
fn dirs(p: &Path) -> Vec<String> {
    let Ok(rd) = read_dir_sorted(p) else { return vec![] };
    rd.into_iter().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.file_name().to_string_lossy().into_owned()).collect()
}

fn skills_in(root: &Path, prefix: &str, source: SlashSource) -> Vec<SlashCommand> {
    dirs(root)
        .into_iter()
        .filter(|d| root.join(d).join("SKILL.md").exists())
        .map(|d| {
            let fm = frontmatter(&root.join(&d).join("SKILL.md"));
            let name = fm.name.filter(|n| !n.is_empty()).unwrap_or(d);
            SlashCommand { name: format!("{prefix}{name}"), description: fm.description.unwrap_or_default(), source }
        })
        .collect()
}

// Comandos en .md; las subcarpetas forman el nombre con ":" (commands/frontend/test.md → frontend:test).
fn commands_in(root: &Path, prefix: &str, source: SlashSource) -> Vec<SlashCommand> {
    fn walk(root: &Path, dir: &Path, depth: u32, prefix: &str, source: SlashSource, out: &mut Vec<SlashCommand>) {
        let Ok(rd) = read_dir_sorted(dir) else { return };
        for e in rd {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            let fname = e.file_name().to_string_lossy().into_owned();
            if ft.is_dir() && depth < 3 {
                walk(root, &p, depth + 1, prefix, source, out);
            } else if ft.is_file() && fname.ends_with(".md") {
                let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().into_owned();
                let name = rel[..rel.len() - 3].split('/').collect::<Vec<_>>().join(":");
                out.push(SlashCommand { name: format!("{prefix}{name}"), description: frontmatter(&p).description.unwrap_or_default(), source });
            }
        }
    }
    let mut out = vec![];
    walk(root, root, 0, prefix, source, &mut out);
    out
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn enabled_plugins(home: &Path) -> Vec<(String, PathBuf)> {
    let installed = read_json(&home.join(".claude/plugins/installed_plugins.json"));
    let settings = read_json(&home.join(".claude/settings.json"));
    let Some(Value::Object(installed)) = installed.as_ref().and_then(|v| v.get("plugins")) else { return vec![] };
    let enabled = settings.as_ref().and_then(|v| v.get("enabledPlugins"));
    installed
        .iter()
        .filter(|(key, _)| enabled.and_then(|e| e.get(key.as_str())) != Some(&Value::Bool(false)))
        .filter_map(|(key, list)| {
            let path = list.as_array()?.last()?.get("installPath")?.as_str()?;
            let path = PathBuf::from(path);
            (!path.as_os_str().is_empty() && path.exists()).then(|| (key.split('@').next().unwrap_or("").to_string(), path))
        })
        .collect()
}

// Carpetas .claude del proyecto: la del cwd y las de sus padres hasta el home (sin incluir ~/.claude).
fn project_claude_dirs(home: &Path, cwd: &str) -> Vec<PathBuf> {
    let home = home.to_string_lossy();
    let mut out = vec![];
    let mut d = PathBuf::from(cwd);
    // Por carpeta, no por texto: con HOME /home/ana, /home/ana2 no está adentro.
    while d.to_string_lossy().starts_with(&format!("{home}/")) && d.to_string_lossy() != home {
        let c = d.join(".claude");
        if c.is_dir() {
            out.push(c);
        }
        match d.parent() {
            Some(p) => d = p.to_path_buf(),
            None => break,
        }
    }
    out
}

/// Lista de comandos y skills por cwd, con las cachés y la consulta al "init" de Claude Code.
/// Las llamadas bloquean: desde async conviene `spawn_blocking`.
pub struct SlashCommands {
    bin: ClaudeBin,
    clock: Box<dyn Fn() -> u64 + Send + Sync>,
    disk: Mutex<HashMap<String, (u64, Vec<SlashCommand>)>>,
    probed: Mutex<HashMap<String, (u64, Vec<String>)>>,
    probes: Mutex<HashMap<String, Arc<Probe>>>,
}

// Consulta en curso: las llamadas simultáneas para el mismo cwd esperan el mismo resultado.
#[derive(Default)]
struct Probe {
    result: Mutex<Option<Option<Vec<String>>>>,
    done: Condvar,
}

impl Default for SlashCommands {
    fn default() -> Self {
        Self::new()
    }
}

impl SlashCommands {
    pub fn new() -> Self {
        let now = || SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        Self::with_clock(ClaudeBin::new(), now)
    }

    /// Reloj en milisegundos inyectable para probar el vencimiento de las cachés.
    pub fn with_clock(bin: ClaudeBin, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self { bin, clock: Box::new(clock), disk: Default::default(), probed: Default::default(), probes: Default::default() }
    }

    /// Lista para un cwd. Con `quick`, la del disco al instante (más lo que ya haya dado el init, si está
    /// en caché); si no, espera el init (unos segundos la primera vez; se cachea 10 minutos).
    pub fn list_full(&self, cwd: &str, quick: bool) -> Vec<SlashCommand> {
        let disk = self.list(cwd);
        let mut hit = self.probed.lock().unwrap().get(cwd).cloned();
        if quick {
            return match hit {
                Some((_, names)) => merge(&disk, &names),
                None => disk,
            };
        }
        if hit.as_ref().is_none_or(|(at, _)| (self.clock)().saturating_sub(*at) > INIT_TTL_MS) {
            if let Some(names) = self.probe_shared(cwd) {
                let entry = ((self.clock)(), names);
                self.probed.lock().unwrap().insert(cwd.to_string(), entry.clone());
                hit = Some(entry);
            }
        }
        match hit {
            Some((_, names)) => merge(&disk, &names),
            None => disk,
        }
    }

    fn probe_shared(&self, cwd: &str) -> Option<Vec<String>> {
        let (probe, leader) = {
            let mut map = self.probes.lock().unwrap();
            match map.get(cwd) {
                Some(p) => (p.clone(), false),
                None => {
                    let p = Arc::new(Probe::default());
                    map.insert(cwd.to_string(), p.clone());
                    (p, true)
                }
            }
        };
        if leader {
            let names = probe_init(self.bin.get(), cwd);
            self.probes.lock().unwrap().remove(cwd);
            *probe.result.lock().unwrap() = Some(names.clone());
            probe.done.notify_all();
            return names;
        }
        let guard = probe.done.wait_while(probe.result.lock().unwrap(), |r| r.is_none()).unwrap();
        guard.clone().flatten()
    }

    /// Comandos del disco (proyecto > usuario > plugin > propios), cacheados 30 s por cwd.
    pub fn list(&self, cwd: &str) -> Vec<SlashCommand> {
        let now = (self.clock)();
        if let Some((at, list)) = self.disk.lock().unwrap().get(cwd) {
            if now.saturating_sub(*at) < LIST_TTL_MS {
                return list.clone();
            }
        }
        let home = home_dir();
        let user = home.join(".claude");
        let mut all: Vec<SlashCommand> = vec![];
        for d in project_claude_dirs(&home, cwd) {
            all.extend(skills_in(&d.join("skills"), "", SlashSource::Project));
            all.extend(commands_in(&d.join("commands"), "", SlashSource::Project));
        }
        all.extend(skills_in(&user.join("skills"), "", SlashSource::User));
        all.extend(commands_in(&user.join("commands"), "", SlashSource::User));
        for (name, path) in enabled_plugins(&home) {
            all.extend(skills_in(&path.join("skills"), &format!("{name}:"), SlashSource::Plugin));
            all.extend(commands_in(&path.join("commands"), &format!("{name}:"), SlashSource::Plugin));
        }
        all.extend(BUILTIN.iter().map(|(name, description)| SlashCommand { name: name.to_string(), description: description.to_string(), source: SlashSource::Builtin }));
        // Si un nombre se repite, gana el primero (proyecto > usuario > plugin > propio).
        let mut seen = HashSet::new();
        let list: Vec<SlashCommand> = all.into_iter().filter(|c| seen.insert(c.name.clone())).collect();
        self.disk.lock().unwrap().insert(cwd.to_string(), (now, list.clone()));
        list
    }
}

fn merge(disk: &[SlashCommand], init_names: &[String]) -> Vec<SlashCommand> {
    let by_name: HashMap<&str, &SlashCommand> = disk.iter().map(|c| (c.name.as_str(), c)).collect();
    let from_init: Vec<SlashCommand> = init_names
        .iter()
        .filter(|n| !n.starts_with("__") && !HIDDEN.contains(&n.as_str()))
        .map(|n| match by_name.get(n.as_str()) {
            Some(c) => (*c).clone(),
            None => SlashCommand { name: n.clone(), description: String::new(), source: if n.contains(':') { SlashSource::Plugin } else { SlashSource::Builtin } },
        })
        .collect();
    let names: HashSet<&str> = from_init.iter().map(|c| c.name.as_str()).collect();
    // Comandos interactivos que no aparecen en modo -p (resume, exit, help…), desde la lista fija.
    let rest: Vec<SlashCommand> = disk.iter().filter(|c| !names.contains(c.name.as_str())).cloned().collect();
    from_init.into_iter().chain(rest).collect()
}

// Nombres de comandos según el "init" de Claude Code para ese cwd, o None si no se pudo.
fn probe_init(bin: &str, cwd: &str) -> Option<Vec<String>> {
    let mut cmd = Command::new(bin);
    cmd.args(["-p", "--no-session-persistence", "--settings", r#"{"disableAllHooks":true}"#, "--output-format", "stream-json", "--verbose", "--max-turns", "1", "x"])
        .current_dir(cwd)
        .env_clear()
        .envs(clean_env())
        .env("ANTHROPIC_BASE_URL", "http://127.0.0.1:9")
        .env("DISABLE_AUTOUPDATER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            // Sin salto de línea final (línea parcial) no se procesa.
            if !matches!(r.read_until(b'\n', &mut line), Ok(n) if n > 0) || !line.ends_with(b"\n") {
                let _ = tx.send(None);
                return;
            }
            // Línea parcial o no JSON: se ignora.
            let Ok(j) = serde_json::from_slice::<Value>(&line) else { continue };
            let ty = j.get("type").and_then(Value::as_str);
            if ty == Some("system") && j.get("subtype").and_then(Value::as_str) == Some("init") {
                if let Some(a) = j.get("slash_commands").and_then(Value::as_array) {
                    let _ = tx.send(Some(a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>()));
                    return;
                }
            }
            // Por seguridad: si llegara a haber una respuesta del modelo, se corta igual.
            if matches!(ty, Some("assistant" | "result")) {
                let _ = tx.send(None);
                return;
            }
        }
    });
    let names = rx.recv_timeout(PROBE_TIMEOUT).ok().flatten();
    let _ = child.kill();
    let _ = child.wait();
    names
}
