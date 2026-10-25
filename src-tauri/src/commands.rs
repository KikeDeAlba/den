use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::cli::Cli;
use crate::docs::Feature;
use crate::doctor::{self, Report};
use crate::worked::{self, WorkedView};
use crate::model::{Entry, Problem, ProblemKind, Scope, SummaryData, SummaryMeta, SummaryView, Snapshot};
use crate::registry::{Origin, Tool};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    pub command: String,
    pub database: String,
    pub from_environment: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub active: bool,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub client_name: Option<String>,
    #[serde(default)]
    pub jira_project_key: Option<String>,
    #[serde(default)]
    pub jira: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraProject {
    pub project_id: i64,
    #[serde(default)]
    pub jira_project_key: Option<String>,
    #[serde(default = "jira_by_default")]
    pub jira: bool,
}

fn jira_by_default() -> bool {
    true
}

pub fn jira_projects_of(rows: Vec<serde_json::Value>) -> Vec<JiraProject> {
    rows.into_iter()
        .filter_map(|row| serde_json::from_value::<JiraProject>(row).ok())
        .map(|mut row| {
            row.jira_project_key = row
                .jira_project_key
                .map(|key| key.trim().to_string())
                .filter(|key| !key.is_empty());
            row
        })
        .filter(|row| row.jira_project_key.is_some() || !row.jira)
        .collect()
}

#[tauri::command]
pub fn snapshot(state: State<'_, AppState>) -> Snapshot {
    state.snapshot(Utc::now())
}

#[tauri::command]
pub fn cli_info(state: State<'_, AppState>) -> Option<CliInfo> {
    state.describe_cli().map(|cli| CliInfo {
        command: cli.command_line(),
        database: cli.database_path().display().to_string(),
        from_environment: cli.origin() == Origin::Override,
    })
}

#[tauri::command]
pub async fn refresh(app: AppHandle) -> Result<Snapshot, Problem> {
    let state = app.state::<AppState>();
    state.refresh(&app).await;
    Ok(state.snapshot(Utc::now()))
}

#[tauri::command]
pub async fn projects(app: AppHandle) -> Result<Vec<Project>, Problem> {
    let cli = app.state::<AppState>().require_cli(&app).await?;
    cli.call(&["projects"]).await
}

#[tauri::command]
pub async fn start_timer(
    app: AppHandle,
    title: Option<String>,
    project: Option<String>,
    kind: Option<String>,
) -> Result<Snapshot, Problem> {
    let mut args: Vec<String> = vec!["start".into()];
    if let Some(title) = title.as_ref().map(|value| value.trim()) {
        if !title.is_empty() {
            args.push(title.to_string());
        }
    }
    if let Some(project) = project {
        args.push("--project".into());
        args.push(project);
    }
    if let Some(kind) = kind.filter(|value| !value.trim().is_empty()) {
        args.push("--kind".into());
        args.push(kind);
    }
    act(app, args).await
}

#[tauri::command]
pub async fn stop_timer(app: AppHandle, id: i64) -> Result<Snapshot, Problem> {
    act(app, vec!["stop".into(), id.to_string()]).await
}

#[tauri::command]
pub async fn discard_timer(app: AppHandle, id: i64) -> Result<Snapshot, Problem> {
    act(app, vec!["cancel".into(), id.to_string()]).await
}

#[tauri::command]
pub async fn amend_timer(
    app: AppHandle,
    id: i64,
    title: Option<String>,
    project: Option<String>,
    kind: Option<String>,
) -> Result<Snapshot, Problem> {
    let mut args: Vec<String> = vec!["amend".into(), id.to_string()];
    if let Some(title) = title.as_ref().map(|value| value.trim()) {
        if !title.is_empty() {
            args.push("--title".into());
            args.push(title.to_string());
        }
    }
    if let Some(project) = project {
        args.push("--project".into());
        args.push(project);
    }
    if let Some(kind) = kind.filter(|value| !value.trim().is_empty()) {
        args.push("--kind".into());
        args.push(kind);
    }
    act(app, args).await
}

async fn act(app: AppHandle, args: Vec<String>) -> Result<Snapshot, Problem> {
    let state = app.state::<AppState>();
    let cli = state.require_cli(&app).await?;
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    cli.run(&borrowed).await?;
    state.refresh(&app).await;
    Ok(state.snapshot(Utc::now()))
}

pub fn summary_view(data: SummaryData, meta: serde_json::Value) -> SummaryView {
    let meta: SummaryMeta = serde_json::from_value(meta).unwrap_or_default();
    let estimate_seconds = data
        .groups
        .iter()
        .filter(|group| group.jira)
        .map(|group| group.estimate_seconds)
        .sum();

    SummaryView {
        total_seconds: data.total_seconds,
        total_human: data.total_human,
        jira_seconds: data.jira_seconds.unwrap_or(data.total_seconds),
        non_jira_seconds: data.non_jira_seconds.unwrap_or(0),
        non_jira: meta.non_jira,
        estimate_seconds,
        groups: data.groups,
        overlaps: meta.overlaps,
        excluded: meta.excluded,
    }
}

