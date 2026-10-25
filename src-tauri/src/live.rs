use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::process::Command;
use tokio::time::{interval, MissedTickBehavior};

use crate::ask::{self, parse_jsonl, Answer};
use crate::cli::node;
use crate::meeting::Segment;
use crate::model::{Problem, ProblemKind};
use crate::recap::{recap_call, RecapError};
use crate::state::AppState;

pub const LABEL: &str = "live";
pub const STATE_EVENT: &str = "bita://live-state";
pub const TRANSCRIPT_EVENT: &str = "bita://live-transcript";
pub const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+Space";
pub const MEETINGS_ROUTE: &str = "reuniones";

const WIDTH: f64 = 380.0;
const HEIGHT: f64 = 620.0;
const MARGIN: f64 = 16.0;
const TAIL_LINES: usize = 40;
const POLL: Duration = Duration::from_secs(1);
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const SETTINGS_FILE: &str = "live.json";
const STATE_DIR_ENV: &str = "RECAP_STATE_DIR";
const AUTO_ASK_MIN_SECONDS: i64 = 10;
const AUTO_ASK_MAX_SECONDS: i64 = 120;
const AUTO_ASK_MIN_CONCURRENCY: i64 = 1;
const AUTO_ASK_MAX_CONCURRENCY: i64 = 6;
const ASKING_DIR: &str = "asking";
const ASKING_FILE: &str = "asking.json";

