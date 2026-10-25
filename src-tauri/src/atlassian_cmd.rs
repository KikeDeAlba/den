use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::cli::{CallOptions, Cli};
use crate::docs::Feature;
use crate::model::{Problem, ProblemKind};
use crate::notes_cmd::payload_with;
use crate::registry::Tool;

pub const SYNCED_EVENT: &str = "bita://confluence-synced";

const QUICK_SECONDS: u64 = 30;
pub const SYNC_SECONDS: u64 = 120;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlassianSettings {
    #[serde(default)]
    pub site: Option<String>,
    #[serde(default)]
    pub confluence: Option<String>,
    #[serde(default)]
    pub pull: Option<bool>,
    #[serde(default)]
    pub push: Option<bool>,
}

async fn sync_data(args: &[&str], options: CallOptions) -> Result<Value, Problem> {
    payload_with(Feature::ConfluenceSync, args, options).await.map(|payload| payload.data)
}

async fn sites_client() -> Result<Cli, Problem> {
    crate::docs::require(Feature::Atlassian).await?;
    Cli::for_tool(Tool::Atl).await
}

async fn raw(cli: &Cli, args: &[&str], options: CallOptions) -> Result<Value, Problem> {
    cli.call_with_options::<Value>(args, options)
        .await
        .map(|(data, _)| data.unwrap_or(Value::Null))
}

fn atl_status(check: &Value) -> &'static str {
    let ok = |product: &str| check.get(product).and_then(|part| part.get("ok")).and_then(Value::as_bool) == Some(true);
    if ok("jira") || ok("confluence") {
        return "ok";
    }
    let detail = ["jira", "confluence"]
        .iter()
        .filter_map(|product| check.get(*product).and_then(|part| part.get("detail")).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if detail.contains("401") || detail.contains("403") || detail.contains("auth") || detail.contains("token") {
        "auth_failed"
    } else {
        "unreachable"
    }
}

pub(crate) fn atl_site_view(site: &Value, check: Option<&Value>) -> Value {
    let product = |name: &str| match check {
        Some(found) => found.get(name).and_then(|part| part.get("ok")).and_then(Value::as_bool).unwrap_or(false),
        None => true,
    };
    json!({
        "site": site.get("url").and_then(Value::as_str).or_else(|| site.get("name").and_then(Value::as_str)).unwrap_or_default(),
        "name": site.get("name").cloned().unwrap_or(Value::Null),
        "email": site.get("email").and_then(Value::as_str).unwrap_or_default(),
        "tokenStored": true,
        "jira": product("jira"),
        "confluence": product("confluence"),
        "projects": [],
        "status": check.map(atl_status).unwrap_or("unknown"),
    })
}

fn same_site(site: &Value, reference: &str) -> bool {
    let wanted = reference.trim_end_matches('/');
    ["url", "name"]
        .iter()
        .filter_map(|key| site.get(*key).and_then(Value::as_str))
        .any(|value| value.trim_end_matches('/') == wanted)
}

async fn atl_check(cli: &Cli, site: &Value) -> Option<Value> {
    let name = site.get("name").and_then(Value::as_str)?;
    raw(cli, &["site", "test", name], CallOptions::timeout(60)).await.ok()
}

fn quick() -> CallOptions {
    CallOptions::timeout(QUICK_SECONDS)
}

fn site_arg(site: &str) -> Result<&str, Problem> {
    let trimmed = site.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return Err(Problem::new(ProblemKind::CliFailed, "Falta el sitio de Atlassian."));
    }
    Ok(trimmed)
}

pub(crate) fn on_off(value: bool) -> &'static str {
    if value {
        "on"
    } else {
        "off"
    }
}

pub(crate) fn as_list(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        Value::Null => Vec::new(),
        other => vec![other],
    }
}

#[tauri::command]
pub async fn atlassian_sites(check: bool) -> Result<Vec<Value>, Problem> {
    let cli = sites_client().await?;
    let sites = as_list(raw(&cli, &["site", "ls"], quick()).await?);
    let mut views = Vec::with_capacity(sites.len());
    for site in &sites {
        let checked = if check { atl_check(&cli, site).await } else { None };
        views.push(atl_site_view(site, checked.as_ref()));
    }
    Ok(views)
}

