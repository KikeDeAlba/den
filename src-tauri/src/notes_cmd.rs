use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::process::Command;

use crate::cli;
use crate::docs::Feature;
use crate::platform;
use crate::model::{Problem, ProblemKind};


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliPayload {
    pub data: serde_json::Value,
    pub meta: serde_json::Value,
}

async fn payload(feature: Feature, args: &[&str]) -> Result<CliPayload, Problem> {
    payload_with(feature, args, cli::CallOptions::default()).await
}

pub(crate) async fn payload_with(
    feature: Feature,
    args: &[&str],
    options: cli::CallOptions,
) -> Result<CliPayload, Problem> {
    let (data, meta) = crate::docs::call(feature, args, options).await.map_err(newer_database)?;
    Ok(CliPayload {
        data: data.unwrap_or(serde_json::Value::Null),
        meta,
    })
}

async fn backlog_payload(args: &[&str]) -> Result<CliPayload, Problem> {
    payload(Feature::Backlog, args).await
}

fn newer_database(problem: Problem) -> Problem {
    if !problem.message.contains("was written by a newer version") {
        return problem;
    }
    Problem::new(
        ProblemKind::CliTooOld,
        "La base de datos la escribió una versión más nueva que la herramienta instalada.",
    )
    .with_hint(Some("Actualiza la herramienta con su comando de instalación.".into()))
}

#[tauri::command]
pub async fn notes_tree() -> Result<CliPayload, Problem> {
    payload(Feature::Notes, &["tree", "--pages", "--months"]).await
}

#[tauri::command]
pub async fn page_document(page_id: i64) -> Result<CliPayload, Problem> {
    let id = page_id.to_string();
    payload(Feature::Notes, &["page", "show", &id]).await
}

#[tauri::command]
pub async fn notes_document(entry_id: i64) -> Result<CliPayload, Problem> {
    let id = entry_id.to_string();
    payload(Feature::EntryNotes, &["note", "show", &id]).await
}

#[tauri::command]
pub async fn notes_search_pages(
    query: String,
    project: Option<String>,
) -> Result<CliPayload, Problem> {
    let needle = query.trim();
    if needle.is_empty() {
        return Err(Problem::new(
            ProblemKind::CliFailed,
            "La búsqueda necesita algo que buscar.",
        ));
    }
    let args = page_search_args(needle, project.as_deref());
    payload(Feature::Notes, &args).await
}

fn page_search_args<'a>(needle: &'a str, project: Option<&'a str>) -> Vec<&'a str> {
    let mut args = vec!["search", needle, "--pages"];
    if let Some(project) = project.filter(|value| !value.trim().is_empty()) {
        args.push("--project");
        args.push(project);
    }
    args
}

#[tauri::command]
pub async fn backlog_add(
    kind: String,
    title: String,
    body: Option<String>,
    page_id: Option<i64>,
    project: Option<String>,
) -> Result<CliPayload, Problem> {
    let kind = backlog_kind(&kind)?;
    let title = title.trim();
    if title.is_empty() {
        return Err(Problem::new(ProblemKind::CliFailed, "El ítem necesita un título."));
    }
    let page = page_id.map(|id| id.to_string());
    let args = add_args(kind, title, body.as_deref(), page.as_deref(), project.as_deref());
    backlog_payload(&args).await
}

fn add_args<'a>(
    kind: &'a str,
    title: &'a str,
    body: Option<&'a str>,
    page: Option<&'a str>,
    project: Option<&'a str>,
) -> Vec<&'a str> {
    let mut args = vec!["backlog", "add", "--kind", kind, "--title", title];
    if let Some(body) = body.map(str::trim).filter(|text| !text.is_empty()) {
        args.push("--body");
        args.push(body);
    }
    if let Some(page) = page {
        args.push("--page");
        args.push(page);
    } else if let Some(project) = project.filter(|value| !value.trim().is_empty()) {
        args.push("--project");
        args.push(project);
    }
    args
}

#[tauri::command]
pub async fn backlog_list() -> Result<CliPayload, Problem> {
    backlog_payload(&["backlog", "ls", "--status", "all"]).await
}

