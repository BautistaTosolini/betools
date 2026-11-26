use crate::util::home_dir;
use std::fs;
use std::path::Path;

// La app se llamaba "clawhip": sus datos estaban en ~/.config/clawhip. En el primer arranque con el
// nombre nuevo se copian a la carpeta actual (~/.config/betools). No se borra la vieja.
const FILES: [&str; 4] = ["sessions.json", "settings.json", "openers.json", "secrets.json"];

pub fn migrate_legacy_data(user_data: &Path) -> crate::Result<()> {
    migrate_legacy_data_from(&home_dir(), user_data)
}

pub fn migrate_legacy_data_from(home: &Path, user_data: &Path) -> crate::Result<()> {
    let from = home.join(".config").join("clawhip");
    if from == user_data || !from.join("sessions.json").exists() || user_data.join("sessions.json").exists() {
        return Ok(());
    }
    fs::create_dir_all(user_data)?;
    for f in FILES {
        let src = from.join(f);
        if !src.exists() {
            continue;
        }
        let dst = user_data.join(f);
        fs::copy(&src, &dst)?;
        // preserveTimestamps: se conserva la fecha de modificación.
        let mtime = fs::metadata(&src)?.modified()?;
        fs::File::options().write(true).open(&dst)?.set_modified(mtime)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy(home: &Path) -> std::path::PathBuf {
        let d = home.join(".config").join("clawhip");
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn copies_known_files_and_keeps_the_old_ones() {
        let home = tempfile::tempdir().unwrap();
        let from = legacy(home.path());
        fs::write(from.join("sessions.json"), "S").unwrap();
        fs::write(from.join("secrets.json"), "X").unwrap();
        fs::write(from.join("other.json"), "O").unwrap();
        let to = home.path().join(".config").join("betools");
        migrate_legacy_data_from(home.path(), &to).unwrap();
        assert_eq!(fs::read_to_string(to.join("sessions.json")).unwrap(), "S");
        assert_eq!(fs::read_to_string(to.join("secrets.json")).unwrap(), "X");
        assert!(!to.join("settings.json").exists());
        assert!(!to.join("other.json").exists());
        assert!(from.join("sessions.json").exists());
        assert_eq!(
            fs::metadata(from.join("sessions.json")).unwrap().modified().unwrap(),
            fs::metadata(to.join("sessions.json")).unwrap().modified().unwrap()
        );
    }

    #[test]
    fn does_nothing_without_legacy_sessions_or_when_target_has_them() {
        let home = tempfile::tempdir().unwrap();
        let to = home.path().join("new");
        migrate_legacy_data_from(home.path(), &to).unwrap();
        assert!(!to.exists());

        let from = legacy(home.path());
        fs::write(from.join("settings.json"), "only settings").unwrap();
        migrate_legacy_data_from(home.path(), &to).unwrap();
        assert!(!to.exists());

        fs::write(from.join("sessions.json"), "old").unwrap();
        fs::create_dir_all(&to).unwrap();
        fs::write(to.join("sessions.json"), "new").unwrap();
        migrate_legacy_data_from(home.path(), &to).unwrap();
        assert_eq!(fs::read_to_string(to.join("sessions.json")).unwrap(), "new");
        assert!(!to.join("settings.json").exists());
    }

    #[test]
    fn same_dir_is_a_noop() {
        let home = tempfile::tempdir().unwrap();
        let from = legacy(home.path());
        fs::write(from.join("sessions.json"), "S").unwrap();
        migrate_legacy_data_from(home.path(), &from).unwrap();
        assert_eq!(fs::read_to_string(from.join("sessions.json")).unwrap(), "S");
    }
}
