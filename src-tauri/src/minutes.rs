use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::meeting::{inside, meeting_id, Segment};
use crate::model::{Problem, ProblemKind};
use crate::pdf::{create_unique, sanitize_with};
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
    let id = meeting_id(&id)?;
    let data = recap_call(&["transcript", id], CALL_TIMEOUT).await.map_err(Problem::from)?;
    read_transcript(data)
}

#[tauri::command]
pub async fn meeting_summary(id: String) -> Result<MeetingSummary, Problem> {
    let id = meeting_id(&id)?;
    let data = recap_call(&["summary", id], CALL_TIMEOUT).await.map_err(Problem::from)?;
    read_summary(data)
}

const DOWNLOADABLE: [&str; 3] = ["m4a", "mov", "mp4"];

#[derive(Debug, Deserialize)]
struct Located {
    dir: String,
    #[serde(default)]
    recording: Option<String>,
}

fn not_downloadable(message: impl Into<String>) -> Problem {
    Problem::new(ProblemKind::CliFailed, message)
}

pub(crate) fn recording_extension(recording: &std::path::Path) -> Option<String> {
    recording
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| DOWNLOADABLE.contains(&extension.as_str()))
}

pub(crate) fn locate_recording(data: Value) -> Result<PathBuf, Problem> {
    let located: Located = serde_json::from_value(data).map_err(unreadable)?;
    let folder = PathBuf::from(&located.dir);
    if !folder.is_absolute() || !folder.join("meeting.json").is_file() {
        return Err(not_downloadable("La reunión ya no tiene su carpeta en este equipo."));
    }
    let source = located
        .recording
        .as_deref()
        .and_then(|recording| inside(&folder, recording))
        .filter(|path| path.is_file())
        .ok_or_else(|| not_downloadable("La grabación ya no está en este equipo."))?;
    if recording_extension(&source).is_none() {
        return Err(not_downloadable("Solo se descargan grabaciones m4a, mov o mp4."));
    }
    Ok(source)
}

pub(crate) fn copy_to_downloads(downloads: &std::path::Path, title: &str, source: &std::path::Path) -> Result<PathBuf, Problem> {
    let extension = recording_extension(source).ok_or_else(|| not_downloadable("Solo se descargan grabaciones m4a, mov o mp4."))?;
    let stem = sanitize_with(if title.trim().is_empty() { DEFAULT_STEM } else { title }, &extension);
    let (target, mut file) = create_unique(downloads, &stem, &extension)
        .map_err(|error| not_downloadable(format!("No pude crear la copia en {}: {error}", downloads.display())))?;
    let mut input = std::fs::File::open(source)
        .map_err(|error| not_downloadable(format!("No pude leer la grabación: {error}")))?;
    std::io::copy(&mut input, &mut file).map_err(|error| {
        let _ = std::fs::remove_file(&target);
        not_downloadable(format!("No pude copiar la grabación: {error}"))
    })?;
    Ok(target)
}

#[tauri::command]
pub async fn meeting_download(id: String, title: String) -> Result<String, Problem> {
    let id = meeting_id(&id)?;
    let data = recap_call(&["show", id], CALL_TIMEOUT).await.map_err(Problem::from)?;
    let source = locate_recording(data)?;
    crate::report_export::save_to_downloads(move |downloads| {
        std::fs::create_dir_all(downloads).map_err(|error| {
            Problem::new(ProblemKind::CliFailed, format!("No pude preparar {}: {error}", downloads.display()))
        })?;
        copy_to_downloads(downloads, &title, &source)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{copy_to_downloads, locate_recording, meeting_id, read_summary, read_transcript, ActionItem};
    use serde_json::json;

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
        assert!(meeting_id("2026-10-24-daily").is_ok());
        assert!(meeting_id("--json").is_err());
        assert!(meeting_id("a b").is_err());
        assert!(meeting_id("").is_err());
    }

    #[test]
    fn the_download_takes_the_title_and_the_recording_extension() {
        let dir = std::env::temp_dir().join(format!("den-minutes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let meeting = dir.join("meeting");
        let downloads = dir.join("downloads");
        std::fs::create_dir_all(&meeting).expect("meeting");
        std::fs::create_dir_all(&downloads).expect("downloads");
        std::fs::write(meeting.join("meeting.json"), "{}").expect("meta");
        std::fs::write(meeting.join("recording.MOV"), b"video").expect("recording");
        let source = locate_recording(json!({"dir": meeting.display().to_string(), "recording": "recording.MOV"})).expect("source");
        let first = copy_to_downloads(&downloads, "Daily: Viva", &source).expect("first");
        assert_eq!(first, downloads.join("Daily- Viva.mov"));
        assert_eq!(std::fs::read(&first).expect("copy"), b"video");
        assert_eq!(copy_to_downloads(&downloads, "Daily: Viva", &source).expect("second"), downloads.join("Daily- Viva (2).mov"));
        assert_eq!(copy_to_downloads(&downloads, " ", &source).expect("blank"), downloads.join("reunion.mov"));
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn only_recordings_inside_a_recap_folder_with_known_extensions_download() {
        let dir = std::env::temp_dir().join(format!("den-minutes-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let meeting = dir.join("meeting");
        std::fs::create_dir_all(&meeting).expect("meeting");
        std::fs::write(meeting.join("meeting.json"), "{}").expect("meta");
        std::fs::write(meeting.join("notes.txt"), "x").expect("notes");
        std::fs::write(dir.join("outside.m4a"), "x").expect("outside");
        let at = |recording: &str| json!({"dir": meeting.display().to_string(), "recording": recording});
        assert!(locate_recording(at("notes.txt")).is_err());
        assert!(locate_recording(at("../outside.m4a")).is_err());
        assert!(locate_recording(at(&dir.join("outside.m4a").display().to_string())).is_err());
        assert!(locate_recording(json!({"dir": "relative", "recording": "a.m4a"})).is_err());
        assert!(locate_recording(json!({"dir": dir.display().to_string(), "recording": "outside.m4a"})).is_err());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
