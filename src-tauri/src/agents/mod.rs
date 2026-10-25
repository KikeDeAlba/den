pub mod model;
pub mod pty;
pub mod quit;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, Runtime, Window, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::cli::Cli;
use crate::model::{Problem, ProblemKind};
use crate::platform;
use crate::registry::{self, Tool};
use model::{SessionDirectory, SessionListing, SpawnRequest};
use pty::{Pty, PtySpec, KILL_GRACE};
use quit::QuitDecision;

pub const PLUGIN: &str = "agents";
pub const CHANGED_EVENT: &str = "den://agents/changed";
#[cfg(test)]
const COMMANDS: &[&str] = &[
    "agent_spawn",
    "agent_attach",
    "agent_write",
    "agent_resize",
    "agent_send",
    "agent_kill",
    "agent_list",
    "agent_sessions",
    "agent_dirs",
    "agent_pick_folder",
];

const LINK_ATTEMPTS: u32 = 30;
const LINK_EVERY: Duration = Duration::from_secs(1);
const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: u64,
    pub harness: Option<String>,
    pub project: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub resume_session: Option<i64>,
    pub pid: Option<u32>,
    pub started_at: String,
    pub alive: bool,
    pub exit_code: Option<i32>,
    pub bita: Option<SessionListing>,
}

struct Session {
    info: AgentInfo,
    pty: Arc<Pty>,
}

