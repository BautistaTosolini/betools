// Parser incremental del transcript .jsonl de Claude Code. El formato es interno de Claude Code: se toleran
// campos desconocidos y líneas que no parsean.
use crate::js::{self, get, get_str, key_of, truthy};
use betools_types::{Artifact, ArtifactSource, ConversationItem, ConversationKind, NoticeLevel, ToolCall, ToolEdit};
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::sync::LazyLock;
use std::time::UNIX_EPOCH;

pub const INTERRUPTED: &str = "Interrupted by user";

// Extensiones que se consideran "documento" (filtro por defecto del panel).
pub const DOCUMENT_EXTS: &[&str] = &[
    ".pdf", ".html", ".htm", ".md", ".markdown", ".txt", ".csv", ".tsv", ".docx", ".doc", ".odt", ".xlsx", ".xls", ".ods", ".pptx", ".ppt",
    ".odp", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".drawio", ".mp4", ".webm",
];

// En comandos Bash solo se buscan estas: archivos que suelen *generarse* por script (pandoc, playwright,
// scripts de reportes) y que no se ven como Write/Edit.
const BASH_EXTS: &str = "pdf|html|htm|docx|xlsx|pptx|odt|png|jpg|jpeg|svg|csv|drawio|md";

// Rust no tiene lookahead: el delimitador final se consume y la búsqueda siguiente arranca al final de la ruta
// (grupo 1), que es donde JS deja `lastIndex`.
static BASH_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?:^|[\s'"=>(])((?:~|\.{{1,2}})?/?[A-Za-z0-9_@%+.,/~-]*\.(?i:{BASH_EXTS}))(?:$|[\s'";)|&<>])"#
    ))
    .unwrap()
});

