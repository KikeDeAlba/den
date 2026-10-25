pub mod model;
pub mod pty;
pub mod quit;
pub mod scan;
#[cfg(all(test, unix))]
mod smoke;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, Runtime, Window, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::cli::{node, Cli};
use crate::model::{Problem, ProblemKind};
use crate::platform;
use crate::registry::{self, Tool};
use model::{SessionDirectory, SessionListing, SpawnRequest};
use pty::{Pty, PtySpec, KILL_GRACE};
use quit::{Answer, QuitDecision, QuitState};

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
    "agent_close",
    "agent_list",
    "agent_sessions",
    "agent_dirs",
    "agent_pick_folder",
];

const EXIT_GRACE: Duration = Duration::from_millis(500);
const SPAWN_SETTLE: Duration = Duration::from_secs(5);
const SETTLE_POLL: Duration = Duration::from_millis(20);
const LINK_ATTEMPTS: u32 = 30;
const LINK_EVERY: Duration = Duration::from_secs(1);
const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 30;
pub const INPUT_LIMIT: usize = 256 * 1024;
pub const LIVE_LIMIT: usize = 16;

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
    reserved: AtomicUsize,
    quit: QuitState,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Agents {
    fn info(&self, id: u64) -> Option<AgentInfo> {
        lock(&self.sessions).get(&id).map(current)
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

    fn open(&self) -> usize {
        let sessions = lock(&self.sessions);
        sessions.values().filter(|session| session.pty.alive()).count() + self.reserved.load(Ordering::SeqCst)
    }

    fn settled(&self, wait: Duration) -> Vec<Arc<Pty>> {
        let deadline = Instant::now() + wait;
        loop {
            let sessions = lock(&self.sessions);
            if self.reserved.load(Ordering::SeqCst) == 0 || Instant::now() >= deadline {
                return sessions
                    .values()
                    .filter(|session| session.pty.alive())
                    .map(|session| Arc::clone(&session.pty))
                    .collect();
            }
            drop(sessions);
            std::thread::sleep(SETTLE_POLL);
        }
    }

    fn close(&self, id: u64) -> Result<(), Problem> {
        let mut sessions = lock(&self.sessions);
        match sessions.get(&id) {
            Some(session) if session.pty.alive() => Err(failed("La sesión sigue viva. Termínala antes de cerrar la pestaña.")),
            Some(_) => {
                sessions.remove(&id);
                Ok(())
            }
            None => Ok(()),
        }
    }

    fn reserve(&self) -> Result<Slot<'_>, Problem> {
        let sessions = lock(&self.sessions);
        if self.quit.closing() {
            return Err(closing_down());
        }
        let live = sessions.values().filter(|session| session.pty.alive()).count();
        if live + self.reserved.load(Ordering::SeqCst) >= LIVE_LIMIT {
            return Err(failed(format!(
                "Ya hay {LIVE_LIMIT} sesiones abiertas. Termina alguna antes de arrancar otra."
            )));
        }
        self.reserved.fetch_add(1, Ordering::SeqCst);
        drop(sessions);
        Ok(Slot { agents: self, held: true })
    }

    fn link(&self, id: u64, listing: SessionListing) -> Option<AgentInfo> {
        let mut sessions = lock(&self.sessions);
        let session = sessions.get_mut(&id)?;
        session.info.bita = Some(listing);
        Some(current(session))
    }
}

struct Slot<'a> {
    agents: &'a Agents,
    held: bool,
}