type Fingerprint = Option<(SystemTime, u64)>;
type DirFingerprint = Option<Vec<(String, SystemTime, u64)>>;

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveMeeting {
    pub meeting_id: String,
    pub dir: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConfig {
    pub enabled: bool,
    pub open_window: bool,
    pub proposals: bool,
    pub assist_model: Option<String>,
    pub max_chunk_seconds: Option<i64>,
    pub auto_ask: Option<bool>,
    pub auto_ask_model: Option<String>,
    pub auto_ask_min_seconds: Option<i64>,
    pub auto_ask_concurrency: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AskPhase {
    Queued,
    #[default]
    Running,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAsk {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub state: AskPhase,
    #[serde(default)]
    pub auto: bool,
    #[serde(default)]
    pub question: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Toggle {
    Show,
    Hide,
}

pub fn toggle_action(visible: bool) -> Toggle {
    if visible {
        Toggle::Hide
    } else {
        Toggle::Show
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveView {
    pub active: Option<ActiveMeeting>,
    pub title: Option<String>,
    pub entry_id: Option<i64>,
    pub project: Option<String>,
    pub transcript: Vec<Segment>,
    pub answers: Vec<Answer>,
    pub asking: bool,
    pub pending_asks: Vec<PendingAsk>,
    pub shortcut: String,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptUpdate {
    pub meeting_id: String,
    pub transcript: Vec<Segment>,
    pub from: usize,
    pub lines: Vec<Segment>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullTranscript {
    pub meeting_id: String,
    pub transcript: Vec<Segment>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    #[serde(default)]
    shortcut: Option<String>,
}

#[derive(Default)]
struct SessionInner {
    active: Option<ActiveMeeting>,
    title: Option<String>,
    entry_id: Option<i64>,
    project: Option<String>,
    transcript: Vec<Segment>,
    full: Vec<Segment>,
    answers: Vec<Answer>,
    pending_asks: Vec<PendingAsk>,
    transcript_mark: Fingerprint,
    answers_mark: Fingerprint,
    asking_mark: Option<(DirFingerprint, Fingerprint)>,
}

#[derive(Default)]
pub struct LiveSession {
    inner: Mutex<SessionInner>,
    shortcut: Mutex<String>,
}

impl LiveSession {
    fn lock(&self) -> std::sync::MutexGuard<'_, SessionInner> {
        self.inner.lock().expect("live poisoned")
    }

    pub fn shortcut(&self) -> String {
        let current = self.shortcut.lock().expect("live poisoned").clone();
        if current.is_empty() {
            DEFAULT_SHORTCUT.to_string()
        } else {
            current
        }
    }

    fn set_shortcut(&self, value: &str) {
        *self.shortcut.lock().expect("live poisoned") = value.to_string();
    }

    pub fn active(&self) -> Option<ActiveMeeting> {
        self.lock().active.clone()
    }
}

pub fn parse_active(text: &str) -> Option<ActiveMeeting> {
    let active: ActiveMeeting = serde_json::from_str(text.trim()).ok()?;
    if active.meeting_id.trim().is_empty() || active.dir.trim().is_empty() {
        return None;
    }
    Some(active)
}

pub fn parse_asking(text: &str) -> Option<PendingAsk> {
    let mut state: PendingAsk = serde_json::from_str(text.trim()).ok()?;
    state.question = state
        .question
        .map(|question| question.trim().to_string())
        .filter(|question| !question.is_empty());
    state.id = state.id.map(|id| id.trim().to_string()).filter(|id| !id.is_empty());
    Some(state)
}

pub fn read_asking(path: &Path) -> Option<PendingAsk> {
    parse_asking(&fs::read_to_string(path).ok()?)
}

fn asking_entries(dir: &Path) -> Option<Vec<PathBuf>> {
    let mut paths: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "json") && path.is_file())
        .collect();
    paths.sort();
    Some(paths)
}

pub fn read_asking_dir(dir: &Path) -> Option<Vec<PendingAsk>> {
    let mut asks: Vec<PendingAsk> = asking_entries(dir)?
        .iter()
        .filter_map(|path| {
            let mut ask = read_asking(path)?;
            if ask.id.is_none() {
                ask.id = path.file_stem().map(|stem| stem.to_string_lossy().into_owned());
            }
            Some(ask)
        })
        .collect();
    asks.sort_by(|left, right| left.started_at.cmp(&right.started_at).then_with(|| left.id.cmp(&right.id)));
    Some(asks)
}

pub fn read_pending_asks(live_dir: &Path) -> Vec<PendingAsk> {
    read_asking_dir(&live_dir.join(ASKING_DIR))
        .unwrap_or_else(|| read_asking(&live_dir.join(ASKING_FILE)).into_iter().collect())
}

fn dir_fingerprint(dir: &Path) -> DirFingerprint {
    let entries = asking_entries(dir)?;
    Some(
        entries
            .iter()
            .filter_map(|path| {
                let meta = fs::metadata(path).ok()?;
                Some((path.file_name()?.to_string_lossy().into_owned(), meta.modified().ok()?, meta.len()))
            })
            .collect(),
    )
}

pub fn parse_config(data: &Value) -> Option<LiveConfig> {
    let settings = data.get("settings")?.as_object()?;
    let flag = |key: &str, fallback: bool| settings.get(key).and_then(Value::as_bool).unwrap_or(fallback);
    Some(LiveConfig {
        enabled: flag("live.enabled", true),
        open_window: flag("live.openWindow", true),
        proposals: flag("live.proposals", true),
        assist_model: settings
            .get("live.assistModel")
            .and_then(Value::as_str)
            .map(str::to_string),
        max_chunk_seconds: settings.get("live.maxChunkSeconds").and_then(Value::as_i64),
        auto_ask: settings.get("live.autoAsk").and_then(Value::as_bool),
        auto_ask_model: settings
            .get("live.autoAskModel")
            .and_then(Value::as_str)
            .map(str::to_string),
        auto_ask_min_seconds: settings.get("live.autoAskMinSeconds").and_then(Value::as_i64),
        auto_ask_concurrency: settings.get("live.autoAskConcurrency").and_then(Value::as_i64),
    })
}

pub fn tail<T: Clone>(items: &[T], count: usize) -> Vec<T> {
    items[items.len().saturating_sub(count)..].to_vec()
}

pub fn increment<T: Clone + PartialEq>(previous: &[T], lines: &[T]) -> (usize, Vec<T>) {
    let kept = previous.len();
    if lines.len() >= kept && lines[..kept] == *previous {
        (kept, lines[kept..].to_vec())
    } else {
        (0, lines.to_vec())
    }
}

fn state_dir_from(explicit: Option<PathBuf>, xdg: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = explicit.filter(|dir| !dir.as_os_str().is_empty()) {
        return Some(dir);
    }
    if let Some(dir) = xdg.filter(|dir| dir.is_absolute()) {
        return Some(dir.join("recap"));
    }
    home.map(|home| home.join(".local/state/recap"))
}

pub fn active_file() -> Option<PathBuf> {
    state_dir_from(
        env::var_os(STATE_DIR_ENV).map(PathBuf::from),
        env::var_os("XDG_STATE_HOME").map(PathBuf::from),
        node::home(),
    )
    .map(|dir| dir.join("active.json"))
}

fn fingerprint(path: &Path) -> Fingerprint {
    let meta = fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

fn read_active() -> Option<ActiveMeeting> {
    let path = active_file()?;
    parse_active(&fs::read_to_string(path).ok()?)
}

pub fn find(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

pub fn compact_visible(app: &AppHandle) -> bool {
    find(app)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

pub fn is_visible(app: &AppHandle) -> bool {
    compact_visible(app)
}

fn corner(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let left = f64::from(area.position.x) / scale;
    let top = f64::from(area.position.y) / scale;
    let width = f64::from(area.size.width) / scale;
    Some(((left + width - WIDTH - MARGIN).max(left), top + MARGIN))
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("live.html".into()))
        .title("Asistente de reunión")
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(320.0, 360.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .content_protected(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .accept_first_mouse(true)
        .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("localhost"));
    if let Some((x, y)) = corner(app) {
        builder = builder.position(x, y);
    }
    let window = builder.build()?;
    let target = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = target.hide();
        }
    });
    Ok(window)
}

#[cfg(target_os = "macos")]
fn float(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::{NSFloatingWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowSharingType};
        let Ok(pointer) = target.ns_window() else {
            let _ = target.show();
            return;
        };
        let Some(ns_window) = (unsafe { pointer.cast::<NSWindow>().as_ref() }) else {
            let _ = target.show();
            return;
        };
        ns_window.setSharingType(NSWindowSharingType::None);
        ns_window.setLevel(NSFloatingWindowLevel);
        ns_window.setHidesOnDeactivate(false);
        ns_window.setCollectionBehavior(
            ns_window.collectionBehavior()
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
        ns_window.orderFrontRegardless();
    });
}

#[cfg(not(target_os = "macos"))]
fn float(window: &WebviewWindow) {
    let _ = window.show();
}

fn open_compact(app: &AppHandle) -> tauri::Result<()> {
    let window = match find(app) {
        Some(existing) => existing,
        None => build(app)?,
    };
    float(&window);
    Ok(())
}

fn hide_compact(app: &AppHandle) {
    if let Some(window) = find(app) {
        let _ = window.hide();
    }
}

pub fn show(app: &AppHandle) -> tauri::Result<()> {
    open_compact(app)?;
    let _ = app.emit(STATE_EVENT, ());
    Ok(())
}

pub fn hide(app: &AppHandle) {
    hide_compact(app);
    let _ = app.emit(STATE_EVENT, ());
}

pub fn toggle(app: &AppHandle) -> Toggle {
    let action = toggle_action(is_visible(app));
    match action {
        Toggle::Hide => hide(app),
        Toggle::Show => {
            let _ = show(app);
        }
    }
    action
}

fn open_meetings(app: &AppHandle) -> tauri::Result<()> {
    hide(app);
    crate::shell::navigate(app, MEETINGS_ROUTE)
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(SETTINGS_FILE))
}

fn stored_settings(app: &AppHandle) -> StoredSettings {
    settings_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn store_settings(app: &AppHandle, settings: &StoredSettings) -> Result<(), Problem> {
    let path = settings_path(app)
        .ok_or_else(|| Problem::new(ProblemKind::Unreadable, "No sé dónde guardar los ajustes de la app."))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|error| Problem::new(ProblemKind::Unreadable, format!("No pude crear {}: {error}", dir.display())))?;
    }
    let text = serde_json::to_string_pretty(settings).unwrap_or_else(|_| "{}".into());
    fs::write(&path, text)
        .map_err(|error| Problem::new(ProblemKind::Unreadable, format!("No pude guardar {}: {error}", path.display())))
}

pub fn shortcut_fired(app: &AppHandle) {
    if toggle(app) == Toggle::Hide {
        return;
    }
    if app.state::<LiveSession>().active().is_none() {
        let _ = app.emit(
            ask::ANSWER_EVENT,
            ask::AnswerEvent {
                ask_id: 0,
                event: ask::StreamEvent::Error {
                    code: "NO_ACTIVE".into(),
                    message: "No se está grabando ninguna reunión.".into(),
                },
            },
        );
        return;
    }
    let _ = ask::start(app, None);
}

pub fn register_shortcut(app: &AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let wanted = stored_settings(app).shortcut.unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());
    let chosen = if app.global_shortcut().register(wanted.as_str()).is_ok() {
        wanted
    } else if app.global_shortcut().register(DEFAULT_SHORTCUT).is_ok() {
        DEFAULT_SHORTCUT.to_string()
    } else {
        String::new()
    };
    app.state::<LiveSession>().set_shortcut(&chosen);
}

pub fn shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_global_shortcut::{Builder, ShortcutState};
    Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let fired = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| shortcut_fired(app)));
            if fired.is_err() {
                eprintln!("bita: the meeting assistant shortcut failed");
            }
        })
        .build()
}