static ANSI_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*m").unwrap());
static REMINDER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<system-reminder>[\s\S]*?</system-reminder>").unwrap());
static CMD_NAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<command-name>([^<]*)</command-name>").unwrap());
static CMD_ARGS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<command-args>([\s\S]*?)</command-args>").unwrap());
static LOCAL_OUT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<local-command-(?:stdout|stderr)>([\s\S]*?)</local-command-(?:stdout|stderr)>").unwrap());
static BASH_INPUT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<bash-input>([\s\S]*?)</bash-input>").unwrap());
static SUMMARY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<summary>([\s\S]*?)</summary>").unwrap());
static STATUS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<status>([^<]*)</status>").unwrap());
static FAIL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)fail|error|kill|stop").unwrap());
static ERROR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)error").unwrap());
static RECAP_HINT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\(turn off recaps[^)]*\)\s*$").unwrap());
static INTERNAL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^<(local-command|bash-std|system-reminder|command-)").unwrap());
static INTERRUPT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[Request interrupted by user").unwrap());

const RESULT_MAX: usize = 6000;
const INPUT_MAX: usize = 4000;

struct Op {
    path: String,
    source: ArtifactSource,
    at: String,
}

struct Mutable {
    sources: Vec<ArtifactSource>,
    first_at: String,
    last_at: String,
    ops: i64,
}

#[derive(Default)]
pub struct TranscriptParser {
    remainder: Vec<u8>,
    artifacts: IndexMap<String, Mutable>,
    // tool_use_id -> operaciones, para descartar las que terminaron en error.
    pending: HashMap<String, Vec<Op>>,
    custom_title: Option<String>,
    ai_title: Option<String>,
    // Modelo de la última respuesta (id, p. ej. "claude-opus-5-5"); "<synthetic>" son mensajes internos.
    last_model: Option<String>,
    // Conversación para la pestaña Rendered. Crece, y además un ítem de herramienta se reemplaza cuando llega
    // su resultado; changed_from marca el primer índice tocado desde la última lectura (take_changed_from).
    items: Vec<ConversationItem>,
    changed_from: Option<usize>,
    tool_index: HashMap<String, usize>,
}

impl TranscriptParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn model(&self) -> Option<&str> {
        self.last_model.as_deref()
    }

    pub fn items(&self) -> &[ConversationItem] {
        &self.items
    }

    // None equivale al `Infinity` de la versión TS (nada tocado).
    pub fn take_changed_from(&mut self) -> Option<usize> {
        self.changed_from.take()
    }

    fn touch(&mut self, i: usize) {
        if self.changed_from.is_none_or(|c| i < c) {
            self.changed_from = Some(i);
        }
    }

    // /rename gana sobre el título generado por Claude.
    pub fn title(&self) -> Option<&str> {
        self.custom_title.as_deref().or(self.ai_title.as_deref())
    }

    // Recibe bytes nuevos del archivo. Corta por "\n" a nivel de bytes (seguro en UTF-8) y guarda la última
    // línea incompleta para la próxima llamada.
    pub fn push(&mut self, chunk: &[u8]) -> bool {
        let buf: Vec<u8> = if self.remainder.is_empty() { chunk.to_vec() } else { [self.remainder.as_slice(), chunk].concat() };
        let mut start = 0;
        let mut changed = false;
        while let Some(rel) = buf[start..].iter().position(|&b| b == b'\n') {
            let nl = start + rel;
            if nl > start {
                changed = self.line(&String::from_utf8_lossy(&buf[start..nl])) || changed;
            }
            start = nl + 1;
        }
        self.remainder = buf[start..].to_vec();
        changed
    }

    pub fn list(&self) -> Vec<Artifact> {
        let mut out: Vec<Artifact> = self
            .artifacts
            .iter()
            .map(|(path, a)| {
                let ext = js::extname(path).to_lowercase();
                Artifact {
                    path: path.clone(),
                    name: js::basename(path).to_string(),
                    is_document: DOCUMENT_EXTS.contains(&ext.as_str()),
                    ext,
                    sources: a.sources.clone(),
                    first_at: a.first_at.clone(),
                    last_at: a.last_at.clone(),
                    exists: std::path::Path::new(path).exists(),
                }
            })
            .collect();
        out.sort_by(|x, y| y.last_at.cmp(&x.last_at));
        out
    }

    fn line(&mut self, text: &str) -> bool {
        let Some(d) = js::parse_json(text) else { return false };
        if !d.is_object() {
            return false;
        }
        let ty = get_str(&d, "type");
        if ty == Some("custom-title") {
            if let Some(t) = get_str(&d, "customTitle") {
                self.custom_title = Some(js::trim(t)).filter(|t| !t.is_empty()).map(String::from);
                return true;
            }
        }
        if ty == Some("ai-title") {
            if let Some(t) = get_str(&d, "aiTitle") {
                self.ai_title = Some(js::trim(t)).filter(|t| !t.is_empty()).map(String::from);
                return true;
            }
        }
        if !truthy(d.get("isSidechain")) {
            self.conversation(&d);
        }
        let mut model_changed = false;
        let m = if ty == Some("assistant") { d.get("message").and_then(|x| get_str(x, "model")) } else { None };
        if let Some(m) = m {
            if !m.is_empty() && !m.starts_with('<') && Some(m) != self.last_model.as_deref() {
                self.last_model = Some(m.to_string());
                model_changed = true;
            }
        }
        let Some(content) = d.get("message").and_then(|m| get(m, "content")).and_then(Value::as_array) else { return model_changed };
        let at = get_str(&d, "timestamp").map(String::from).unwrap_or_else(js::now_iso);
        let cwd = get_str(&d, "cwd");
        let mut changed = model_changed;

        for c in content {
            let ct = get_str(c, "type");
            if ct == Some("tool_use") && ty == Some("assistant") {
                let ops = self.ops_for(c, cwd, &at);
                if !ops.is_empty() {
                    let key = key_of(get(c, "id"));
                    for op in &ops {
                        self.add(op);
                    }
                    self.pending.insert(key, ops);
                    changed = true;
                }
            } else if ct == Some("tool_result") && truthy(c.get("tool_use_id")) {
                let ops = self.pending.remove(&key_of(get(c, "tool_use_id")));
                if let Some(ops) = ops {
                    if truthy(c.get("is_error")) {
                        for op in &ops {
                            self.undo(op);
                        }
                        changed = true;
                    }
                }
            }
        }
        changed
    }

    fn push_item(&mut self, item: ConversationItem) {
        // Bloques de texto consecutivos de la misma respuesta: un solo ítem.
        if item.kind == ConversationKind::Assistant && item.msg_id.as_deref().is_some_and(|m| !m.is_empty()) {
            if let Some(last) = self.items.last_mut() {
                if last.kind == ConversationKind::Assistant && last.msg_id == item.msg_id {
                    last.text = format!("{}\n\n{}", last.text, item.text);
                    let i = self.items.len() - 1;
                    self.touch(i);
                    return;
                }
            }
        }
        if let Some(t) = &item.tool {
            self.tool_index.insert(t.id.clone(), self.items.len());
        }
        self.touch(self.items.len());
        self.items.push(item);
    }

    fn simple(&mut self, kind: ConversationKind, text: String, at: &str) {
        self.push_item(ConversationItem { kind, text, at: at.to_string(), msg_id: None, tool: None, level: None });
    }

    fn notice(&mut self, level: NoticeLevel, text: String, at: &str) {
        self.push_item(ConversationItem { kind: ConversationKind::Notice, text, at: at.to_string(), msg_id: None, tool: None, level: Some(level) });
    }

    // Resultado de una herramienta: completa su ítem.
    fn tool_result(&mut self, c: &Value, d: &Value) {
        let key = key_of(get(c, "tool_use_id"));
        let Some(&i) = self.tool_index.get(&key) else { return };
        let Some(tool) = self.items.get(i).and_then(|it| it.tool.as_ref()) else { return };
        self.tool_index.remove(&key);
        let raw = match get(c, "content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) => a
                .iter()
                .map(|b| match get_str(b, "type") {
                    Some("text") => get_str(b, "text").unwrap_or("").to_string(),
                    Some("image") => "[image]".to_string(),
                    _ => String::new(),
                })
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        // Bash trae stdout y stderr por separado en toolUseResult; si no, el contenido del resultado.
        let tur = get(d, "toolUseResult");
        let text = match tur.and_then(|t| get_str(t, "stdout").map(|o| (t, o))) {
            Some((t, out)) if t.is_object() => [Some(out), get_str(t, "stderr")]
                .into_iter()
                .flatten()
                .filter(|x| !js::trim(x).is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
            _ => raw,
        };
        let mut tool = tool.clone();
        tool.result = Some(clip(&strip_tags(&text), RESULT_MAX));
        tool.error = Some(truthy(c.get("is_error")));
        tool.done = true;
        self.items[i].tool = Some(tool);
        self.touch(i);
    }

    fn command_text(t: &str, name: &str) -> String {
        let args = CMD_ARGS_RE.captures(t).map(|a| js::trim(&a[1]).to_string()).unwrap_or_default();
        if args.is_empty() { name.to_string() } else { format!("{name} {args}") }
    }

    fn conversation(&mut self, d: &Value) {
        let at = get_str(d, "timestamp").map(String::from).unwrap_or_else(js::now_iso);
        let content = d.get("message").and_then(|m| get(m, "content"));
        let ty = get_str(d, "type");
        let subtype = get_str(d, "subtype");
        let dcontent = get_str(d, "content");

        // Comandos locales (/context, /model...) y su salida: type "system", subtype "local_command".
        if ty == Some("system") && subtype == Some("local_command") {
            if let Some(t) = dcontent {
                if let Some(cmd) = CMD_NAME_RE.captures(t) {
                    let text = Self::command_text(t, &cmd[1]);
                    return self.simple(ConversationKind::Command, text, &at);
                }
                let out = LOCAL_OUT_RE.captures(t).map(|o| o[1].to_string());
                let clean = out.map(|o| js::trim(&ANSI_RE.replace_all(&o, "")).to_string());
                // La salida se pega al comando anterior (separada por \u0000) para mostrarla desplegable.
                if let (Some(clean), Some(last)) = (clean.filter(|c| !c.is_empty()), self.items.last_mut()) {
                    if last.kind == ConversationKind::Command && !last.text.contains('\0') {
                        last.text = format!("{}\0{}", last.text, clean);
                    }
                }
                return;
            }
        }
        // Avisos de Claude Code: resumen al volver, informativos, errores de hooks, duración del turno.
        if ty == Some("system") && !truthy(d.get("isSidechain")) {
            let st = subtype;
            if let (Some("away_summary"), Some(t)) = (st, dcontent) {
                return self.notice(NoticeLevel::Info, format!("Recap: {}", RECAP_HINT_RE.replace(t, "")), &at);
            }
            if let (Some("informational"), Some(t)) = (st, dcontent) {
                return self.notice(NoticeLevel::Info, t.to_string(), &at);
            }
            if let (Some("model_refusal_fallback"), Some(t)) = (st, dcontent) {
                return self.notice(NoticeLevel::Warn, t.to_string(), &at);
            }
            if let (Some("turn_duration"), Some(ms)) = (st, get(d, "durationMs").and_then(Value::as_f64)) {
                return self.notice(NoticeLevel::Done, format!("Worked for {}", duration(ms)), &at);
            }
            if let (Some("stop_hook_summary"), Some(errs)) = (st, get(d, "hookErrors").and_then(Value::as_array)) {
                if !errs.is_empty() {
                    let joined = errs.iter().map(js::js_string).collect::<Vec<_>>().join(" · ");
                    return self.notice(NoticeLevel::Error, format!("Stop hook error: {joined}"), &at);
                }
            }
            if let Some(t) = dcontent {
                if ERROR_RE.is_match(st.unwrap_or("")) {
                    return self.notice(NoticeLevel::Error, t.to_string(), &at);
                }
            }
        }
        // Mensaje que mandaste mientras Claude trabajaba y que tomó a mitad del turno.
        let att = if ty == Some("attachment") { get(d, "attachment") } else { None };
        if let Some(att) = att {
            let human = att.get("origin").and_then(|o| get_str(o, "kind")) == Some("human") || truthy(att.get("humanTurn"));
            if let (Some("queued_command"), Some(prompt)) = (get_str(att, "type"), get_str(att, "prompt")) {
                if human {
                    return self.simple(ConversationKind::User, js::trim(prompt).to_string(), &at);
                }
            }
        }
        // Respuestas a AskUserQuestion (vienen con estructura en toolUseResult.answers).
        let answers = if ty == Some("user") { d.get("toolUseResult").and_then(|t| get(t, "answers")) } else { None };
        if let Some(Value::Object(map)) = answers {
            let mut ordered = Value::Object(map.clone());
            js::normalize(&mut ordered);
            let list: Vec<Value> = ordered.as_object().unwrap().iter().map(|(q, a)| json!({"q": q, "a": js::js_string(a)})).collect();
            if !list.is_empty() {
                self.simple(ConversationKind::Answers, Value::Array(list).to_string(), &at);
            }
        }
        if ty == Some("user") {
            if let Some(arr) = content.and_then(Value::as_array) {
                for c in arr {
                    if get_str(c, "type") == Some("tool_result") && truthy(c.get("tool_use_id")) {
                        self.tool_result(c, d);
                    }
                }
            }
            if truthy(d.get("isCompactSummary")) {
                return self.simple(ConversationKind::Summary, "Conversation compacted".into(), &at);
            }
            if truthy(d.get("isMeta")) {
                return;
            }
            let texts: Vec<String> = match content {
                Some(Value::String(s)) => vec![s.clone()],
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|c| match get_str(c, "type") {
                        Some("text") => get_str(c, "text").map(String::from),
                        Some("image") => Some("[image]".to_string()),
                        _ => None,
                    })
                    .collect(),
                _ => vec![],
            };
            for raw in texts {
                let t = js::trim(&raw);
                if t.is_empty() {
                    continue;
                }
                if let Some(cmd) = CMD_NAME_RE.captures(t) {
                    let text = Self::command_text(t, &cmd[1]);
                    self.simple(ConversationKind::Command, text, &at);
                    continue;
                }
                if let Some(bash) = BASH_INPUT_RE.captures(t) {
                    self.simple(ConversationKind::Command, format!("! {}", js::trim(&bash[1])), &at);
                    continue;
                }
                // Tarea en segundo plano terminada (comando, agente, workflow): aviso con su resumen.
                if t.starts_with("<task-notification>") {
                    let sum = SUMMARY_RE.captures(t).map(|s| js::trim(&s[1]).to_string()).filter(|s| !s.is_empty());
                    let status = STATUS_RE.captures(t).map(|s| js::trim(&s[1]).to_string()).unwrap_or_default();
                    if let Some(sum) = sum {
                        let level = if FAIL_RE.is_match(&status) { NoticeLevel::Error } else { NoticeLevel::Done };
                        self.notice(level, sum, &at);
                    }
                    continue;
                }
                // Salidas de comandos locales, avisos internos y recordatorios del sistema: no son mensajes tuyos.
                if INTERNAL_RE.is_match(t) {
                    continue;
                }
                // Interrupción con Esc/Ctrl+C: va como separador, no como mensaje tuyo.
                if INTERRUPT_RE.is_match(t) {
                    self.simple(ConversationKind::Summary, INTERRUPTED.into(), &at);
                    continue;
                }
                self.simple(ConversationKind::User, t.to_string(), &at);
            }
            return;
        }
        if ty == Some("assistant") {
            let Some(arr) = content.and_then(Value::as_array) else { return };
            let msg_id = d.get("message").and_then(|m| get_str(m, "id")).map(String::from);
            for c in arr {
                let ct = get_str(c, "type");
                let text = get_str(c, "text").filter(|t| !js::trim(t).is_empty());
                let thinking = get_str(c, "thinking").filter(|t| !js::trim(t).is_empty());
                if let (Some("text"), Some(text)) = (ct, text) {
                    self.push_item(ConversationItem { kind: ConversationKind::Assistant, text: text.to_string(), at: at.clone(), msg_id: msg_id.clone(), tool: None, level: None });
                } else if let (Some("thinking"), Some(th)) = (ct, thinking) {
                    self.push_item(ConversationItem { kind: ConversationKind::Thinking, text: js::trim(th).to_string(), at: at.clone(), msg_id: msg_id.clone(), tool: None, level: None });
                } else if matches!(ct, Some("tool_use" | "server_tool_use")) && truthy(c.get("id")) {
                    let empty = json!({});
                    let input = get(c, "input").unwrap_or(&empty);
                    let name = key_of(get(c, "name"));
                    self.push_item(ConversationItem {
                        kind: ConversationKind::Tool,
                        text: tool_summary(&name, input),
                        at: at.clone(),
                        msg_id: msg_id.clone(),
                        tool: Some(ToolCall {
                            id: key_of(get(c, "id")),
                            input: clip(&tool_input(&name, input), INPUT_MAX),
                            edits: tool_edits(&name, input),
                            name,
                            result: None,
                            error: None,
                            done: false,
                        }),
                        level: None,
                    });
                }
            }
        }
    }

    fn ops_for(&self, c: &Value, cwd: Option<&str>, at: &str) -> Vec<Op> {
        let empty = json!({});
        let input = get(c, "input").unwrap_or(&empty);
        let name = get_str(c, "name");
        let file_source = match name {
            Some("Write") => Some(ArtifactSource::Write),
            Some("Edit") => Some(ArtifactSource::Edit),
            Some("MultiEdit") => Some(ArtifactSource::MultiEdit),
            Some("NotebookEdit") => Some(ArtifactSource::NotebookEdit),
            _ => None,
        };
        if let Some(source) = file_source {
            let p = get(input, "file_path").or_else(|| get(input, "notebook_path"));
            return self.normalize(p, cwd).map(|path| vec![Op { path, source, at: at.to_string() }]).unwrap_or_default();
        }
        if name == Some("Bash") {
            if let Some(cmd) = get_str(input, "command") {
                // Heurística: rutas con extensión de documento que existen y se modificaron después de que se
                // lanzó el comando (descarta los archivos que solo se leen).
                let Some(since) = js::parse_date(at).map(|t| (t - 2000) as f64) else { return vec![] };
                let mut ops: Vec<Op> = Vec::new();
                let mut pos = 0;
                while let Some(caps) = BASH_PATH_RE.captures_at(cmd, pos) {
                    let m = caps.get(1).unwrap();
                    pos = m.end();
                    let Some(p) = self.normalize(Some(&Value::String(m.as_str().to_string())), cwd) else { continue };
                    if ops.iter().any(|o| o.path == p) {
                        continue;
                    }
                    // Si no existe, no se generó (o se movió después).
                    let mtime = fs::metadata(&p).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok());
                    if mtime.is_some_and(|t| t.as_secs_f64() * 1000.0 >= since) {
                        ops.push(Op { path: p, source: ArtifactSource::Bash, at: at.to_string() });
                    }
                }
                return ops;
            }
        }
        vec![]
    }

    fn normalize(&self, p: Option<&Value>, cwd: Option<&str>) -> Option<String> {
        let p = p?.as_str().filter(|s| !s.is_empty())?;
        let home = js::home();
        let mut abs = match p.strip_prefix("~/") {
            Some(rest) => js::resolve(&home, rest),
            None => p.to_string(),
        };
        if !abs.starts_with('/') {
            let cwd = cwd.filter(|c| !c.is_empty())?;
            abs = js::resolve(cwd, &abs);
        }
        let abs = js::resolve("/", &abs);
        // Escrituras internas de Claude Code (memoria, etc.) que no son artefactos de la sesión.
        let ignored = js::resolve(&home, ".claude/projects");
        (!abs.starts_with(&format!("{ignored}/"))).then_some(abs)
    }

    fn add(&mut self, op: &Op) {
        match self.artifacts.get_mut(&op.path) {
            None => {
                self.artifacts.insert(
                    op.path.clone(),
                    Mutable { sources: vec![op.source], first_at: op.at.clone(), last_at: op.at.clone(), ops: 1 },
                );
            }
            Some(a) => {
                if !a.sources.contains(&op.source) {
                    a.sources.push(op.source);
                }
                a.ops += 1;
                if op.at > a.last_at {
                    a.last_at = op.at.clone();
                }
            }
        }
    }

    fn undo(&mut self, op: &Op) {
        let Some(a) = self.artifacts.get_mut(&op.path) else { return };
        a.ops -= 1;
        if a.ops <= 0 {
            self.artifacts.shift_remove(&op.path);
        }
    }
}

