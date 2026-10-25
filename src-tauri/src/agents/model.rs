use serde::{Deserialize, Serialize};

pub const HARNESSES: [&str; 4] = ["claude", "opencode", "codex", "gemini"];
pub const NO_PROJECT: &str = "0";
pub const PASTE_START: &str = "\u{1b}[200~";
pub const PASTE_END: &str = "\u{1b}[201~";
pub const PROMPT_LIMIT: usize = 32 * 1024;
const PROJECT_NAME_LIMIT: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub project_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListing {
    pub id: i64,
    #[serde(default)]
    pub entry_id: Option<i64>,
    pub harness: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub wrapper_pid: i64,
    pub cwd: String,
    #[serde(default)]
    pub transcript_path: Option<String>,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    pub open: bool,
    pub resumable: bool,
    #[serde(default)]
    pub entry: Option<SessionEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirectory {
    pub cwd: String,
    pub last_used_at: String,
    pub sessions: i64,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub project_name: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub resume_session: Option<i64>,
    #[serde(default)]
    pub title: Option<String>,
}

pub fn is_harness(value: &str) -> bool {
    HARNESSES.contains(&value)
}

fn filled(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|text| !text.is_empty())
}

pub fn valid_project(value: &str) -> bool {
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        return true;
    }
    let count = value.chars().count();
    (1..=PROJECT_NAME_LIMIT).contains(&count)
        && value.chars().all(|letter| letter.is_alphanumeric() || matches!(letter, '_' | ' ' | '.' | '-'))
}

fn project_flag(value: &str) -> Result<String, String> {
    if valid_project(value) {
        Ok(format!("--project={value}"))
    } else {
        Err("El proyecto no es válido.".into())
    }
}

pub fn work_args(request: &SpawnRequest) -> Result<Vec<String>, String> {
    let mut args = vec!["work".to_string()];
    let project = filled(&request.project);
    if let Some(session) = request.resume_session {
        if session <= 0 {
            return Err("La sesión a retomar no es válida.".into());
        }
        args.extend(["--resume".into(), "--session".into(), session.to_string()]);
        if let Some(project) = project {
            args.push(project_flag(project)?);
        }
    } else {
        let harness = filled(&request.harness).ok_or("Elige un agente.")?;
        if !is_harness(harness) {
            return Err(format!("No conozco el agente «{harness}»."));
        }
        args.extend(["--harness".into(), harness.to_string()]);
        args.push(project_flag(project.unwrap_or(NO_PROJECT))?);
    }
    if let Some(prompt) = request.prompt.as_deref().filter(|text| !text.trim().is_empty()) {
        if prompt.len() > PROMPT_LIMIT {
            return Err("El primer mensaje es demasiado largo (máximo 32 KiB).".into());
        }
        args.push(format!("--prompt={prompt}"));
    }
    Ok(args)
}

pub fn clean_paste(text: &str) -> String {
    text.chars().filter(|letter| matches!(letter, '\n' | '\t') || !letter.is_control()).collect()
}

pub fn paste(text: &str, bracketed: bool) -> Vec<u8> {
    let clean = clean_paste(text);
    if bracketed {
        format!("{PASTE_START}{clean}{PASTE_END}\r").into_bytes()
    } else {
        format!("{}\r", clean.replace('\n', "\r")).into_bytes()
    }
}

pub fn message(text: &str, bracketed: bool) -> Option<Vec<u8>> {
    if clean_paste(text).trim().is_empty() {
        None
    } else {
        Some(paste(text, bracketed))
    }
}