async fn meeting_meta(meeting_id: &str) -> (Option<String>, Option<i64>) {
    match recap_call(&["show", meeting_id], CALL_TIMEOUT).await {
        Ok(data) => (
            data.get("title").and_then(Value::as_str).map(str::to_string),
            data.get("bitaEntryId").and_then(Value::as_i64),
        ),
        Err(_) => (None, None),
    }
}

fn project_of(app: &AppHandle, entry_id: Option<i64>) -> Option<String> {
    let entry_id = entry_id?;
    app.state::<AppState>()
        .snapshot(Utc::now())
        .running
        .into_iter()
        .find(|timer| timer.id == entry_id)
        .and_then(|timer| timer.project_name)
}

pub async fn live_config() -> Result<LiveConfig, RecapError> {
    let data = recap_call(&["config", "get"], CALL_TIMEOUT).await?;
    parse_config(&data).ok_or_else(|| {
        RecapError::Failed(Problem::new(ProblemKind::Unreadable, "No entiendo los ajustes de recap."))
    })
}

async fn started(app: &AppHandle, active: ActiveMeeting) {
    {
        let session = app.state::<LiveSession>();
        let mut inner = session.lock();
        *inner = SessionInner {
            active: Some(active.clone()),
            ..SessionInner::default()
        };
    }
    let (title, entry_id) = meeting_meta(&active.meeting_id).await;
    let project = project_of(app, entry_id);
    {
        let session = app.state::<LiveSession>();
        let mut inner = session.lock();
        if inner.active.as_ref().map(|current| &current.meeting_id) == Some(&active.meeting_id) {
            inner.title = title;
            inner.entry_id = entry_id;
            inner.project = project;
        }
    }
    let opens = live_config().await.map(|config| config.enabled && config.open_window).unwrap_or(false);
    if opens {
        let _ = show(app);
    }
    let _ = app.emit(STATE_EVENT, ());
}