#[tauri::command]
pub async fn backlog_set_status(
    id: i64,
    status: String,
    resolution: Option<String>,
) -> Result<CliPayload, Problem> {
    let action = backlog_action(&status)?;
    let id = id.to_string();
    let args = status_args(action, &id, resolution.as_deref());
    backlog_payload(&args).await
}

fn status_args<'a>(action: &'a str, id: &'a str, resolution: Option<&'a str>) -> Vec<&'a str> {
    let mut args = vec!["backlog", action, id];
    if let Some(text) = resolution.map(str::trim).filter(|text| !text.is_empty()) {
        if action == "resolve" {
            args.push("--resolution");
            args.push(text);
        }
    }
    args
}

#[tauri::command]
pub async fn backlog_set_kind(id: i64, kind: String) -> Result<CliPayload, Problem> {
    let kind = backlog_kind(&kind)?;
    let id = id.to_string();
    backlog_payload(&["backlog", "edit", &id, "--kind", kind]).await
}

fn backlog_kind(kind: &str) -> Result<&'static str, Problem> {
    match kind {
        "pending" => Ok("pending"),
        "finding" => Ok("finding"),
        other => Err(Problem::new(
            ProblemKind::CliFailed,
            format!("No conozco el tipo «{other}»."),
        )),
    }
}

fn backlog_action(status: &str) -> Result<&'static str, Problem> {
    match status {
        "resolved" => Ok("resolve"),
        "open" => Ok("reopen"),
        other => Err(Problem::new(
            ProblemKind::CliFailed,
            format!("No conozco el estado «{other}»."),
        )),
    }
}

#[tauri::command]
pub async fn open_document(rel_path: String) -> Result<(), Problem> {
    let absolute = inside_docs_root(&rel_path)?;

    let Some(editor) = cli::editor_override() else {
        return platform::open_path(&absolute).map_err(|error| {
            Problem::new(
                ProblemKind::CliFailed,
                format!("No pude abrir {}: {error}", absolute.display()),
            )
        });
    };
    let status = platform::quiet(&mut Command::new(&editor))
        .arg(&absolute)
        .status()
        .await
        .map_err(|error| {
            Problem::new(
                ProblemKind::CliFailed,
                format!("No pude abrir {}: {error}", absolute.display()),
            )
        })?;

    if status.success() {
        return Ok(());
    }
    Err(Problem::new(
        ProblemKind::CliFailed,
        format!("El editor no quiso abrir {}.", absolute.display()),
    ))
}

const ASSET_MAX_BYTES: u64 = 10 * 1024 * 1024;
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (at, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if at <= chunk.len() {
                out.push(BASE64[((triple >> shift) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[tauri::command]
pub async fn page_asset(rel_path: String) -> Result<Option<String>, Problem> {
    let candidate = image_shaped(&rel_path).map_err(|reason| {
        Problem::new(
            ProblemKind::CliFailed,
            format!("\"{rel_path}\" no es un asset de bita: {reason}."),
        )
    })?;
    if !cli::docs_roots().iter().any(|root| root.join(candidate).exists()) {
        return Ok(None);
    }
    let absolute = resolve_inside(&rel_path, image_shaped)?;
    let size = std::fs::metadata(&absolute).map(|meta| meta.len()).unwrap_or(0);
    if size > ASSET_MAX_BYTES {
        return Err(Problem::new(
            ProblemKind::Unreadable,
            format!("El render de {rel_path} pesa más de 10 MB."),
        ));
    }
    let bytes = std::fs::read(&absolute).map_err(|error| {
        Problem::new(ProblemKind::Unreadable, format!("No pude leer {rel_path}: {error}"))
    })?;
    Ok(Some(format!("data:image/png;base64,{}", base64(&bytes))))
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), Problem> {
    let parsed = url.trim();
    let allowed = ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| parsed.starts_with(scheme));

    if !allowed {
        return Err(Problem::new(
            ProblemKind::CliFailed,
            format!("No abro enlaces de ese tipo: {parsed}"),
        ));
    }

    platform::open_url(parsed).map_err(|error| {
        Problem::new(ProblemKind::CliFailed, format!("No pude abrir el enlace: {error}"))
    })
}

#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Result<(), Problem> {
    app.clipboard().write_text(text).map_err(|error| {
        Problem::new(
            ProblemKind::Unreadable,
            format!("No pude escribir en el portapapeles: {error}"),
        )
    })
}

fn relative_inside(rel_path: &str) -> Result<&Path, &'static str> {
    let candidate = Path::new(rel_path);
    if candidate.is_absolute() || candidate.has_root() {
        return Err("la ruta es absoluta");
    }
    if candidate
        .components()
        .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
    {
        return Err("la ruta sale del directorio");
    }
    Ok(candidate)
}

fn in_assets(candidate: &Path) -> bool {
    candidate
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".assets"))
}