#[tauri::command]
pub async fn worked(app: AppHandle, range: String) -> Result<WorkedView, Problem> {
    let range = match range.as_str() {
        "week" => "week",
        _ => "today",
    };
    let cli = app.state::<AppState>().require_cli(&app).await?;
    let entries: Vec<Entry> = cli.call(&["entries", range]).await?;
    Ok(worked::group(&entries, Utc::now()))
}

#[tauri::command]
pub async fn pending() -> Result<SummaryView, Problem> {
    crate::docs::require(Feature::Jira).await?;
    let cli = Cli::for_tool(Tool::Tally).await?;
    let (data, meta) = cli.call_with_meta::<SummaryData>(&["summary", "--pending"]).await?;
    Ok(summary_view(data, meta))
}

#[tauri::command]
pub async fn jira_projects() -> Result<Vec<JiraProject>, Problem> {
    let status = crate::registry::global().status().await;
    if !status.modules.jira {
        return Ok(Vec::new());
    }
    let cli = Cli::for_tool(Tool::Tally).await?;
    let rows: Vec<serde_json::Value> = cli.call(&["map", "list"]).await?;
    Ok(jira_projects_of(rows))
}

#[tauri::command]
pub async fn scopes(app: AppHandle) -> Result<Vec<Scope>, Problem> {
    let cli = app.state::<AppState>().require_cli(&app).await?;
    cli.call(&["scope", "list"]).await
}

#[tauri::command]
pub async fn add_project(app: AppHandle, name: String) -> Result<Vec<Project>, Problem> {
    let cli = app.state::<AppState>().require_cli(&app).await?;
    cli.run(&["project", "add", name.trim()]).await?;
    cli.call(&["projects"]).await
}

#[tauri::command]
pub async fn set_scope(app: AppHandle, prefix: String, project: String) -> Result<Vec<Scope>, Problem> {
    let cli = app.state::<AppState>().require_cli(&app).await?;
    cli.run(&["scope", "set", prefix.trim(), project.trim()]).await?;
    cli.call(&["scope", "list"]).await
}

#[tauri::command]
pub async fn unset_scope(app: AppHandle, prefix: String) -> Result<Vec<Scope>, Problem> {
    let cli = app.state::<AppState>().require_cli(&app).await?;
    cli.run(&["scope", "unset", prefix.trim()]).await?;
    cli.call(&["scope", "list"]).await
}

#[tauri::command]
pub async fn doctor_report() -> Result<Report, Problem> {
    Ok(doctor::report().await)
}

#[tauri::command]
pub fn open_notes(app: AppHandle, entry_id: Option<i64>) -> Result<(), Problem> {
    crate::notes::open(&app, entry_id).map_err(|error| {
        Problem::new(
            ProblemKind::Unreadable,
            format!("No pude abrir la ventana de notas: {error}"),
        )
    })
}

#[tauri::command]
pub fn open_reports(app: AppHandle) -> Result<(), Problem> {
    crate::reports::open(&app).map_err(|error| {
        Problem::new(
            ProblemKind::Unreadable,
            format!("No pude abrir la ventana de reportes: {error}"),
        )
    })
}

#[tauri::command]
pub fn notes_take_focus(app: AppHandle) -> Option<i64> {
    crate::notes::take_focus(&app)
}

#[tauri::command]
pub fn open_notes_meeting(app: AppHandle, entry_id: i64, tab: String) -> Result<(), Problem> {
    let tab = match tab.as_str() {
        "proposals" | "answers" | "meeting" | "minutes" => tab,
        _ => "document".to_string(),
    };
    crate::notes::open_meeting(&app, crate::notes::MeetingFocus { entry_id, tab }).map_err(|error| {
        Problem::new(
            ProblemKind::Unreadable,
            format!("No pude abrir la ventana de notas: {error}"),
        )
    })
}