fn ended(app: &AppHandle) {
    *app.state::<LiveSession>().lock() = SessionInner::default();
    ask::cancel();
    hide(app);
}

fn refresh_files(app: &AppHandle) {
    let session = app.state::<LiveSession>();
    let (dir, meeting_id, transcript_mark, answers_mark, asking_mark) = {
        let inner = session.lock();
        let Some(active) = inner.active.as_ref() else {
            return;
        };
        (
            PathBuf::from(&active.dir).join("live"),
            active.meeting_id.clone(),
            inner.transcript_mark,
            inner.answers_mark,
            inner.asking_mark.clone(),
        )
    };

    let transcript_path = dir.join("transcript.jsonl");
    let current = fingerprint(&transcript_path);
    if current != transcript_mark {
        let lines: Vec<Segment> = fs::read_to_string(&transcript_path)
            .map(|text| parse_jsonl(&text))
            .unwrap_or_default();
        let kept = tail(&lines, TAIL_LINES);
        let total = lines.len();
        let (from, added) = {
            let mut inner = session.lock();
            let step = increment(&inner.full, &lines);
            inner.transcript_mark = current;
            inner.transcript = kept.clone();
            inner.full = lines;
            step
        };
        let _ = app.emit(
            TRANSCRIPT_EVENT,
            TranscriptUpdate {
                meeting_id: meeting_id.clone(),
                transcript: kept,
                from,
                lines: added,
                total,
            },
        );
    }

    let answers_path = dir.join("answers.jsonl");
    let current = fingerprint(&answers_path);
    if current != answers_mark {
        let answers: Vec<Answer> = fs::read_to_string(&answers_path)
            .map(|text| parse_jsonl(&text))
            .unwrap_or_default();
        {
            let mut inner = session.lock();
            inner.answers_mark = current;
            inner.answers = answers;
        }
        let _ = app.emit(STATE_EVENT, ());
    }

    let current = Some((dir_fingerprint(&dir.join(ASKING_DIR)), fingerprint(&dir.join(ASKING_FILE))));
    if current != asking_mark {
        let pending = read_pending_asks(&dir);
        let changed = {
            let mut inner = session.lock();
            inner.asking_mark = current;
            let changed = inner.pending_asks != pending;
            inner.pending_asks = pending;
            changed
        };
        if changed {
            let _ = app.emit(STATE_EVENT, ());
        }
    }
}

pub fn spawn_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(POLL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut seen: Fingerprint = None;
        let mut known: Option<String> = None;
        let mut first = true;
        loop {
            ticker.tick().await;
            let current = active_file().and_then(|path| fingerprint(&path));
            if first || current != seen {
                first = false;
                seen = current;
                let active = read_active();
                let id = active.as_ref().map(|meeting| meeting.meeting_id.clone());
                if id != known {
                    known = id;
                    match active {
                        Some(meeting) => started(&app, meeting).await,
                        None => ended(&app),
                    }
                }
            }
            refresh_files(&app);
        }
    });
}

fn view(app: &AppHandle) -> LiveView {
    let session = app.state::<LiveSession>();
    let shortcut = session.shortcut();
    let mut inner = session.lock();
    if inner.project.is_none() {
        inner.project = project_of(app, inner.entry_id);
    }
    LiveView {
        active: inner.active.clone(),
        title: inner.title.clone(),
        entry_id: inner.entry_id,
        project: inner.project.clone(),
        transcript: inner.transcript.clone(),
        answers: inner.answers.clone(),
        asking: ask::is_asking(),
        pending_asks: inner.pending_asks.clone(),
        shortcut,
        visible: is_visible(app),
    }
}

#[tauri::command]
pub fn live_transcript_full(app: AppHandle) -> Option<FullTranscript> {
    let session = app.state::<LiveSession>();
    let inner = session.lock();
    let active = inner.active.as_ref()?;
    Some(FullTranscript {
        meeting_id: active.meeting_id.clone(),
        transcript: inner.full.clone(),
    })
}

#[tauri::command]
pub fn live_open_meetings(app: AppHandle) -> Result<(), Problem> {
    open_meetings(&app)
        .map_err(|error| Problem::new(ProblemKind::Unreadable, format!("No pude abrir Reuniones: {error}")))
}

#[tauri::command]
pub fn live_state(app: AppHandle) -> LiveView {
    view(&app)
}