fn extension(candidate: &Path) -> Option<&str> {
    candidate.extension().and_then(|value| value.to_str())
}

fn doc_shaped(rel_path: &str) -> Result<&Path, &'static str> {
    let candidate = relative_inside(rel_path)?;
    match extension(candidate) {
        Some("md") => Ok(candidate),
        Some("drawio") if in_assets(candidate) => Ok(candidate),
        _ => Err("no es un .md ni un .drawio de una página"),
    }
}

fn image_shaped(rel_path: &str) -> Result<&Path, &'static str> {
    let candidate = relative_inside(rel_path)?;
    if extension(candidate) != Some("png") || !in_assets(candidate) {
        return Err("no es un .png de los assets de una página");
    }
    Ok(candidate)
}

fn inside_docs_root(rel_path: &str) -> Result<PathBuf, Problem> {
    resolve_inside(rel_path, doc_shaped)
}

fn resolve_inside(rel_path: &str, shape: fn(&str) -> Result<&Path, &'static str>) -> Result<PathBuf, Problem> {
    let refused = |reason: &str| {
        Problem::new(
            ProblemKind::CliFailed,
            format!("\"{rel_path}\" no es un documento de bita: {reason}."),
        )
    };

    let candidate = shape(rel_path).map_err(refused)?;

    let mut outside = false;
    for root in cli::docs_roots() {
        let Ok(canonical_target) = std::fs::canonicalize(root.join(candidate)) else {
            continue;
        };
        let canonical_root = std::fs::canonicalize(&root).unwrap_or(root);
        if canonical_target.starts_with(&canonical_root) {
            return Ok(canonical_target);
        }
        outside = true;
    }
    Err(refused(if outside { "la ruta sale del directorio" } else { "el archivo no está donde dice la base" }))
}

#[cfg(test)]
mod tests {
    use super::{doc_shaped, inside_docs_root, newer_database};
    use crate::model::{Problem, ProblemKind};

    #[test]
    fn a_database_from_the_future_reads_as_a_stale_tool() {
        let raw = Problem::new(
            ProblemKind::CliFailed,
            "the database at /x/bita.db was written by a newer version (schema 4, this build understands 3) (UNEXPECTED_ERROR)",
        );
        let mapped = newer_database(raw);

        assert_eq!(mapped.kind, ProblemKind::CliTooOld);
        assert!(mapped.message.contains("base de datos"));
        assert!(mapped.hint.is_some());
    }

    #[test]
    fn any_other_failure_is_left_alone() {
        let raw = Problem::new(ProblemKind::CliFailed, "No entry #999. (USAGE_ERROR)");
        let mapped = newer_database(raw);

        assert_eq!(mapped.kind, ProblemKind::CliFailed);
        assert_eq!(mapped.message, "No entry #999. (USAGE_ERROR)");
    }

    #[test]
    fn only_open_and_resolved_reach_the_cli() {
        assert_eq!(super::backlog_action("resolved").ok(), Some("resolve"));
        assert_eq!(super::backlog_action("open").ok(), Some("reopen"));
        assert!(super::backlog_action("rm").is_err());
    }