#[tauri::command]
pub fn notes_take_meeting(app: AppHandle) -> Option<crate::notes::MeetingFocus> {
    crate::notes::take_meeting(&app)
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::{jira_projects_of, summary_view, JiraProject, Project};
    use crate::model::SummaryData;
    use serde_json::json;

    const BITA_1_PROJECTS: &str = r#"{"schemaVersion":3,"ok":true,"command":"projects","generatedAt":"2026-10-10T23:00:32.532Z","data":[{"id":1,"key":"CON","name":"Contrato","clientName":"Acme","active":true}]}"#;
    const BITA_018_PROJECTS: &str = r#"{"schemaVersion":3,"ok":true,"command":"projects","data":[{"id":7,"name":"CoDi","active":true,"clientName":null,"jiraProjectKey":"COD","jira":false}]}"#;

    #[test]
    fn projects_from_bita_1_and_0_18_both_parse() {
        let envelope: crate::model::Envelope<Vec<Project>> = serde_json::from_str(BITA_1_PROJECTS).expect("bita 1.0");
        let project = &envelope.data.expect("data")[0];
        assert_eq!(project.key.as_deref(), Some("CON"));
        assert_eq!(project.client_name.as_deref(), Some("Acme"));
        assert!(project.jira_project_key.is_none() && project.jira.is_none());

        let envelope: crate::model::Envelope<Vec<Project>> = serde_json::from_str(BITA_018_PROJECTS).expect("bita 0.18");
        let project = &envelope.data.expect("data")[0];
        assert_eq!(project.jira, Some(false));
        assert_eq!(project.jira_project_key.as_deref(), Some("COD"));
        assert!(project.key.is_none());
    }

    #[test]
    fn jira_projects_come_from_the_tally_map() {
        let rows = vec![
            json!({"projectId": 1, "projectName": "Contrato", "jiraProjectKey": "CON", "epicMode": "fixed"}),
            json!({"projectId": 2, "projectName": "Roto"}),
            json!({"projectId": 3, "jiraProjectKey": " "}),
        ];
        assert_eq!(
            jira_projects_of(rows),
            vec![JiraProject { project_id: 1, jira_project_key: Some("CON".into()), jira: true }]
        );
    }

    #[test]
    fn the_jira_flag_comes_from_the_tally_map_and_defaults_to_on() {
        let rows = vec![
            json!({"projectId": 1, "projectName": "Contrato", "jiraProjectKey": "CON", "jira": true}),
            json!({"projectId": 2, "projectName": "Mascotas", "jiraProjectKey": null, "jira": false}),
            json!({"projectId": 3, "projectName": "Viejo", "jiraProjectKey": "OLD"}),
            json!({"projectId": 4, "projectName": "Pausado", "jiraProjectKey": "PAU", "jira": false}),
            json!({"projectId": 5, "projectName": "Sin mapa", "jira": true}),
        ];
        assert_eq!(
            jira_projects_of(rows),
            vec![
                JiraProject { project_id: 1, jira_project_key: Some("CON".into()), jira: true },
                JiraProject { project_id: 2, jira_project_key: None, jira: false },
                JiraProject { project_id: 3, jira_project_key: Some("OLD".into()), jira: true },
                JiraProject { project_id: 4, jira_project_key: Some("PAU".into()), jira: false },
            ]
        );
    }

    #[test]
    fn a_tally_summary_becomes_the_jira_tab() {
        let data: SummaryData = serde_json::from_value(json!({
            "totalSeconds": 5400,
            "totalHuman": "1h 30m",
            "jiraSeconds": 3600,
            "nonJiraSeconds": 1800,
            "groups": [
                {"summary": "Firma BBVA", "projectId": 7, "projectName": "CoDi", "totalSeconds": 3600, "totalHuman": "1h",
                 "estimateSeconds": 5400, "estimateHuman": "1h 30m", "entryIds": [1, 2], "days": ["2026-10-10"],
                 "docs": [], "partIndex": 1, "partCount": 1, "jiraProjectKey": "COD", "jira": true},
                {"summary": "Interno", "projectId": 8, "projectName": "Casa", "totalSeconds": 1800, "totalHuman": "30m",
                 "estimateSeconds": 1800, "estimateHuman": "30m", "entryIds": [3], "days": ["2026-10-10"],
                 "partIndex": 1, "partCount": 1, "jira": false}
            ]
        }))
        .expect("tally data");
        let meta = json!({
            "overlaps": [],
            "excluded": [{"id": 4, "description": "", "projectName": null, "durationHuman": "5m", "reason": "no-description"}],
            "nonJira": {"totalSeconds": 1800, "totalHuman": "30m", "projects": [{"name": "Casa", "totalSeconds": 1800, "totalHuman": "30m"}]}
        });
        let view = summary_view(data, meta);
        assert_eq!(view.estimate_seconds, 5400);
        assert_eq!(view.jira_seconds, 3600);
        assert_eq!(view.non_jira_seconds, 1800);
        assert_eq!(view.excluded.len(), 1);
        assert_eq!(view.non_jira.expect("non jira").projects.len(), 1);

        let bare: SummaryData = serde_json::from_value(json!({"totalSeconds": 0, "totalHuman": "0m", "groups": []})).expect("bare");
        let empty = summary_view(bare, serde_json::Value::Null);
        assert_eq!(empty.jira_seconds, 0);
        assert!(empty.groups.is_empty() && empty.excluded.is_empty());
    }
}