#[tauri::command]
pub fn live_show(app: AppHandle) -> Result<(), Problem> {
    show(&app)
        .map_err(|error| Problem::new(ProblemKind::Unreadable, format!("No pude abrir el asistente: {error}")))
}

#[tauri::command]
pub fn live_hide(app: AppHandle) {
    hide(&app);
}

#[tauri::command]
pub fn live_ask(app: AppHandle, question: Option<String>) -> Result<u64, Problem> {
    if app.state::<LiveSession>().active().is_none() {
        return Err(Problem::new(ProblemKind::CliFailed, "No se está grabando ninguna reunión."));
    }
    ask::start(&app, question)
}

#[tauri::command]
pub fn live_cancel() -> bool {
    ask::cancel()
}

#[tauri::command]
pub async fn live_sources(project: String) -> Result<Option<Value>, Problem> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Ok(None);
    }
    match recap_call(&["ask", "--sources", "--project", &project], CALL_TIMEOUT).await {
        Ok(data) => Ok(Some(data)),
        Err(RecapError::Missing) => Ok(None),
        Err(RecapError::Failed(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[tauri::command]
pub async fn recap_config() -> Result<Option<LiveConfig>, Problem> {
    match live_config().await {
        Ok(config) => Ok(Some(config)),
        Err(RecapError::Missing) | Err(RecapError::Failed(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn config_value(key: &str, value: &Value) -> Result<String, Problem> {
    const BOOLEAN: [&str; 4] = ["live.enabled", "live.openWindow", "live.proposals", "live.autoAsk"];
    if BOOLEAN.contains(&key) {
        return value
            .as_bool()
            .map(|flag| flag.to_string())
            .ok_or_else(|| Problem::new(ProblemKind::CliFailed, format!("{key} solo acepta sí o no.")));
    }
    match key {
        "live.maxChunkSeconds" => value
            .as_i64()
            .map(|seconds| seconds.to_string())
            .ok_or_else(|| Problem::new(ProblemKind::CliFailed, "live.maxChunkSeconds es un número de segundos.")),
        "live.autoAskMinSeconds" => value
            .as_i64()
            .filter(|seconds| (AUTO_ASK_MIN_SECONDS..=AUTO_ASK_MAX_SECONDS).contains(seconds))
            .map(|seconds| seconds.to_string())
            .ok_or_else(|| {
                Problem::new(
                    ProblemKind::CliFailed,
                    format!("live.autoAskMinSeconds va de {AUTO_ASK_MIN_SECONDS} a {AUTO_ASK_MAX_SECONDS} segundos."),
                )
            }),
        "live.autoAskConcurrency" => value
            .as_i64()
            .filter(|count| (AUTO_ASK_MIN_CONCURRENCY..=AUTO_ASK_MAX_CONCURRENCY).contains(count))
            .map(|count| count.to_string())
            .ok_or_else(|| {
                Problem::new(
                    ProblemKind::CliFailed,
                    format!("live.autoAskConcurrency va de {AUTO_ASK_MIN_CONCURRENCY} a {AUTO_ASK_MAX_CONCURRENCY} respuestas a la vez."),
                )
            }),
        "live.assistModel" | "live.autoAskModel" => Ok(match value {
            Value::Null => "null".into(),
            Value::String(text) if text.trim().is_empty() => "null".into(),
            Value::String(text) => text.trim().to_string(),
            _ => return Err(Problem::new(ProblemKind::CliFailed, format!("{key} es un nombre de modelo."))),
        }),
        other => Err(Problem::new(ProblemKind::CliFailed, format!("No conozco el ajuste «{other}»."))),
    }
}

#[tauri::command]
pub async fn recap_config_set(key: String, value: Value) -> Result<Option<LiveConfig>, Problem> {
    let text = config_value(&key, &value)?;
    let data = recap_call(&["config", "set", &key, &text], CALL_TIMEOUT)
        .await
        .map_err(Problem::from)?;
    Ok(parse_config(&data))
}

#[tauri::command]
pub async fn live_shortcut_set(app: AppHandle, accelerator: String) -> Result<String, Problem> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let wanted = accelerator.trim().to_string();
    let parsed: Shortcut = wanted
        .parse()
        .map_err(|_| Problem::new(ProblemKind::CliFailed, format!("No entiendo el atajo «{wanted}».")))?;
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    if let Err(error) = shortcuts.register(parsed) {
        let previous = app.state::<LiveSession>().shortcut();
        let _ = shortcuts.register(previous.as_str());
        return Err(Problem::new(
            ProblemKind::CliFailed,
            format!("No pude usar «{wanted}»: otra app ya lo tiene ({error})."),
        ));
    }
    let mut settings = stored_settings(&app);
    settings.shortcut = Some(wanted.clone());
    store_settings(&app, &settings)?;
    app.state::<LiveSession>().set_shortcut(&wanted);
    let _ = app.emit(STATE_EVENT, ());
    Ok(wanted)
}

pub fn openable_file(path: &str) -> Result<PathBuf, Problem> {
    let candidate = PathBuf::from(path);
    if !candidate.is_absolute() {
        return Err(Problem::new(ProblemKind::CliFailed, format!("{path} no es una ruta completa.")));
    }
    let canonical = fs::canonicalize(&candidate)
        .map_err(|_| Problem::new(ProblemKind::CliFailed, format!("{path} no existe en este equipo.")))?;
    if !canonical.is_file() {
        return Err(Problem::new(ProblemKind::CliFailed, format!("{path} no es un archivo.")));
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn open_source_file(path: String) -> Result<(), Problem> {
    let target = openable_file(&path)?;
    let Some(editor) = crate::cli::editor_override() else {
        return crate::platform::open_as_text(&target)
            .await
            .map_err(|error| Problem::new(ProblemKind::CliFailed, format!("No pude abrir {}: {error}", target.display())));
    };
    crate::platform::quiet(&mut Command::new(editor))
        .arg(&target)
        .status()
        .await
        .map_err(|error| Problem::new(ProblemKind::CliFailed, format!("No pude abrir {}: {error}", target.display())))
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{
        config_value, increment, openable_file, parse_active, parse_asking, parse_config, read_asking, read_asking_dir,
        read_pending_asks, state_dir_from, tail, toggle_action, AskPhase, StoredSettings, Toggle,
    };
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn the_active_file_names_the_meeting_being_recorded() {
        let active = parse_active(
            r#"{"meetingId":"2026-10-08-1000-seguimiento","dir":"/Users/x/Recap/2026-10-08-1000-seguimiento","mode":"remote","startedAt":"2026-10-08T16:00:00Z"}"#,
        )
        .expect("active");
        assert_eq!(active.meeting_id, "2026-10-08-1000-seguimiento");
        assert_eq!(active.mode.as_deref(), Some("remote"));
    }

    #[test]
    fn an_empty_or_broken_active_file_means_nothing_is_recording() {
        assert!(parse_active("").is_none());
        assert!(parse_active("{").is_none());
        assert!(parse_active(r#"{"meetingId":"","dir":"/x"}"#).is_none());
        assert!(parse_active(r#"{"meetingId":"m","dir":"/x"}"#).is_some());
    }

    #[test]
    fn the_state_directory_honours_the_override_then_xdg_then_home() {
        let root = std::env::temp_dir();
        let home = Some(root.join("Users").join("x"));
        assert_eq!(
            state_dir_from(Some(root.join("state")), None, home.clone()),
            Some(root.join("state"))
        );
        assert_eq!(
            state_dir_from(None, Some(root.join("xdg")), home.clone()),
            Some(root.join("xdg").join("recap"))
        );
        assert_eq!(
            state_dir_from(None, Some(PathBuf::from("rel")), home.clone()),
            Some(root.join("Users").join("x").join(".local/state/recap"))
        );
        assert_eq!(state_dir_from(None, None, None), None);
    }

    #[test]
    fn recap_settings_are_read_from_the_settings_map() {
        let data = json!({
            "path": "/Users/x/.config/recap/config.json",
            "key": null,
            "value": null,
            "settings": {
                "live.enabled": true,
                "live.openWindow": false,
                "live.proposals": true,
                "live.assistModel": null,
                "live.maxChunkSeconds": 20
            }
        });
        let config = parse_config(&data).expect("config");
        assert!(config.enabled);
        assert!(!config.open_window);
        assert!(config.proposals);
        assert_eq!(config.assist_model, None);
        assert_eq!(config.max_chunk_seconds, Some(20));
        assert_eq!(config.auto_ask, None);
        assert_eq!(config.auto_ask_model, None);
        assert_eq!(config.auto_ask_min_seconds, None);
        assert!(parse_config(&json!({"meetings": []})).is_none());
    }

    #[test]
    fn the_automatic_answer_settings_are_read_when_recap_has_them() {
        let data = json!({
            "settings": {
                "live.enabled": true,
                "live.openWindow": true,
                "live.proposals": true,
                "live.assistModel": null,
                "live.maxChunkSeconds": 20,
                "live.autoAsk": false,
                "live.autoAskModel": "haiku",
                "live.autoAskMinSeconds": 30
            }
        });
        let config = parse_config(&data).expect("config");
        assert_eq!(config.auto_ask, Some(false));
        assert_eq!(config.auto_ask_model.as_deref(), Some("haiku"));
        assert_eq!(config.auto_ask_min_seconds, Some(30));
        assert_eq!(config.auto_ask_concurrency, None);
    }

    #[test]
    fn the_parallel_answer_count_is_read_when_recap_has_it() {
        let data = json!({"settings": {"live.autoAsk": true, "live.autoAskConcurrency": 3}});
        assert_eq!(parse_config(&data).expect("config").auto_ask_concurrency, Some(3));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bita-live-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[test]
    fn every_file_in_the_asking_directory_is_a_pending_answer() {
        let live = scratch("asking-dir");
        let dir = live.join("asking");
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(
            dir.join("b2.json"),
            r#"{"id":"b2","auto":true,"question":"¿Quién aprueba el pase?","questionMs":61000,"channel":"system","startedAt":"2026-10-09T05:42:10Z","state":"running"}"#,
        )
        .expect("b2");
        std::fs::write(
            dir.join("a1.json"),
            r#"{"id":"a1","auto":true,"question":"¿Dónde corre el job?","startedAt":"2026-10-09T05:41:00Z","state":"running"}"#,
        )
        .expect("a1");
        std::fs::write(
            dir.join("c3.json"),
            r#"{"id":"c3","auto":true,"question":"¿Hay rollback?","startedAt":"2026-10-09T05:43:00Z","state":"queued"}"#,
        )
        .expect("c3");
        std::fs::write(dir.join("d4.json"), r#"{"id":"d4","auto":false,"question":null,"startedAt":"2026-10-09T05:43:30Z","state":"running"}"#)
            .expect("d4");
        std::fs::write(dir.join("broken.json"), "{\"id\":").expect("broken");
        std::fs::write(dir.join("notes.txt"), "x").expect("txt");
        std::fs::write(live.join("asking.json"), r#"{"auto":false,"question":"¿legado?","startedAt":"2026-10-09T05:40:00Z"}"#).expect("legacy");

        let asks = read_pending_asks(&live);
        let ids: Vec<_> = asks.iter().map(|ask| ask.id.clone().unwrap_or_default()).collect();
        assert_eq!(ids, vec!["a1", "b2", "c3", "d4"]);
        assert_eq!(asks[1].question_ms, Some(61_000));
        assert_eq!(asks[1].channel.as_deref(), Some("system"));
        assert_eq!(asks[0].state, AskPhase::Running);
        assert_eq!(asks[2].state, AskPhase::Queued);
        assert!(!asks[3].auto);
        assert_eq!(asks[3].question, None);
        let _ = std::fs::remove_dir_all(&live);
    }

    #[test]
    fn an_asking_file_without_id_takes_its_file_name() {
        let live = scratch("asking-noid");
        let dir = live.join("asking");
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join("k9.json"), r#"{"auto":true,"question":"¿Y?","startedAt":"2026-10-09T05:41:00Z"}"#).expect("k9");
        let asks = read_asking_dir(&dir).expect("asks");
        assert_eq!(asks[0].id.as_deref(), Some("k9"));
        assert_eq!(asks[0].state, AskPhase::Running);
        let _ = std::fs::remove_dir_all(&live);
    }

    #[test]
    fn an_empty_asking_directory_means_nothing_is_being_answered() {
        let live = scratch("asking-empty");
        std::fs::create_dir_all(live.join("asking")).expect("dir");
        std::fs::write(live.join("asking.json"), r#"{"auto":true,"question":"¿viejo?","startedAt":"2026-10-09T05:40:00Z"}"#).expect("legacy");
        assert!(read_pending_asks(&live).is_empty());
        let _ = std::fs::remove_dir_all(&live);
    }

    #[test]
    fn without_the_asking_directory_the_legacy_file_is_the_only_pending_answer() {
        let live = scratch("asking-legacy");
        assert!(read_pending_asks(&live).is_empty());
        assert!(read_asking_dir(&live.join("asking")).is_none());
        std::fs::write(live.join("asking.json"), r#"{"auto":true,"question":"¿Dónde está el pipeline?","startedAt":"2026-10-09T05:41:38Z"}"#).expect("legacy");
        let asks = read_pending_asks(&live);
        assert_eq!(asks.len(), 1);
        assert_eq!(asks[0].id, None);
        assert_eq!(asks[0].state, AskPhase::Running);
        assert_eq!(asks[0].question.as_deref(), Some("¿Dónde está el pipeline?"));
        let _ = std::fs::remove_dir_all(&live);
    }

    #[test]
    fn the_asking_file_describes_the_running_answer() {
        let detected = parse_asking(r#"{"auto":true,"question":"¿Cómo se despliega bita-desktop?","startedAt":"2026-10-09T05:41:38Z"}"#)
            .expect("detected");
        assert!(detected.auto);
        assert_eq!(detected.question.as_deref(), Some("¿Cómo se despliega bita-desktop?"));
        assert_eq!(detected.started_at.as_deref(), Some("2026-10-09T05:41:38Z"));

        let manual = parse_asking(r#"{"auto":false,"question":null,"startedAt":"2026-10-09T05:42:00Z"}"#).expect("manual");
        assert!(!manual.auto);
        assert_eq!(manual.question, None);

        let blank = parse_asking(r#"{"auto":false,"question":"  ","startedAt":"2026-10-09T05:42:00Z"}"#).expect("blank");
        assert_eq!(blank.question, None);

        assert!(parse_asking("").is_none());
        assert!(parse_asking("{").is_none());
    }

    #[test]
    fn the_asking_file_may_say_when_and_who_asked() {
        let detected = parse_asking(
            r#"{"auto":true,"question":"¿Cuántas transacciones aguanta?","startedAt":"2026-10-09T05:41:38Z","questionMs":2452000,"channel":"system"}"#,
        )
        .expect("detected");
        assert_eq!(detected.question_ms, Some(2_452_000));
        assert_eq!(detected.channel.as_deref(), Some("system"));
        let older = parse_asking(r#"{"auto":true,"question":"¿Y?","startedAt":"2026-10-09T05:41:38Z"}"#).expect("older");
        assert_eq!(older.question_ms, None);
        assert_eq!(older.channel, None);
    }

    #[test]
    fn a_missing_asking_file_means_nothing_is_being_answered() {
        let path = std::env::temp_dir().join(format!("bita-asking-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        assert!(read_asking(&path).is_none());
        std::fs::write(&path, r#"{"auto":true,"question":"¿Dónde está el pipeline?","startedAt":"2026-10-09T05:41:38Z"}"#).expect("write");
        assert!(read_asking(&path).is_some_and(|state| state.auto));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn settings_values_are_checked_before_reaching_recap() {
        assert_eq!(config_value("live.openWindow", &json!(true)).expect("bool"), "true");
        assert!(config_value("live.openWindow", &json!("yes")).is_err());
        assert_eq!(config_value("live.maxChunkSeconds", &json!(15)).expect("int"), "15");
        assert_eq!(config_value("live.assistModel", &json!("")).expect("null"), "null");
        assert_eq!(config_value("live.assistModel", &json!(" sonnet ")).expect("model"), "sonnet");
        assert_eq!(config_value("live.autoAsk", &json!(false)).expect("bool"), "false");
        assert!(config_value("live.autoAsk", &json!("no")).is_err());
        assert_eq!(config_value("live.autoAskModel", &json!("haiku")).expect("model"), "haiku");
        assert_eq!(config_value("live.autoAskModel", &json!(null)).expect("reset"), "null");
        assert_eq!(config_value("live.autoAskMinSeconds", &json!(30)).expect("int"), "30");
        assert!(config_value("live.autoAskMinSeconds", &json!(5)).is_err());
        assert!(config_value("live.autoAskMinSeconds", &json!(121)).is_err());
        assert_eq!(config_value("live.autoAskConcurrency", &json!(1)).expect("int"), "1");
        assert_eq!(config_value("live.autoAskConcurrency", &json!(6)).expect("int"), "6");
        assert!(config_value("live.autoAskConcurrency", &json!(0)).is_err());
        assert!(config_value("live.autoAskConcurrency", &json!(7)).is_err());
        assert!(config_value("live.autoAskConcurrency", &json!("3")).is_err());
        assert!(config_value("live.other", &json!(true)).is_err());
    }

    #[test]
    fn the_tail_keeps_the_last_lines_only() {
        assert_eq!(tail(&[1, 2, 3, 4], 2), vec![3, 4]);
        assert_eq!(tail(&[1], 5), vec![1]);
        assert!(tail::<i32>(&[], 3).is_empty());
    }

    #[test]
    fn the_transcript_increment_sends_only_the_new_lines() {
        assert_eq!(increment::<i32>(&[], &[1, 2]), (0, vec![1, 2]));
        assert_eq!(increment(&[1, 2], &[1, 2, 3, 4]), (2, vec![3, 4]));
        assert_eq!(increment(&[1, 2], &[1, 2]), (2, vec![]));
    }

    #[test]
    fn a_rewritten_transcript_is_sent_again_from_the_start() {
        assert_eq!(increment(&[1, 2, 3], &[1, 2]), (0, vec![1, 2]));
        assert_eq!(increment(&[1, 2], &[1, 9, 3]), (0, vec![1, 9, 3]));
    }

    #[test]
    fn settings_from_the_old_wide_mode_still_load_their_shortcut() {
        let empty: StoredSettings = serde_json::from_str("{}").expect("empty");
        assert_eq!(empty.shortcut, None);
        let wide: StoredSettings = serde_json::from_str(r#"{"shortcut":"Ctrl+Alt+A","mode":"wide"}"#).expect("wide");
        assert_eq!(wide.shortcut.as_deref(), Some("Ctrl+Alt+A"));
        let text = serde_json::to_string(&wide).expect("serialize");
        assert!(!text.contains("mode"));
    }

    #[test]
    fn the_shortcut_always_toggles_the_mini_window() {
        assert_eq!(toggle_action(false), Toggle::Show);
        assert_eq!(toggle_action(true), Toggle::Hide);
    }

    #[test]
    fn only_existing_absolute_files_open_in_the_editor() {
        assert!(openable_file("relative/file.ts").is_err());
        assert!(openable_file("/definitely/not/here.ts").is_err());
        assert!(openable_file("/tmp").is_err());
        let file = std::env::temp_dir().join(format!("bita-live-{}.ts", std::process::id()));
        std::fs::write(&file, "x").expect("write");
        assert!(openable_file(&file.display().to_string()).is_ok());
        let _ = std::fs::remove_file(&file);
    }
}
