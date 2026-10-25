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

fn granted(capability: &str) -> BTreeSet<String> {
    let value: serde_json::Value = serde_json::from_str(&read(&format!("capabilities/{capability}.json"))).expect("json");
    value["permissions"]
        .as_array()
        .expect("permissions")
        .iter()
        .filter_map(|permission| permission.as_str())
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