impl Slot<'_> {
    fn fill(mut self, id: u64, session: Session) {
        let mut sessions = lock(&self.agents.sessions);
        sessions.insert(id, session);
        self.agents.reserved.fetch_sub(1, Ordering::SeqCst);
        self.held = false;
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        if self.held {
            let _sessions = lock(&self.agents.sessions);
            self.agents.reserved.fetch_sub(1, Ordering::SeqCst);
        }
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

fn closing_down() -> Problem {
    failed("Den se está cerrando. No puede arrancar otra sesión.")
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

const AGENT_ENV_PREFIXES: [&str; 12] = [
    "ANTHROPIC_",
    "CLAUDE_",
    "OPENAI_",
    "CODEX_",
    "GEMINI_",
    "GOOGLE_",
    "VERTEX_",
    "OPENCODE_",
    "OPENROUTER_",
    "AZURE_",
    "AWS_",
    "LC_",
];
const AGENT_ENV_VARS: [&str; 20] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SHELL",
    "USER",
    "LOGNAME",
    "SSH_AUTH_SOCK",
    "EDITOR",
    "VISUAL",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
];
const BLOCKED_ENV_PREFIXES: [&str; 5] = ["DYLD_", "LD_", "DEN_", "TAURI_", "WEBKIT_"];
const BLOCKED_ENV_VARS: [&str; 1] = ["NODE_OPTIONS"];

pub fn agent_env_passes(key: &str) -> bool {
    if BLOCKED_ENV_PREFIXES.iter().any(|prefix| key.starts_with(prefix)) || BLOCKED_ENV_VARS.contains(&key) {
        return false;
    }
    platform::is_essential(key)
        || registry::passes_through(key)
        || AGENT_ENV_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
        || AGENT_ENV_VARS.contains(&key)
}

pub fn pty_env(bin: &[OsString], inherited: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    let mut inherited_path = None;
    let mut env: HashMap<OsString, OsString> = HashMap::new();
    for (key, value) in inherited {
        if key == "PATH" {
            inherited_path = Some(value);
        } else if key.to_str().is_some_and(agent_env_passes) {
            env.insert(key, value);
        }
    }
    for (key, value) in node::identity() {
        env.entry(OsString::from(key)).or_insert(value);
    }
    let mut path = registry::path_for(bin);
    if let Some(existing) = inherited_path.as_deref().and_then(absolute_entries) {
        path.push(if cfg!(windows) { ";" } else { ":" });
        path.push(existing);
    }
    env.insert("PATH".into(), path);
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env.entry("LANG".into()).or_insert_with(|| "en_US.UTF-8".into());
    if let Some(home) = platform::home() {
        env.insert("HOME".into(), home.into_os_string());
    }
    let mut list: Vec<(OsString, OsString)> = env.into_iter().collect();
    list.sort();
    list
}

fn absolute_entries(path: &std::ffi::OsStr) -> Option<OsString> {
    let kept: Vec<PathBuf> = std::env::split_paths(path)
        .filter(|entry| !entry.as_os_str().is_empty() && entry.is_absolute())
        .collect();
    if kept.is_empty() {
        return None;
    }
    std::env::join_paths(kept).ok()
}

fn directory(request: &SpawnRequest) -> Result<PathBuf, Problem> {
    let Some(raw) = request.cwd.as_deref().map(str::trim).filter(|text| !text.is_empty()) else {
        return Err(failed("Elige la carpeta donde trabaja el agente."));
    };
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(failed(format!("La carpeta {raw} no es una ruta completa.")));
    }
    match std::fs::canonicalize(&path) {
        Ok(found) if found.is_dir() => Ok(platform::simplified(&found)),
        Ok(_) => Err(failed(format!("{raw} no es una carpeta."))),
        Err(_) => Err(failed(format!("La carpeta {raw} ya no existe. Elige otra para la sesión."))),
    }
}

