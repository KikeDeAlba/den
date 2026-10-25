use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::model::{Problem, ProblemKind};
use crate::notes_cmd::base64;
use crate::recap::recap_call;

const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const FRAMES_MAX: usize = 60;
const FRAME_MAX_BYTES: u64 = 4 * 1024 * 1024;
const VIDEO_EXTENSIONS: [&str; 3] = ["mp4", "mov", "m4v"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    title: String,
    mode: String,
    status: String,
    dir: String,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    duration_seconds: Option<i64>,
    #[serde(default)]
    recording: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    transcript_segments: Option<String>,
    #[serde(default)]
    frames: Option<String>,
    #[serde(default)]
    has_video: Option<bool>,
    #[serde(default)]
    storage: Option<MeetingStorage>,
    #[serde(default)]
    video: Option<VideoInfo>,
    #[serde(default)]
    video_removed_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStorage {
    #[serde(default)]
    pub recording_bytes: u64,
    #[serde(default)]
    pub intermediate_bytes: u64,
    #[serde(default)]
    pub frames_bytes: u64,
    #[serde(default)]
    pub other_bytes: u64,
    #[serde(default)]
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub compressed_at: String,
    pub preset: String,
    #[serde(default)]
    pub original_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub channel: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameInfo {
    file: String,
    time_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub time_seconds: f64,
    pub src: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingView {
    pub id: String,
    pub title: String,
    pub mode: String,
    pub status: String,
    pub dir: String,
    pub started_at: Option<String>,
    pub duration_seconds: Option<i64>,
    pub recording: Option<String>,
    pub summary_markdown: Option<String>,
    pub segments: Vec<Segment>,
    pub frames: Vec<Frame>,
    pub has_video: bool,
    pub storage: Option<MeetingStorage>,
    pub video: Option<VideoInfo>,
    pub video_removed_at: Option<String>,
    pub answers: Vec<crate::ask::Answer>,
    pub proposals: Vec<crate::proposals::Proposal>,
}

pub(crate) fn meeting_id(id: &str) -> Result<&str, Problem> {
    let ok = !id.is_empty()
        && !id.starts_with('-')
        && id != "."
        && id != ".."
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(id)
    } else {
        Err(Problem::new(ProblemKind::CliFailed, format!("«{id}» no es el id de una reunión.")))
    }
}

pub(crate) fn inside(dir: &Path, path: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(path);
    let resolved = if candidate.is_absolute() { candidate } else { dir.join(candidate) };
    let canonical = std::fs::canonicalize(&resolved).ok()?;
    let root = std::fs::canonicalize(dir).ok()?;
    canonical.starts_with(&root).then_some(canonical)
}

fn read_frames(dir: &Path, index: &Path) -> Vec<Frame> {
    let Ok(text) = std::fs::read_to_string(index) else {
        return Vec::new();
    };
    let Ok(infos) = serde_json::from_str::<Vec<FrameInfo>>(&text) else {
        return Vec::new();
    };
    infos
        .into_iter()
        .take(FRAMES_MAX)
        .filter_map(|info| {
            let path = inside(dir, &info.file)?;
            let size = std::fs::metadata(&path).ok()?.len();
            if size > FRAME_MAX_BYTES {
                return None;
            }
            let bytes = std::fs::read(&path).ok()?;
            Some(Frame {
                time_seconds: info.time_seconds,
                src: format!("data:image/jpeg;base64,{}", base64(&bytes)),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn meeting_for_entry(app: AppHandle, entry_id: i64) -> Result<Option<MeetingView>, Problem> {
    let entry = entry_id.to_string();
    view_of(&app, &["show", "--bita-entry", &entry]).await
}

#[tauri::command]
pub async fn meeting_by_id(app: AppHandle, id: String) -> Result<Option<MeetingView>, Problem> {
    let id = meeting_id(&id)?;
    view_of(&app, &["show", id]).await
}

async fn view_of(app: &AppHandle, args: &[&str]) -> Result<Option<MeetingView>, Problem> {
    let data = match recap_call(args, CALL_TIMEOUT).await {
        Ok(data) => data,
        Err(error) if error.is_not_found() => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if data.is_null() {
        return Ok(None);
    }
    let extras = crate::proposals::extras_of(&data);
    let record: Record = serde_json::from_value(data).map_err(|error| {
        Problem::new(ProblemKind::Unreadable, format!("No entiendo la respuesta de recap: {error}"))
    })?;
    let dir = PathBuf::from(&record.dir);
    if !dir.join("meeting.json").is_file() {
        return Ok(None);
    }

    let summary_markdown = record
        .summary
        .as_deref()
        .and_then(|path| inside(&dir, path))
        .and_then(|path| std::fs::read_to_string(path).ok());

    let segments = record
        .transcript_segments
        .as_deref()
        .and_then(|path| inside(&dir, path))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Vec<Segment>>(&text).ok())
        .unwrap_or_default();

    let frames = record
        .frames
        .as_deref()
        .and_then(|path| inside(&dir, path))
        .map(|path| read_frames(&dir, &path))
        .unwrap_or_default();

    let recording = record.recording.as_deref().and_then(|path| inside(&dir, path));
    if let Some(path) = &recording {
        let _ = app.asset_protocol_scope().allow_file(path);
    }

    let has_video = record.has_video.unwrap_or_else(|| recording.as_deref().is_some_and(is_video_file));

    Ok(Some(MeetingView {
        id: record.id,
        title: record.title,
        mode: record.mode,
        status: record.status,
        dir: dir.display().to_string(),
        started_at: record.started_at,
        duration_seconds: record.duration_seconds,
        recording: recording.map(|path| path.display().to_string()),
        summary_markdown,
        segments,
        frames,
        has_video,
        storage: record.storage,
        video: record.video,
        video_removed_at: record.video_removed_at,
        answers: extras.answers,
        proposals: extras.proposals,
    }))
}

pub(crate) fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| VIDEO_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
}

#[tauri::command]
pub async fn open_meeting_folder(dir: String) -> Result<(), Problem> {
    let path = PathBuf::from(&dir);
    if !path.is_absolute() || !path.join("meeting.json").is_file() {
        return Err(Problem::new(
            ProblemKind::CliFailed,
            format!("{dir} no es la carpeta de una reunión de recap."),
        ));
    }
    crate::platform::open_path(&path)
        .map_err(|error| Problem::new(ProblemKind::CliFailed, format!("No pude abrir la carpeta: {error}")))
}

#[cfg(test)]
mod tests {
    use super::{inside, is_video_file, meeting_id};
    use std::fs;
    use std::path::Path;

    #[test]
    fn one_validator_accepts_recap_ids_and_rejects_paths_and_flags() {
        assert!(meeting_id("2026-10-06-1530-standup").is_ok());
        assert!(meeting_id("2026.10.06_daily").is_ok());
        for bad in ["", "-x", "--json", ".", "..", "../x", "a/b", "a\\b", "a b", "/abs"] {
            assert!(meeting_id(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn only_video_containers_count_as_video() {
        assert!(is_video_file(Path::new("/x/recording.mp4")));
        assert!(is_video_file(Path::new("/x/recording.MOV")));
        assert!(!is_video_file(Path::new("/x/recording.m4a")));
        assert!(!is_video_file(Path::new("/x/recording")));
    }

    #[test]
    fn only_files_inside_the_meeting_folder_are_read() {
        let root = std::env::temp_dir().join(format!("bita-meeting-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("frames")).expect("frames");
        fs::write(root.join("summary.md"), "## Resumen").expect("summary");
        fs::write(root.join("frames/00-00-00.jpg"), "jpg").expect("frame");

        assert!(inside(&root, "summary.md").is_some());
        assert!(inside(&root, "frames/00-00-00.jpg").is_some());
        assert!(inside(&root, &root.join("summary.md").display().to_string()).is_some());
        assert!(inside(&root, "../etc/passwd").is_none());
        assert!(inside(&root, "/etc/hosts").is_none());
        assert!(inside(&root, "missing.md").is_none());
        let _ = fs::remove_dir_all(&root);
    }
}
