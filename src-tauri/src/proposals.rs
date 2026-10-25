use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::ask::Answer;
use crate::cli::CallOptions;
use crate::docs::Feature;
use crate::model::{Problem, ProblemKind};
use crate::recap::recap_call;

const RECAP_TIMEOUT: Duration = Duration::from_secs(60);
const SHOW_TIMEOUT: Duration = Duration::from_secs(20);
const BRANCH_PREFIX: &str = "proposal/meeting-";

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub start_ms: i64,
    #[serde(default)]
    pub channel: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub n: i64,
    pub page_id: i64,
    #[serde(default)]
    pub page_title: Option<String>,
    #[serde(default)]
    pub section: Option<String>,
    pub title: String,
    #[serde(default)]
    pub rationale: Option<String>,
    #[serde(default)]
    pub quotes: Vec<Quote>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub sha: Option<String>,
    pub status: String,
    #[serde(default)]
    pub applied_sha: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDetail {
    pub proposal: Proposal,
    pub markdown: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub old_line: Option<i64>,
    #[serde(default)]
    pub new_line: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    #[serde(default)]
    pub header: String,
    #[serde(default)]
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCommit {
    pub sha: String,
    #[serde(default)]
    pub page_id: Option<i64>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub hunks: Vec<Hunk>,
    #[serde(default)]
    pub diff: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDiff {
    pub branch: String,
    #[serde(default)]
    pub commits: Vec<BranchCommit>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub sha: String,
    pub date: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default = "unknown_source")]
    pub source: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub entry_id: Option<i64>,
}