pub fn spec_for(cli_bin: &[OsString], database: &Path, request: &SpawnRequest, cols: u16, rows: u16) -> Result<PtySpec, Problem> {
    let (program, prefix) = cli_bin.split_first().ok_or_else(|| registry::missing_problem(Tool::Bita))?;
    let relative = std::iter::once(program)
        .chain(prefix.iter().filter(|part| !part.to_string_lossy().starts_with('-')))
        .find(|part| !Path::new(part).is_absolute());
    if let Some(part) = relative {
        return Err(failed(format!(
            "El registro apunta a bita con una ruta incompleta ({}). Vuelve a correr bita setup.",
            Path::new(part).display()
        )));
    }
    let mut args: Vec<String> = prefix.iter().map(|part| part.to_string_lossy().into_owned()).collect();
    args.extend(model::work_args(request).map_err(failed)?);
    args.push("--db-path".into());
    args.push(database.to_string_lossy().into_owned());
    Ok(PtySpec {
        program: PathBuf::from(program),
        args,
        cwd: Some(directory(request)?),
        env: pty_env(cli_bin, std::env::vars_os()),
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
    let agents = app.state::<Agents>();
    let slot = agents.reserve()?;
    let cli = bita().await?;
    let spec = spec_for(cli.bin(), cli.database_path(), &request, cols, rows)?;
    if agents.quit.closing() {
        return Err(closing_down());
    }
    let id = agents.next.fetch_add(1, Ordering::SeqCst) + 1;
    let pty = Arc::new(Pty::spawn(&spec).map_err(|error| failed(format!("No pude lanzar bita work: {error}")))?);
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
    slot.fill(
        id,
        Session {
            info,
            pty: Arc::clone(&pty),
        },
    );
    if agents.quit.closing() {
        end_session(&pty);
    }
    let exit_app = app.clone();
    pty.watch(move |_| {
        if let Some(info) = exit_app.state::<Agents>().info(id) {
            emit_changed(&exit_app, &info);
        }
    });
    let snapshot = agents.info(id).ok_or_else(|| failed("Esa sesión ya no existe en Den."))?;
    emit_changed(&app, &snapshot);
    spawn_link(app.clone(), id, pid);
    Ok(snapshot)
}

fn within_input_limit(len: usize) -> Result<(), Problem> {
    if len > INPUT_LIMIT {
        Err(failed("Es demasiado texto para mandarlo de una vez (máximo 256 KiB)."))
    } else {
        Ok(())
    }
}

async fn write_blocking(pty: Arc<Pty>, bytes: Vec<u8>) -> std::io::Result<()> {
    tauri::async_runtime::spawn_blocking(move || pty.write(&bytes))
        .await
        .map_err(std::io::Error::other)?
}

#[tauri::command]
async fn agent_attach(
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
async fn agent_write(app: AppHandle, window: Window, id: u64, data: Vec<u8>) -> Result<(), Problem> {
    ensure_main(&window)?;
    within_input_limit(data.len())?;
    let pty = app.state::<Agents>().pty(id)?;
    write_blocking(pty, data)
        .await
        .map_err(|error| failed(format!("No pude escribirle a la sesión: {error}")))
}

#[tauri::command]
async fn agent_send(app: AppHandle, window: Window, id: u64, text: String) -> Result<(), Problem> {
    ensure_main(&window)?;
    within_input_limit(text.len())?;
    let pty = app.state::<Agents>().pty(id)?;
    let Some(bytes) = model::message(&text, pty.bracketed()) else {
        return Ok(());
    };
    write_blocking(pty, bytes)
        .await
        .map_err(|error| failed(format!("No pude mandarle el mensaje: {error}")))
}

#[tauri::command]
async fn agent_resize(app: AppHandle, window: Window, id: u64, cols: u16, rows: u16) -> Result<(), Problem> {
    ensure_main(&window)?;
    let pty = app.state::<Agents>().pty(id)?;
    if !pty.alive() {
        return Ok(());
    }
    pty.resize(cols, rows)
        .map_err(|error| failed(format!("No pude cambiar el tamaño de la terminal: {error}")))
}

#[tauri::command]
async fn agent_kill(app: AppHandle, window: Window, id: u64) -> Result<(), Problem> {
    ensure_main(&window)?;
    end_session(&app.state::<Agents>().pty(id)?);
    Ok(())
}

#[tauri::command]
async fn agent_close(app: AppHandle, window: Window, id: u64) -> Result<(), Problem> {
    ensure_main(&window)?;
    app.state::<Agents>().close(id)
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
        Some(dir) => args.push(format!("--cwd={dir}")),
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
            agent_close,
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

fn terminate_all(live: Vec<Arc<Pty>>, grace: Duration) {
    let workers: Vec<_> = live
        .into_iter()
        .map(|pty| std::thread::spawn(move || pty.terminate(grace)))
        .collect();
    for worker in workers {
        let _ = worker.join();
    }
}

fn finish_quit(app: &AppHandle, terminate: bool) {
    let finish = app.state::<Agents>().quit.finish(terminate);
    quit::forget_power_off();
    if let Some(answer) = finish.reply {
        quit::reply(app, answer);
        if answer {
            exit_after_reply(app.clone());
        }
    }
    if finish.exit {
        exit_now(app);
    } else if !terminate {
        let _ = crate::shell::show(app);
    }
}

fn exit_after_reply(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(quit::REPLY_FALLBACK);
        exit_now(&app);
    });
}

fn end_all_and_quit(app: AppHandle, grace: Duration) {
    std::thread::spawn(move || {
        terminate_all(app.state::<Agents>().settled(SPAWN_SETTLE), grace);
        finish_quit(&app, true);
    });
}

fn exit_now(app: &AppHandle) {
    if let Some(agents) = app.try_state::<Agents>() {
        agents.quit.mark_quitting();
    }
    app.exit(0);
}

pub fn quit_decision(app: &AppHandle) -> QuitDecision {
    let Some(agents) = app.try_state::<Agents>() else {
        return QuitDecision::Exit;
    };
    agents.quit.decide(agents.open())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn quit_shutting_down(app: &AppHandle) -> bool {
    app.try_state::<Agents>().is_some_and(|agents| agents.quit.shutting_down())
}

pub fn request_quit(app: &AppHandle) {
    match quit_decision(app) {
        QuitDecision::Exit => exit_now(app),
        QuitDecision::Wait => {
            let _ = crate::shell::show(app);
        }
        QuitDecision::Confirm => confirm_quit(app, false),
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn confirm_before_reply(app: &AppHandle) {
    confirm_quit(app, true);
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn end_for_shutdown(app: &AppHandle) {
    if app.state::<Agents>().quit.shutdown() {
        end_all_and_quit(app.clone(), EXIT_GRACE);
    }
}

fn confirm_quit(app: &AppHandle, reply_pending: bool) {
    let agents = app.state::<Agents>();
    let open = agents.open();
    agents.quit.ask(reply_pending);
    let _ = crate::shell::show(app);
    let handle = app.clone();
    app.dialog()
        .message(quit_message(open))
        .title("Salir de Den")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Terminar y salir".into(), "Cancelar".into()))
        .show(move |confirmed| match handle.state::<Agents>().quit.answer(confirmed) {
            Answer::Ignore => {}
            Answer::EndAll => {
                if handle.state::<Agents>().quit.start_ending() {
                    end_all_and_quit(handle.clone(), KILL_GRACE);
                }
            }
            Answer::Cancel => finish_quit(&handle, false),
        });
}

pub fn hang_up_all(app: &AppHandle) {
    if let Some(agents) = app.try_state::<Agents>() {
        terminate_all(agents.settled(SPAWN_SETTLE), EXIT_GRACE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_without_a_folder_asks_for_every_session() {
        assert_eq!(sessions_args(None, 50), ["sessions", "ls", "--all", "--limit", "50"]);
        assert_eq!(sessions_args(Some("  "), 0), ["sessions", "ls", "--all", "--limit", "1"]);
        assert_eq!(sessions_args(Some("/tmp/den"), 10), ["sessions", "ls", "--cwd=/tmp/den", "--limit", "10"]);
        assert_eq!(sessions_args(Some("--all"), 10), ["sessions", "ls", "--cwd=--all", "--limit", "10"]);
    }

    #[test]
    fn xdg_variables_reach_the_agent_on_every_platform() {
        let env = env_of(&[
            ("XDG_CONFIG_HOME", "/cfg"),
            ("XDG_DATA_HOME", "/data"),
            ("XDG_STATE_HOME", "/state"),
            ("XDG_CACHE_HOME", "/cache"),
            ("XDG_RUNTIME_DIR", "/run/user/501"),
        ]);
        for (key, value) in [
            ("XDG_CONFIG_HOME", "/cfg"),
            ("XDG_DATA_HOME", "/data"),
            ("XDG_STATE_HOME", "/state"),
            ("XDG_CACHE_HOME", "/cache"),
            ("XDG_RUNTIME_DIR", "/run/user/501"),
        ] {
            assert_eq!(lookup(&env, key).as_deref(), Some(value), "{key}");
        }
    }

    fn env_of(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pty_env(
            &[OsString::from("/opt/bita/bin/bita")],
            pairs.iter().map(|(key, value)| (OsString::from(key), OsString::from(value))),
        )
    }

    fn lookup(env: &[(OsString, OsString)], key: &str) -> Option<String> {
        env.iter().find(|(name, _)| name == key).map(|(_, value)| value.to_string_lossy().into_owned())
    }

    #[test]
    fn the_terminal_gets_colors_and_a_usable_path() {
        let env = env_of(&[("NO_COLOR", "1"), ("PATH", "/custom/bin")]);
        assert_eq!(lookup(&env, "TERM").as_deref(), Some("xterm-256color"));
        assert_eq!(lookup(&env, "NO_COLOR"), None);
        let path = lookup(&env, "PATH").expect("path");
        assert!(path.starts_with("/opt/bita/bin"));
        assert!(path.ends_with("/custom/bin"));
    }

    #[test]
    fn relative_and_empty_path_entries_are_not_inherited() {
        let env = env_of(&[("PATH", "/usr/bin::.:bin:./node_modules/.bin:/custom/bin:")]);
        let path = lookup(&env, "PATH").expect("path");
        let entries: Vec<String> = std::env::split_paths(&path).map(|entry| entry.to_string_lossy().into_owned()).collect();
        assert!(entries.iter().all(|entry| entry.starts_with('/')), "{path}");
        assert!(path.ends_with(":/usr/bin:/custom/bin"), "{path}");
        let only_relative = env_of(&[("PATH", ".:bin:")]);
        let path = lookup(&only_relative, "PATH").expect("path");
        assert!(std::env::split_paths(&path).all(|entry| entry.is_absolute()), "{path}");
    }

    #[test]
    fn the_bita_program_must_be_an_absolute_path() {
        let request = SpawnRequest {
            harness: Some("claude".into()),
            cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
            ..SpawnRequest::default()
        };
        for program in ["bita", "./bita", "bin/node", ""] {
            let bin = [OsString::from(program), OsString::from("/opt/bita.js")];
            let refused = spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).expect_err(program);
            assert!(refused.message.contains("ruta incompleta"), "{program}: {}", refused.message);
        }
        for script in ["bita.js", "./bita.js", "dist/bin/bita.js", ""] {
            let bin = [OsString::from("/usr/bin/node"), OsString::from("--no-warnings"), OsString::from(script)];
            let refused = spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).expect_err(script);
            assert!(refused.message.contains("ruta incompleta"), "{script}: {}", refused.message);
        }
        assert!(spec_for(&[OsString::from("/usr/bin/node")], Path::new("/tmp/x.db"), &request, 80, 24).is_ok());
        let bin = [OsString::from("/usr/bin/node"), OsString::from("--no-warnings"), OsString::from("/opt/bita.js")];
        assert!(spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).is_ok());
    }

    #[test]
    fn the_child_only_inherits_what_the_cli_policy_and_the_agents_need() {
        let env = env_of(&[
            ("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib"),
            ("LD_PRELOAD", "/tmp/evil.so"),
            ("NODE_OPTIONS", "--require /tmp/evil.js"),
            ("DEN_AGENT_SMOKE_BITA", "/tmp/bita.js"),
            ("TAURI_ENV_DEBUG", "1"),
            ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
            ("RANDOM_SECRET", "x"),
            ("ANTHROPIC_API_KEY", "sk-ant"),
            ("OPENAI_API_KEY", "sk-oa"),
            ("GEMINI_API_KEY", "g"),
            ("HTTPS_PROXY", "http://proxy:3128"),
            ("no_proxy", "localhost"),
            ("BITA_DB_PATH", "/tmp/bita.db"),
            ("TMPDIR", "/tmp/den"),
        ]);
        for blocked in [
            "DYLD_INSERT_LIBRARIES",
            "LD_PRELOAD",
            "NODE_OPTIONS",
            "DEN_AGENT_SMOKE_BITA",
            "TAURI_ENV_DEBUG",
            "WEBKIT_DISABLE_COMPOSITING_MODE",
            "RANDOM_SECRET",
        ] {
            assert_eq!(lookup(&env, blocked), None, "{blocked}");
        }
        for kept in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "HTTPS_PROXY", "no_proxy", "BITA_DB_PATH", "TMPDIR"] {
            assert!(lookup(&env, kept).is_some(), "{kept}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn values_that_are_not_utf8_pass_through_without_panicking() {
        use std::os::unix::ffi::OsStringExt;
        let raw = OsString::from_vec(vec![b'/', b't', 0xff, b'p']);
        let env = pty_env(
            &[OsString::from("/opt/bita/bin/bita")],
            vec![
                (OsString::from("TMPDIR"), raw.clone()),
                (OsString::from_vec(vec![b'X', 0xfe]), OsString::from("1")),
            ],
        );
        assert!(env.iter().any(|(key, value)| key == "TMPDIR" && *value == raw));
        assert!(!env.iter().any(|(key, _)| key.to_str().is_none()));
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
            ["/opt/bita.js", "work", "--harness", "codex", "--project=0", "--prompt=hola", "--db-path", "/tmp/test.db"]
        );
        assert_eq!(spec.cwd, Some(std::fs::canonicalize(folder).expect("canonical")));
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
        let missing = spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).expect_err("missing");
        assert!(missing.message.contains("ya no existe"));
        request.cwd = Some("relative/dir".into());
        assert!(spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).is_err());
    }

    #[test]
    fn the_folder_is_canonicalized() {
        let root = std::env::temp_dir().join(format!("den-agent-cwd-{}", std::process::id()));
        std::fs::create_dir_all(root.join("inner")).expect("dirs");
        let bin = [OsString::from("/usr/bin/bita")];
        let request = SpawnRequest {
            harness: Some("claude".into()),
            cwd: Some(root.join("inner").join("..").join("inner").to_string_lossy().into_owned()),
            ..SpawnRequest::default()
        };
        let spec = spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).expect("spec");
        assert_eq!(spec.cwd, Some(std::fs::canonicalize(root.join("inner")).expect("canonical")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resuming_runs_in_the_session_folder_and_fails_when_it_is_gone() {
        let bin = [OsString::from("/usr/bin/bita")];
        let mut request = SpawnRequest {
            resume_session: Some(7),
            ..SpawnRequest::default()
        };
        assert!(spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).is_err());
        request.cwd = Some("/definitely/not/here".into());
        let gone = spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).expect_err("gone");
        assert!(gone.message.contains("ya no existe"));
        request.cwd = Some(std::env::temp_dir().to_string_lossy().into_owned());
        let spec = spec_for(&bin, Path::new("/tmp/x.db"), &request, 80, 24).expect("spec");
        assert_eq!(&spec.args[..4], ["work", "--resume", "--session", "7"]);
    }

    #[cfg(unix)]
    fn session_running(script: &str) -> Session {
        let pty = Arc::new(
            Pty::spawn(&PtySpec {
                program: PathBuf::from("/bin/sh"),
                args: vec!["-c".into(), script.into()],
                cwd: None,
                env: vec![("PATH".into(), "/usr/bin:/bin".into())],
                cols: 80,
                rows: 24,
            })
            .expect("spawn"),
        );
        pty.watch(|_| ());
        Session {
            info: AgentInfo {
                id: 0,
                harness: None,
                project: None,
                cwd: None,
                title: None,
                prompt: None,
                resume_session: None,
                pid: pty.pid(),
                started_at: String::new(),
                alive: true,
                exit_code: None,
                bita: None,
            },
            pty,
        }
    }

    #[cfg(unix)]
    #[test]
    fn closing_frees_only_sessions_that_ended() {
        let agents = Agents::default();
        let ended = session_running("exit 0");
        let ended_pty = Arc::downgrade(&ended.pty);
        assert!(ended.pty.wait_exit(Duration::from_secs(5)));
        let live = session_running("sleep 30");
        let live_pty = Arc::clone(&live.pty);
        lock(&agents.sessions).insert(1, ended);
        lock(&agents.sessions).insert(2, live);
        agents.close(1).expect("close ended");
        assert!(agents.info(1).is_none());
        assert!(ended_pty.upgrade().is_none());
        assert!(agents.close(2).is_err());
        assert!(agents.info(2).is_some());
        assert!(agents.close(99).is_ok());
        live_pty.terminate(Duration::from_millis(200));
    }

    #[cfg(unix)]
    #[test]
    fn there_is_a_cap_on_live_sessions() {
        let agents = Agents::default();
        let mut ptys = Vec::new();
        for id in 0..LIVE_LIMIT as u64 {
            let session = session_running("sleep 30");
            ptys.push(Arc::clone(&session.pty));
            agents.reserve().expect("room").fill(id, session);
        }
        assert!(agents.reserve().is_err());
        assert_eq!(agents.reserved.load(Ordering::SeqCst), 0);
        for pty in &ptys {
            pty.terminate(Duration::from_millis(200));
        }
        assert!(agents.reserve().is_ok());
    }

    #[test]
    fn a_reserved_slot_counts_until_it_is_filled_or_dropped() {
        let agents = Agents::default();
        let slots: Vec<Slot<'_>> = (0..LIVE_LIMIT).map(|_| agents.reserve().expect("room")).collect();
        assert!(agents.reserve().is_err());
        drop(slots);
        assert_eq!(agents.reserved.load(Ordering::SeqCst), 0);
        let failed_spawn = agents.reserve().expect("room");
        drop(failed_spawn);
        assert_eq!(agents.reserved.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn concurrent_spawns_cannot_overshoot_the_cap() {
        let agents = Arc::new(Agents::default());
        let barrier = Arc::new(std::sync::Barrier::new(LIVE_LIMIT * 2));
        let workers: Vec<_> = (0..LIVE_LIMIT * 2)
            .map(|_| {
                let agents = Arc::clone(&agents);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    let slot = agents.reserve();
                    let won = slot.is_ok();
                    std::thread::sleep(Duration::from_millis(50));
                    drop(slot);
                    won
                })
            })
            .collect();
        let won = workers.into_iter().filter_map(|worker| worker.join().ok()).filter(|won| *won).count();
        assert_eq!(won, LIVE_LIMIT);
        assert_eq!(agents.reserved.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_spawn_in_flight_counts_as_open() {
        let agents = Agents::default();
        assert_eq!(agents.open(), 0);
        let slot = agents.reserve().expect("room");
        assert_eq!(agents.open(), 1);
        assert_eq!(agents.quit.decide(agents.open()), QuitDecision::Confirm);
        drop(slot);
        assert_eq!(agents.open(), 0);
        assert_eq!(agents.quit.decide(agents.open()), QuitDecision::Exit);
    }

    #[test]
    fn no_spawn_starts_once_den_is_closing() {
        let agents = Agents::default();
        assert!(agents.quit.start_ending());
        assert!(agents.reserve().is_err());
        assert_eq!(agents.reserved.load(Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[test]
    fn ending_waits_for_spawns_in_flight_and_returns_them_to_kill() {
        let agents = Arc::new(Agents::default());
        let slot_agents = Arc::clone(&agents);
        let (reserved, ready) = std::sync::mpsc::channel();
        let spawner = std::thread::spawn(move || {
            let slot = slot_agents.reserve().expect("room");
            reserved.send(()).expect("signal");
            std::thread::sleep(Duration::from_millis(200));
            slot.fill(7, session_running("sleep 30"));
        });
        ready.recv().expect("reserved");
        assert!(agents.quit.start_ending());
        let started = Instant::now();
        let live = agents.settled(Duration::from_secs(5));
        assert!(started.elapsed() >= Duration::from_millis(150));
        spawner.join().expect("spawner");
        assert_eq!(live.len(), 1);
        terminate_all(live, Duration::from_millis(200));
        assert_eq!(agents.open(), 0);
    }

    #[test]
    fn ending_does_not_wait_forever_for_a_stuck_spawn() {
        let agents = Agents::default();
        let slot = agents.reserve().expect("room");
        let started = Instant::now();
        assert!(agents.settled(Duration::from_millis(100)).is_empty());
        assert!(started.elapsed() >= Duration::from_millis(100));
        drop(slot);
    }

    #[test]
    fn input_is_capped_at_256_kib() {
        assert!(within_input_limit(INPUT_LIMIT).is_ok());
        assert!(within_input_limit(INPUT_LIMIT + 1).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn writes_run_off_the_calling_thread() {
        let pty = Arc::new(
            Pty::spawn(&PtySpec {
                program: PathBuf::from("/bin/sh"),
                args: vec!["-c".into(), "stty raw -echo; echo ready; exec sleep 30".into()],
                cwd: None,
                env: vec![("PATH".into(), "/usr/bin:/bin".into())],
                cols: 80,
                rows: 24,
            })
            .expect("spawn"),
        );
        pty.watch(|_| ());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let target = Arc::clone(&seen);
        pty.attach(Box::new(move |chunk| {
            lock(&target).extend(chunk);
            true
        }));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !String::from_utf8_lossy(&lock(&seen)).contains("ready") && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let (release, released) = std::sync::mpsc::channel::<()>();
        let watchdog = {
            let pty = Arc::clone(&pty);
            std::thread::spawn(move || {
                let _ = released.recv_timeout(Duration::from_secs(3));
                pty.terminate(Duration::from_millis(200));
            })
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().expect("runtime");
        let started = std::time::Instant::now();
        let (stalled, caller_free) = runtime.block_on(async {
            let write = write_blocking(Arc::clone(&pty), vec![b'x'; 4 * 1024 * 1024]);
            tokio::pin!(write);
            let stalled = tokio::time::timeout(Duration::from_millis(300), &mut write).await.is_err();
            (stalled, started.elapsed() < Duration::from_secs(2))
        });
        assert!(stalled, "the write finished although nobody reads the terminal");
        assert!(caller_free, "the calling thread was blocked by the write");
        drop(release);
        let _ = watchdog.join();
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
        let found = std::process::Command::new("sh")
            .args(["-c", &format!("command -v '{}'", node.to_string_lossy())])
            .output()
            .expect("which");
        let bin = [OsString::from(String::from_utf8_lossy(&found.stdout).trim()), script];
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
        spec.env.retain(|(key, _)| key != "HOME" && !key.to_string_lossy().starts_with("BITA_"));
        spec.env.push(("HOME".into(), root.join("home").into_os_string()));
        spec.env.push(("BITA_HARNESS_BIN_CLAUDE".into(), fake.clone().into_os_string()));
        spec.env.push(("BITA_DB_PATH".into(), database.clone().into_os_string()));
        let (sender, receiver) = std::sync::mpsc::channel();
        let pty = Arc::new(Pty::spawn(&spec).expect("spawn"));
        pty.watch(move |code| {
            let _ = sender.send(code);
        });
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
