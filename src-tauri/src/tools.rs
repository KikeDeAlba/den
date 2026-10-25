use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use tauri::{AppHandle, Emitter, Manager};

use crate::registry::{self, ToolsStatus};
use crate::state::AppState;

pub const TOOLS_EVENT: &str = "bita://tools-changed";
pub const LEGACY_IDENTIFIER: &str = "com.kikedealba.bita-desktop";
const LIVE_SETTINGS: &str = "live.json";
const DEBOUNCE: Duration = Duration::from_millis(300);
const POLL: Duration = Duration::from_secs(30);

static INKWELL_DATABASE_WATCHED: AtomicBool = AtomicBool::new(false);
static INKWELL_DOCS_WATCHED: AtomicBool = AtomicBool::new(false);

pub fn ensure_inkwell_watchers(app: &AppHandle) {
    if !INKWELL_DATABASE_WATCHED.load(Ordering::SeqCst)
        && crate::watch::spawn_database(app.clone(), registry::inkwell_database_path(), false)
    {
        INKWELL_DATABASE_WATCHED.store(true, Ordering::SeqCst);
    }
    if !INKWELL_DOCS_WATCHED.load(Ordering::SeqCst)
        && crate::watch::spawn_docs(app.clone(), registry::inkwell_docs_root())
    {
        INKWELL_DOCS_WATCHED.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn tools_status(app: AppHandle, refresh: Option<bool>) -> ToolsStatus {
    if refresh.unwrap_or(false) {
        changed(&app).await;
    }
    registry::global().status().await
}

pub async fn changed(app: &AppHandle) {
    registry::global().invalidate();
    app.state::<AppState>().forget_cli();
    let status = registry::global().status().await;
    ensure_inkwell_watchers(app);
    let _ = app.emit(TOOLS_EVENT, &status);
    app.state::<AppState>().refresh(app).await;
    crate::shell::mark_docs_stale(app);
}

pub fn warm(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let status = registry::global().status().await;
        let _ = app.emit(TOOLS_EVENT, &status);
    });
}

pub fn spawn_watch(app: AppHandle) {
    let dir = registry::global().dir().to_path_buf();
    thread::spawn(move || loop {
        if dir.is_dir() {
            watch_until_gone(&app, &dir);
        }
        let before = registry::fingerprint(&dir);
        thread::sleep(POLL);
        if registry::fingerprint(&dir) != before {
            notify_changed(&app);
        }
    });
}

fn notify_changed(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        changed(&handle).await;
    });
}

fn watch_until_gone(app: &AppHandle, dir: &Path) {
    let (sender, receiver) = mpsc::channel::<DebounceEventResult>();
    let Ok(mut debouncer) = new_debouncer(DEBOUNCE, None, sender) else {
        return;
    };
    if debouncer.watch(dir, RecursiveMode::NonRecursive).is_err() {
        return;
    }
    let mut seen = registry::fingerprint(dir);
    loop {
        match receiver.recv_timeout(POLL) {
            Ok(Ok(_)) | Err(mpsc::RecvTimeoutError::Timeout) => {
                let current = registry::fingerprint(dir);
                if current != seen {
                    seen = current;
                    notify_changed(app);
                }
                if !dir.is_dir() {
                    break;
                }
            }
            Ok(Err(_)) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(debouncer);
}

pub fn legacy_config_dir(current: &Path) -> Option<PathBuf> {
    Some(current.parent()?.join(LEGACY_IDENTIFIER))
}

pub fn migrate_legacy_settings(current: &Path) -> std::io::Result<bool> {
    let target = current.join(LIVE_SETTINGS);
    if target.exists() {
        return Ok(false);
    }
    let Some(legacy) = legacy_config_dir(current) else {
        return Ok(false);
    };
    if legacy == current {
        return Ok(false);
    }
    let source = legacy.join(LIVE_SETTINGS);
    if !source.is_file() {
        return Ok(false);
    }
    fs::create_dir_all(current)?;
    fs::copy(&source, &target)?;
    Ok(true)
}

pub fn migrate_app_settings(app: &AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = migrate_legacy_settings(&dir);
    }
}

pub fn print_status_and_exit() -> bool {
    if !std::env::args().any(|arg| arg == "--tools-status") {
        return false;
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build();
    let Ok(runtime) = runtime else {
        return true;
    };
    let status = runtime.block_on(registry::global().status());
    println!("{}", serde_json::to_string_pretty(&status).unwrap_or_default());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("den-tools-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch");
        directory
    }

    #[test]
    fn live_settings_move_over_from_the_old_identifier() {
        let root = scratch("migrate");
        let legacy = root.join(LEGACY_IDENTIFIER);
        let current = root.join("com.kikedealba.den");
        fs::create_dir_all(&legacy).expect("legacy");
        fs::write(legacy.join(LIVE_SETTINGS), "{\"shortcut\":\"Ctrl+Alt+Space\"}").expect("legacy settings");

        assert!(migrate_legacy_settings(&current).expect("migrate"));
        assert_eq!(
            fs::read_to_string(current.join(LIVE_SETTINGS)).expect("copied"),
            "{\"shortcut\":\"Ctrl+Alt+Space\"}"
        );
        assert!(legacy.join(LIVE_SETTINGS).is_file());

        fs::write(legacy.join(LIVE_SETTINGS), "{\"shortcut\":\"other\"}").expect("rewrite");
        assert!(!migrate_legacy_settings(&current).expect("second run"));
        assert!(fs::read_to_string(current.join(LIVE_SETTINGS)).expect("kept").contains("Ctrl+Alt+Space"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_to_migrate_leaves_no_trace() {
        let root = scratch("nothing");
        let current = root.join("com.kikedealba.den");
        assert!(!migrate_legacy_settings(&current).expect("migrate"));
        assert!(!current.exists());
        let _ = fs::remove_dir_all(&root);
    }
}
