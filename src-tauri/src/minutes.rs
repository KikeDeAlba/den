use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::meeting::{inside, Segment};
use crate::model::{Problem, ProblemKind};
use crate::pdf::{sanitize_with, unique_path_with};
use crate::recap::recap_call;

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_STEM: &str = "reunion";

#[derive(Debug, Deserialize)]
struct RawSegment {
    start: f64,
    end: f64,
    #[serde(default)]
    channel: String,
    #[serde(default)]
    text: String,
}

#[derive(Debug, Deserialize)]
struct RawParagraph {
    start: f64,
    #[serde(default)]
    channel: String,
    #[serde(default)]
    speaker: Option<String>,
    #[serde(default)]
    text: String,
}

#[derive(Debug, Deserialize)]
struct RawTranscript {
    #[serde(default)]
    segments: Vec<RawSegment>,
    #[serde(default)]
    paragraphs: Vec<RawParagraph>,
    #[serde(default)]
    channels: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
    pub start_ms: i64,
    pub channel: String,
    pub speaker: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranscript {
    pub segments: Vec<Segment>,
    pub paragraphs: Vec<Paragraph>,
    pub channels: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSummary {
    #[serde(default)]
    markdown: String,
    #[serde(default)]
    agreements: Vec<Value>,
    #[serde(default)]
    action_items: Vec<RawActionItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawActionItem {
    #[serde(default)]
    text: String,
    #[serde(default)]
    backlog_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItem {
    pub text: String,
    pub backlog_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSummary {
    pub markdown: String,
    pub agreements: Vec<String>,
    pub action_items: Vec<ActionItem>,
}

fn millis(seconds: f64) -> i64 {
    if seconds.is_finite() {
        (seconds.max(0.0) * 1000.0).round() as i64
    } else {
        0
    }
}

fn unreadable(error: impl std::fmt::Display) -> Problem {
    Problem::new(ProblemKind::Unreadable, format!("No entiendo la respuesta de recap: {error}"))
}

fn valid_id(id: &str) -> Result<&str, Problem> {
    let ok = !id.is_empty()
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(id)
    } else {
        Err(Problem::new(ProblemKind::CliFailed, format!("«{id}» no es el id de una reunión.")))
    }
}

pub(crate) fn read_transcript(data: Value) -> Result<MeetingTranscript, Problem> {
    let raw: RawTranscript = serde_json::from_value(data).map_err(unreadable)?;
    Ok(MeetingTranscript {
        segments: raw
            .segments
            .into_iter()
            .map(|segment| Segment {
                start_ms: millis(segment.start),
                end_ms: millis(segment.end),
                channel: segment.channel,
                text: segment.text.trim().to_string(),
            })
            .collect(),
        paragraphs: raw
            .paragraphs
            .into_iter()
            .map(|paragraph| Paragraph {
                start_ms: millis(paragraph.start),
                channel: paragraph.channel,
                speaker: paragraph.speaker.filter(|name| !name.trim().is_empty()),
                text: paragraph.text.trim().to_string(),
            })
            .collect(),
        channels: raw.channels,
    })
}

fn agreement_text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.as_str(),
        Value::Object(map) => map.get("text").and_then(Value::as_str)?,
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

pub(crate) fn read_summary(data: Value) -> Result<MeetingSummary, Problem> {
    let raw: RawSummary = serde_json::from_value(data).map_err(unreadable)?;
    Ok(MeetingSummary {
        markdown: raw.markdown,
        agreements: raw.agreements.iter().filter_map(agreement_text).collect(),
        action_items: raw
            .action_items
            .into_iter()
            .filter(|item| !item.text.trim().is_empty())
            .map(|item| ActionItem {
                text: item.text.trim().to_string(),
                backlog_key: item.backlog_key.filter(|key| !key.trim().is_empty()),
            })
            .collect(),
    })
}

#[tauri::command]
pub async fn meeting_transcript(id: String) -> Result<MeetingTranscript, Problem> {
    let id = valid_id(&id)?;
    let data = recap_call(&["transcript", id], CALL_TIMEOUT).await.map_err(Problem::from)?;
    read_transcript(data)
}

#[tauri::command]
pub async fn meeting_summary(id: String) -> Result<MeetingSummary, Problem> {
    let id = valid_id(&id)?;
    let data = recap_call(&["summary", id], CALL_TIMEOUT).await.map_err(Problem::from)?;
    read_summary(data)
}

pub(crate) fn download_target(
    downloads: &std::path::Path,
    title: &str,
    recording: &std::path::Path,
) -> PathBuf {
    let extension = recording
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("m4a")
        .to_ascii_lowercase();
    let stem = sanitize_with(if title.trim().is_empty() { DEFAULT_STEM } else { title }, &extension);
    unique_path_with(downloads, &stem, &extension)
}

#[tauri::command]
pub async fn meeting_download(dir: String, recording: String, title: String) -> Result<String, Problem> {
    let folder = PathBuf::from(&dir);
    if !folder.is_absolute() || !folder.join("meeting.json").is_file() {
        return Err(Problem::new(
            ProblemKind::CliFailed,
            format!("{dir} no es la carpeta de una reunión de recap."),
        ));
    }
    let source = inside(&folder, &recording)
        .filter(|path| path.is_file())
        .ok_or_else(|| Problem::new(ProblemKind::CliFailed, "La grabación ya no está en este equipo."))?;
    crate::report_export::save_to_downloads(move |downloads| {
        std::fs::create_dir_all(downloads).map_err(|error| {
            Problem::new(ProblemKind::CliFailed, format!("No pude preparar {}: {error}", downloads.display()))
        })?;
        let target = download_target(downloads, &title, &source);
        std::fs::copy(&source, &target).map_err(|error| {
            Problem::new(ProblemKind::CliFailed, format!("No pude copiar la grabación: {error}"))
        })?;
        Ok(target)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{download_target, read_summary, read_transcript, valid_id, ActionItem};
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn the_transcript_turns_seconds_into_milliseconds() {
        let transcript = read_transcript(json!({
            "segments": [{"start": 1.25, "end": 3.5, "channel": "mic", "text": " Hola "}],
            "paragraphs": [{"start": 61.0, "channel": "system", "speaker": "Ana", "text": "Buenas"}],
            "channels": ["mic", "system"]
        }))
        .expect("transcript");
        assert_eq!(transcript.segments[0].start_ms, 1250);
        assert_eq!(transcript.segments[0].end_ms, 3500);
        assert_eq!(transcript.segments[0].text, "Hola");
        assert_eq!(transcript.paragraphs[0].start_ms, 61_000);
        assert_eq!(transcript.paragraphs[0].speaker.as_deref(), Some("Ana"));
        assert_eq!(transcript.channels, json!(["mic", "system"]));
    }

    #[test]
    fn a_blank_speaker_is_no_speaker_and_missing_lists_are_empty() {
        let transcript = read_transcript(json!({
            "paragraphs": [{"start": 0, "channel": "mic", "speaker": "  ", "text": "x"}]
        }))
        .expect("transcript");
        assert!(transcript.segments.is_empty());
        assert_eq!(transcript.paragraphs[0].speaker, None);
    }

    #[test]
    fn a_transcript_without_times_is_unreadable() {
        assert!(read_transcript(json!({"segments": [{"text": "x"}]})).is_err());
    }

    #[test]
    fn the_summary_keeps_agreements_and_action_items_with_their_backlog_key() {
        let summary = read_summary(json!({
            "markdown": "## Resumen\nTodo bien",
            "agreements": ["Subir el viernes", {"text": "Revisar OIDC"}, "  ", 3],
            "actionItems": [
                {"text": "Alarma de cierre", "backlogKey": "STI-19"},
                {"text": "Sin clave"},
                {"text": " ", "backlogKey": "X-1"}
            ]
        }))
        .expect("summary");
        assert_eq!(summary.markdown, "## Resumen\nTodo bien");
        assert_eq!(summary.agreements, vec!["Subir el viernes", "Revisar OIDC"]);
        assert_eq!(
            summary.action_items,
            vec![
                ActionItem { text: "Alarma de cierre".into(), backlog_key: Some("STI-19".into()) },
                ActionItem { text: "Sin clave".into(), backlog_key: None },
            ]
        );
    }

    #[test]
    fn meeting_ids_cannot_smuggle_flags() {
        assert!(valid_id("2026-10-24-daily").is_ok());
        assert!(valid_id("--json").is_err());
        assert!(valid_id("a b").is_err());
        assert!(valid_id("").is_err());
    }

    #[test]
    fn the_download_takes_the_title_and_the_recording_extension() {
        let dir = std::env::temp_dir().join(format!("den-minutes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let target = download_target(&dir, "Daily: Viva", Path::new("/x/recording.MOV"));
        assert_eq!(target, dir.join("Daily- Viva.mov"));
        std::fs::write(&target, b"x").expect("write");
        assert_eq!(download_target(&dir, "Daily: Viva", Path::new("/x/recording.mov")), dir.join("Daily- Viva (2).mov"));
        assert_eq!(download_target(&dir, " ", Path::new("/x/recording")), dir.join("reunion.m4a"));
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
