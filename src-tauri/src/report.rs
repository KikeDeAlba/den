use std::collections::HashMap;

use chrono::{Local, NaiveDate};
use tauri::AppHandle;
use serde::{Deserialize, Serialize};

use crate::cli::{CallOptions, Cli};
use crate::docs::Feature;
use crate::model::{Overlap, Problem, ProblemKind};
use crate::pay::{MonthSpec, Overtime, Pay, UPGRADE_TALLY_OVERTIME};
use crate::registry::{Tool, ToolsStatus};

const REPORT_TIMEOUT_SECONDS: u64 = 60;
const OVERTIME_CONCURRENCY: usize = 4;
const UPGRADE_BITA: &str = "Actualiza bita a 1.2 para ver reportes";
const UPGRADE_TALLY: &str = "Actualiza tally a 0.3 para ver el estado en Jira";
const PROJECT_COLORS: [&str; 5] = [
    "var(--aqua)",
    "var(--blue)",
    "var(--purple)",
    "var(--ok)",
    "var(--estimate)",
];
const NO_PROJECT_COLOR: &str = "var(--fg-faint)";
const BITA_NO_PROJECT: &str = "(no project)";
const NO_PROJECT_NAME: &str = "Sin proyecto";
const REPORT_CAPABILITY: &str = "time.report.read";
const STATUS_CAPABILITY: &str = "timesheet.status";

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRange {
    pub from_day: String,
    pub to_day: String,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub week_starts_on: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitaProject {
    #[serde(default)]
    pub project_id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub client_name: Option<String>,
    pub total_seconds: i64,
    #[serde(default)]
    pub entry_count: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSeconds {
    #[serde(default)]
    pub project_id: Option<i64>,
    pub seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDay {
    pub day: String,
    pub total_seconds: i64,
    #[serde(default)]
    pub projects: Vec<ProjectSeconds>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportWeek {
    pub from_day: String,
    pub to_day: String,
    pub total_seconds: i64,
    #[serde(default)]
    pub projects: Vec<ProjectSeconds>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitaReportEntry {
    pub id: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub project_id: Option<i64>,
    pub start: String,
    #[serde(default)]
    pub stop: Option<String>,
    pub local_day: String,
    pub seconds: i64,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub overlapping: bool,
    #[serde(default)]
    pub block_ids: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitaReport {
    pub range: ReportRange,
    pub total_seconds: i64,
    #[serde(default)]
    pub entry_count: i64,
    #[serde(default)]
    pub active_days: i64,
    #[serde(default)]
    pub projects: Vec<BitaProject>,
    #[serde(default)]
    pub days: Vec<ReportDay>,
    #[serde(default)]
    pub weeks: Vec<ReportWeek>,
    #[serde(default)]
    pub overlaps: Vec<Overlap>,
    #[serde(default)]
    pub entries: Option<Vec<BitaReportEntry>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TallyProject {
    pub project_id: Option<i64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub jira: bool,
    #[serde(default)]
    pub registered_seconds: i64,
    #[serde(default)]
    pub pending_seconds: i64,
    #[serde(default)]
    pub excluded_seconds: i64,
    #[serde(default)]
    pub non_jira_seconds: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate_seconds: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TallyTotals {
    #[serde(default)]
    pub registered_seconds: i64,
    #[serde(default)]
    pub pending_seconds: i64,
    #[serde(default)]
    pub excluded_seconds: i64,
    #[serde(default)]
    pub non_jira_seconds: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate_seconds: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TallyEntry {
    pub entry_id: i64,
    #[serde(default)]
    pub registered: bool,
    #[serde(default)]
    pub issue_key: Option<String>,
    #[serde(default)]
    pub jira: bool,
    #[serde(default)]
    pub excluded_reason: Option<String>,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub local_day: Option<String>,
    #[serde(default)]
    pub seconds: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TallyStatus {
    #[serde(default)]
    pub projects: Vec<TallyProject>,
    #[serde(default)]
    pub totals: TallyTotals,
    #[serde(default)]
    pub entries: Option<Vec<TallyEntry>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportProject {
    pub project_id: Option<i64>,
    pub name: String,
    pub client_name: Option<String>,
    pub total_seconds: i64,
    pub entry_count: i64,
    pub color: String,
    pub jira: bool,
    pub registered_seconds: i64,
    pub pending_seconds: i64,
    pub excluded_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportEntry {
    pub id: i64,
    pub title: String,
    pub project_id: Option<i64>,
    pub start: String,
    pub stop: Option<String>,
    pub local_day: String,
    pub seconds: i64,
    pub kind: Option<String>,
    pub overlapping: bool,
    pub block_ids: Vec<i64>,
    pub color: String,
    pub registered: Option<bool>,
    pub issue_key: Option<String>,
    pub jira: Option<bool>,
    pub excluded_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportView {
    pub range: ReportRange,
    pub total_seconds: i64,
    pub entry_count: i64,
    pub active_days: i64,
    pub projects: Vec<ReportProject>,
    pub days: Vec<ReportDay>,
    pub weeks: Vec<ReportWeek>,
    pub overlaps: Vec<Overlap>,
    pub entries: Option<Vec<ReportEntry>>,
    pub jira_available: bool,
    pub jira_totals: Option<TallyTotals>,
    pub jira_problem: Option<String>,
    pub overtime: Option<Overtime>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReportRequest {
    pub preset: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub project_id: Option<i64>,
    pub entries: Option<bool>,
}

pub fn project_color(project_id: Option<i64>) -> &'static str {
    match project_id {
        Some(id) => PROJECT_COLORS[id.rem_euclid(PROJECT_COLORS.len() as i64) as usize],
        None => NO_PROJECT_COLOR,
    }
}

pub fn merge(report: BitaReport, status: Option<TallyStatus>) -> ReportView {
    let by_project: HashMap<Option<i64>, &TallyProject> = status
        .iter()
        .flat_map(|status| status.projects.iter())
        .map(|project| (project.project_id, project))
        .collect();
    let mut by_block: HashMap<i64, Vec<&TallyEntry>> = HashMap::new();
    for entry in status.iter().flat_map(|status| status.entries.iter().flatten()) {
        by_block.entry(entry.entry_id).or_default().push(entry);
    }
    let jira_available = status.is_some();

    let projects = report
        .projects
        .into_iter()
        .map(|project| {
            let tally = by_project.get(&project.project_id);
            ReportProject {
                color: project_color(project.project_id).to_string(),
                jira: tally.is_some_and(|found| found.jira),
                registered_seconds: tally.map_or(0, |found| found.registered_seconds),
                pending_seconds: tally.map_or(0, |found| found.pending_seconds),
                excluded_seconds: tally.map_or(0, |found| found.excluded_seconds),
                project_id: project.project_id,
                name: project_name(project.project_id, project.name),
                client_name: project.client_name,
                total_seconds: project.total_seconds,
                entry_count: project.entry_count,
            }
        })
        .collect();

    let entries = report.entries.map(|entries| {
        entries
            .into_iter()
            .map(|entry| {
                let rows: Vec<&TallyEntry> = entry
                    .block_ids
                    .iter()
                    .flat_map(|block| by_block.get(block).into_iter().flatten().copied())
                    .collect();
                let known = !rows.is_empty();
                ReportEntry {
                    color: project_color(entry.project_id).to_string(),
                    registered: known.then(|| rows.iter().all(|row| row.registered)),
                    issue_key: shared(rows.iter().map(|row| row.issue_key.as_deref())),
                    jira: known.then(|| rows.iter().any(|row| row.jira)),
                    excluded_reason: shared(rows.iter().map(|row| row.excluded_reason.as_deref())),
                    block_ids: entry.block_ids,
                    id: entry.id,
                    title: entry.title,
                    project_id: entry.project_id,
                    start: entry.start,
                    stop: entry.stop,
                    local_day: entry.local_day,
                    seconds: entry.seconds,
                    kind: entry.kind,
                    overlapping: entry.overlapping,
                }
            })
            .collect()
    });

    ReportView {
        range: report.range,
        total_seconds: report.total_seconds,
        entry_count: report.entry_count,
        active_days: report.active_days,
        projects,
        days: report.days,
        weeks: report.weeks,
        overlaps: report.overlaps,
        entries,
        jira_available,
        jira_totals: status.map(|status| status.totals),
        jira_problem: None,
        overtime: None,
    }
}

fn project_name(project_id: Option<i64>, name: String) -> String {
    if project_id.is_none() && (name.trim().is_empty() || name == BITA_NO_PROJECT) {
        return NO_PROJECT_NAME.to_string();
    }
    name
}

fn shared<'a>(mut values: impl Iterator<Item = Option<&'a str>>) -> Option<String> {
    let first = values.next()??;
    values.all(|value| value == Some(first)).then(|| first.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    Yes,
    No,
    Unknown,
}

pub fn support(capabilities: &[String], verified: bool, capability: &str) -> Support {
    if capabilities.iter().any(|item| item == capability) {
        Support::Yes
    } else if verified {
        Support::No
    } else {
        Support::Unknown
    }
}

fn upgrade_bita() -> Problem {
    Problem::new(ProblemKind::CliTooOld, UPGRADE_BITA).with_hint(Some(Tool::Bita.default_install()))
}

pub fn tally_outcome(result: Result<Option<TallyStatus>, Problem>) -> (Option<TallyStatus>, Option<String>) {
    match result {
        Ok(status) => (status, None),
        Err(problem) if problem.kind == ProblemKind::CliFailed && is_unknown_command(&problem) => {
            (None, Some(UPGRADE_TALLY.to_string()))
        }
        Err(problem) => (None, Some(problem.message)),
    }
}

fn invalid(message: impl Into<String>) -> Problem {
    Problem::new(ProblemKind::CliFailed, message)
}

fn day(value: &str, label: &str) -> Result<String, Problem> {
    let value = value.trim();
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|_| value.to_string())
        .map_err(|_| invalid(format!("La fecha {label} no es válida: {value}")))
}

pub fn range_args(request: &ReportRequest) -> Result<Vec<String>, Problem> {
    let mut args = Vec::new();
    let from = request.from.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let to = request.to.as_deref().map(str::trim).filter(|value| !value.is_empty());
    if from.is_some() || to.is_some() {
        if let Some(from) = from {
            args.extend(["--from".to_string(), day(from, "inicial")?]);
        }
        if let Some(to) = to {
            args.extend(["--to".to_string(), day(to, "final")?]);
        }
    } else if let Some(preset) = request.preset.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        let valid = !preset.starts_with('-')
            && preset.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !valid {
            return Err(invalid(format!("No reconozco el periodo {preset}.")));
        }
        args.push(preset.to_string());
    }
    if let Some(project_id) = request.project_id {
        args.extend(["--project".to_string(), project_id.to_string()]);
    }
    if request.entries == Some(true) {
        args.push("--entries".to_string());
    }
    Ok(args)
}

pub fn bita_args(request: &ReportRequest) -> Result<Vec<String>, Problem> {
    let mut args = vec!["report".to_string()];
    args.extend(range_args(request)?);
    Ok(args)
}

pub fn tally_args(request: &ReportRequest) -> Result<Vec<String>, Problem> {
    let mut args = vec!["status".to_string()];
    args.extend(range_args(request)?);
    args.push("--include-running".to_string());
    Ok(args)
}

pub fn is_unknown_command(problem: &Problem) -> bool {
    let message = problem.message.trim();
    message.ends_with("(UNKNOWN_COMMAND)")
        || (message.ends_with("(USAGE_ERROR)") && message.to_lowercase().starts_with("unknown command"))
}

pub fn bita_problem(problem: Problem) -> Problem {
    if problem.kind == ProblemKind::CliFailed && is_unknown_command(&problem) {
        return upgrade_bita();
    }
    problem
}

async fn call<T: serde::de::DeserializeOwned>(tool: Tool, cli: &Cli, args: &[String]) -> Result<T, Problem> {
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let (data, _) = cli
        .call_with_options::<T>(&borrowed, CallOptions::timeout(REPORT_TIMEOUT_SECONDS))
        .await?;
    data.ok_or_else(|| {
        Problem::new(ProblemKind::Unreadable, format!("La respuesta de {} venía sin datos.", tool.name()))
    })
}

fn tool_support(status: &ToolsStatus, tool: Tool, capability: &str) -> Support {
    status
        .tool(tool)
        .map_or(Support::Unknown, |found| support(&found.capabilities, found.verified, capability))
}

async fn bita_report(status: &ToolsStatus, args: &[String]) -> Result<BitaReport, Problem> {
    if tool_support(status, Tool::Bita, REPORT_CAPABILITY) == Support::No {
        return Err(upgrade_bita());
    }
    let cli = Cli::for_tool(Tool::Bita).await?;
    call::<BitaReport>(Tool::Bita, &cli, args).await.map_err(bita_problem)
}

async fn tally_status(status: &ToolsStatus, args: &[String]) -> Result<Option<TallyStatus>, Problem> {
    if crate::docs::refusal(Feature::Jira, status).is_some() {
        return Ok(None);
    }
    if tool_support(status, Tool::Tally, STATUS_CAPABILITY) == Support::No {
        return Err(Problem::new(ProblemKind::CliTooOld, UPGRADE_TALLY));
    }
    let Ok(cli) = Cli::for_tool(Tool::Tally).await else { return Ok(None) };
    call::<TallyStatus>(Tool::Tally, &cli, args).await.map(Some)
}

pub fn overtime_args(month: &MonthSpec) -> Vec<String> {
    vec![
        "status".to_string(),
        "--from".to_string(),
        month.from.format("%Y-%m-%d").to_string(),
        "--to".to_string(),
        month.to.format("%Y-%m-%d").to_string(),
        "--include-running".to_string(),
    ]
}

async fn monthly_overtime(
    tools: &ToolsStatus,
    range: &ReportRange,
    pay: &Pay,
    tally_failure: Option<&str>,
) -> Option<Overtime> {
    pay.monthly_salary?;
    if let Some(failure) = tally_failure {
        let problem = if failure == UPGRADE_TALLY { UPGRADE_TALLY_OVERTIME } else { failure };
        return Some(Overtime::with_problem(pay, problem));
    }
    if crate::docs::refusal(Feature::Jira, tools).is_some() {
        return None;
    }
    let today = Local::now().date_naive();
    if tool_support(tools, Tool::Tally, STATUS_CAPABILITY) == Support::No {
        return Some(Overtime::with_problem(pay, UPGRADE_TALLY_OVERTIME));
    }
    let from = NaiveDate::parse_from_str(&range.from_day, "%Y-%m-%d").ok()?;
    let to = NaiveDate::parse_from_str(&range.to_day, "%Y-%m-%d").ok()?;
    let cli = Cli::for_tool(Tool::Tally).await.ok()?;
    let months = crate::pay::months_between(from, to, today);
    let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(OVERTIME_CONCURRENCY));
    let mut jobs = tokio::task::JoinSet::new();
    for (index, month) in months.iter().enumerate() {
        let cli = cli.clone();
        let args = overtime_args(month);
        let permits = permits.clone();
        jobs.spawn(async move {
            let _permit = permits.acquire_owned().await;
            (index, call::<TallyStatus>(Tool::Tally, &cli, &args).await)
        });
    }
    let mut statuses: Vec<Option<TallyStatus>> = vec![None; months.len()];
    while let Some(joined) = jobs.join_next().await {
        let (index, result) = match joined {
            Ok(done) => done,
            Err(_) => return Some(Overtime::with_problem(pay, "No pude calcular las horas extra.")),
        };
        match result {
            Ok(status) => statuses[index] = Some(status),
            Err(problem) if problem.kind == ProblemKind::CliFailed && is_unknown_command(&problem) => {
                return Some(Overtime::with_problem(pay, UPGRADE_TALLY_OVERTIME));
            }
            Err(problem) => return Some(Overtime::with_problem(pay, problem.message)),
        }
    }
    let paired = months.into_iter().zip(statuses).filter_map(|(month, status)| Some((month, status?))).collect();
    Some(crate::pay::overtime(paired, pay, today))
}

#[tauri::command]
pub async fn report(
    app: AppHandle,
    preset: Option<String>,
    from: Option<String>,
    to: Option<String>,
    project_id: Option<i64>,
    entries: Option<bool>,
) -> Result<ReportView, Problem> {
    let request = ReportRequest { preset, from, to, project_id, entries };
    let bita = bita_args(&request)?;
    let tally = tally_args(&request)?;
    let tools = crate::registry::global().status().await;
    let (report, status) =
        tokio::try_join!(bita_report(&tools, &bita), async { Ok(tally_status(&tools, &tally).await) })?;
    let (status, jira_problem) = tally_outcome(status);
    let mut view = merge(report, status);
    view.jira_problem = jira_problem;
    let pay = crate::pay::stored_pay(&app);
    view.overtime = monthly_overtime(&tools, &view.range, &pay, view.jira_problem.as_deref()).await;
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BITA_REPORT: &str = r#"{
        "range": {"fromDay": "2026-10-05", "toDay": "2026-10-11", "timezone": "America/Mexico_City", "weekStartsOn": 1},
        "totalSeconds": 12600,
        "entryCount": 4,
        "activeDays": 2,
        "projects": [
            {"projectId": 7, "name": "Contrato", "clientName": "Solemti", "totalSeconds": 9000, "entryCount": 2},
            {"projectId": 3, "name": "Interno", "clientName": null, "totalSeconds": 2700, "entryCount": 1},
            {"projectId": null, "name": "(no project)", "clientName": null, "totalSeconds": 900, "entryCount": 1}
        ],
        "days": [
            {"day": "2026-10-05", "totalSeconds": 10800, "projects": [{"projectId": 7, "seconds": 9000}, {"projectId": null, "seconds": 900}, {"projectId": 3, "seconds": 900}]},
            {"day": "2026-10-06", "totalSeconds": 1800, "projects": [{"projectId": 3, "seconds": 1800}]},
            {"day": "2026-10-07", "totalSeconds": 0, "projects": []}
        ],
        "weeks": [
            {"fromDay": "2026-10-05", "toDay": "2026-10-11", "totalSeconds": 12600, "projects": [{"projectId": 7, "seconds": 9000}, {"projectId": 3, "seconds": 2700}, {"projectId": null, "seconds": 900}]}
        ],
        "overlaps": [
            {"localDay": "2026-10-05", "trackedSeconds": 10800, "clockSeconds": 9900, "overlapSeconds": 900}
        ]
    }"#;

    const BITA_ENTRIES: &str = r#"[
        {"id": 11, "title": "Rotar el secreto", "projectId": 7, "start": "2026-10-05T15:00:00.000Z", "stop": "2026-10-05T17:30:00.000Z", "localDay": "2026-10-05", "seconds": 9000, "kind": "work", "overlapping": true, "blockIds": [11, 14]},
        {"id": 12, "title": "Junta", "projectId": null, "start": "2026-10-05T16:00:00.000Z", "stop": null, "localDay": "2026-10-05", "seconds": 900, "kind": null, "overlapping": false, "blockIds": [12]}
    ]"#;

    const TALLY_STATUS: &str = r#"{
        "projects": [
            {"projectId": 7, "name": "Contrato", "jira": true, "registeredSeconds": 5400, "pendingSeconds": 3600, "excludedSeconds": 0, "nonJiraSeconds": 0},
            {"projectId": 3, "name": "Interno", "jira": false, "registeredSeconds": 0, "pendingSeconds": 0, "excludedSeconds": 600, "nonJiraSeconds": 2100}
        ],
        "totals": {"registeredSeconds": 5400, "pendingSeconds": 3600, "excludedSeconds": 0, "nonJiraSeconds": 3600}
    }"#;

    const TALLY_ENTRIES: &str = r#"[
        {"entryId": 11, "registered": true, "issueKey": "PP-1", "jira": true, "excludedReason": null, "projectId": 7, "localDay": "2026-10-05", "seconds": 5400},
        {"entryId": 14, "registered": true, "issueKey": "PP-1", "jira": true, "excludedReason": null, "projectId": 7, "localDay": "2026-10-05", "seconds": 3600},
        {"entryId": 12, "registered": false, "issueKey": null, "jira": false, "excludedReason": "running", "projectId": null, "localDay": "2026-10-05", "seconds": 900}
    ]"#;

    fn bita(with_entries: bool) -> BitaReport {
        let mut value: serde_json::Value = serde_json::from_str(BITA_REPORT).expect("bita fixture");
        if with_entries {
            value["entries"] = serde_json::from_str(BITA_ENTRIES).expect("entries fixture");
        }
        serde_json::from_value(value).expect("bita report")
    }

    fn tally(with_entries: bool) -> TallyStatus {
        let mut value: serde_json::Value = serde_json::from_str(TALLY_STATUS).expect("tally fixture");
        if with_entries {
            value["entries"] = serde_json::from_str(TALLY_ENTRIES).expect("entries fixture");
        }
        serde_json::from_value(value).expect("tally status")
    }

    fn request(preset: Option<&str>, from: Option<&str>, to: Option<&str>) -> ReportRequest {
        ReportRequest {
            preset: preset.map(str::to_string),
            from: from.map(str::to_string),
            to: to.map(str::to_string),
            project_id: None,
            entries: None,
        }
    }

    #[test]
    fn the_palette_is_the_one_the_shell_uses() {
        let colors = include_str!("../../src/shell/colors.ts");
        let start = colors.find("const PROJECT_COLORS = [").expect("PROJECT_COLORS in shell/colors.ts");
        let end = start + colors[start..].find(']').expect("end of PROJECT_COLORS");
        let palette: Vec<&str> = colors[start..end]
            .split('\'')
            .skip(1)
            .step_by(2)
            .collect();
        assert_eq!(palette, PROJECT_COLORS);
        assert!(colors.contains(&format!("if (projectId === null) return '{NO_PROJECT_COLOR}'")));
        assert!(colors.contains("PROJECT_COLORS[projectId % PROJECT_COLORS.length]"));
    }

    #[test]
    fn colors_follow_the_order_of_project_color_in_the_shell() {
        assert_eq!(project_color(Some(0)), "var(--aqua)");
        assert_eq!(project_color(Some(1)), "var(--blue)");
        assert_eq!(project_color(Some(2)), "var(--purple)");
        assert_eq!(project_color(Some(3)), "var(--ok)");
        assert_eq!(project_color(Some(4)), "var(--estimate)");
        assert_eq!(project_color(Some(7)), "var(--purple)");
        assert_eq!(project_color(None), "var(--fg-faint)");
    }

    #[test]
    fn merges_the_jira_columns_into_each_project() {
        let view = merge(bita(false), Some(tally(false)));
        assert!(view.jira_available);
        assert_eq!(view.total_seconds, 12600);
        assert_eq!(view.days.len(), 3);
        assert_eq!(view.weeks.len(), 1);
        assert_eq!(view.overlaps[0].overlap_seconds, 900);

        let contract = &view.projects[0];
        assert_eq!(contract.project_id, Some(7));
        assert_eq!(contract.color, "var(--purple)");
        assert!(contract.jira);
        assert_eq!(contract.registered_seconds, 5400);
        assert_eq!(contract.pending_seconds, 3600);
        assert_eq!(contract.excluded_seconds, 0);

        let internal = &view.projects[1];
        assert_eq!(internal.excluded_seconds, 600);
        assert_eq!(internal.color, "var(--ok)");
        assert!(!internal.jira);

        let loose = &view.projects[2];
        assert_eq!(loose.project_id, None);
        assert_eq!(loose.name, "Sin proyecto");
        assert_eq!(loose.color, "var(--fg-faint)");
        assert!(!loose.jira);
        assert_eq!(loose.pending_seconds, 0);
        assert_eq!(view.jira_totals.as_ref().map(|totals| totals.pending_seconds), Some(3600));
        assert!(view.entries.is_none());
    }

    #[test]
    fn without_tally_the_report_has_no_jira_column() {
        let view = merge(bita(true), None);
        assert!(!view.jira_available);
        assert!(view.jira_totals.is_none());
        assert!(view.projects.iter().all(|project| !project.jira && project.registered_seconds == 0));
        let entries = view.entries.expect("entries");
        assert_eq!(entries[0].registered, None);
        assert_eq!(entries[0].color, "var(--purple)");
    }

    #[test]
    fn merges_the_registration_of_each_entry() {
        let view = merge(bita(true), Some(tally(true)));
        let entries = view.entries.expect("entries");
        assert_eq!(entries[0].registered, Some(true));
        assert_eq!(entries[0].issue_key.as_deref(), Some("PP-1"));
        assert_eq!(entries[0].jira, Some(true));
        assert_eq!(entries[0].block_ids, [11, 14]);
        assert_eq!(entries[1].registered, Some(false));
        assert_eq!(entries[1].excluded_reason.as_deref(), Some("running"));
        assert_eq!(entries[1].stop, None);
        assert_eq!(entries[1].color, "var(--fg-faint)");
    }

    #[test]
    fn a_merged_entry_is_registered_only_when_every_block_is() {
        let mut report = bita(true);
        let entries = report.entries.as_mut().expect("entries");
        let mut next_day = entries[0].clone();
        next_day.local_day = "2026-10-06".into();
        next_day.block_ids = vec![15];
        entries.push(next_day);
        let mut status = tally(true);
        let rows = status.entries.as_mut().expect("entries");
        rows[1].registered = false;
        rows[1].issue_key = None;
        rows.push(TallyEntry {
            entry_id: 15,
            registered: true,
            issue_key: Some("PP-9".into()),
            jira: true,
            excluded_reason: None,
            project_id: Some(7),
            local_day: Some("2026-10-06".into()),
            seconds: 600,
        });
        let entries = merge(report, Some(status)).entries.expect("entries");
        assert_eq!(entries[0].registered, Some(false));
        assert_eq!(entries[0].issue_key, None);
        assert_eq!(entries[2].id, entries[0].id);
        assert_eq!(entries[2].registered, Some(true));
        assert_eq!(entries[2].issue_key.as_deref(), Some("PP-9"));
    }

    #[test]
    fn entries_without_tally_rows_have_no_registration() {
        let mut status = tally(true);
        status.entries = Some(Vec::new());
        let entries = merge(bita(true), Some(status)).entries.expect("entries");
        assert!(entries.iter().all(|entry| entry.registered.is_none() && entry.jira.is_none()));
    }

    #[test]
    fn support_comes_from_the_declared_capabilities() {
        let declared = vec!["time.entries.read".to_string(), REPORT_CAPABILITY.to_string()];
        assert_eq!(support(&declared, true, REPORT_CAPABILITY), Support::Yes);
        assert_eq!(support(&declared, false, REPORT_CAPABILITY), Support::Yes);
        assert_eq!(support(&declared, true, STATUS_CAPABILITY), Support::No);
        assert_eq!(support(&declared, false, STATUS_CAPABILITY), Support::Unknown);
    }

    #[test]
    fn a_project_named_by_bita_keeps_its_name() {
        assert_eq!(project_name(None, "(no project)".into()), "Sin proyecto");
        assert_eq!(project_name(None, String::new()), "Sin proyecto");
        assert_eq!(project_name(Some(4), "(no project)".into()), "(no project)");
        assert_eq!(project_name(Some(4), "Contrato".into()), "Contrato");
    }

    #[test]
    fn an_old_tally_asks_to_upgrade_and_a_missing_one_is_silent() {
        let (status, problem) = tally_outcome(Ok(None));
        assert!(status.is_none() && problem.is_none());

        let unknown = Problem::new(ProblemKind::CliFailed, "Unknown command \"status\". (UNKNOWN_COMMAND)");
        let (status, problem) = tally_outcome(Err(unknown));
        assert!(status.is_none());
        assert_eq!(problem.as_deref(), Some(UPGRADE_TALLY));

        let declared_old = Problem::new(ProblemKind::CliTooOld, UPGRADE_TALLY);
        let (status, problem) = tally_outcome(Err(declared_old));
        assert!(status.is_none());
        assert_eq!(problem.as_deref(), Some(UPGRADE_TALLY));

        let broken = Problem::new(ProblemKind::Unreadable, "No entiendo la respuesta de tally: missing field");
        let (status, problem) = tally_outcome(Err(broken));
        assert!(status.is_none());
        assert_eq!(problem.as_deref(), Some("No entiendo la respuesta de tally: missing field"));

        let (status, problem) = tally_outcome(Ok(Some(tally(false))));
        assert!(status.is_some() && problem.is_none());
    }

    #[test]
    fn serializes_in_camel_case_and_reads_itself_back() {
        let view = merge(bita(true), Some(tally(true)));
        let json = serde_json::to_value(&view).expect("serialize");
        for key in ["range", "totalSeconds", "entryCount", "activeDays", "projects", "days", "weeks", "overlaps", "entries", "jiraAvailable", "jiraTotals", "jiraProblem"] {
            assert!(json.get(key).is_some(), "missing {key}: {json}");
        }
        assert_eq!(json["range"]["fromDay"], "2026-10-05");
        assert_eq!(json["range"]["weekStartsOn"], 1);
        for key in ["projectId", "clientName", "totalSeconds", "entryCount", "color", "jira", "registeredSeconds", "pendingSeconds", "excludedSeconds"] {
            assert!(json["projects"][0].get(key).is_some(), "missing {key}");
        }
        assert_eq!(json["days"][0]["projects"][0]["projectId"], 7);
        assert_eq!(json["entries"][0]["issueKey"], "PP-1");
        let back: ReportView = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, view);
    }

    #[test]
    fn builds_the_arguments_for_a_preset() {
        let mut asked = request(Some("week"), None, None);
        asked.project_id = Some(7);
        asked.entries = Some(true);
        assert_eq!(bita_args(&asked).unwrap(), ["report", "week", "--project", "7", "--entries"]);
        assert_eq!(
            tally_args(&asked).unwrap(),
            ["status", "week", "--project", "7", "--entries", "--include-running"]
        );
        assert_eq!(bita_args(&ReportRequest::default()).unwrap(), ["report"]);
    }

    #[test]
    fn an_explicit_range_wins_over_the_preset() {
        let asked = request(Some("week"), Some("2026-10-01"), Some(" 2026-10-09 "));
        assert_eq!(bita_args(&asked).unwrap(), ["report", "--from", "2026-10-01", "--to", "2026-10-09"]);
        let only_from = request(None, Some("2026-10-01"), Some(""));
        assert_eq!(bita_args(&only_from).unwrap(), ["report", "--from", "2026-10-01"]);
    }

    #[test]
    fn refuses_arguments_that_could_become_flags() {
        assert!(bita_args(&request(Some("--db-path"), None, None)).is_err());
        assert!(bita_args(&request(Some("week; rm"), None, None)).is_err());
        assert!(bita_args(&request(None, Some("--all"), None)).is_err());
        assert!(bita_args(&request(None, None, Some("2026-13-40"))).is_err());
    }

    #[test]
    fn an_old_bita_asks_to_upgrade() {
        let unknown = Problem::new(ProblemKind::CliFailed, "Unknown command \"report\". (UNKNOWN_COMMAND)");
        let mapped = bita_problem(unknown);
        assert_eq!(mapped.kind, ProblemKind::CliTooOld);
        assert_eq!(mapped.message, UPGRADE_BITA);
        assert!(mapped.hint.is_some());

        let legacy = bita_problem(Problem::new(ProblemKind::CliFailed, "Unknown command. (USAGE_ERROR)"));
        assert_eq!(legacy.message, UPGRADE_BITA);

        let echoed = bita_problem(Problem::new(ProblemKind::CliFailed, "Unknown command option --foo for report. (INVALID_OPTION)"));
        assert_eq!(echoed.kind, ProblemKind::CliFailed);

        let other = bita_problem(Problem::new(ProblemKind::CliFailed, "No project 99. (USAGE_ERROR)"));
        assert_eq!(other.kind, ProblemKind::CliFailed);
        assert_eq!(other.message, "No project 99. (USAGE_ERROR)");
    }
    #[test]
    fn overtime_asks_tally_for_one_calendar_month() {
        let month = MonthSpec {
            month: "2026-10".into(),
            from: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
            to: NaiveDate::from_ymd_opt(2026, 10, 10).unwrap(),
        };
        assert_eq!(
            overtime_args(&month),
            ["status", "--from", "2026-10-01", "--to", "2026-10-10", "--include-running"]
        );
    }

    #[test]
    fn without_salary_or_tally_estimates_the_view_stays_as_before() {
        let view = merge(bita(false), Some(tally(false)));
        let json = serde_json::to_value(&view).expect("json");
        assert!(json["overtime"].is_null());
        assert!(json["jiraTotals"].get("estimateSeconds").is_none());
    }

    #[test]
    fn tally_estimates_are_read_when_present() {
        let mut value: serde_json::Value = serde_json::from_str(TALLY_STATUS).expect("fixture");
        value["projects"][0]["estimateSeconds"] = 10800.into();
        value["totals"]["estimateSeconds"] = 10800.into();
        let status: TallyStatus = serde_json::from_value(value).expect("status");
        assert_eq!(status.projects[0].estimate_seconds, Some(10800));
        assert_eq!(status.projects[1].estimate_seconds, None);
        assert_eq!(status.totals.estimate_seconds, Some(10800));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_salary_means_no_overtime() {
        let tools = ToolsStatus {
            registry_dir: String::new(),
            tools: Vec::new(),
            invalid: Vec::new(),
            modules: crate::registry::Modules::default(),
            inkwell_migrated: None,
        };
        let range: ReportRange = bita(false).range;
        assert!(monthly_overtime(&tools, &range, &Pay::default(), None).await.is_none());
        let paid = Pay { monthly_salary: Some(16000.0), ..Pay::default() };
        let failed = monthly_overtime(&tools, &range, &paid, Some(UPGRADE_TALLY)).await.expect("overtime");
        assert_eq!(failed.problem.as_deref(), Some(UPGRADE_TALLY_OVERTIME));
    }
}