#[tauri::command]
pub async fn atlassian_site_add(
    site: String,
    email: String,
    token: String,
) -> Result<Value, Problem> {
    let site = site_arg(&site)?;
    let email = email.trim();
    if email.is_empty() || email.starts_with('-') {
        return Err(Problem::new(ProblemKind::CliFailed, "Falta el correo de la cuenta."));
    }
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(Problem::new(ProblemKind::CliFailed, "Falta el token de la API."));
    }
    let options = CallOptions::timeout(60).with_stdin(token);
    let cli = sites_client().await?;
    let added = raw(&cli, &atl_add_site_args(site, email), options).await?;
    let saved = added.get("site").cloned().unwrap_or(Value::Null);
    Ok(atl_site_view(&saved, added.get("check")))
}

pub(crate) fn atl_add_site_args<'a>(site: &'a str, email: &'a str) -> Vec<&'a str> {
    vec!["site", "add", site, "--email", email, "--token-stdin"]
}

#[tauri::command]
pub async fn atlassian_site_test(site: String) -> Result<Value, Problem> {
    let site = site_arg(&site)?;
    let cli = sites_client().await?;
    let sites = as_list(raw(&cli, &["site", "ls"], quick()).await?);
    let found = sites
        .into_iter()
        .find(|entry| same_site(entry, site))
        .ok_or_else(|| Problem::new(ProblemKind::CliFailed, format!("atl no conoce el sitio {site}.")))?;
    let checked = atl_check(&cli, &found).await;
    Ok(atl_site_view(&found, checked.as_ref()))
}

#[tauri::command]
pub async fn atlassian_site_remove(site: String) -> Result<(), Problem> {
    let site = site_arg(&site)?;
    let cli = sites_client().await?;
    let sites = as_list(raw(&cli, &["site", "ls"], quick()).await?);
    let name = sites
        .iter()
        .find(|entry| same_site(entry, site))
        .and_then(|entry| entry.get("name").and_then(Value::as_str))
        .unwrap_or(site)
        .to_string();
    raw(&cli, &["site", "rm", &name], quick()).await.map(|_| ())
}

pub(crate) fn space_args(project: &str, settings: &AtlassianSettings) -> Vec<String> {
    let mut args: Vec<String> = vec!["space".into(), "set".into(), project.into()];
    if let Some(site) = settings.site.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        args.push("--site".into());
        args.push(site.into());
    }
    if let Some(reference) = settings.confluence.as_deref() {
        let reference = reference.trim();
        args.push("--confluence".into());
        args.push(if reference.is_empty() { "none".into() } else { reference.into() });
    }
    if let Some(pull) = settings.pull {
        args.push("--pull".into());
        args.push(on_off(pull).into());
    }
    if let Some(push) = settings.push {
        args.push("--push".into());
        args.push(on_off(push).into());
    }
    args
}

#[tauri::command]
pub async fn project_atlassian(
    app: AppHandle,
    project: String,
    settings: AtlassianSettings,
) -> Result<Value, Problem> {
    let project = site_arg(&project)?.to_string();
    crate::docs::require(Feature::Notes).await?;
    let cli = Cli::for_tool(Tool::Inkwell).await?;
    let args = space_args(&project, &settings);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = raw(&cli, &refs, quick()).await?;
    crate::shell::mark_docs_stale(&app);
    Ok(value.get("atlassian").cloned().unwrap_or(value))
}

pub(crate) fn sync_args(project: Option<&str>) -> Vec<&str> {
    match project.map(str::trim).filter(|value| !value.is_empty()) {
        Some(project) => vec!["confluence", "sync", project],
        None => vec!["confluence", "sync", "--all"],
    }
}

pub async fn run_sync(app: &AppHandle, project: Option<&str>) -> Result<Vec<Value>, Problem> {
    let value = sync_data(&sync_args(project), CallOptions::timeout(SYNC_SECONDS)).await?;
    crate::shell::mark_docs_stale(app);
    let _ = app.emit(SYNCED_EVENT, ());
    Ok(as_list(value))
}

#[tauri::command]
pub async fn confluence_sync(app: AppHandle, project: Option<String>) -> Result<Vec<Value>, Problem> {
    run_sync(&app, project.as_deref()).await
}

#[tauri::command]
pub async fn confluence_sync_status(project: String) -> Result<Vec<Value>, Problem> {
    let project = site_arg(&project)?.to_string();
    sync_data(&["confluence", "status", &project], CallOptions::timeout(60))
        .await
        .map(as_list)
}

