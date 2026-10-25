use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

fn read(relative: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)).expect(relative)
}

fn registered() -> BTreeSet<String> {
    let main = read("src/main.rs");
    let start = main.find("generate_handler![").expect("handler");
    let end = start + main[start..].find("])").expect("handler end");
    main[start + "generate_handler![".len()..end]
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.rsplit("::").next().unwrap_or(part).to_string())
        .collect()
}

fn manifest() -> BTreeSet<String> {
    let build = read("build.rs");
    let start = build.find("COMMANDS: &[&str] = &[").expect("commands");
    let end = start + build[start..].find("];").expect("commands end");
    build[start..end]
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"')?.strip_suffix("\",").map(str::to_string))
        .collect()
}

fn permissions(capability: &str) -> BTreeSet<String> {
    let value: serde_json::Value = serde_json::from_str(&read(&format!("capabilities/{capability}.json"))).expect("json");
    value["permissions"]
        .as_array()
        .expect("permissions")
        .iter()
        .filter_map(|permission| permission.as_str())
        .map(str::to_string)
        .collect()
}

fn granted(capability: &str) -> BTreeSet<String> {
    permissions(capability)
        .iter()
        .filter_map(|permission| permission.strip_prefix("allow-"))
        .map(|command| command.replace('-', "_"))
        .collect()
}

#[test]
fn every_registered_command_has_a_generated_permission() {
    assert_eq!(manifest(), registered());
}

#[test]
fn capabilities_only_name_registered_commands() {
    let known = registered();
    for capability in ["main", "live"] {
        let unknown: Vec<_> = granted(capability).difference(&known).cloned().collect();
        assert!(unknown.is_empty(), "{capability} grants unknown commands: {unknown:?}");
    }
}

#[test]
fn the_live_window_gets_only_the_assistant_commands_and_no_core_default() {
    let live = granted("live");
    let expected: BTreeSet<String> = [
        "backlog_add",
        "copy_text",
        "live_ask",
        "live_hide",
        "live_open_meetings",
        "live_sources",
        "live_state",
        "navigate_to",
        "open_external",
        "open_source_file",
        "page_asset",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    assert_eq!(live, expected);
    let raw = read("capabilities/live.json");
    assert!(!raw.contains("core:default"));
}

#[test]
fn the_live_window_gets_only_the_core_permissions_its_title_bar_needs() {
    let core: BTreeSet<String> = permissions("live").into_iter().filter(|permission| permission.starts_with("core:")).collect();
    let expected: BTreeSet<String> = [
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "core:window:allow-internal-toggle-maximize",
        "core:window:allow-start-dragging",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    assert_eq!(core, expected);
}

#[test]
fn every_drag_region_can_drag_and_toggle_maximize_its_window() {
    for (capability, sources) in [("main", ["../src/shell/topbar.ts"]), ("live", ["../src/live.ts"])] {
        let draws_region = sources.iter().any(|source| read(source).contains("data-tauri-drag-region"));
        assert!(draws_region, "{capability} no longer draws a drag region; update this test");
        let granted = permissions(capability);
        for needed in ["core:window:allow-start-dragging", "core:window:allow-internal-toggle-maximize"] {
            assert!(granted.contains(needed), "{capability} draws a drag region but lacks {needed}");
        }
    }
}

#[test]
fn commands_the_frontend_dropped_stay_unregistered() {
    let known = registered();
    for gone in ["live_cancel", "notes_list", "notes_search", "notes_today", "reveal_in_finder"] {
        assert!(!known.contains(gone), "{gone} is registered again");
    }
    assert!(known.contains("quit"));
}
