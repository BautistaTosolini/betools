//! Tipos compartidos: equivalentes a src/shared/types.ts, con el mismo JSON.
//! Los opcionales de TS (`?:`) se omiten al serializar; los `| null` van siempre explícitos.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub created_at: String,
    pub last_active_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<Vec<EnvVarMeta>>,
}

/// El valor de una variable nunca viaja a la interfaz (salvo `plain`, que no es secreta).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum EnvSource {
    #[serde(rename = "plain")]
    Plain { value: String },
    #[serde(rename = "local")]
    Local {},
    #[serde(rename = "aws-sm", rename_all = "camelCase")]
    AwsSm {
        profile: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        region: Option<String>,
        secret_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        json_key: Option<String>,
    },
    #[serde(rename = "aws-ssm")]
    AwsSsm {
        profile: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        region: Option<String>,
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVarMeta {
    pub name: String,
    pub source: EnvSource,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvScopeKind {
    Folder,
    Session,
}

/// Ámbito de una variable: una carpeta o una sesión (esta pisa a la carpeta).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnvScope {
    pub kind: EnvScopeKind,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub color: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapsed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<Vec<EnvVarMeta>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<SavedCommand>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedCommand {
    pub id: String,
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreState {
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
    pub selected_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FolderSuggestion {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Stopped,
    Idle,
    Working,
    Waiting,
    Done,
    Exited,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub close_to_tray: bool,
    pub autostart: bool,
    pub notifications: bool,
    pub eager_start: bool,
    pub remote_control: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSession {
    pub id: String,
    pub cwd: String,
    pub cwd_exists: bool,
    pub title: String,
    pub modified_at: String,
    pub size_kb: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArtifactSource {
    Write,
    Edit,
    MultiEdit,
    NotebookEdit,
    Bash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub sources: Vec<ArtifactSource>,
    pub is_document: bool,
    pub first_at: String,
    pub last_at: String,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub model: Option<String>,
    pub context_pct: Option<f64>,
}

/// `resets_at` en segundos Unix.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanWindow {
    pub pct: f64,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimits {
    pub five_hour: Option<PlanWindow>,
    pub seven_day: Option<PlanWindow>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyTokens {
    pub day: String,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub total: u64,
    pub messages: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationKind {
    User,
    Assistant,
    Tool,
    Command,
    Summary,
    Answers,
    Thinking,
    Notice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeLevel {
    Info,
    Warn,
    Error,
    Done,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationItem {
    pub kind: ConversationKind,
    pub text: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<NoticeLevel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolEdit {
    pub old: String,
    pub new: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edits: Option<Vec<ToolEdit>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlashSource {
    Builtin,
    User,
    Project,
    Plugin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub source: SlashSource,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::{json, Value};

    /// Deserializa, reserializa y exige el mismo JSON (campos ausentes siguen ausentes).
    fn round_trip<T: Serialize + DeserializeOwned>(v: Value) {
        let t: T = serde_json::from_value(v.clone()).expect("deserializa");
        assert_eq!(serde_json::to_value(&t).unwrap(), v);
    }

    #[test]
    fn session_with_and_without_env() {
        round_trip::<Session>(json!({"id":"a","name":"n","cwd":"/x","createdAt":"2026-01-01T00:00:00.000Z","lastActiveAt":"2026-01-02T00:00:00.000Z"}));
        round_trip::<Session>(json!({"id":"a","name":"n","cwd":"/x","createdAt":"c","lastActiveAt":"l",
            "env":[{"name":"AWS_PROFILE","source":{"kind":"plain","value":"dev"},"updatedAt":"u"}]}));
    }

    #[test]
    fn env_sources() {
        round_trip::<EnvSource>(json!({"kind":"plain","value":"us-east-1"}));
        round_trip::<EnvSource>(json!({"kind":"local"}));
        round_trip::<EnvSource>(json!({"kind":"aws-sm","profile":"p","secretId":"s"}));
        round_trip::<EnvSource>(json!({"kind":"aws-sm","profile":"p","region":"r","secretId":"s","jsonKey":"k"}));
        round_trip::<EnvSource>(json!({"kind":"aws-ssm","profile":"p","name":"/a/b"}));
        round_trip::<EnvSource>(json!({"kind":"aws-ssm","profile":"p","region":"r","name":"/a/b"}));
        assert!(serde_json::from_value::<EnvSource>(json!({"kind":"nope"})).is_err());
    }

    #[test]
    fn env_scope() {
        round_trip::<EnvScope>(json!({"kind":"folder","id":"f1"}));
        round_trip::<EnvScope>(json!({"kind":"session","id":"s1"}));
        assert!(serde_json::from_value::<EnvScope>(json!({"kind":"x","id":"1"})).is_err());
    }

    #[test]
    fn folder_optionals() {
        round_trip::<Folder>(json!({"id":"1","name":"Cliente","color":"#fff","path":"/p"}));
        round_trip::<Folder>(json!({"id":"1","name":"C","color":"#fff","path":"/p","extraPaths":["/q"],
            "collapsed":true,"env":[],"commands":[{"id":"c","name":"sso","command":"aws sso login"}]}));
    }

    #[test]
    fn store_state_null_selected() {
        round_trip::<StoreState>(json!({"folders":[],"sessions":[],"selectedId":null}));
        round_trip::<StoreState>(json!({"folders":[],"sessions":[],"selectedId":"s"}));
    }

    #[test]
    fn status_strings() {
        for (s, v) in [
            (SessionStatus::Stopped, "stopped"),
            (SessionStatus::Idle, "idle"),
            (SessionStatus::Working, "working"),
            (SessionStatus::Waiting, "waiting"),
            (SessionStatus::Done, "done"),
            (SessionStatus::Exited, "exited"),
        ] {
            assert_eq!(serde_json::to_value(s).unwrap(), json!(v));
            assert_eq!(serde_json::from_value::<SessionStatus>(json!(v)).unwrap(), s);
        }
    }

    #[test]
    fn settings_and_suggestion() {
        round_trip::<Settings>(json!({"closeToTray":true,"autostart":false,"notifications":true,"eagerStart":false,"remoteControl":false}));
        round_trip::<FolderSuggestion>(json!({"name":"n","path":"/p"}));
    }

    #[test]
    fn discovered_and_artifact() {
        round_trip::<DiscoveredSession>(json!({"id":"i","cwd":"/c","cwdExists":false,"title":"t","modifiedAt":"m","sizeKb":12}));
        round_trip::<Artifact>(json!({"path":"/a.md","name":"a.md","ext":"md","sources":["Write","Edit","MultiEdit","NotebookEdit","Bash"],
            "isDocument":true,"firstAt":"f","lastAt":"l","exists":true}));
    }

    #[test]
    fn meta_and_limits_keep_nulls() {
        round_trip::<SessionMeta>(json!({"model":null,"contextPct":null}));
        round_trip::<SessionMeta>(json!({"model":"opus","contextPct":42.5}));
        round_trip::<PlanLimits>(json!({"fiveHour":null,"sevenDay":null,"updatedAt":1760000000000i64}));
        round_trip::<PlanLimits>(json!({"fiveHour":{"pct":12.5,"resetsAt":1760000000},"sevenDay":{"pct":3.5,"resetsAt":null},"updatedAt":1}));
    }

    #[test]
    fn daily_tokens() {
        round_trip::<DailyTokens>(json!({"day":"2026-01-01","input":1,"output":2,"cacheWrite":3,"cacheRead":4,"total":10,"messages":5}));
    }

    #[test]
    fn conversation_items() {
        round_trip::<ConversationItem>(json!({"kind":"user","text":"hola","at":"t"}));
        round_trip::<ConversationItem>(json!({"kind":"notice","text":"x","at":"t","msgId":"m","level":"warn"}));
        for k in ["user","assistant","tool","command","summary","answers","thinking","notice"] {
            round_trip::<ConversationItem>(json!({"kind":k,"text":"","at":"t"}));
        }
        for l in ["info","warn","error","done"] {
            round_trip::<ConversationItem>(json!({"kind":"notice","text":"","at":"t","level":l}));
        }
        round_trip::<ConversationItem>(json!({"kind":"tool","text":"Edit a.ts","at":"t","tool":{
            "id":"tu1","name":"Edit","input":"a.ts","result":"ok","error":false,"done":true,
            "edits":[{"old":"a","new":"b"}]}}));
        round_trip::<ConversationItem>(json!({"kind":"tool","text":"Bash","at":"t","tool":{"id":"x","name":"Bash","input":"ls","done":false}}));
    }

    #[test]
    fn slash_commands() {
        for s in ["builtin","user","project","plugin"] {
            round_trip::<SlashCommand>(json!({"name":"/x","description":"d","source":s}));
        }
    }

    #[test]
    fn unknown_fields_are_ignored() {
        // Archivos viejos pueden traer campos extra: no deben romper la carga.
        let s: Settings = serde_json::from_value(json!({"closeToTray":true,"autostart":true,"notifications":true,
            "eagerStart":true,"remoteControl":true,"legacy":1})).unwrap();
        assert!(s.close_to_tray);
    }
}