    #[test]
    fn a_resolution_travels_only_when_resolving_and_not_blank() {
        assert_eq!(
            super::status_args("resolve", "7", Some(" rotado ")),
            vec!["backlog", "resolve", "7", "--resolution", "rotado"]
        );
        assert_eq!(super::status_args("resolve", "7", Some("  ")), vec!["backlog", "resolve", "7"]);
        assert_eq!(super::status_args("reopen", "7", Some("x")), vec!["backlog", "reopen", "7"]);
    }

    #[test]
    fn only_pending_and_finding_are_kinds() {
        assert_eq!(super::backlog_kind("pending").ok(), Some("pending"));
        assert_eq!(super::backlog_kind("finding").ok(), Some("finding"));
        assert!(super::backlog_kind("bug").is_err());
    }

    #[test]
    fn a_page_search_asks_for_pages_and_scopes_only_with_a_project() {
        assert_eq!(super::page_search_args("ssm", None), vec!["search", "ssm", "--pages"]);
        assert_eq!(
            super::page_search_args("ssm", Some("codi")),
            vec!["search", "ssm", "--pages", "--project", "codi"]
        );
        assert_eq!(super::page_search_args("ssm", Some(" ")), vec!["search", "ssm", "--pages"]);
    }

    #[test]
    fn a_new_item_goes_to_its_page_or_else_its_project() {
        assert_eq!(
            super::add_args("pending", "Rotar", Some(" "), None, Some("codi")),
            vec!["backlog", "add", "--kind", "pending", "--title", "Rotar", "--project", "codi"]
        );
        assert_eq!(
            super::add_args("finding", "X", Some("cuerpo"), Some("7"), Some("codi")),
            vec!["backlog", "add", "--kind", "finding", "--title", "X", "--body", "cuerpo", "--page", "7"]
        );
    }

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(super::base64(b""), "");
        assert_eq!(super::base64(b"f"), "Zg==");
        assert_eq!(super::base64(b"fo"), "Zm8=");
        assert_eq!(super::base64(b"foo"), "Zm9v");
        assert_eq!(super::base64(&[0x89, 0x50, 0x4e, 0x47]), "iVBORw==");
    }

    #[test]
    fn only_pngs_inside_a_page_assets_folder_are_images() {
        assert!(super::image_shaped("dportenis/aws.assets/red.png").is_ok());
        assert!(super::image_shaped("dportenis/aws.assets/red.drawio").is_err());
        assert!(super::image_shaped("dportenis/red.png").is_err());
        assert!(super::image_shaped("dportenis/aws.assets/../../x.png").is_err());
        assert!(super::image_shaped("/etc/aws.assets/x.png").is_err());
    }

    #[test]
    fn a_drawio_source_opens_only_from_a_page_assets_folder() {
        assert!(doc_shaped("dportenis/aws.assets/red.drawio").is_ok());
        assert!(doc_shaped("dportenis/red.drawio").is_err());
        assert!(doc_shaped("dportenis/aws.assets/red.sh").is_err());
    }

    #[test]
    fn a_nested_page_path_keeps_its_shape() {
        assert!(doc_shaped("pharma-sti/bootstrap/credenciales-y-secretos.md").is_ok());
        assert!(doc_shaped("pharma-sti/a/b/c/d/hondo.md").is_ok());
    }

    #[test]
    fn climbing_out_from_a_nested_page_is_refused() {
        assert!(doc_shaped("pharma-sti/bootstrap/../../../etc/passwd.md").is_err());
    }

    #[test]
    fn an_absolute_path_is_refused() {
        assert!(inside_docs_root("/etc/passwd.md").is_err());
    }

    #[test]
    fn climbing_out_of_the_docs_root_is_refused() {
        assert!(inside_docs_root("../../etc/passwd.md").is_err());
        assert!(inside_docs_root("arsm/../../escape.md").is_err());
    }

    #[test]
    fn only_markdown_is_opened() {
        assert!(inside_docs_root("arsm/2026/09/20-735-cognito.txt").is_err());
        assert!(inside_docs_root("arsm/2026/09/../../../etc/hosts").is_err());
    }
}
