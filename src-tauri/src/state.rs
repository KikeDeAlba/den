use std::collections::HashSet;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use tauri::AppHandle;

use crate::cli::Cli;
use crate::model::{Entry, LiveTimer, Problem, Snapshot};

#[derive(Debug, Clone)]
struct Running {
    id: i64,
    title: Option<String>,
    doc_rel_path: Option<String>,
    sections_written: Option<i64>,
    sections_total: Option<i64>,
    touched_since_note: Option<i64>,
    project_name: Option<String>,
    project_id: Option<i64>,
    started_at: DateTime<Utc>,
    start_local: String,
    draft: bool,
    kind: Option<String>,
}

impl Running {
    fn from_entry(entry: &Entry) -> Option<Self> {
        let started_at = DateTime::parse_from_rfc3339(&entry.start)
            .ok()?
            .with_timezone(&Utc);
        let draft = entry.is_draft();
        Some(Self {
            id: entry.id,
            title: if draft {
                None
            } else {
                Some(entry.description.clone())
            },
            doc_rel_path: entry.doc_rel_path.clone(),
            sections_written: entry.sections_written,
            sections_total: entry.sections_total,
            touched_since_note: entry.touched_since_note,
            project_name: entry.project_name.clone(),
            project_id: entry.project_id,
            started_at,
            start_local: entry.start_local.clone(),
            draft,
            kind: entry.kind.clone(),
        })
    }

    fn elapsed(&self, now: DateTime<Utc>) -> i64 {
        (now - self.started_at).num_seconds().max(0)
    }

    fn live(&self, now: DateTime<Utc>) -> LiveTimer {
        LiveTimer {
            id: self.id,
            title: self.title.clone(),
            doc_rel_path: self.doc_rel_path.clone(),
            sections_written: self.sections_written,
            sections_total: self.sections_total,
            touched_since_note: self.touched_since_note,
            project_name: self.project_name.clone(),
            project_id: self.project_id,
            started_at: self.started_at.to_rfc3339(),
            start_local: self.start_local.clone(),
            elapsed_seconds: self.elapsed(now),
            draft: self.draft,
            kind: self.kind.clone(),
        }
    }
}

#[derive(Default)]
struct Inner {
    running: Vec<Running>,
    settled_today_seconds: i64,
    running_today: HashSet<i64>,
    problem: Option<Problem>,
}

pub struct AppState {
    cli: Mutex<Option<Cli>>,
    inner: Mutex<Inner>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            cli: Mutex::new(None),
            inner: Mutex::new(Inner::default()),
        }
    }

    pub fn snapshot(&self, now: DateTime<Utc>) -> Snapshot {
        let inner = self.inner.lock().expect("state poisoned");
        let live: Vec<LiveTimer> = inner.running.iter().map(|entry| entry.live(now)).collect();
        let running_today: i64 = inner
            .running
            .iter()
            .filter(|entry| inner.running_today.contains(&entry.id))
            .map(|entry| entry.elapsed(now))
            .sum();

        Snapshot {
            running: live,
            today_seconds: inner.settled_today_seconds + running_today,
            problem: inner.problem.clone(),
        }
    }

    pub async fn refresh(&self, app: &AppHandle) {
        let cli = match self.ensure_cli(app).await {
            Ok(cli) => cli,
            Err(problem) => {
                self.fail(problem);
                return;
            }
        };

        let running: Vec<Entry> = match cli.call(&["ls"]).await {
            Ok(entries) => entries,
            Err(problem) => {
                self.fail(problem);
                return;
            }
        };

        let today: Vec<Entry> = match cli.call(&["entries", "today"]).await {
            Ok(entries) => entries,
            Err(problem) => {
                self.fail(problem);
                return;
            }
        };

        let settled_today_seconds = today
            .iter()
            .filter(|entry| !entry.running)
            .map(|entry| entry.duration_seconds)
            .sum();

        let running_today: HashSet<i64> = today
            .iter()
            .filter(|entry| entry.running)
            .map(|entry| entry.id)
            .collect();

        let mut inner = self.inner.lock().expect("state poisoned");
        inner.running = running.iter().filter_map(Running::from_entry).collect();
        inner.settled_today_seconds = settled_today_seconds;
        inner.running_today = running_today;
        inner.problem = None;
    }

    pub fn forget_cli(&self) {
        *self.cli.lock().expect("state poisoned") = None;
    }

    pub async fn require_cli(&self, app: &AppHandle) -> Result<Cli, Problem> {
        self.ensure_cli(app).await
    }

    async fn ensure_cli(&self, app: &AppHandle) -> Result<Cli, Problem> {
        let existing = self.cli.lock().expect("state poisoned").clone();
        if let Some(cli) = existing {
            return Ok(cli);
        }
        let discovered = Cli::discover(app).await?;
        *self.cli.lock().expect("state poisoned") = Some(discovered.clone());
        Ok(discovered)
    }

    fn fail(&self, problem: Problem) {
        let mut inner = self.inner.lock().expect("state poisoned");
        inner.running.clear();
        inner.problem = Some(problem);
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
