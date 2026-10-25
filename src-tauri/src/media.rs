use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::cli;
use crate::meeting::{inside, meeting_id};
use crate::model::{Problem, ProblemKind};
use crate::recap::{recap_binary, recap_call, RecapError};

pub const MEDIA_EVENT: &str = "bita://meeting-media-changed";

const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const COMPRESS_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const STRIP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const PRUNE_TIMEOUT: Duration = Duration::from_secs(60);
const PRESETS: [&str; 3] = ["light", "medium", "max"];
const CONTEXT_CHARS: usize = 60;
const MATCHES_PER_MEETING: usize = 20;

static JOBS: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaChange {
    pub id: String,
    pub ok: bool,
    pub error: Option<String>,
    pub record: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMatch {
    pub start_ms: Option<i64>,
    pub prefix: String,
    #[serde(rename = "match")]
    pub matched: String,
    pub suffix: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptHit {
    pub entry_id: i64,
    pub meeting_id: String,
    pub match_count: usize,
    pub matches: Vec<TranscriptMatch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub db_bytes: u64,
    pub docs_bytes: u64,
    pub recap_available: bool,
    pub meetings: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SegmentText {
    start_ms: i64,
    text: String,
}

pub(crate) fn valid_preset(preset: &str) -> Result<&str, Problem> {
    PRESETS
        .iter()
        .find(|known| **known == preset)
        .copied()
        .ok_or_else(|| Problem::new(ProblemKind::CliFailed, format!("No conozco el preset «{preset}».")))
}

pub async fn list_meetings() -> Result<Vec<Value>, RecapError> {
    let data = recap_call(&["list", "--limit", "0"], LIST_TIMEOUT).await?;
    Ok(match data {
        Value::Array(items) => items,
        Value::Object(ref map) => map
            .get("meetings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    })
}

#[tauri::command]
pub async fn recap_list() -> Result<Vec<Value>, Problem> {
    match list_meetings().await {
        Ok(items) => Ok(items),
        Err(RecapError::Missing) => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

fn fold_char(c: char) -> char {
    let lower = c.to_lowercase().next().unwrap_or(c);
    match lower {
        'á' | 'à' | 'ä' | 'â' | 'ã' => 'a',
        'é' | 'è' | 'ë' | 'ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
        'ú' | 'ù' | 'ü' | 'û' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        other => other,
    }
}

pub(crate) fn fold(text: &str) -> Vec<char> {
    text.chars().map(fold_char).collect()
}

fn squash(chars: &[char]) -> String {
    chars
        .iter()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn find_matches(text: &str, needle: &[char], start_ms: Option<i64>) -> Vec<TranscriptMatch> {
    if needle.is_empty() {
        return Vec::new();
    }
    let original: Vec<char> = text.chars().collect();
    let folded = fold(text);
    let mut found = Vec::new();
    let mut at = 0;
    while at + needle.len() <= folded.len() {
        if folded[at..at + needle.len()] == *needle {
            let end = at + needle.len();
            let from = at.saturating_sub(CONTEXT_CHARS);
            let to = (end + CONTEXT_CHARS).min(original.len());
            let mut prefix = squash(&original[from..at]);
            if at > 0 && original[at - 1].is_whitespace() {
                prefix.push(' ');
            }
            let mut suffix = squash(&original[end..to]);
            if end < original.len() && original[end].is_whitespace() {
                suffix.insert(0, ' ');
            }
            found.push(TranscriptMatch {
                start_ms,
                prefix,
                matched: original[at..end].iter().collect(),
                suffix,
            });
            at = end;
        } else {
            at += 1;
        }
    }
    found
}

fn transcript_matches(record: &Value, needle: &[char]) -> Vec<TranscriptMatch> {
    let Some(dir) = record.get("dir").and_then(Value::as_str).map(PathBuf::from) else {
        return Vec::new();
    };
    let segments = record
        .get("transcriptSegments")
        .and_then(Value::as_str)
        .and_then(|path| inside(&dir, path))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Vec<SegmentText>>(&text).ok());
    if let Some(segments) = segments {
        return segments
            .iter()
            .flat_map(|segment| find_matches(&segment.text, needle, Some(segment.start_ms)))
            .collect();
    }
    record
        .get("transcript")
        .and_then(Value::as_str)
        .and_then(|path| inside(&dir, path))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|text| text.lines().flat_map(|line| find_matches(line, needle, None)).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn search_transcripts(query: String, entry_ids: Vec<i64>) -> Result<Vec<TranscriptHit>, Problem> {
    let needle = fold(query.trim());
    if needle.is_empty() || entry_ids.is_empty() {
        return Ok(Vec::new());
    }
    let records = match list_meetings().await {
        Ok(items) => items,
        Err(RecapError::Missing) => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let wanted: HashSet<i64> = entry_ids.into_iter().collect();
    let hits = tauri::async_runtime::spawn_blocking(move || {
        records
            .iter()
            .filter_map(|record| {
                let entry_id = record.get("bitaEntryId").and_then(Value::as_i64)?;
                if !wanted.contains(&entry_id) {
                    return None;
                }
                let meeting_id = record.get("id").and_then(Value::as_str)?.to_string();
                let mut matches = transcript_matches(record, &needle);
                if matches.is_empty() {
                    return None;
                }
                let match_count = matches.len();
                matches.truncate(MATCHES_PER_MEETING);
                Some(TranscriptHit {
                    entry_id,
                    meeting_id,
                    match_count,
                    matches,
                })
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| Problem::new(ProblemKind::CliFailed, format!("La búsqueda se cayó: {error}")))?;
    Ok(hits)
}

struct Job(String);

impl Job {
    fn claim(id: &str) -> Result<Self, Problem> {
        let mut jobs = JOBS.lock().expect("jobs poisoned");
        if !jobs.insert(id.to_string()) {
            return Err(Problem::new(
                ProblemKind::CliFailed,
                "Ya hay un cambio en curso sobre el video de esa reunión.",
            ));
        }
        Ok(Self(id.to_string()))
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        JOBS.lock().expect("jobs poisoned").remove(&self.0);
    }
}

fn announce(app: &AppHandle, id: &str, outcome: &Result<Value, Problem>) {
    let change = match outcome {
        Ok(record) => MediaChange {
            id: id.to_string(),
            ok: true,
            error: None,
            record: Some(record.clone()),
        },
        Err(problem) => MediaChange {
            id: id.to_string(),
            ok: false,
            error: Some(problem.message.clone()),
            record: None,
        },
    };
    let _ = app.emit(MEDIA_EVENT, change);
}

pub(crate) fn media_args<'a>(action: &'a str, id: &'a str, preset: Option<&'a str>, prune: bool) -> Vec<&'a str> {
    let mut args = vec![action, id];
    if let Some(preset) = preset {
        args.push("--preset");
        args.push(preset);
    }
    if prune {
        args.push("--prune-intermediates");
    }
    args
}

#[tauri::command]
pub async fn meeting_compress(app: AppHandle, id: String, preset: String, prune: bool) -> Result<(), Problem> {
    meeting_id(&id)?;
    let preset = valid_preset(&preset)?.to_string();
    if recap_binary().is_none() {
        return Err(crate::recap::missing());
    }
    let job = Job::claim(&id)?;
    tauri::async_runtime::spawn(async move {
        let args = media_args("compress-video", &id, Some(&preset), prune);
        let outcome = recap_call(&args, COMPRESS_TIMEOUT).await.map_err(Problem::from);
        drop(job);
        announce(&app, &id, &outcome);
    });
    Ok(())
}

#[tauri::command]
pub async fn meeting_strip_video(app: AppHandle, id: String, prune: bool) -> Result<Value, Problem> {
    meeting_id(&id)?;
    let job = Job::claim(&id)?;
    let args = media_args("strip-video", &id, None, prune);
    let outcome = recap_call(&args, STRIP_TIMEOUT).await.map_err(Problem::from);
    drop(job);
    announce(&app, &id, &outcome);
    outcome
}

#[tauri::command]
pub async fn meeting_prune(id: String) -> Result<Value, Problem> {
    meeting_id(&id)?;
    let _job = Job::claim(&id)?;
    recap_call(&["prune", &id, "--intermediates"], PRUNE_TIMEOUT)
        .await
        .map_err(Problem::from)
}

#[tauri::command]
pub async fn meeting_delete(id: String) -> Result<Value, Problem> {
    meeting_id(&id)?;
    let _job = Job::claim(&id)?;
    recap_call(&["delete", &id], PRUNE_TIMEOUT).await.map_err(Problem::from)
}

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

pub(crate) fn tree_size(root: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(root) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    std::fs::read_dir(root)
        .map(|entries| entries.flatten().map(|entry| tree_size(&entry.path())).sum())
        .unwrap_or(0)
}

fn database_bytes(database: &Path) -> u64 {
    let mut total = file_size(database);
    for suffix in ["-wal", "-shm"] {
        let mut name = database.as_os_str().to_owned();
        name.push(suffix);
        total += file_size(Path::new(&name));
    }
    total
}

#[tauri::command]
pub async fn storage_report() -> Result<StorageReport, Problem> {
    let (db_bytes, docs_bytes) = tauri::async_runtime::spawn_blocking(|| {
        (database_bytes(&cli::database_path()), tree_size(&cli::docs_root()))
    })
    .await
    .map_err(|error| Problem::new(ProblemKind::CliFailed, format!("No pude medir el disco: {error}")))?;

    let (recap_available, meetings) = match list_meetings().await {
        Ok(items) => (true, items),
        Err(RecapError::Missing) => (false, Vec::new()),
        Err(error) => return Err(error.into()),
    };

    Ok(StorageReport {
        db_bytes,
        docs_bytes,
        recap_available,
        meetings,
    })
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), Problem> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() || !target.exists() {
        return Err(Problem::new(ProblemKind::CliFailed, format!("{path} no existe.")));
    }
    reveal(&target).await
}

pub async fn reveal(target: &Path) -> Result<(), Problem> {
    crate::platform::reveal(target).map_err(|error| {
        Problem::new(
            ProblemKind::CliFailed,
            format!("No pude mostrarlo en {}: {error}", crate::platform::file_manager_name()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{find_matches, fold, meeting_id, media_args, tree_size, valid_preset};
    use std::fs;

    #[test]
    fn folding_ignores_case_and_spanish_accents() {
        assert_eq!(fold("ÁrBOL Ñandú"), fold("arbol nandu"));
    }

    #[test]
    fn matches_keep_the_original_text_and_some_context() {
        let found = find_matches("Hablamos de la Migración del kernel", &fold("migracion"), Some(1200));
        assert_eq!(found.len(), 1);
        let first = &found[0];
        assert_eq!(first.matched, "Migración");
        assert_eq!(first.prefix, "Hablamos de la ");
        assert_eq!(first.suffix, " del kernel");
        assert_eq!(first.start_ms, Some(1200));
    }

    #[test]
    fn every_occurrence_is_found_and_context_is_bounded() {
        let text = format!("{}x{}x", "a".repeat(100), "b".repeat(100));
        let found = find_matches(&text, &fold("x"), None);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].prefix.chars().count(), 60);
        assert!(find_matches("abc", &[], None).is_empty());
    }

    #[test]
    fn only_known_presets_pass() {
        assert!(valid_preset("light").is_ok());
        assert!(valid_preset("medium").is_ok());
        assert!(valid_preset("max").is_ok());
        assert!(valid_preset("ultra").is_err());
    }

    #[test]
    fn meeting_ids_cannot_smuggle_flags() {
        assert!(meeting_id("2026-10-06-1530-standup").is_ok());
        assert!(meeting_id("--all").is_err());
        assert!(meeting_id("a b").is_err());
        assert!(meeting_id("../x").is_err());
    }

    #[test]
    fn media_arguments_add_the_preset_and_pruning_only_when_asked() {
        assert_eq!(
            media_args("compress-video", "m1", Some("max"), true),
            vec!["compress-video", "m1", "--preset", "max", "--prune-intermediates"]
        );
        assert_eq!(media_args("strip-video", "m1", None, false), vec!["strip-video", "m1"]);
    }

    #[test]
    fn a_tree_size_adds_every_file() {
        let root = std::env::temp_dir().join(format!("bita-size-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("a/b")).expect("dirs");
        fs::write(root.join("one"), [0u8; 10]).expect("one");
        fs::write(root.join("a/b/two"), [0u8; 5]).expect("two");
        assert_eq!(tree_size(&root), 15);
        let _ = fs::remove_dir_all(&root);
    }
}