pub fn linked(listings: &[SessionListing], pid: u32) -> Option<&SessionListing> {
    listings
        .iter()
        .filter(|listing| listing.open && listing.wrapper_pid == i64::from(pid))
        .max_by_key(|listing| listing.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Envelope;

    const LISTING: &str = r#"{"schemaVersion":3,"ok":true,"command":"sessions ls","data":[
        {"id":42,"entryId":131,"harness":"claude","sessionId":"abc","wrapperPid":4242,"cwd":"/tmp/den",
         "transcriptPath":null,"startedAt":"2026-10-25T10:00:00.000Z","endedAt":null,"open":true,"resumable":false,
         "entry":{"description":"","projectId":3,"projectName":"den"}},
        {"id":41,"entryId":128,"harness":"codex","sessionId":null,"wrapperPid":99,"cwd":"/tmp/viva",
         "transcriptPath":"/tmp/t.jsonl","startedAt":"2026-10-24T10:00:00.000Z","endedAt":"2026-10-24T11:00:00.000Z",
         "open":false,"resumable":true,"entry":{"description":"Conciliación","projectId":null,"projectName":null}}]}"#;

    const DIRS: &str = r#"{"schemaVersion":3,"ok":true,"command":"sessions dirs","data":[
        {"cwd":"/tmp/den","lastUsedAt":"2026-10-25T10:00:00.000Z","sessions":6,"projectId":3,"projectName":"den"},
        {"cwd":"/tmp/qa","lastUsedAt":"2026-10-20T10:00:00.000Z","sessions":1,"projectId":null,"projectName":null}]}"#;

    fn request() -> SpawnRequest {
        SpawnRequest {
            harness: Some("claude".into()),
            project: Some("3".into()),
            ..SpawnRequest::default()
        }
    }

    #[test]
    fn sessions_ls_parses_inside_the_envelope() {
        let envelope: Envelope<Vec<SessionListing>> = serde_json::from_str(LISTING).expect("listing");
        let data = envelope.data.expect("data");
        assert_eq!(data.len(), 2);
        assert_eq!(data[0].wrapper_pid, 4242);
        assert_eq!(data[0].entry.as_ref().and_then(|entry| entry.project_name.as_deref()), Some("den"));
        assert!(data[1].resumable && !data[1].open);
        assert_eq!(data[1].entry.as_ref().and_then(|entry| entry.project_id), None);
        assert_eq!(data[1].entry_id, Some(128));
    }

    #[test]
    fn a_session_without_a_timer_has_no_entry() {
        let raw = r#"{"schemaVersion":3,"ok":true,"command":"sessions ls","data":[
            {"id":7,"entryId":null,"harness":"claude","sessionId":"s","wrapperPid":5,"cwd":"/tmp/x","transcriptPath":null,
             "startedAt":"2026-10-25T10:00:00.000Z","endedAt":null,"open":true,"resumable":false,"entry":null},
            {"id":8,"harness":"codex","wrapperPid":6,"cwd":"/tmp/y","startedAt":"2026-10-25T10:00:00.000Z","open":false,"resumable":true}]}"#;
        let envelope: Envelope<Vec<SessionListing>> = serde_json::from_str(raw).expect("timerless");
        let data = envelope.data.expect("data");
        assert!(data.iter().all(|row| row.entry_id.is_none() && row.entry.is_none()));
        let value = serde_json::to_value(&data[0]).expect("json");
        assert!(value["entryId"].is_null() && value["entry"].is_null());
        assert_eq!(linked(&data, 5).map(|row| row.id), Some(7));
    }

    #[test]
    fn sessions_dirs_parses_inside_the_envelope() {
        let envelope: Envelope<Vec<SessionDirectory>> = serde_json::from_str(DIRS).expect("dirs");
        let data = envelope.data.expect("data");
        assert_eq!(data[0].sessions, 6);
        assert_eq!(data[1].project_name, None);
    }

    #[test]
    fn listings_serialize_back_in_camel_case() {
        let envelope: Envelope<Vec<SessionListing>> = serde_json::from_str(LISTING).expect("listing");
        let value = serde_json::to_value(&envelope.data.expect("data")[0]).expect("json");
        assert_eq!(value["wrapperPid"], 4242);
        assert_eq!(value["entry"]["projectName"], "den");
    }

    #[test]
    fn a_session_is_linked_only_by_an_open_row_with_its_pid() {
        let envelope: Envelope<Vec<SessionListing>> = serde_json::from_str(LISTING).expect("listing");
        let data = envelope.data.expect("data");
        assert_eq!(linked(&data, 4242).map(|row| row.id), Some(42));
        assert_eq!(linked(&data, 99), None);
        assert_eq!(linked(&data, 1), None);
    }

    #[test]
    fn a_new_session_names_harness_and_project() {
        assert_eq!(work_args(&request()).expect("args"), ["work", "--harness", "claude", "--project=3"]);
    }

    #[test]
    fn no_project_means_zero() {
        let mut plain = request();
        plain.project = None;
        assert_eq!(work_args(&plain).expect("args")[3], "--project=0");
    }

    #[test]
    fn the_prompt_always_rides_glued_to_its_flag() {
        let mut ask = request();
        ask.prompt = Some("--revisa esto".into());
        assert_eq!(work_args(&ask).expect("args").last().map(String::as_str), Some("--prompt=--revisa esto"));
        ask.prompt = Some("   ".into());
        assert!(!work_args(&ask).expect("args").iter().any(|arg| arg.starts_with("--prompt")));
    }

    #[test]
    fn resuming_names_the_session_and_skips_the_harness() {
        let resume = SpawnRequest {
            resume_session: Some(41),
            harness: Some("claude".into()),
            ..SpawnRequest::default()
        };
        assert_eq!(work_args(&resume).expect("args"), ["work", "--resume", "--session", "41"]);
    }

    #[test]
    fn unknown_or_missing_harnesses_are_refused() {
        let mut odd = request();
        odd.harness = Some("bash".into());
        assert!(work_args(&odd).is_err());
        odd.harness = None;
        assert!(work_args(&odd).is_err());
        let bad = SpawnRequest {
            resume_session: Some(0),
            ..SpawnRequest::default()
        };
        assert!(work_args(&bad).is_err());
    }

    #[test]
    fn projects_are_ids_or_plain_names() {
        assert!(valid_project("12"));
        assert!(valid_project("Den 2.0_beta-x"));
        assert!(valid_project("Conciliación"));
        assert!(!valid_project(""));
        assert!(!valid_project("--db-path=/tmp/x"));
        assert!(!valid_project("a;rm -rf"));
        assert!(!valid_project("x/y"));
        assert!(!valid_project(&"a".repeat(81)));
        assert!(valid_project(&"a".repeat(80)));
    }

    #[test]
    fn a_project_that_looks_like_a_flag_rides_glued_to_its_own() {
        let mut odd = request();
        odd.project = Some("-x".into());
        assert_eq!(work_args(&odd).expect("args")[3], "--project=-x");
        odd.project = Some("den\nrm".into());
        assert!(work_args(&odd).is_err());
        let resume = SpawnRequest {
            resume_session: Some(5),
            project: Some("a=b".into()),
            ..SpawnRequest::default()
        };
        assert!(work_args(&resume).is_err());
    }

    #[test]
    fn the_prompt_is_capped_at_32_kib() {
        let mut ask = request();
        ask.prompt = Some("a".repeat(PROMPT_LIMIT));
        assert!(work_args(&ask).is_ok());
        ask.prompt = Some("a".repeat(PROMPT_LIMIT + 1));
        assert!(work_args(&ask).is_err());
    }

    #[test]
    fn pasted_text_cannot_close_the_paste_early() {
        let bytes = paste("hola\u{1b}[201~rm -rf", true);
        let text = String::from_utf8(bytes).expect("utf8");
        assert_eq!(text, "\u{1b}[200~hola[201~rm -rf\u{1b}[201~\r");
    }

    #[test]
    fn a_nested_end_marker_cannot_be_rebuilt_by_the_cleanup() {
        let text = String::from_utf8(paste("a\u{1b}[20\u{1b}[201~1~b", true)).expect("utf8");
        let inner = text.strip_prefix(PASTE_START).and_then(|rest| rest.strip_suffix("\u{1b}[201~\r")).expect("framed");
        assert!(!inner.contains('\u{1b}'), "{inner:?}");
        assert!(!inner.contains(PASTE_END));
    }

    #[test]
    fn every_control_character_but_newline_and_tab_is_dropped() {
        assert_eq!(clean_paste("a\u{0}b\u{7}c\u{8}d\re\u{1b}f\u{7f}g\u{9b}h\ni\tj"), "abcdefgh\ni\tj");
    }

    #[test]
    fn a_message_that_cleans_down_to_nothing_sends_no_enter() {
        for text in ["", "   ", "\u{1b}", "\u{1b}\u{7}\u{9b}", " \u{3}\n\t "] {
            assert_eq!(message(text, true), None, "{text:?}");
            assert_eq!(message(text, false), None, "{text:?}");
        }
        assert_eq!(message("\u{1b}hola", false), Some(b"hola\r".to_vec()));
    }

    #[test]
    fn without_bracketed_mode_the_text_is_typed_plainly() {
        assert_eq!(paste("uno\ndos\u{1b}[A", false), b"uno\rdos[A\r");
    }
}
