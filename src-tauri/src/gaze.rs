use serde_json::Value;

use crate::cli::{CallOptions, Cli};
use crate::docs::{self, Feature};
use crate::model::{Problem, ProblemKind};
use crate::registry::Tool;

const GRAPH_SECONDS: u64 = 60;
const QUICK_SECONDS: u64 = 20;
const SEARCH_LIMIT: &str = "25";

async fn call(feature: Feature, args: &[&str], seconds: u64) -> Result<Value, Problem> {
    docs::require(feature).await?;
    let cli = Cli::for_tool(Tool::Gaze).await?;
    let (data, _) = cli.call_with_options::<Value>(args, CallOptions::timeout(seconds)).await?;
    Ok(data.unwrap_or(Value::Null))
}

fn project_arg(project: Option<&str>) -> Option<&str> {
    project.map(str::trim).filter(|value| !value.is_empty())
}

fn plain(value: &str) -> &str {
    value.trim().trim_start_matches('-').trim()
}

fn invalid(message: &str) -> Problem {
    Problem::new(ProblemKind::CliFailed, message)
}

pub fn graph_args(project: Option<&str>) -> Vec<&str> {
    let mut args = vec!["graph"];
    if let Some(project) = project_arg(project) {
        args.extend(["--project", project]);
    }
    args
}

pub fn show_args(id: &str) -> Option<Vec<&str>> {
    let id = plain(id);
    (!id.is_empty()).then(|| vec!["show", id])
}

pub fn search_args<'a>(query: &'a str, project: Option<&'a str>) -> Option<Vec<&'a str>> {
    let query = plain(query);
    if query.is_empty() {
        return None;
    }
    let mut args = vec!["search", query];
    match project_arg(project) {
        Some(project) => args.extend(["--project", project]),
        None => args.push("--all"),
    }
    args.extend(["--limit", SEARCH_LIMIT]);
    Some(args)
}

#[tauri::command]
pub async fn gaze_graph(project: Option<String>) -> Result<Value, Problem> {
    call(Feature::Graph, &graph_args(project.as_deref()), GRAPH_SECONDS).await
}

#[tauri::command]
pub async fn gaze_show(id: String) -> Result<Value, Problem> {
    let args = show_args(&id).ok_or_else(|| invalid("Falta el nodo que quieres abrir."))?;
    call(Feature::Graph, &args, QUICK_SECONDS).await
}

#[tauri::command]
pub async fn gaze_search(query: String, project: Option<String>) -> Result<Value, Problem> {
    let args = search_args(&query, project.as_deref()).ok_or_else(|| invalid("Escribe algo para buscar."))?;
    call(Feature::GraphSearch, &args, QUICK_SECONDS).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_graph_is_scoped_to_a_project_only_when_one_is_given() {
        assert_eq!(graph_args(None), vec!["graph"]);
        assert_eq!(graph_args(Some("  ")), vec!["graph"]);
        assert_eq!(graph_args(Some("den")), vec!["graph", "--project", "den"]);
    }

    #[test]
    fn a_node_needs_an_id_that_is_not_a_flag() {
        assert_eq!(show_args("rule:42"), Some(vec!["show", "rule:42"]));
        assert_eq!(show_args("--all"), Some(vec!["show", "all"]));
        assert_eq!(show_args(" - "), None);
    }

    #[test]
    fn search_spans_every_project_unless_one_is_chosen() {
        assert_eq!(
            search_args("auth flow", None),
            Some(vec!["search", "auth flow", "--all", "--limit", SEARCH_LIMIT])
        );
        assert_eq!(
            search_args("  tokens ", Some("den")),
            Some(vec!["search", "tokens", "--project", "den", "--limit", SEARCH_LIMIT])
        );
        assert_eq!(search_args("--json", None), Some(vec!["search", "json", "--all", "--limit", SEARCH_LIMIT]));
        assert_eq!(search_args("   ", None), None);
    }
}