// Los largos se miden en unidades UTF-16, como `String.length` de JS.
fn clip(s: &str, max: usize) -> String {
    let len = js::utf16_len(s);
    if len > max {
        format!("{}\n… ({} more characters)", js::slice_utf16(s, max), len - max)
    } else {
        s.to_string()
    }
}

// Recordatorios del sistema pegados al resultado de una herramienta: no son parte de la salida.
fn strip_tags(s: &str) -> String {
    let a = REMINDER_RE.replace_all(s, "");
    js::trim(&ANSI_RE.replace_all(&a, "")).to_string()
}

fn duration(ms: f64) -> String {
    let s = (ms / 1000.0 + 0.5).floor() as i64; // Math.round
    if s < 60 {
        return format!("{s}s");
    }
    let m = s / 60;
    if m < 60 { format!("{m}m {}s", s % 60) } else { format!("{}h {}m", m / 60, m % 60) }
}

// Entrada completa de la herramienta: el comando o la ruta tal cual; si no, el JSON.
fn tool_input(name: &str, input: &Value) -> String {
    if name == "Bash" {
        if let Some(cmd) = get_str(input, "command") {
            let desc = get_str(input, "description").filter(|d| !d.is_empty());
            return desc.map_or(String::new(), |d| format!("# {d}\n")) + cmd;
        }
    }
    if matches!(name, "Edit" | "MultiEdit" | "Write" | "Read" | "NotebookEdit") {
        let (fp, np) = (get(input, "file_path"), get(input, "notebook_path"));
        if truthy(fp) || truthy(np) {
            return js::js_string(fp.or(np).unwrap());
        }
    }
    js::pretty(input)
}

