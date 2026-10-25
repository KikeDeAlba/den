use serde::{Deserialize, Serialize};

pub const SUPPORTED_SCHEMA: u32 = 3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope<T> {
    pub schema_version: u32,
    pub ok: bool,
    pub data: Option<T>,
    pub meta: Option<serde_json::Value>,
    pub error: Option<CliError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: i64,
    pub description: String,
    #[serde(default)]
    pub doc_rel_path: Option<String>,
    #[serde(default)]
    pub sections_written: Option<i64>,
    #[serde(default)]
    pub sections_total: Option<i64>,
    #[serde(default)]
    pub touched_since_note: Option<i64>,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub project_name: Option<String>,
    pub start: String,
    #[serde(default)]
    pub stop: Option<String>,
    pub start_local: String,
    pub local_day: String,
    pub duration_seconds: i64,
    pub duration_human: String,
    #[serde(default)]
    pub registered: bool,
    pub running: bool,
    #[serde(default)]
    pub kind: Option<String>,
}

impl Entry {
    pub fn is_draft(&self) -> bool {
        self.description.trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTimer {
    pub id: i64,
    pub title: Option<String>,
    pub doc_rel_path: Option<String>,
    pub sections_written: Option<i64>,
    pub sections_total: Option<i64>,
    pub touched_since_note: Option<i64>,
    pub project_name: Option<String>,
    pub project_id: Option<i64>,
    pub started_at: String,
    pub start_local: String,
    pub elapsed_seconds: i64,
    pub draft: bool,
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub running: Vec<LiveTimer>,
    pub today_seconds: i64,
    pub problem: Option<Problem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub kind: ProblemKind,
    pub message: String,
    #[serde(default)]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProblemKind {
    ToolMissing,
    CliTooOld,
    SchemaMismatch,
    CliFailed,
    Unreadable,
}

impl Problem {
    pub fn new(kind: ProblemKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            hint: None,
        }
    }

    pub fn with_hint(mut self, hint: Option<String>) -> Self {
        self.hint = hint;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub summary: String,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub project_name: Option<String>,
    pub total_seconds: i64,
    pub total_human: String,
    pub estimate_seconds: i64,
    pub estimate_human: String,
    pub entry_ids: Vec<i64>,
    pub days: Vec<String>,
    #[serde(default)]
    pub docs: Vec<serde_json::Value>,
    pub part_index: u32,
    pub part_count: u32,
    #[serde(default)]
    pub jira_project_key: Option<String>,
    #[serde(default = "goes_to_jira")]
    pub jira: bool,
    #[serde(default)]
    pub issue_key: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

pub fn goes_to_jira() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryData {
    pub total_seconds: i64,
    pub total_human: String,
    pub groups: Vec<Group>,
    #[serde(default)]
    pub jira_seconds: Option<i64>,
    #[serde(default)]
    pub non_jira_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NonJiraProject {
    #[serde(default)]
    pub name: Option<String>,
    pub total_seconds: i64,
    pub total_human: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NonJira {
    pub total_seconds: i64,
    pub total_human: String,
    #[serde(default)]
    pub projects: Vec<NonJiraProject>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlap {
    pub local_day: String,
    pub tracked_seconds: i64,
    pub clock_seconds: i64,
    pub overlap_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Excluded {
    pub id: i64,
    pub description: String,
    #[serde(default)]
    pub project_name: Option<String>,
    pub duration_human: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryMeta {
    #[serde(default)]
    pub overlaps: Vec<Overlap>,
    #[serde(default)]
    pub excluded: Vec<Excluded>,
    #[serde(default)]
    pub non_jira: Option<NonJira>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryView {
    pub total_seconds: i64,
    pub total_human: String,
    pub jira_seconds: i64,
    pub non_jira_seconds: i64,
    pub non_jira: Option<NonJira>,
    pub estimate_seconds: i64,
    pub groups: Vec<Group>,
    pub overlaps: Vec<Overlap>,
    pub excluded: Vec<Excluded>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub prefix: String,
    pub project_id: i64,
    pub project_name: String,
    pub slug_source: String,
}

#[cfg(test)]
mod tests {
    use super::{Entry, Envelope, SUPPORTED_SCHEMA};

    const RUNNING: &str = r#"{"schemaVersion":3,"ok":true,"command":"current","generatedAt":"2026-09-20T06:41:57.412Z","meta":{"runningCount":1},"data":[{"id":733,"externalId":null,"description":"Cognito developers: MFA y caducidad","projectId":222494997,"projectName":"Pharma STI","clientName":null,"billable":false,"registered":false,"issueKey":null,"start":"2026-09-20T05:48:20.380Z","stop":null,"startLocal":"2026-09-19T22:48:20-07:00","localDay":"2026-09-19","durationSeconds":3217,"durationHuman":"54m","durationHours":0.89,"startedJira":"2026-09-19T22:48:20.380-0700","running":true}]}"#;

    const REFUSED: &str = r#"{"schemaVersion":3,"ok":false,"command":"error","generatedAt":"2026-09-20T06:42:07.162Z","error":{"code":"REPO_NOT_MAPPED","message":"No project resolves for the repository.","hint":"bita repo init"}}"#;

    const USAGE: &str = r#"{"schemaVersion":3,"ok":false,"command":"error","generatedAt":"2026-09-20T06:42:07.162Z","error":{"code":"USAGE_ERROR","message":"Unknown command."}}"#;

    #[test]
    fn reads_a_running_timer_out_of_a_real_envelope() {
        let envelope: Envelope<Vec<Entry>> = serde_json::from_str(RUNNING).expect("parse");
        assert!(envelope.ok);
        assert_eq!(envelope.schema_version, SUPPORTED_SCHEMA);
        let entries = envelope.data.expect("data");
        let entry = entries.first().expect("one entry");
        assert_eq!(entry.id, 733);
        assert_eq!(entry.project_name.as_deref(), Some("Pharma STI"));
        assert!(entry.running);
        assert!(!entry.is_draft());
        assert!(envelope.meta.is_some());
    }

    #[test]
    fn a_refusal_carries_its_code_and_its_hint() {
        let envelope: Envelope<serde_json::Value> = serde_json::from_str(REFUSED).expect("parse");
        assert!(!envelope.ok);
        assert!(envelope.data.is_none());
        let error = envelope.error.expect("error");
        assert_eq!(error.code, "REPO_NOT_MAPPED");
        assert_eq!(error.hint.as_deref(), Some("bita repo init"));
    }

    #[test]
    fn a_refusal_without_a_hint_still_parses() {
        let envelope: Envelope<serde_json::Value> = serde_json::from_str(USAGE).expect("parse");
        let error = envelope.error.expect("error");
        assert_eq!(error.code, "USAGE_ERROR");
        assert!(error.hint.is_none());
    }

    #[test]
    fn an_entry_without_kind_parses_and_one_with_kind_keeps_it() {
        let envelope: Envelope<Vec<Entry>> = serde_json::from_str(RUNNING).expect("parse");
        assert!(envelope.data.expect("data")[0].kind.is_none());

        let with_kind = RUNNING.replace(r#""running":true}"#, r#""running":true,"kind":"remote-meeting"}"#);
        let envelope: Envelope<Vec<Entry>> = serde_json::from_str(&with_kind).expect("parse");
        assert_eq!(envelope.data.expect("data")[0].kind.as_deref(), Some("remote-meeting"));
    }

    #[test]
    fn an_empty_description_is_a_draft() {
        let envelope: Envelope<Vec<Entry>> = serde_json::from_str(RUNNING).expect("parse");
        let mut entry = envelope.data.expect("data").remove(0);
        entry.description = "   ".into();
        assert!(entry.is_draft());
    }

    const BITA_1_CURRENT: &str = r#"{"schemaVersion":3,"ok":true,"command":"current","generatedAt":"2026-10-10T23:00:32.773Z","meta":{"runningCount":1,"totalSeconds":0,"totalHuman":"0m"},"data":[{"id":2,"externalId":null,"description":"Revisar","projectId":1,"projectName":"Contrato","clientName":"Acme","billable":false,"start":"2026-10-10T23:00:32.693Z","stop":null,"startLocal":"2026-10-10T17:00:32-06:00","localDay":"2026-10-10","durationSeconds":0,"durationHuman":"0m","durationHours":0,"startedJira":"2026-10-10T17:00:32.693-0600","running":true,"mergedInto":null,"kind":null}]}"#;

    const BITA_1_ENTRIES: &str = r#"{"schemaVersion":3,"ok":true,"command":"entries","generatedAt":"2026-10-10T23:00:32.852Z","meta":{"range":{"fromDay":"2026-10-10","toDay":"2026-10-10","timezone":"America/Mexico_City"},"entryCount":2,"totalSeconds":1800,"totalHuman":"30m","overlaps":[],"warnings":[]},"data":[{"id":1,"externalId":null,"description":"Rotar el secreto","projectId":1,"projectName":"Contrato","clientName":"Acme","billable":false,"start":"2026-10-10T06:10:00.000Z","stop":"2026-10-10T06:40:00.000Z","startLocal":"2026-10-10T00:10:00-06:00","localDay":"2026-10-10","durationSeconds":1800,"durationHuman":"30m","durationHours":0.5,"startedJira":"2026-10-10T00:10:00.000-0600","running":false,"mergedInto":null,"kind":null,"segments":[]},{"id":2,"externalId":null,"description":"Revisar","projectId":1,"projectName":"Contrato","clientName":"Acme","billable":false,"start":"2026-10-10T23:00:32.693Z","stop":null,"startLocal":"2026-10-10T17:00:32-06:00","localDay":"2026-10-10","durationSeconds":0,"durationHuman":"0m","durationHours":0,"startedJira":"2026-10-10T17:00:32.693-0600","running":true,"mergedInto":null,"kind":null,"segments":[]}]}"#;

    #[test]
    fn bita_1_entries_without_registered_or_issue_key_parse() {
        let envelope: Envelope<Vec<Entry>> = serde_json::from_str(BITA_1_CURRENT).expect("current");
        assert_eq!(envelope.schema_version, SUPPORTED_SCHEMA);
        let running = envelope.data.expect("data").remove(0);
        assert!(running.running && !running.registered);
        assert_eq!(running.project_name.as_deref(), Some("Contrato"));

        let envelope: Envelope<Vec<Entry>> = serde_json::from_str(BITA_1_ENTRIES).expect("entries");
        let entries = envelope.data.expect("data");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].stop.as_deref(), Some("2026-10-10T06:40:00.000Z"));
        assert!(entries.iter().all(|entry| !entry.registered));
    }
}
