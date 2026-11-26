use std::collections::HashMap;

/// Variables de entorno resueltas de una sesión (carpeta + propias). Lo produce el crate de secretos.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResolvedEnv {
    pub env: HashMap<String, String>,
    /// Nombres de las variables con secretos, para la instrucción a Claude y la lista de denegados.
    pub names: Vec<String>,
    pub errors: Vec<String>,
}

// Variables que Claude Code define para sus procesos hijos. Si la app se lanza desde una sesión
// de Claude, se heredan y la sesión nueva se cree "hija": entre otras cosas, no guarda el transcript.
// Se quitan solo estas; las CLAUDE_CODE_* de configuración del usuario (Bedrock, etc.) se respetan.
const INHERITED_SESSION_VARS: &[&str] = &[
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

/// Entorno del proceso sin las variables que Claude Code deja a sus hijos.
pub fn clean_env() -> HashMap<String, String> {
    clean_env_from(std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))))
}

pub(crate) fn clean_env_from(vars: impl IntoIterator<Item = (String, String)>) -> HashMap<String, String> {
    vars.into_iter().filter(|(k, _)| !INHERITED_SESSION_VARS.contains(&k.as_str())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_inherited_session_vars() {
        let input = [
            ("PATH", "/bin"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_SESSION_ID", "x"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("AI_AGENT", "a"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()));
        let env = clean_env_from(input);
        let mut keys: Vec<_> = env.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["CLAUDE_CODE_USE_BEDROCK", "PATH"]);
    }
}