fn tool_edits(name: &str, input: &Value) -> Option<Vec<ToolEdit>> {
    let cut = |v: Option<&Value>| clip(v.and_then(Value::as_str).unwrap_or(""), 3000);
    let field = |e: &Value, k: &str| cut(e.get(k));
    match name {
        "Edit" => Some(vec![ToolEdit { old: field(input, "old_string"), new: field(input, "new_string") }]),
        "MultiEdit" => get(input, "edits")
            .and_then(Value::as_array)
            .map(|a| a.iter().take(20).map(|e| ToolEdit { old: field(e, "old_string"), new: field(e, "new_string") }).collect()),
        "Write" => Some(vec![ToolEdit { old: String::new(), new: field(input, "content") }]),
        _ => None,
    }
}

// Una línea por herramienta: el dato más representativo de su entrada.
fn tool_summary(name: &str, input: &Value) -> String {
    let keys = ["command", "file_path", "notebook_path", "pattern", "url", "query", "description", "prompt", "skill"];
    let pick = keys.iter().filter_map(|k| input.get(k).and_then(Value::as_str)).find(|v| !js::trim(v).is_empty());
    let one = js::collapse_ws(pick.unwrap_or(""));
    if one.is_empty() {
        name.to_string()
    } else if js::utf16_len(&one) > 240 {
        format!("{name}: {}…", js::slice_utf16(&one, 240))
    } else {
        format!("{name}: {one}")
    }
}