fn unknown_source() -> String {
    "unknown".into()
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageHistory {
    pub page_id: i64,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub revisions: Vec<Revision>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDiff {
    pub page_id: i64,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub diff: String,
    #[serde(default)]
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummary {
    pub name: String,
    #[serde(default)]
    pub head: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchList {
    #[serde(default)]
    branches: Vec<BranchSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMeeting {
    pub entry_id: i64,
    pub meeting_id: Option<String>,
    pub title: String,
    pub ended_at: Option<String>,
    pub proposals: Vec<Proposal>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingExtras {
    pub answers: Vec<Answer>,
    pub proposals: Vec<Proposal>,
}

pub fn extras_of(data: &Value) -> MeetingExtras {
    let list = |key: &str| data.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    MeetingExtras {
        answers: list("answers")
            .into_iter()
            .filter_map(|item| serde_json::from_value(item).ok())
            .collect(),
        proposals: list("proposals")
            .into_iter()
            .filter_map(|item| serde_json::from_value(item).ok())
            .collect(),
    }
}

pub fn proposal_entry(branch: &str) -> Option<i64> {
    branch.strip_prefix(BRANCH_PREFIX)?.parse().ok()
}

pub fn pending_only(proposals: Vec<Proposal>) -> Vec<Proposal> {
    proposals.into_iter().filter(|proposal| proposal.status == "pending").collect()
}

fn ended_at(data: &Value) -> Option<String> {
    if let Some(stopped) = data.get("stoppedAt").and_then(Value::as_str) {
        return Some(stopped.to_string());
    }
    let started = data.get("startedAt").and_then(Value::as_str)?;
    let seconds = data.get("durationSeconds").and_then(Value::as_i64)?;
    let start = chrono::DateTime::parse_from_rfc3339(started).ok()?;
    Some((start + chrono::Duration::seconds(seconds)).to_rfc3339())
}

async fn docs<T: for<'de> Deserialize<'de>>(feature: Feature, args: &[&str]) -> Result<T, Problem> {
    let (data, _) = crate::docs::call(feature, args, CallOptions::default()).await?;
    serde_json::from_value(data.unwrap_or(Value::Null))
        .map_err(|error| Problem::new(ProblemKind::Unreadable, format!("No entiendo la respuesta de los docs: {error}")))
}

async fn recap(args: &[&str], limit: Duration) -> Result<Value, Problem> {
    crate::docs::require(Feature::Meetings).await?;
    recap_call(args, limit).await.map_err(Problem::from)
}

fn valid_rev(rev: &str) -> Result<&str, Problem> {
    let ok = (4..=64).contains(&rev.len()) && rev.chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        Ok(rev)
    } else {
        Err(Problem::new(ProblemKind::CliFailed, format!("«{rev}» no es una versión.")))
    }
}

fn valid_branch(branch: &str) -> Result<&str, Problem> {
    let ok = !branch.is_empty()
        && !branch.starts_with('-')
        && !branch.contains("..")
        && branch
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
    if ok {
        Ok(branch)
    } else {
        Err(Problem::new(ProblemKind::CliFailed, format!("«{branch}» no es una rama de los docs.")))
    }
}

fn valid_meeting(id: &str) -> Result<&str, Problem> {
    let ok = !id.is_empty()
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(id)
    } else {
        Err(Problem::new(ProblemKind::CliFailed, format!("«{id}» no es el id de una reunión.")))
    }
}

fn proposal_of(data: Value) -> Result<Proposal, Problem> {
    let inner = data.get("proposal").cloned().unwrap_or(data);
    serde_json::from_value(inner)
        .map_err(|error| Problem::new(ProblemKind::Unreadable, format!("No entiendo la propuesta de recap: {error}")))
}

#[tauri::command]
pub async fn docs_branch_diff(branch: String, sha: String) -> Result<BranchDiff, Problem> {
    let branch = valid_branch(&branch)?;
    let sha = valid_rev(&sha)?;
    docs(Feature::History, &["branch", "diff", branch, "--commit", sha]).await
}

#[tauri::command]
pub async fn page_history(page_id: i64) -> Result<PageHistory, Problem> {
    let id = page_id.to_string();
    docs(Feature::History, &["page", "history", &id]).await
}

#[tauri::command]
pub async fn page_diff(page_id: i64, rev: String) -> Result<PageDiff, Problem> {
    let id = page_id.to_string();
    let rev = valid_rev(&rev)?;
    docs(Feature::History, &["page", "diff", &id, rev]).await
}

#[tauri::command]
pub async fn page_restore(app: AppHandle, page_id: i64, sha: String) -> Result<Value, Problem> {
    let id = page_id.to_string();
    let sha = valid_rev(&sha)?;
    let result = docs::<Value>(Feature::History, &["page", "restore", &id, sha]).await?;
    crate::shell::mark_docs_stale(&app);
    Ok(result)
}

#[tauri::command]
pub async fn proposal_accept(
    app: AppHandle,
    meeting_id: String,
    n: i64,
    markdown: Option<String>,
) -> Result<Proposal, Problem> {
    let meeting = valid_meeting(&meeting_id)?;
    let number = n.to_string();
    let edited = match markdown.filter(|text| !text.trim().is_empty()) {
        Some(text) => {
            let path = std::env::temp_dir().join(format!("bita-proposal-{}-{meeting}-{n}.md", std::process::id()));
            std::fs::write(&path, text).map_err(|error| {
                Problem::new(ProblemKind::Unreadable, format!("No pude guardar el texto editado: {error}"))
            })?;
            Some(path)
        }
        None => None,
    };
    let path_text = edited.as_ref().map(|path| path.display().to_string());
    let mut args = vec!["proposals", "accept", meeting, number.as_str()];
    if let Some(path) = path_text.as_deref() {
        args.push("--md");
        args.push(path);
    }
    let outcome = recap(&args, RECAP_TIMEOUT).await;
    if let Some(path) = edited {
        let _ = std::fs::remove_file(path);
    }
    let proposal = proposal_of(outcome?)?;
    crate::shell::mark_docs_stale(&app);
    Ok(proposal)
}

pub fn detail_of(data: Value) -> Result<ProposalDetail, Problem> {
    let markdown = data.get("markdown").and_then(Value::as_str).map(str::to_string);
    Ok(ProposalDetail {
        proposal: proposal_of(data)?,
        markdown,
    })
}

#[tauri::command]
pub async fn proposal_show(meeting_id: String, n: i64) -> Result<ProposalDetail, Problem> {
    let meeting = valid_meeting(&meeting_id)?;
    let number = n.to_string();
    let data = recap(&["proposals", "show", meeting, &number], RECAP_TIMEOUT).await?;
    detail_of(data)
}

#[tauri::command]
pub async fn proposal_reject(meeting_id: String, n: i64) -> Result<Proposal, Problem> {
    let meeting = valid_meeting(&meeting_id)?;
    let number = n.to_string();
    let data = recap(&["proposals", "reject", meeting, &number], RECAP_TIMEOUT).await?;
    proposal_of(data)
}

#[tauri::command]
pub async fn pending_proposals() -> Result<Vec<PendingMeeting>, Problem> {
    let list = match docs::<BranchList>(Feature::Proposals, &["branch", "ls"]).await {
        Ok(list) => list,
        Err(_) => return Ok(Vec::new()),
    };
    let mut pending = Vec::new();
    for entry_id in list.branches.iter().filter_map(|branch| proposal_entry(&branch.name)) {
        let entry = entry_id.to_string();
        let Ok(data) = recap_call(&["show", "--bita-entry", &entry], SHOW_TIMEOUT).await else {
            continue;
        };
        let proposals = pending_only(extras_of(&data).proposals);
        if proposals.is_empty() {
            continue;
        }
        pending.push(PendingMeeting {
            entry_id,
            meeting_id: data.get("id").and_then(Value::as_str).map(str::to_string),
            title: data
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Reunión")
                .to_string(),
            ended_at: ended_at(&data),
            proposals,
        });
    }
    pending.sort_by(|left, right| right.ended_at.cmp(&left.ended_at));
    Ok(pending)
}

#[cfg(test)]
mod tests {
    use super::{
        detail_of, ended_at, extras_of, pending_only, proposal_entry, proposal_of, valid_branch, valid_rev,
        BranchDiff, PageDiff, PageHistory,
    };
    use serde_json::json;

    fn show_payload() -> serde_json::Value {
        json!({
            "id": "2026-10-08-1000-seguimiento",
            "title": "Seguimiento CoDi · QA",
            "startedAt": "2026-10-08T16:00:00Z",
            "durationSeconds": 2820,
            "liveTranscript": "/Users/x/Recap/m/live/transcript.jsonl",
            "answers": [
                {"id": "a1", "askedAt": "2026-10-08T16:23:31Z", "question": "¿Cómo se corre el simulador?", "answer": "Con `pnpm sim:webhook`.", "found": true,
                 "sources": [{"kind": "page", "label": "CoDi › Ambientes bajos", "pageId": 42}]},
                {"broken": true}
            ],
            "proposals": [
                {"n": 1, "pageId": 42, "pageTitle": "Reglas de negocio", "section": "Límites", "title": "Subir el tope a 10,000 MXN en producción",
                 "rationale": "Se acordó en la reunión", "quotes": [{"startMs": 242000, "channel": "system", "text": "lo vamos a subir a 10 mil"}],
                 "branch": "proposal/meeting-733", "sha": "a1c9e04f", "status": "pending"},
                {"n": 2, "pageId": 43, "pageTitle": "Ambientes bajos", "section": null, "title": "Los CNAME los crea infraestructura",
                 "rationale": "", "quotes": [], "branch": "proposal/meeting-733", "sha": "b2d0f15e", "status": "accepted", "appliedSha": "c3e1a26f"}
            ]
        })
    }

    #[test]
    fn a_meeting_brings_its_live_answers_and_proposals() {
        let extras = extras_of(&show_payload());
        assert_eq!(extras.answers.len(), 1);
        assert_eq!(extras.answers[0].sources[0].page_id, Some(42));
        assert_eq!(extras.proposals.len(), 2);
        assert_eq!(extras.proposals[0].quotes[0].start_ms, 242_000);
        assert_eq!(extras.proposals[1].applied_sha.as_deref(), Some("c3e1a26f"));
        assert!(extras_of(&json!({"id": "old"})).proposals.is_empty());
    }

    #[test]
    fn only_pending_proposals_count_for_the_panel() {
        let pending = pending_only(extras_of(&show_payload()).proposals);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].n, 1);
    }

    #[test]
    fn a_meeting_ends_when_it_stopped_or_after_its_duration() {
        assert_eq!(ended_at(&show_payload()).as_deref(), Some("2026-10-08T16:47:00+00:00"));
        assert_eq!(
            ended_at(&json!({"stoppedAt": "2026-10-08T17:00:00Z"})).as_deref(),
            Some("2026-10-08T17:00:00Z")
        );
        assert_eq!(ended_at(&json!({})), None);
    }

    #[test]
    fn proposal_branches_name_their_entry() {
        assert_eq!(proposal_entry("proposal/meeting-733"), Some(733));
        assert_eq!(proposal_entry("proposal/meeting-x"), None);
        assert_eq!(proposal_entry("variant/codi"), None);
    }

    #[test]
    fn accept_and_reject_answer_with_the_proposal() {
        let wrapped = proposal_of(json!({"proposal": {"n": 3, "pageId": 9, "title": "t", "status": "stale"}})).expect("wrapped");
        assert_eq!(wrapped.status, "stale");
        let bare = proposal_of(json!({"n": 3, "pageId": 9, "title": "t", "status": "rejected"})).expect("bare");
        assert_eq!(bare.status, "rejected");
        assert!(proposal_of(json!({"nope": true})).is_err());
    }

    #[test]
    fn a_proposal_detail_brings_the_markdown_to_edit() {
        let detail = detail_of(json!({
            "proposal": {"n": 1, "pageId": 42, "pageTitle": "Reglas", "section": "Límites", "title": "t", "rationale": "r",
                         "quotes": [], "branch": "proposal/meeting-733", "sha": "a1c9e04f", "status": "pending",
                         "file": "/Users/x/Recap/m/proposals/1.md", "updatedAt": "2026-10-08T17:00:00Z"},
            "markdown": "- Tope por operación: 10,000 MXN.\n",
            "diff": null
        }))
        .expect("detail");
        assert_eq!(detail.proposal.file.as_deref(), Some("/Users/x/Recap/m/proposals/1.md"));
        assert!(detail.markdown.expect("markdown").contains("10,000"));
    }

    #[test]
    fn a_branch_diff_carries_typed_hunks() {
        let diff: BranchDiff = serde_json::from_value(json!({
            "branch": "proposal/meeting-733",
            "commits": [{
                "sha": "a1c9e04f", "pageId": 42, "path": "codi/reglas-de-negocio.md", "reason": "Se acordó",
                "diff": "@@ -1,3 +1,4 @@",
                "hunks": [{"header": "@@ -1,3 +1,4 @@", "lines": [
                    {"kind": "context", "text": "## Límites", "oldLine": 1, "newLine": 1},
                    {"kind": "del", "text": "- Tope por operación: 8,000 MXN.", "oldLine": 2, "newLine": null},
                    {"kind": "add", "text": "- Tope por operación: 10,000 MXN en producción.", "oldLine": null, "newLine": 2}
                ]}]
            }]
        }))
        .expect("diff");
        let lines = &diff.commits[0].hunks[0].lines;
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1].kind, "del");
        assert_eq!(lines[1].new_line, None);
        assert_eq!(lines[2].new_line, Some(2));
    }

    #[test]
    fn a_page_history_lists_revisions_with_their_source() {
        let history: PageHistory = serde_json::from_value(json!({
            "pageId": 42,
            "path": "codi/reglas-de-negocio.md",
            "revisions": [
                {"sha": "c3e1a26f", "date": "2026-10-08T17:02:00Z", "subject": "docs(codi): update reglas de negocio", "source": "meeting", "reason": "Límites: tope 10,000 MXN", "entryId": 733},
                {"sha": "9f8e7d6c", "date": "2026-10-05T23:30:00Z", "subject": "docs(codi): pull from confluence", "source": "confluence-pull", "reason": null, "entryId": null},
                {"sha": "1a2b3c4d", "date": "2026-09-30T14:14:00Z", "subject": "chore: import existing bita docs"}
            ]
        }))
        .expect("history");
        assert_eq!(history.revisions.len(), 3);
        assert_eq!(history.revisions[0].entry_id, Some(733));
        assert_eq!(history.revisions[1].source, "confluence-pull");
        assert_eq!(history.revisions[2].source, "unknown");
    }

    #[test]
    fn a_page_diff_can_point_at_the_working_tree() {
        let diff: PageDiff = serde_json::from_value(json!({
            "pageId": 42, "from": "9f8e7d6c", "to": "worktree", "diff": "", "hunks": []
        }))
        .expect("diff");
        assert_eq!(diff.to, "worktree");
        assert!(diff.hunks.is_empty());
    }

    #[test]
    fn revisions_and_branches_cannot_smuggle_flags() {
        assert!(valid_rev("a1c9e04").is_ok());
        assert!(valid_rev("--all").is_err());
        assert!(valid_rev("HEAD").is_err());
        assert!(valid_branch("proposal/meeting-733").is_ok());
        assert!(valid_branch("--force").is_err());
        assert!(valid_branch("a/../b").is_err());
    }
}
