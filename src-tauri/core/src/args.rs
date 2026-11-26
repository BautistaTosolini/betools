//! Argumentos de línea de comandos que entiende index.ts: `--hidden` y `--user-data-dir=<dir>`.

use std::path::PathBuf;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Args {
    /// Arranca sin mostrar la ventana (autoarranque).
    pub hidden: bool,
    /// Reemplaza el directorio de datos (`~/.config/betools`).
    pub user_data_dir: Option<PathBuf>,
}

impl Args {
    /// `args` sin el nombre del programa.
    pub fn parse(args: impl IntoIterator<Item = String>) -> Args {
        let mut out = Args::default();
        let mut it = args.into_iter();
        while let Some(a) = it.next() {
            if a == "--hidden" {
                out.hidden = true;
            } else if let Some(dir) = a.strip_prefix("--user-data-dir=") {
                out.user_data_dir = Some(PathBuf::from(dir));
            } else if a == "--user-data-dir" {
                // Chromium acepta también la forma con espacio.
                out.user_data_dir = it.next().map(PathBuf::from);
            }
        }
        out
    }

    /// El `userData` de Electron: `$XDG_CONFIG_HOME/betools`, o `~/.config/betools`.
    pub fn user_data(&self) -> PathBuf {
        self.user_data_dir
            .clone()
            .unwrap_or_else(|| dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("betools"))
    }

    /// Datos del webview (WebKit). Dentro de userData para que `--user-data-dir` aísle también el localStorage.
    pub fn webview_dir(&self) -> PathBuf {
        self.user_data().join("webview")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(a: &[&str]) -> Args {
        Args::parse(a.iter().map(|s| s.to_string()))
    }

    #[test]
    fn defaults() {
        let a = p(&[]);
        assert!(!a.hidden);
        assert_eq!(a.user_data_dir, None);
        assert!(a.user_data().ends_with("betools"));
    }

    #[test]
    fn hidden_and_dir() {
        let a = p(&["--hidden", "--user-data-dir=/tmp/x"]);
        assert!(a.hidden);
        assert_eq!(a.user_data(), PathBuf::from("/tmp/x"));
        assert_eq!(a.webview_dir(), PathBuf::from("/tmp/x/webview"));
    }

    #[test]
    fn dir_with_space_form() {
        assert_eq!(p(&["--user-data-dir", "/tmp/y"]).user_data_dir, Some(PathBuf::from("/tmp/y")));
        assert_eq!(p(&["--user-data-dir"]).user_data_dir, None);
    }

    #[test]
    fn unknown_flags_are_ignored() {
        assert_eq!(p(&["--foo", "bar"]), Args::default());
    }
}