#[derive(Default)]
pub struct Agents {
    sessions: Mutex<HashMap<u64, Session>>,
    next: AtomicU64,
    quitting: AtomicBool,
    asking: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Agents {
    fn info(&self, id: u64) -> Option<AgentInfo> {
        lock(&self.sessions).get(&id).map(|session| current(session))
    }

    fn pty(&self, id: u64) -> Result<Arc<Pty>, Problem> {
        lock(&self.sessions)
            .get(&id)
            .map(|session| Arc::clone(&session.pty))
            .ok_or_else(|| failed("Esa sesión ya no existe en Den."))
    }

    fn list(&self) -> Vec<AgentInfo> {
        let mut list: Vec<AgentInfo> = lock(&self.sessions).values().map(current).collect();
        list.sort_by_key(|info| info.id);
        list
    }

    fn live(&self) -> Vec<Arc<Pty>> {
        lock(&self.sessions)
            .values()
            .filter(|session| session.pty.alive())
            .map(|session| Arc::clone(&session.pty))
            .collect()
    }

    fn link(&self, id: u64, listing: SessionListing) -> Option<AgentInfo> {
        let mut sessions = lock(&self.sessions);
        let session = sessions.get_mut(&id)?;
        session.info.bita = Some(listing);
        Some(current(session))
    }
}

fn current(session: &Session) -> AgentInfo {
    let mut info = session.info.clone();
    let exit = session.pty.exit_code();
    info.alive = exit.is_none();
    info.exit_code = exit.flatten();
    info
}

fn failed(message: impl Into<String>) -> Problem {
    Problem::new(ProblemKind::CliFailed, message)
}

fn ensure_main<R: Runtime>(window: &Window<R>) -> Result<(), Problem> {
    if window.label() == crate::shell::LABEL {
        Ok(())
    } else {
        Err(failed("Las sesiones de agentes solo se manejan desde la ventana de Den."))
    }
}

fn emit_changed(app: &AppHandle, info: &AgentInfo) {
    let _ = app.emit_to(crate::shell::LABEL, CHANGED_EVENT, info);
}

fn sink(channel: Channel<InvokeResponseBody>) -> pty::Sink {
    Box::new(move |chunk| channel.send(InvokeResponseBody::Raw(chunk)).is_ok())
}

pub fn pty_env(bin: &[OsString], inherited: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    let mut env: HashMap<String, String> = inherited.collect();
    let mut path = registry::path_for(bin);
    if let Some(existing) = env.get("PATH").filter(|value| !value.is_empty()) {
        path.push(if cfg!(windows) { ";" } else { ":" });
        path.push(existing);
    }
    env.insert("PATH".into(), path.to_string_lossy().into_owned());
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env.remove("NO_COLOR");
    env.entry("LANG".into()).or_insert_with(|| "en_US.UTF-8".into());
    if let Some(home) = platform::home() {
        env.entry("HOME".into()).or_insert_with(|| home.to_string_lossy().into_owned());
    }
    let mut list: Vec<(String, String)> = env.into_iter().collect();
    list.sort();
    list
}

fn directory(request: &SpawnRequest) -> Result<Option<PathBuf>, Problem> {
    let Some(raw) = request.cwd.as_deref().map(str::trim).filter(|text| !text.is_empty()) else {
        if request.resume_session.is_some() {
            return Ok(platform::home());
        }
        return Err(failed("Elige la carpeta donde trabaja el agente."));
    };
    let path = PathBuf::from(raw);
    if !path.is_absolute() || !path.is_dir() {
        return Err(failed(format!("La carpeta {raw} no existe.")));
    }
    Ok(Some(path))
}

pub fn spec_for(cli_bin: &[OsString], database: &Path, request: &SpawnRequest, cols: u16, rows: u16) -> Result<PtySpec, Problem> {
    let (program, prefix) = cli_bin.split_first().ok_or_else(|| registry::missing_problem(Tool::Bita))?;
    let mut args: Vec<String> = prefix.iter().map(|part| part.to_string_lossy().into_owned()).collect();
    args.extend(model::work_args(request).map_err(failed)?);
    args.push("--db-path".into());
    args.push(database.to_string_lossy().into_owned());
    Ok(PtySpec {
        program: PathBuf::from(program),
        args,
        cwd: directory(request)?,
        env: pty_env(cli_bin, std::env::vars()),
        cols: if cols == 0 { DEFAULT_COLS } else { cols },
        rows: if rows == 0 { DEFAULT_ROWS } else { rows },
    })
}

async fn bita() -> Result<Cli, Problem> {
    Cli::for_tool(Tool::Bita).await
}

fn spawn_link(app: AppHandle, id: u64, pid: Option<u32>) {
    let Some(pid) = pid else { return };
    tauri::async_runtime::spawn(async move {
        for _ in 0..LINK_ATTEMPTS {
            tokio::time::sleep(LINK_EVERY).await;
            let agents = app.state::<Agents>();
            if !agents.pty(id).map(|pty| pty.alive()).unwrap_or(false) {
                return;
            }
            let Ok(cli) = bita().await else { return };
            let Ok(listings) = cli.call::<Vec<SessionListing>>(&["sessions", "ls", "--open", "--all"]).await else {
                continue;
            };
            if let Some(listing) = model::linked(&listings, pid).cloned() {
                if let Some(info) = agents.link(id, listing) {
                    emit_changed(&app, &info);
                }
                return;
            }
        }
    });
}

#[tauri::command]
async fn agent_spawn(
    app: AppHandle,
    window: Window,
    request: SpawnRequest,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> Result<AgentInfo, Problem> {
    ensure_main(&window)?;
    let cli = bita().await?;
    let spec = spec_for(cli.bin(), cli.database_path(), &request, cols, rows)?;
    let agents = app.state::<Agents>();
    let id = agents.next.fetch_add(1, Ordering::SeqCst) + 1;
    let exit_app = app.clone();
    let pty = Pty::spawn(&spec, move |_| {
        if let Some(info) = exit_app.state::<Agents>().info(id) {
            emit_changed(&exit_app, &info);
        }
    })
    .map_err(|error| failed(format!("No pude lanzar bita work: {error}")))?;
    pty.attach(sink(on_output));
    let pid = pty.pid();
    let info = AgentInfo {
        id,
        harness: request.harness.clone().filter(|_| request.resume_session.is_none()),
        project: request.project.clone(),
        cwd: spec.cwd.as_ref().map(|path| path.to_string_lossy().into_owned()),
        title: request.title.clone().filter(|text| !text.trim().is_empty()),
        prompt: request.prompt.clone().filter(|text| !text.trim().is_empty()),
        resume_session: request.resume_session,
        pid,
        started_at: Utc::now().to_rfc3339(),
        alive: true,
        exit_code: None,
        bita: None,
    };
    let session = Session {
        info,
        pty: Arc::new(pty),
    };
    let snapshot = current(&session);
    lock(&agents.sessions).insert(id, session);
    emit_changed(&app, &snapshot);
    spawn_link(app.clone(), id, pid);
    Ok(snapshot)
}

#[tauri::command]
fn agent_attach(
    app: AppHandle,
    window: Window,
    id: u64,
    on_output: Channel<InvokeResponseBody>,
) -> Result<AgentInfo, Problem> {
    ensure_main(&window)?;
    let agents = app.state::<Agents>();
    agents.pty(id)?.attach(sink(on_output));
    agents.info(id).ok_or_else(|| failed("Esa sesión ya no existe en Den."))
}

#[tauri::command]
fn agent_write(app: AppHandle, window: Window, id: u64, data: String) -> Result<(), Problem> {
    ensure_main(&window)?;
    app.state::<Agents>()
        .pty(id)?
        .write(data.as_bytes())
        .map_err(|error| failed(format!("No pude escribirle a la sesión: {error}")))
}

#[tauri::command]
fn agent_send(app: AppHandle, window: Window, id: u64, text: String) -> Result<(), Problem> {
    ensure_main(&window)?;
    if text.trim().is_empty() {
        return Ok(());
    }
    app.state::<Agents>()
        .pty(id)?
        .write(&model::bracketed_paste(&text))
        .map_err(|error| failed(format!("No pude mandarle el mensaje: {error}")))
}

#[tauri::command]
fn agent_resize(app: AppHandle, window: Window, id: u64, cols: u16, rows: u16) -> Result<(), Problem> {
    ensure_main(&window)?;
    let pty = app.state::<Agents>().pty(id)?;
    if !pty.alive() {
        return Ok(());
    }
    pty.resize(cols, rows)
        .map_err(|error| failed(format!("No pude cambiar el tamaño de la terminal: {error}")))
}

#[tauri::command]
fn agent_kill(app: AppHandle, window: Window, id: u64) -> Result<(), Problem> {
    ensure_main(&window)?;
    end_session(&app.state::<Agents>().pty(id)?);
    Ok(())
}

fn end_session(pty: &Arc<Pty>) {
    pty.kill_tree(KILL_GRACE);
}

#[tauri::command]
fn agent_list(app: AppHandle, window: Window) -> Result<Vec<AgentInfo>, Problem> {
    ensure_main(&window)?;
    Ok(app.state::<Agents>().list())
}

pub fn sessions_args(cwd: Option<&str>, limit: u32) -> Vec<String> {
    let mut args = vec!["sessions".to_string(), "ls".to_string()];
    match cwd.map(str::trim).filter(|text| !text.is_empty()) {
        Some(dir) => args.extend(["--cwd".to_string(), dir.to_string()]),
        None => args.push("--all".into()),
    }
    args.extend(["--limit".to_string(), limit.max(1).to_string()]);
    args
}

#[tauri::command]
async fn agent_sessions(window: Window, cwd: Option<String>, limit: Option<u32>) -> Result<Vec<SessionListing>, Problem> {
    ensure_main(&window)?;
    let args = sessions_args(cwd.as_deref(), limit.unwrap_or(50));
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    bita().await?.call(&refs).await
}

#[tauri::command]
async fn agent_dirs(window: Window, limit: Option<u32>) -> Result<Vec<SessionDirectory>, Problem> {
    ensure_main(&window)?;
    let limit = limit.unwrap_or(20).max(1).to_string();
    bita().await?.call(&["sessions", "dirs", "--limit", &limit]).await
}

#[tauri::command]
async fn agent_pick_folder(app: AppHandle, window: Window, start: Option<String>) -> Result<Option<String>, Problem> {
    ensure_main(&window)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Carpeta de la sesión").set_parent(&window);
    if let Some(start) = start.map(PathBuf::from).filter(|path| path.is_dir()) {
        dialog = dialog.set_directory(start);
    }
    dialog.pick_folder(move |picked| {
        let _ = sender.send(picked.and_then(|path| path.into_path().ok()));
    });
    let picked = receiver.await.ok().flatten();
    Ok(picked.map(|path| path.to_string_lossy().into_owned()))
}

pub fn plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new(PLUGIN)
        .invoke_handler(tauri::generate_handler![
            agent_spawn,
            agent_attach,
            agent_write,
            agent_resize,
            agent_send,
            agent_kill,
            agent_list,
            agent_sessions,
            agent_dirs,
            agent_pick_folder
        ])
        .setup(|app, _| {
            app.manage(Agents::default());
            Ok(())
        })
        .build()
}

pub fn quit_message(live: usize) -> String {
    if live == 1 {
        "Hay una sesión de agente abierta. Si sales, Den la termina.".to_string()
    } else {
        format!("Hay {live} sesiones de agentes abiertas. Si sales, Den las termina.")
    }
}

fn end_all_and_exit(app: AppHandle, live: Vec<Arc<Pty>>) {
    std::thread::spawn(move || {
        for pty in &live {
            end_session(pty);
        }
        for pty in &live {
            pty.wait_exit(KILL_GRACE + Duration::from_millis(500));
        }
        exit_now(&app);
    });
}

fn exit_now(app: &AppHandle) {
    if let Some(agents) = app.try_state::<Agents>() {
        agents.quitting.store(true, Ordering::SeqCst);
    }
    app.exit(0);
}

pub fn quit_decision(app: &AppHandle) -> QuitDecision {
    let Some(agents) = app.try_state::<Agents>() else {
        return QuitDecision::Exit;
    };
    quit::decide(
        agents.live().len(),
        agents.quitting.load(Ordering::SeqCst),
        agents.asking.load(Ordering::SeqCst),
    )
}

pub fn request_quit(app: &AppHandle) {
    match quit_decision(app) {
        QuitDecision::Exit => exit_now(app),
        QuitDecision::Wait => {
            let _ = crate::shell::show(app);
        }
        QuitDecision::Confirm => confirm_quit(app),
    }
}

fn confirm_quit(app: &AppHandle) {
    let agents = app.state::<Agents>();
    let live = agents.live();
    agents.asking.store(true, Ordering::SeqCst);
    let _ = crate::shell::show(app);
    let handle = app.clone();
    app.dialog()
        .message(quit_message(live.len()))
        .title("Salir de Den")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Terminar y salir".into(), "Cancelar".into()))
        .show(move |confirmed| {
            handle.state::<Agents>().asking.store(false, Ordering::SeqCst);
            if confirmed {
                let live = handle.state::<Agents>().live();
                end_all_and_exit(handle, live);
            }
        });
}

pub fn hang_up_all(app: &AppHandle) {
    if let Some(agents) = app.try_state::<Agents>() {
        for pty in agents.live() {
            pty.kill_tree(Duration::ZERO);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_without_a_folder_asks_for_every_session() {
        assert_eq!(sessions_args(None, 50), ["sessions", "ls", "--all", "--limit", "50"]);
        assert_eq!(sessions_args(Some("  "), 0), ["sessions", "ls", "--all", "--limit", "1"]);
        assert_eq!(sessions_args(Some("/tmp/den"), 10), ["sessions", "ls", "--cwd", "/tmp/den", "--limit", "10"]);
    }

    #[test]
    fn the_terminal_gets_colors_and_a_usable_path() {
        let env = pty_env(
            &[OsString::from("/opt/bita/bin/bita")],
            vec![("NO_COLOR".to_string(), "1".to_string()), ("PATH".to_string(), "/custom/bin".to_string())].into_iter(),
        );
        let get = |key: &str| env.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone());
        assert_eq!(get("TERM").as_deref(), Some("xterm-256color"));
        assert_eq!(get("NO_COLOR"), None);
        let path = get("PATH").expect("path");
        assert!(path.starts_with("/opt/bita/bin"));
        assert!(path.ends_with("/custom/bin"));
    }

    #[test]
    fn the_spec_runs_bita_work_with_the_database_in_the_folder() {
        let folder = std::env::temp_dir();
        let request = SpawnRequest {
            harness: Some("codex".into()),
            project: Some("0".into()),
            cwd: Some(folder.to_string_lossy().into_owned()),
            prompt: Some("hola".into()),
            ..SpawnRequest::default()
        };
        let bin = [OsString::from("/usr/bin/node"), OsString::from("/opt/bita.js")];
        let spec = spec_for(&bin, Path::new("/tmp/test.db"), &request, 0, 0).expect("spec");
        assert_eq!(spec.program, PathBuf::from("/usr/bin/node"));
        assert_eq!(
            spec.args,
            ["/opt/bita.js", "work", "--harness", "codex", "--project", "0", "--prompt=hola", "--db-path", "/tmp/test.db"]
        );
        assert_eq!(spec.cwd, Some(folder));
        assert_eq!((spec.cols, spec.rows), (DEFAULT_COLS, DEFAULT_ROWS));
    }

    #[test]
    fn a_new_session_needs_an_existing_folder() {
        let bin = [OsString::from("/usr/bin/bita")];
        let mut request = SpawnRequest {
            harness: Some("claude".into()),
            ..SpawnRequest::default()
        };
        assert!(spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).is_err());
        request.cwd = Some("/definitely/not/here".into());
        assert!(spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).is_err());
        request.cwd = Some("relative/dir".into());
        assert!(spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).is_err());
    }

    #[test]
    fn resuming_does_not_need_a_folder() {
        let bin = [OsString::from("/usr/bin/bita")];
        let request = SpawnRequest {
            resume_session: Some(7),
            ..SpawnRequest::default()
        };
        let spec = spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).expect("spec");
        assert_eq!(&spec.args[..4], ["work", "--resume", "--session", "7"]);
    }

    #[test]
    fn the_quit_message_counts_the_sessions() {
        assert!(quit_message(1).contains("una sesión"));
        assert!(quit_message(3).contains("3 sesiones"));
    }

    #[test]
    fn every_command_is_listed_for_the_capabilities() {
        let build = include_str!("../../build.rs");
        assert!(COMMANDS.iter().all(|name| build.contains(&format!("\"{name}\""))));
        assert_eq!(build.matches("\"agent_").count(), COMMANDS.len());
    }

    #[cfg(unix)]
    #[test]
    fn bita_work_runs_in_the_pty_and_links_by_wrapper_pid() {
        let Some(script) = std::env::var_os("DEN_AGENT_SMOKE_BITA") else {
            eprintln!("skipped: DEN_AGENT_SMOKE_BITA is not set");
            return;
        };
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("den-agent-smoke-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("home")).expect("root");
        let fake = root.join("fake-claude");
        std::fs::write(&fake, "#!/bin/sh\necho fake-agent:\"$@\"\nread line\necho bye:$line\n").expect("fake");
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let database = root.join("bita.db");
        let node = std::env::var_os("DEN_AGENT_SMOKE_NODE").unwrap_or_else(|| OsString::from("node"));
        let bin = [node, script];
        let added = std::process::Command::new(&bin[0])
            .arg(&bin[1])
            .args(["project", "add", "Smoke", "--json", "--db-path"])
            .arg(&database)
            .env("HOME", root.join("home"))
            .output()
            .expect("project add");
        assert!(added.status.success(), "{}", String::from_utf8_lossy(&added.stdout));
        let request = SpawnRequest {
            harness: Some("claude".into()),
            project: Some("Smoke".into()),
            cwd: Some(root.to_string_lossy().into_owned()),
            prompt: Some("--hola".into()),
            ..SpawnRequest::default()
        };
        let mut spec = spec_for(&bin, &database, &request, 80, 24).expect("spec");
        spec.env.retain(|(key, _)| key != "HOME" && !key.starts_with("BITA_"));
        spec.env.push(("HOME".into(), root.join("home").to_string_lossy().into_owned()));
        spec.env.push(("BITA_HARNESS_BIN_CLAUDE".into(), fake.to_string_lossy().into_owned()));
        spec.env.push(("BITA_DB_PATH".into(), database.to_string_lossy().into_owned()));
        let (sender, receiver) = std::sync::mpsc::channel();
        let pty = Arc::new(Pty::spawn(&spec, move |code| {
            let _ = sender.send(code);
        })
        .expect("spawn"));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let target = Arc::clone(&seen);
        pty.attach(Box::new(move |chunk| {
            lock(&target).extend(chunk);
            true
        }));
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !String::from_utf8_lossy(&lock(&seen)).contains("fake-agent:") && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        let output = String::from_utf8_lossy(&lock(&seen)).into_owned();
        assert!(output.contains("fake-agent:"), "{output}");
        assert!(output.contains("--hola"), "{output}");
        let listed = std::process::Command::new(&bin[0])
            .arg(&bin[1])
            .args(["sessions", "ls", "--open", "--all", "--json", "--db-path"])
            .arg(&database)
            .env("HOME", root.join("home"))
            .output()
            .expect("sessions ls");
        let text = String::from_utf8_lossy(&listed.stdout);
        let envelope: crate::model::Envelope<Vec<SessionListing>> =
            serde_json::from_str(text.trim().lines().last().unwrap_or_default()).expect("envelope");
        let rows = envelope.data.expect("data");
        let pid = pty.pid().expect("pid");
        let row = model::linked(&rows, pid).unwrap_or_else(|| panic!("no open row for pid {pid}: {text}"));
        assert_eq!(row.harness, "claude");
        pty.write(b"listo\r").expect("write");
        let code = receiver.recv_timeout(Duration::from_secs(20)).expect("exit");
        assert_eq!(code, Some(0), "{}", String::from_utf8_lossy(&lock(&seen)));
        assert!(String::from_utf8_lossy(&lock(&seen)).contains("bye:listo"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