#[tauri::command]
pub async fn confluence_resolve(app: AppHandle, page_id: i64, keep: String) -> Result<(), Problem> {
    let keep = match keep.as_str() {
        "local" => "local",
        "remote" => "remote",
        other => {
            return Err(Problem::new(
                ProblemKind::CliFailed,
                format!("No sé quedarme con «{other}»."),
            ))
        }
    };
    let id = page_id.to_string();
    sync_data(
        &["confluence", "conflict", "resolve", &id, "--keep", keep],
        CallOptions::timeout(SYNC_SECONDS),
    )
    .await?;
    crate::shell::mark_docs_stale(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{as_list, atl_add_site_args, atl_site_view, on_off, same_site, space_args, sync_args, AtlassianSettings};
    use serde_json::json;

    #[test]
    fn switches_travel_as_on_and_off() {
        assert_eq!(on_off(true), "on");
        assert_eq!(on_off(false), "off");
    }

    #[test]
    fn only_the_settings_given_reach_the_cli() {
        let settings = AtlassianSettings {
            site: Some("https://acme.atlassian.net".into()),
            confluence: Some(String::new()),
            pull: Some(true),
            push: Some(false),
        };
        assert_eq!(
            space_args("codi", &settings),
            vec![
                "space", "set", "codi", "--site", "https://acme.atlassian.net",
                "--confluence", "none", "--pull", "on", "--push", "off"
            ]
        );
        assert_eq!(space_args("codi", &AtlassianSettings::default()), vec!["space", "set", "codi"]);
    }

    #[test]
    fn a_sync_covers_one_project_or_all() {
        assert_eq!(sync_args(Some("codi")), vec!["confluence", "sync", "codi"]);
        assert_eq!(sync_args(None), vec!["confluence", "sync", "--all"]);
        assert_eq!(sync_args(Some(" ")), vec!["confluence", "sync", "--all"]);
    }

    #[test]
    fn a_single_result_reads_as_a_list() {
        assert_eq!(as_list(json!({"project": "codi"})).len(), 1);
        assert_eq!(as_list(json!([1, 2])).len(), 2);
        assert!(as_list(json!(null)).is_empty());
    }

    #[test]
    fn an_atl_site_becomes_the_view_the_window_draws() {
        let site = json!({"name": "acme", "url": "https://acme.atlassian.net", "email": "me@acme.com", "default": true});
        let unchecked = atl_site_view(&site, None);
        assert_eq!(unchecked["site"], "https://acme.atlassian.net");
        assert_eq!(unchecked["status"], "unknown");
        assert_eq!(unchecked["jira"], true);

        let good = json!({"site": "acme", "jira": {"ok": true, "detail": "Jira: Ana"}, "confluence": {"ok": false, "detail": "Confluence: 404"}});
        let checked = atl_site_view(&site, Some(&good));
        assert_eq!(checked["status"], "ok");
        assert_eq!(checked["confluence"], false);

        let denied = json!({"jira": {"ok": false, "detail": "Jira: 401 Unauthorized"}, "confluence": {"ok": false, "detail": "Confluence: 401"}});
        assert_eq!(atl_site_view(&site, Some(&denied))["status"], "auth_failed");
        let down = json!({"jira": {"ok": false, "detail": "Jira: ENOTFOUND"}, "confluence": {"ok": false, "detail": "x"}});
        assert_eq!(atl_site_view(&site, Some(&down))["status"], "unreachable");

        assert!(same_site(&site, "https://acme.atlassian.net/"));
        assert!(same_site(&site, "acme"));
        assert!(!same_site(&site, "other"));
    }

    #[test]
    fn atl_receives_the_token_on_stdin() {
        let args = atl_add_site_args("https://acme.atlassian.net", "me@acme.com");
        assert_eq!(args, vec!["site", "add", "https://acme.atlassian.net", "--email", "me@acme.com", "--token-stdin"]);
    }

    #[test]
    fn inkwell_keeps_the_settings_on_its_space() {
        let settings = AtlassianSettings { confluence: Some("123".into()), ..AtlassianSettings::default() };
        assert_eq!(space_args("codi", &settings), vec!["space", "set", "codi", "--confluence", "123"]);
    }
}
