use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime};

use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

const DEBOUNCE: Duration = Duration::from_millis(200);
const DOCS_DEBOUNCE: Duration = Duration::from_millis(400);

type Fingerprint = Option<(SystemTime, u64)>;

pub fn spawn(app: AppHandle, database: PathBuf) -> bool {
    spawn_database(app, database, true)
}

pub fn spawn_database(app: AppHandle, database: PathBuf, refreshes_timers: bool) -> bool {
    let Some(directory) = database.parent().map(Path::to_path_buf) else {
        return false;
    };
    if !directory.is_dir() {
        return false;
    }

    thread::spawn(move || {
        let (sender, receiver) = mpsc::channel::<DebounceEventResult>();
        let Ok(mut debouncer) = new_debouncer(DEBOUNCE, None, sender) else {
            return;
        };
        if debouncer
            .watch(&directory, RecursiveMode::NonRecursive)
            .is_err()
        {
            return;
        }

        let mut seen = fingerprint(&database);
        for batch in receiver {
            if batch.is_err() {
                continue;
            }
            let current = fingerprint(&database);
            if same(&current, &seen) {
                continue;
            }
            seen = current;

            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if refreshes_timers {
                    handle.state::<AppState>().refresh(&handle).await;
                }
                crate::shell::mark_docs_stale(&handle);
            });
        }

        drop(debouncer);
    });

    true
}

pub fn spawn_docs(app: AppHandle, root: PathBuf) -> bool {
    if !root.is_dir() {
        return false;
    }

    thread::spawn(move || {
        let (sender, receiver) = mpsc::channel::<DebounceEventResult>();
        let Ok(mut debouncer) = new_debouncer(DOCS_DEBOUNCE, None, sender) else {
            return;
        };
        if debouncer.watch(&root, RecursiveMode::Recursive).is_err() {
            return;
        }

        for batch in receiver {
            let Ok(events) = batch else {
                continue;
            };
            if !events.iter().any(|event| touches_markdown(&root, event)) {
                continue;
            }

            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::shell::mark_docs_stale(&handle);
            });
        }

        drop(debouncer);
    });

    true
}

fn touches_markdown(root: &Path, event: &notify_debouncer_full::DebouncedEvent) -> bool {
    if matches!(event.kind, notify::EventKind::Access(_)) {
        return false;
    }
    event
        .paths
        .iter()
        .any(|path| !inside_git(root, path) && !transient(path) && path.extension().and_then(|value| value.to_str()) == Some("md"))
}

fn transient(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".lock") || name.contains(".tmp-"))
}

fn inside_git(root: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative.components().any(|part| part.as_os_str() == ".git")
}

fn fingerprint(database: &Path) -> Fingerprint {
    let meta = fs::metadata(database).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

fn same(left: &Fingerprint, right: &Fingerprint) -> bool {
    match (left, right) {
        (Some(one), Some(other)) => one == other,
        (None, None) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use super::{fingerprint, inside_git, same, transient};
    use std::path::Path;

    #[test]
    fn the_git_folder_of_the_docs_is_not_a_page_change() {
        let root = Path::new("/docs");
        assert!(inside_git(root, Path::new("/docs/.git/COMMIT_EDITMSG.md")));
        assert!(inside_git(root, Path::new("/docs/.git/refs/heads/main")));
        assert!(!inside_git(root, Path::new("/docs/codi/reglas.md")));
        assert!(!inside_git(root, Path::new("/docs/codi/.gitkeep")));
    }

    #[test]
    fn lock_and_temporary_files_are_not_page_changes() {
        assert!(transient(Path::new("/docs/codi/reglas.md.lock")));
        assert!(transient(Path::new("/docs/codi/reglas.tmp-123.md")));
        assert!(!transient(Path::new("/docs/codi/reglas.md")));
    }

    #[test]
    fn a_missing_database_has_no_fingerprint() {
        let path = std::env::temp_dir().join("bita-does-not-exist.db");
        assert!(fingerprint(&path).is_none());
    }

    #[test]
    fn writing_changes_the_fingerprint_and_reading_does_not() {
        let path = std::env::temp_dir().join(format!("bita-watch-{}.db", std::process::id()));
        fs::write(&path, b"one").expect("write");
        let before = fingerprint(&path);

        let _ = fs::read(&path).expect("read");
        assert!(same(&fingerprint(&path), &before));

        std::thread::sleep(Duration::from_millis(20));
        fs::write(&path, b"two different").expect("write");
        assert!(!same(&fingerprint(&path), &before));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn fsevents_reports_a_write_inside_the_watched_directory() {
        use notify::RecursiveMode;
        use notify_debouncer_full::{new_debouncer, DebounceEventResult};
        use std::sync::mpsc;

        let directory = std::env::temp_dir().join(format!("bita-fsevents-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create dir");
        let database = directory.join("bita.db");
        fs::write(&database, b"seed").expect("seed");

        let (sender, receiver) = mpsc::channel::<DebounceEventResult>();
        let mut debouncer =
            new_debouncer(Duration::from_millis(200), None, sender).expect("debouncer");
        debouncer
            .watch(&directory, RecursiveMode::NonRecursive)
            .expect("watch");

        std::thread::sleep(Duration::from_millis(300));
        let before = fingerprint(&database);
        fs::write(&database, b"a write from somewhere else").expect("write");

        let batch = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("FSEvents did not report the write");
        assert!(batch.is_ok());
        assert!(!same(&fingerprint(&database), &before));

        drop(debouncer);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_database_that_disappears_counts_as_a_change() {
        let present = Some((std::time::SystemTime::UNIX_EPOCH, 10));
        assert!(!same(&present, &None));
        assert!(same(&None, &None));
    }
}
