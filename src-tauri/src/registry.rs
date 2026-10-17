use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;
use tokio::time::timeout;

use crate::cli::node;
use crate::platform;

pub const REGISTRY_ENV: &str = "KIT_REGISTRY_DIR";
pub const MANIFEST_VERSION: u64 = 1;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const PASSTHROUGH_PREFIXES: [&str; 8] = ["KIT_", "XDG_", "BITA_", "INKWELL_", "RECAP_", "ATL_", "TALLY_", "GAZE_"];
const PASSTHROUGH_VARS: [&str; 9] = [
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "PNPM_HOME",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Linux,
    Windows,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }

    fn join(self, base: &str, parts: &[&str]) -> PathBuf {
        let separator = if self == Os::Windows { "\\" } else { "/" };
        let mut text = base.trim_end_matches(['/', '\\']).to_string();
        for part in parts {
            text.push_str(separator);
            text.push_str(part);
        }
        PathBuf::from(text)
    }
}

pub struct Platform<'a> {
    pub os: Os,
    pub var: &'a dyn Fn(&str) -> Option<OsString>,
    pub home: Option<PathBuf>,
}

fn real_var(key: &str) -> Option<OsString> {
    std::env::var_os(key)
}

pub fn home_dir() -> Option<PathBuf> {
    platform::home()
}

impl Platform<'static> {
    pub fn current() -> Self {
        Platform {
            os: Os::current(),
            var: &real_var,
            home: home_dir(),
        }
    }
}

impl Platform<'_> {
    fn home_text(&self) -> String {
        self.home
            .as_ref()
            .map(|home| home.display().to_string())
            .unwrap_or_default()
    }

    fn text(&self, key: &str) -> Option<String> {
        (self.var)(key).map(|value| value.to_string_lossy().into_owned())
    }

    pub fn config_home(&self) -> String {
        match self.os {
            Os::Windows => self
                .text("APPDATA")
                .unwrap_or_else(|| self.os.join(&self.home_text(), &["AppData", "Roaming"]).display().to_string()),
            _ => self
                .text("XDG_CONFIG_HOME")
                .unwrap_or_else(|| self.os.join(&self.home_text(), &[".config"]).display().to_string()),
        }
    }

    pub fn data_home(&self) -> String {
        match self.os {
            Os::Windows => self
                .text("LOCALAPPDATA")
                .unwrap_or_else(|| self.os.join(&self.home_text(), &["AppData", "Local"]).display().to_string()),
            _ => self
                .text("XDG_DATA_HOME")
                .unwrap_or_else(|| self.os.join(&self.home_text(), &[".local", "share"]).display().to_string()),
        }
    }

    pub fn registry_dir(&self) -> PathBuf {
        if let Some(explicit) = self.text(REGISTRY_ENV).filter(|value| !value.is_empty()) {
            return PathBuf::from(explicit);
        }
        self.os.join(&self.config_home(), &["kikedealba", "tools.d"])
    }

    pub fn inkwell_db(&self) -> PathBuf {
        if let Some(explicit) = self.text("INKWELL_DB_PATH").filter(|value| !value.is_empty()) {
            return PathBuf::from(explicit);
        }
        self.os.join(&self.data_home(), &["inkwell", "inkwell.db"])
    }

    pub fn inkwell_docs(&self) -> PathBuf {
        if let Some(explicit) = self.text("INKWELL_DOCS_DIR").filter(|value| !value.is_empty()) {
            return PathBuf::from(explicit);
        }
        self.os.join(&self.data_home(), &["inkwell", "docs"])
    }
}

pub fn registry_dir() -> PathBuf {
    Platform::current().registry_dir()
}

pub fn inkwell_database_path() -> PathBuf {
    Platform::current().inkwell_db()
}

pub fn inkwell_docs_root() -> PathBuf {
    Platform::current().inkwell_docs()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Bita,
    Inkwell,
    Tally,
    Atl,
    Recap,
    Gaze,
}

pub const KNOWN: [Tool; 6] = [Tool::Bita, Tool::Inkwell, Tool::Tally, Tool::Atl, Tool::Recap, Tool::Gaze];

impl Tool {
    pub fn name(self) -> &'static str {
        match self {
            Tool::Bita => "bita",
            Tool::Inkwell => "inkwell",
            Tool::Tally => "tally",
            Tool::Atl => "atl",
            Tool::Recap => "recap",
            Tool::Gaze => "gaze",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        KNOWN.into_iter().find(|tool| tool.name() == name)
    }

    pub fn override_env(self) -> &'static str {
        match self {
            Tool::Bita => "BITA_CLI",
            Tool::Inkwell => "INKWELL_CLI",
            Tool::Tally => "TALLY_CLI",
            Tool::Atl => "ATL_CLI",
            Tool::Recap => "RECAP_CLI",
            Tool::Gaze => "GAZE_CLI",
        }
    }

    pub fn default_install(self) -> String {
        let name = self.name();
        format!("npm install -g @kikedealba/{name} && {name} setup")
    }

    pub fn purpose(self) -> &'static str {
        match self {
            Tool::Bita => "Los cronómetros y el resumen de Hoy.",
            Tool::Inkwell => "Las páginas de documentación, el backlog, el historial, las notas de cada cronómetro y la sincronización con Confluence.",
            Tool::Tally => "Lo pendiente de pasar a Jira: agrupa el tiempo medido y lleva la cuenta de lo ya registrado.",
            Tool::Atl => "Las conexiones con Jira y Confluence.",
            Tool::Recap => "Grabar reuniones, la minuta y el asistente en vivo.",
            Tool::Gaze => "El cerebro de cada proyecto: el grafo de lo aprendido y la búsqueda en él.",
        }
    }

    fn assumed_capabilities(self) -> Vec<String> {
        let list: &[&str] = match self {
            Tool::Bita => &["time.entries.read", "time.entries.write", "time.events"],
            Tool::Inkwell => &[
                "docs.page.read",
                "docs.page.write",
                "docs.backlog",
                "docs.history",
                "docs.propose",
                "docs.diagrams",
                "docs.export.pdf",
                "docs.confluence.sync",
                "docs.entry-notes",
            ],
            Tool::Tally => &["timesheet.summary", "timesheet.map", "timesheet.link"],
            Tool::Atl => &["jira.issue.read", "jira.issue.write", "confluence.page.read", "confluence.page.write"],
            Tool::Recap => &[],
            Tool::Gaze => &["memory.graph.read", "memory.search"],
        };
        list.iter().map(|item| item.to_string()).collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub manifest_version: u64,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    pub bin: Vec<String>,
    pub envelope: u64,
    pub capabilities: Vec<String>,
    pub emits: Vec<String>,
    #[serde(default)]
    pub subscribes: Vec<Value>,
    #[serde(default)]
    pub install: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
}

impl Manifest {
    pub fn is_installed(&self) -> bool {
        self.bin
            .iter()
            .all(|part| !Path::new(part).is_absolute() || Path::new(part).exists())
    }
}

fn is_string_array(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Array(items)) if items.iter().all(Value::is_string))
}

fn valid_tool_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else { return false };
    first.is_ascii_lowercase()
        && name.len() <= 40
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn valid_semver_prefix(version: &str) -> bool {
    let mut pieces = version.splitn(3, '.');
    let major = pieces.next().unwrap_or_default();
    let minor = pieces.next().unwrap_or_default();
    let rest = pieces.next().unwrap_or_default();
    let digits = |text: &str| !text.is_empty() && text.chars().all(|c| c.is_ascii_digit());
    digits(major) && digits(minor) && rest.chars().next().is_some_and(|c| c.is_ascii_digit())
}

pub fn validate(value: &Value) -> Vec<String> {
    let Some(m) = value.as_object() else {
        return vec!["manifest is not an object".into()];
    };
    let mut problems = Vec::new();
    if m.get("manifestVersion").and_then(Value::as_u64) != Some(MANIFEST_VERSION) {
        problems.push(format!("manifestVersion must be {MANIFEST_VERSION}"));
    }
    if !m.get("name").and_then(Value::as_str).is_some_and(valid_tool_name) {
        problems.push("name must be lowercase letters, digits and dashes".into());
    }
    if !m.get("version").and_then(Value::as_str).is_some_and(valid_semver_prefix) {
        problems.push("version must be semver".into());
    }
    let bin_ok = is_string_array(m.get("bin")) && m.get("bin").and_then(Value::as_array).is_some_and(|items| !items.is_empty());
    if !bin_ok {
        problems.push("bin must be a non-empty string array".into());
    }
    if !m.get("envelope").is_some_and(Value::is_number) {
        problems.push("envelope must be a number".into());
    }
    if !is_string_array(m.get("capabilities")) {
        problems.push("capabilities must be a string array".into());
    }
    if !is_string_array(m.get("emits")) {
        problems.push("emits must be a string array".into());
    }
    match m.get("subscribes") {
        Some(Value::Array(items)) => {
            for (index, raw) in items.iter().enumerate() {
                let Some(s) = raw.as_object() else {
                    problems.push(format!("subscribes[{index}] is not an object"));
                    continue;
                };
                if !s.get("tool").is_some_and(Value::is_string) {
                    problems.push(format!("subscribes[{index}].tool must be a string"));
                }
                let non_empty = |key: &str| {
                    is_string_array(s.get(key)) && s.get(key).and_then(Value::as_array).is_some_and(|list| !list.is_empty())
                };
                if !non_empty("events") {
                    problems.push(format!("subscribes[{index}].events must be a non-empty string array"));
                }
                if !non_empty("command") {
                    problems.push(format!("subscribes[{index}].command must be a non-empty string array"));
                }
                if let Some(filter) = s.get("filter") {
                    let ok = filter
                        .as_object()
                        .is_some_and(|map| map.values().all(|value| is_string_array(Some(value))));
                    if !ok {
                        problems.push(format!("subscribes[{index}].filter must map attributes to string arrays"));
                    }
                }
            }
        }
        _ => problems.push("subscribes must be an array".into()),
    }
    if let Some(mcp) = m.get("mcp") {
        match mcp.as_object() {
            None => problems.push("mcp must be an object".into()),
            Some(mcp) => {
                if mcp.get("stdio").is_some() && !is_string_array(mcp.get("stdio")) {
                    problems.push("mcp.stdio must be a string array".into());
                }
                if mcp.get("http").is_some_and(|value| !value.is_string()) {
                    problems.push("mcp.http must be a string".into());
                }
            }
        }
    }
    problems
}

pub fn parse_manifest(text: &str) -> Result<Manifest, Vec<String>> {
    let value: Value = serde_json::from_str(text).map_err(|error| vec![format!("not JSON: {error}")])?;
    let problems = validate(&value);
    if !problems.is_empty() {
        return Err(problems);
    }
    serde_json::from_value(value).map_err(|error| vec![error.to_string()])
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Located {
    pub file: String,
    pub path: PathBuf,
    pub manifest: Manifest,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invalid {
    pub file: String,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Scan {
    pub tools: Vec<Located>,
    pub invalid: Vec<Invalid>,
}

impl Scan {
    pub fn find(&self, name: &str) -> Option<&Located> {
        self.tools.iter().find(|located| located.file == name)
    }
}

pub fn scan(dir: &Path) -> Scan {
    let Ok(entries) = fs::read_dir(dir) else {
        return Scan::default();
    };
    let mut files: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".json")?.to_string();
            Some((stem, entry.path()))
        })
        .collect();
    files.sort();
    let mut result = Scan::default();
    for (file, path) in files {
        let parsed = fs::read_to_string(&path)
            .map_err(|error| vec![error.to_string()])
            .and_then(|text| parse_manifest(&text));
        match parsed {
            Ok(manifest) => result.tools.push(Located { file, path, manifest }),
            Err(problems) => result.invalid.push(Invalid { file, problems }),
        }
    }
    result
}

pub fn fingerprint(dir: &Path) -> Option<Vec<(String, SystemTime, u64)>> {
    let entries = fs::read_dir(dir).ok()?;
    let mut list: Vec<(String, SystemTime, u64)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".json") {
                return None;
            }
            let meta = entry.metadata().ok()?;
            Some((name, meta.modified().ok()?, meta.len()))
        })
        .collect();
    list.sort();
    Some(list)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub emits: Vec<String>,
}

pub fn last_envelope(stdout: &str) -> Option<Value> {
    let trimmed = stdout.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return value.is_object().then_some(value);
    }
    trimmed
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find(Value::is_object)
}

pub fn read_capabilities(stdout: &str) -> Option<Capabilities> {
    let envelope = last_envelope(stdout)?;
    if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let data = envelope.get("data")?;
    if !data.get("name").is_some_and(Value::is_string) || !data.get("version").is_some_and(Value::is_string) {
        return None;
    }
    if !is_string_array(data.get("capabilities")) {
        return None;
    }
    serde_json::from_value(data.clone()).ok()
}

pub fn read_migrated(stdout: &str) -> Option<bool> {
    let envelope = last_envelope(stdout)?;
    if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    envelope.get("data")?.get("migrated")?.as_bool()
}

pub fn path_for(bin: &[OsString]) -> OsString {
    let mut parts: Vec<PathBuf> = Vec::new();
    for item in bin.iter().filter(|item| Path::new(item).is_absolute()) {
        if let Some(parent) = Path::new(item).parent().filter(|parent| !parent.as_os_str().is_empty()) {
            parts.push(parent.to_path_buf());
        }
    }
    if let Some(node) = std::env::var_os("BITA_NODE") {
        if let Some(parent) = Path::new(&node).parent() {
            parts.push(parent.to_path_buf());
        }
    }
    parts.extend(node::candidate_dirs());
    if !cfg!(windows) {
        if let Some(home) = platform::home() {
            parts.push(home.join(".volta").join("bin"));
            parts.push(home.join("Library").join("pnpm"));
            parts.push(home.join(".local").join("share").join("pnpm"));
            parts.push(home.join(".local").join("bin"));
        }
    }
    parts.extend(platform::package_manager_dirs());
    platform::search_path(parts)
}

pub fn passes_through(key: &str) -> bool {
    PASSTHROUGH_PREFIXES.iter().any(|prefix| key.starts_with(prefix)) || PASSTHROUGH_VARS.contains(&key)
}

pub fn command(bin: &[OsString], path: Option<OsString>) -> Option<Command> {
    let (program, prefix) = bin.split_first()?;
    let mut command = Command::new(program);
    platform::quiet(&mut command)
        .args(prefix)
        .current_dir(platform::neutral_dir())
        .env_clear()
        .envs(platform::essential_env())
        .env("PATH", path.unwrap_or_else(|| path_for(bin)))
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(home) = platform::home() {
        command.env("HOME", home);
    }
    for (key, value) in node::identity() {
        command.env(key, value);
    }
    for (key, value) in std::env::vars_os() {
        if key.to_str().is_some_and(passes_through) {
            command.env(key, value);
        }
    }
    Some(command)
}

async fn run_json(bin: &[OsString], args: &[&str]) -> Option<String> {
    let mut command = command(bin, None)?;
    command.args(args).arg("--json").stdout(Stdio::piped()).stderr(Stdio::null());
    let output = timeout(PROBE_TIMEOUT, command.output()).await.ok()?.ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub async fn probe(bin: &[OsString]) -> Option<Capabilities> {
    read_capabilities(&run_json(bin, &["capabilities"]).await?)
}

pub async fn probe_migrated(bin: &[OsString]) -> Option<bool> {
    read_migrated(&run_json(bin, &["migrate", "status"]).await?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Registry,
    Override,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub tool: Tool,
    pub bin: Vec<OsString>,
    pub origin: Origin,
    pub manifest: Option<Located>,
}

impl Resolved {
    pub fn display(&self) -> String {
        self.bin
            .iter()
            .map(|part| part.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn is_script(path: &Path) -> bool {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| matches!(ext, "js" | "mjs" | "cjs" | "ts" | "mts"))
    {
        return true;
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|text| text.lines().next().map(|line| line.starts_with("#!") && line.contains("node")))
        .unwrap_or(false)
}

pub fn override_bin(path: &Path, node: Option<&Path>) -> Option<Vec<OsString>> {
    if !path.is_file() {
        return None;
    }
    let resolved = crate::cli::script_entry(path).unwrap_or_else(|| path.to_path_buf());
    if is_script(&resolved) {
        let node = node?;
        return Some(vec![node.as_os_str().to_os_string(), resolved.into_os_string()]);
    }
    Some(vec![resolved.into_os_string()])
}

pub fn from_manifest(tool: Tool, located: &Located) -> Option<Resolved> {
    if !located.manifest.is_installed() {
        return None;
    }
    Some(Resolved {
        tool,
        bin: located.manifest.bin.iter().map(OsString::from).collect(),
        origin: Origin::Registry,
        manifest: Some(located.clone()),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolState {
    Ready,
    Unresponsive,
    BrokenBin,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub known: bool,
    pub state: ToolState,
    pub version: Option<String>,
    pub capabilities: Vec<String>,
    pub verified: bool,
    pub origin: Option<Origin>,
    pub command: Option<String>,
    pub manifest: Option<String>,
    pub install: String,
    pub purpose: Option<String>,
}

impl ToolStatus {
    pub fn ready(&self) -> bool {
        self.state == ToolState::Ready
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Modules {
    pub timers: bool,
    pub hoy: bool,
    pub jira: bool,
    pub notes: bool,
    pub entry_notes: bool,
    pub backlog: bool,
    pub history: bool,
    pub proposals: bool,
    pub atlassian: bool,
    pub confluence_sync: bool,
    pub meetings: bool,
    pub live_assistant: bool,
    pub auto_ask: bool,
    pub meeting_kinds: bool,
    pub graph: bool,
    pub graph_search: bool,
}

pub type ReadyTools = HashMap<Tool, Vec<String>>;

pub fn modules(ready: &ReadyTools) -> Modules {
    let has = |tool: Tool, capability: &str| {
        ready
            .get(&tool)
            .is_some_and(|caps| caps.iter().any(|cap| cap == capability))
    };
    let bita = ready.contains_key(&Tool::Bita);
    let recap = ready.contains_key(&Tool::Recap);
    Modules {
        timers: bita,
        hoy: bita,
        jira: has(Tool::Tally, "timesheet.summary"),
        notes: has(Tool::Inkwell, "docs.page.read"),
        entry_notes: has(Tool::Inkwell, "docs.entry-notes"),
        backlog: has(Tool::Inkwell, "docs.backlog"),
        history: has(Tool::Inkwell, "docs.history"),
        proposals: recap && has(Tool::Inkwell, "docs.propose"),
        atlassian: ready.contains_key(&Tool::Atl),
        confluence_sync: has(Tool::Inkwell, "docs.confluence.sync"),
        meetings: recap,
        live_assistant: recap,
        auto_ask: recap,
        meeting_kinds: bita && recap,
        graph: has(Tool::Gaze, "memory.graph.read"),
        graph_search: has(Tool::Gaze, "memory.graph.read") && has(Tool::Gaze, "memory.search"),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    pub registry_dir: String,
    pub tools: Vec<ToolStatus>,
    pub invalid: Vec<Invalid>,
    pub modules: Modules,
    pub inkwell_migrated: Option<bool>,
}

impl ToolsStatus {
    pub fn tool(&self, tool: Tool) -> Option<&ToolStatus> {
        self.tools.iter().find(|status| status.name == tool.name())
    }
}

#[derive(Debug, Clone)]
struct Probed {
    key: Vec<OsString>,
    capabilities: Option<Capabilities>,
}

#[derive(Default)]
struct Cache {
    scan: Option<Scan>,
    overrides: HashMap<Tool, Option<Vec<OsString>>>,
    probes: HashMap<String, Probed>,
    migrated: Option<(Vec<OsString>, Option<bool>)>,
    status: Option<ToolsStatus>,
}

pub struct Registry {
    dir: PathBuf,
    overrides: bool,
    cache: Mutex<Cache>,
    generation: Mutex<u64>,
    computing: tokio::sync::Mutex<()>,
}

static GLOBAL: OnceLock<Registry> = OnceLock::new();

pub fn global() -> &'static Registry {
    GLOBAL.get_or_init(|| Registry::with_overrides(registry_dir()))
}

pub fn status_from(
    dir: &Path,
    scan: &Scan,
    resolved: &HashMap<Tool, Resolved>,
    probes: &HashMap<Tool, Option<Capabilities>>,
    inkwell_migrated: Option<bool>,
) -> ToolsStatus {
    let mut tools = Vec::new();
    let mut ready: ReadyTools = HashMap::new();
    for tool in KNOWN {
        let located = scan.find(tool.name());
        let install = located
            .and_then(|found| found.manifest.install.clone())
            .unwrap_or_else(|| tool.default_install());
        let manifest_path = located.map(|found| found.path.display().to_string());
        let status = match resolved.get(&tool) {
            Some(resolution) => {
                let probed = probes.get(&tool).cloned().flatten();
                let declared = resolution.manifest.as_ref().map(|found| &found.manifest);
                let (state, version, capabilities) = match (&probed, resolution.origin, declared) {
                    (Some(live), _, _) => (ToolState::Ready, Some(live.version.clone()), live.capabilities.clone()),
                    (None, Origin::Override, declared) => (
                        ToolState::Ready,
                        declared.map(|manifest| manifest.version.clone()),
                        declared
                            .map(|manifest| manifest.capabilities.clone())
                            .unwrap_or_else(|| tool.assumed_capabilities()),
                    ),
                    (None, Origin::Registry, declared) => (
                        ToolState::Unresponsive,
                        declared.map(|manifest| manifest.version.clone()),
                        declared.map(|manifest| manifest.capabilities.clone()).unwrap_or_default(),
                    ),
                };
                if state == ToolState::Ready {
                    ready.insert(tool, capabilities.clone());
                }
                ToolStatus {
                    name: tool.name().into(),
                    known: true,
                    state,
                    version,
                    capabilities,
                    verified: probed.is_some(),
                    origin: Some(resolution.origin),
                    command: Some(resolution.display()),
                    manifest: manifest_path,
                    install,
                    purpose: Some(tool.purpose().into()),
                }
            }
            None => ToolStatus {
                name: tool.name().into(),
                known: true,
                state: if located.is_some() { ToolState::BrokenBin } else { ToolState::Missing },
                version: located.map(|found| found.manifest.version.clone()),
                capabilities: located.map(|found| found.manifest.capabilities.clone()).unwrap_or_default(),
                verified: false,
                origin: None,
                command: located.map(|found| found.manifest.bin.join(" ")),
                manifest: manifest_path,
                install,
                purpose: Some(tool.purpose().into()),
            },
        };
        tools.push(status);
    }
    for located in scan.tools.iter().filter(|located| Tool::from_name(&located.file).is_none()) {
        tools.push(ToolStatus {
            name: located.file.clone(),
            known: false,
            state: if located.manifest.is_installed() { ToolState::Ready } else { ToolState::BrokenBin },
            version: Some(located.manifest.version.clone()),
            capabilities: located.manifest.capabilities.clone(),
            verified: false,
            origin: Some(Origin::Registry),
            command: Some(located.manifest.bin.join(" ")),
            manifest: Some(located.path.display().to_string()),
            install: located
                .manifest
                .install
                .clone()
                .unwrap_or_else(|| format!("npm install -g @kikedealba/{0} && {0} setup", located.file)),
            purpose: located.manifest.description.clone(),
        });
    }
    let migrated = if ready.contains_key(&Tool::Inkwell) { inkwell_migrated } else { None };
    ToolsStatus {
        registry_dir: dir.display().to_string(),
        tools,
        invalid: scan.invalid.clone(),
        modules: modules(&ready),
        inkwell_migrated: migrated,
    }
}

impl Registry {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            overrides: false,
            cache: Mutex::new(Cache::default()),
            generation: Mutex::new(0),
            computing: tokio::sync::Mutex::new(()),
        }
    }

    pub fn with_overrides(dir: PathBuf) -> Self {
        Self {
            overrides: true,
            ..Self::new(dir)
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn invalidate(&self) {
        let mut cache = self.cache.lock().expect("registry poisoned");
        let overrides = std::mem::take(&mut cache.overrides);
        *cache = Cache {
            overrides,
            ..Cache::default()
        };
        drop(cache);
        *self.generation.lock().expect("registry poisoned") += 1;
    }

    pub fn generation(&self) -> u64 {
        *self.generation.lock().expect("registry poisoned")
    }

    fn scanned(&self) -> Scan {
        let mut cache = self.cache.lock().expect("registry poisoned");
        if cache.scan.is_none() {
            cache.scan = Some(scan(&self.dir));
        }
        cache.scan.clone().unwrap_or_default()
    }

    async fn override_for(&self, tool: Tool) -> Option<Vec<OsString>> {
        let explicit = std::env::var_os(tool.override_env())?;
        if let Some(cached) = self.cache.lock().expect("registry poisoned").overrides.get(&tool) {
            return cached.clone();
        }
        let path = PathBuf::from(explicit);
        let needs_node = path.is_file()
            && is_script(&crate::cli::script_entry(&path).unwrap_or_else(|| path.clone()));
        let node = if needs_node { node::discover().await } else { None };
        let bin = override_bin(&path, node.as_deref());
        self.cache
            .lock()
            .expect("registry poisoned")
            .overrides
            .insert(tool, bin.clone());
        bin
    }

    pub async fn resolve(&self, tool: Tool) -> Option<Resolved> {
        let scan = self.scanned();
        let located = scan.find(tool.name()).cloned();
        if self.overrides && std::env::var_os(tool.override_env()).is_some() {
            if let Some(bin) = self.override_for(tool).await {
                return Some(Resolved {
                    tool,
                    bin,
                    origin: Origin::Override,
                    manifest: located,
                });
            }
        }
        located.as_ref().and_then(|found| from_manifest(tool, found))
    }

    pub fn resolve_now(&self, tool: Tool) -> Option<Resolved> {
        let scan = self.scanned();
        let located = scan.find(tool.name()).cloned();
        if self.overrides {
            if let Some(explicit) = std::env::var_os(tool.override_env()) {
                let cached = self.cache.lock().expect("registry poisoned").overrides.get(&tool).cloned();
                let bin = match cached {
                    Some(bin) => bin,
                    None => override_bin(Path::new(&explicit), None),
                };
                if let Some(bin) = bin {
                    return Some(Resolved {
                        tool,
                        bin,
                        origin: Origin::Override,
                        manifest: located,
                    });
                }
            }
        }
        located.as_ref().and_then(|found| from_manifest(tool, found))
    }

    fn cached_probe(&self, name: &str, bin: &[OsString]) -> Option<Option<Capabilities>> {
        let cache = self.cache.lock().expect("registry poisoned");
        let found = cache.probes.get(name)?;
        (found.key == bin).then(|| found.capabilities.clone())
    }

    fn store_probe(&self, name: &str, bin: Vec<OsString>, capabilities: Option<Capabilities>) {
        self.cache
            .lock()
            .expect("registry poisoned")
            .probes
            .insert(name.to_string(), Probed { key: bin, capabilities });
    }

    async fn migrated_cached(&self, bin: &[OsString]) -> Option<bool> {
        if let Some((key, value)) = &self.cache.lock().expect("registry poisoned").migrated {
            if key == bin {
                return *value;
            }
        }
        let generation = self.generation();
        let value = probe_migrated(bin).await;
        if self.generation() == generation {
            self.cache.lock().expect("registry poisoned").migrated = Some((bin.to_vec(), value));
        }
        value
    }

    pub async fn status(&self) -> ToolsStatus {
        if let Some(cached) = self.cached_status() {
            return cached;
        }
        let _turn = self.computing.lock().await;
        if let Some(cached) = self.cached_status() {
            return cached;
        }
        let generation = self.generation();
        let scan = self.scanned();
        let mut resolved = HashMap::new();
        for tool in KNOWN {
            if let Some(found) = self.resolve(tool).await {
                resolved.insert(tool, found);
            }
        }
        let mut probes: HashMap<Tool, Option<Capabilities>> = HashMap::new();
        let mut jobs = tokio::task::JoinSet::new();
        for (tool, found) in &resolved {
            match self.cached_probe(tool.name(), &found.bin) {
                Some(known) => {
                    probes.insert(*tool, known);
                }
                None => {
                    let tool = *tool;
                    let bin = found.bin.clone();
                    jobs.spawn(async move {
                        let capabilities = probe(&bin).await;
                        (tool, bin, capabilities)
                    });
                }
            }
        }
        while let Some(Ok((tool, bin, capabilities))) = jobs.join_next().await {
            if self.generation() == generation {
                self.store_probe(tool.name(), bin, capabilities.clone());
            }
            probes.insert(tool, capabilities);
        }
        let inkwell_ready = resolved.get(&Tool::Inkwell).filter(|found| {
            probes.get(&Tool::Inkwell).is_some_and(Option::is_some) || found.origin == Origin::Override
        });
        let migrated = match inkwell_ready {
            Some(found) => self.migrated_cached(&found.bin).await,
            None => None,
        };
        let status = status_from(&self.dir, &scan, &resolved, &probes, migrated);
        if self.generation() == generation {
            self.cache.lock().expect("registry poisoned").status = Some(status.clone());
        }
        status
    }

    pub fn cached_status(&self) -> Option<ToolsStatus> {
        self.cache.lock().expect("registry poisoned").status.clone()
    }
}

pub fn missing_problem(tool: Tool) -> crate::model::Problem {
    let hint = global()
        .cached_status()
        .and_then(|status| status.tool(tool).map(|found| found.install.clone()))
        .unwrap_or_else(|| tool.default_install());
    crate::model::Problem::new(
        crate::model::ProblemKind::ToolMissing,
        format!("{} no está instalado en este equipo.", tool.name()),
    )
    .with_hint(Some(hint))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("den-registry-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch");
        directory
    }

    fn vars(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
        move |key| pairs.iter().find(|(name, _)| *name == key).map(|(_, value)| OsString::from(value))
    }

    fn manifest_json(name: &str, bin: &[&str], capabilities: &[&str]) -> String {
        serde_json::json!({
            "manifestVersion": 1,
            "name": name,
            "version": "1.2.3",
            "bin": bin,
            "envelope": 1,
            "capabilities": capabilities,
            "emits": [],
            "subscribes": []
        })
        .to_string()
    }

    #[test]
    fn the_registry_dir_follows_kit_on_each_platform() {
        let none = vars(&[]);
        let mac = Platform { os: Os::Mac, var: &none, home: Some(PathBuf::from("/Users/ana")) };
        assert_eq!(mac.registry_dir(), PathBuf::from("/Users/ana/.config/kikedealba/tools.d"));

        let xdg = vars(&[("XDG_CONFIG_HOME", "/cfg")]);
        let linux = Platform { os: Os::Linux, var: &xdg, home: Some(PathBuf::from("/home/ana")) };
        assert_eq!(linux.registry_dir(), PathBuf::from("/cfg/kikedealba/tools.d"));

        let appdata = vars(&[("APPDATA", "C:\\Users\\ana\\AppData\\Roaming")]);
        let windows = Platform { os: Os::Windows, var: &appdata, home: Some(PathBuf::from("C:\\Users\\ana")) };
        assert_eq!(
            windows.registry_dir().display().to_string(),
            "C:\\Users\\ana\\AppData\\Roaming\\kikedealba\\tools.d"
        );

        let bare = Platform { os: Os::Windows, var: &none, home: Some(PathBuf::from("C:\\Users\\ana")) };
        assert_eq!(
            bare.registry_dir().display().to_string(),
            "C:\\Users\\ana\\AppData\\Roaming\\kikedealba\\tools.d"
        );

        let explicit = vars(&[("KIT_REGISTRY_DIR", "/tmp/sandbox"), ("XDG_CONFIG_HOME", "/cfg")]);
        let overridden = Platform { os: Os::Linux, var: &explicit, home: None };
        assert_eq!(overridden.registry_dir(), PathBuf::from("/tmp/sandbox"));

        let empty = vars(&[("KIT_REGISTRY_DIR", "")]);
        let ignored = Platform { os: Os::Mac, var: &empty, home: Some(PathBuf::from("/Users/ana")) };
        assert_eq!(ignored.registry_dir(), PathBuf::from("/Users/ana/.config/kikedealba/tools.d"));
    }

    #[test]
    fn inkwell_data_lives_under_the_data_home_or_its_overrides() {
        let none = vars(&[]);
        let mac = Platform { os: Os::Mac, var: &none, home: Some(PathBuf::from("/Users/ana")) };
        assert_eq!(mac.inkwell_db(), PathBuf::from("/Users/ana/.local/share/inkwell/inkwell.db"));
        assert_eq!(mac.inkwell_docs(), PathBuf::from("/Users/ana/.local/share/inkwell/docs"));

        let local = vars(&[("LOCALAPPDATA", "C:\\Users\\ana\\AppData\\Local")]);
        let windows = Platform { os: Os::Windows, var: &local, home: None };
        assert_eq!(windows.inkwell_docs().display().to_string(), "C:\\Users\\ana\\AppData\\Local\\inkwell\\docs");

        let explicit = vars(&[("INKWELL_DB_PATH", "/x/i.db"), ("INKWELL_DOCS_DIR", "/x/docs")]);
        let custom = Platform { os: Os::Linux, var: &explicit, home: None };
        assert_eq!(custom.inkwell_db(), PathBuf::from("/x/i.db"));
        assert_eq!(custom.inkwell_docs(), PathBuf::from("/x/docs"));
    }

    #[test]
    fn a_valid_manifest_parses_and_keeps_its_install_hint() {
        let mut value: Value = serde_json::from_str(&manifest_json("atl", &["/usr/bin/env"], &["jira.issue.read"])).expect("json");
        value["install"] = Value::from("npm install -g @kikedealba/atl");
        value["mcp"] = serde_json::json!({"stdio": ["atl", "mcp"], "http": "http://127.0.0.1:7781/mcp"});
        let manifest = parse_manifest(&value.to_string()).expect("valid");
        assert_eq!(manifest.name, "atl");
        assert_eq!(manifest.install.as_deref(), Some("npm install -g @kikedealba/atl"));
        assert_eq!(manifest.capabilities, vec!["jira.issue.read"]);
    }

    #[test]
    fn an_invalid_manifest_lists_every_problem() {
        let problems = parse_manifest(r#"{"manifestVersion":2,"name":"Bad Name","version":"x","bin":[],"envelope":"1","capabilities":[1],"emits":null,"subscribes":[{"tool":"bita","events":[],"command":["x"],"filter":{"kind":"a"}}],"mcp":{"http":3}}"#)
            .expect_err("invalid");
        for expected in [
            "manifestVersion must be 1",
            "name must be lowercase",
            "version must be semver",
            "bin must be a non-empty",
            "envelope must be a number",
            "capabilities must be",
            "emits must be",
            "subscribes[0].events",
            "subscribes[0].filter",
            "mcp.http",
        ] {
            assert!(problems.iter().any(|problem| problem.contains(expected)), "missing {expected}: {problems:?}");
        }
        assert!(parse_manifest("not json").is_err());
        assert!(parse_manifest("[]").is_err());
    }

    #[test]
    fn versions_and_names_follow_kit_rules() {
        assert!(valid_semver_prefix("1.2.3"));
        assert!(valid_semver_prefix("0.18.0-beta.1"));
        assert!(!valid_semver_prefix("1.2"));
        assert!(!valid_semver_prefix("v1.2.3"));
        assert!(valid_tool_name("recap-capture"));
        assert!(!valid_tool_name("9lives"));
        assert!(!valid_tool_name(""));
        assert!(!valid_tool_name(&"a".repeat(41)));
    }

    #[test]
    fn a_scan_reads_json_files_only_and_sets_the_invalid_apart() {
        let dir = scratch("scan");
        fs::write(dir.join("bita.json"), manifest_json("bita", &["/bin/sh"], &["time.entries.read"])).expect("bita");
        fs::write(dir.join("broken.json"), "{").expect("broken");
        fs::write(dir.join("atl.json.123.tmp"), "{}").expect("tmp");
        fs::write(dir.join("notes.txt"), "x").expect("txt");
        let found = scan(&dir);
        assert_eq!(found.tools.len(), 1);
        assert_eq!(found.tools[0].file, "bita");
        assert_eq!(found.invalid.len(), 1);
        assert_eq!(found.invalid[0].file, "broken");
        assert!(scan(&dir.join("absent")).tools.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_manifest_whose_binary_is_gone_is_not_installed() {
        let present = parse_manifest(&manifest_json("bita", &["/bin/sh", "relative.js"], &[])).expect("valid");
        assert!(present.is_installed());
        let gone = parse_manifest(&manifest_json("bita", &["/definitely/not/here/node"], &[])).expect("valid");
        assert!(!gone.is_installed());
    }

    #[test]
    fn capabilities_come_from_the_last_envelope_line() {
        let stdout = "warning: something\n{\"schemaVersion\":1,\"ok\":true,\"command\":\"capabilities\",\"data\":{\"name\":\"recap\",\"version\":\"1.0.0\",\"envelope\":1,\"capabilities\":[\"meeting.record\"],\"emits\":[]}}\n";
        let caps = read_capabilities(stdout).expect("caps");
        assert_eq!(caps.name, "recap");
        assert_eq!(caps.capabilities, vec!["meeting.record"]);
        assert!(read_capabilities(r#"{"ok":false,"error":{"code":"X","message":"no"}}"#).is_none());
        assert!(read_capabilities(r#"{"ok":true,"data":{"name":"x"}}"#).is_none());
        assert!(read_capabilities("").is_none());
    }

    #[test]
    fn the_migration_flag_is_read_from_inkwell() {
        assert_eq!(read_migrated(r#"{"ok":true,"data":{"migrated":true,"bitaDatabase":"/x","migratedAt":"2026"}}"#), Some(true));
        assert_eq!(read_migrated(r#"{"ok":true,"data":{"migrated":false,"bitaDatabase":null,"migratedAt":null}}"#), Some(false));
        assert_eq!(read_migrated(r#"{"ok":false}"#), None);
    }

    fn ready(entries: &[(Tool, &[&str])]) -> ReadyTools {
        entries
            .iter()
            .map(|(tool, caps)| (*tool, caps.iter().map(|cap| cap.to_string()).collect()))
            .collect()
    }

    const INKWELL_CAPS: &[&str] = &[
        "docs.page.read",
        "docs.page.write",
        "docs.backlog",
        "docs.history",
        "docs.propose",
        "docs.confluence.sync",
        "docs.entry-notes",
    ];
    const TALLY_CAPS: &[&str] = &["timesheet.summary", "timesheet.map", "timesheet.link"];

    #[test]
    fn bita_alone_only_measures_time() {
        let only_bita = modules(&ready(&[(Tool::Bita, &["time.entries.read"])]));
        assert!(only_bita.timers && only_bita.hoy);
        assert!(!only_bita.jira && !only_bita.notes && !only_bita.entry_notes);
        assert!(!only_bita.backlog && !only_bita.history && !only_bita.proposals);
        assert!(!only_bita.atlassian && !only_bita.confluence_sync);
        assert!(!only_bita.meetings && !only_bita.live_assistant && !only_bita.meeting_kinds);
    }

    #[test]
    fn each_module_follows_the_tool_that_owns_it() {
        assert_eq!(modules(&ReadyTools::new()), Modules::default());

        let trio = modules(&ready(&[(Tool::Bita, &[]), (Tool::Inkwell, INKWELL_CAPS), (Tool::Tally, TALLY_CAPS)]));
        assert!(trio.timers && trio.hoy && trio.jira);
        assert!(trio.notes && trio.entry_notes && trio.backlog && trio.history && trio.confluence_sync);
        assert!(!trio.proposals && !trio.atlassian && !trio.meetings);

        let with_recap = modules(&ready(&[(Tool::Bita, &[]), (Tool::Inkwell, INKWELL_CAPS), (Tool::Recap, &[])]));
        assert!(with_recap.meetings && with_recap.live_assistant && with_recap.auto_ask);
        assert!(with_recap.meeting_kinds && with_recap.proposals);

        let partial = modules(&ready(&[(Tool::Inkwell, &["docs.page.read"])]));
        assert!(partial.notes);
        assert!(!partial.entry_notes && !partial.backlog && !partial.history && !partial.confluence_sync);
        assert!(!partial.timers && !partial.hoy && !partial.atlassian);

        let tally_without_summary = modules(&ready(&[(Tool::Tally, &["timesheet.link"])]));
        assert!(!tally_without_summary.jira);

        assert!(modules(&ready(&[(Tool::Atl, &["jira.issue.read"])])).atlassian);
        assert!(!trio.graph && !trio.graph_search);

        let brain = modules(&ready(&[(Tool::Gaze, &["memory.graph.read", "memory.search"])]));
        assert!(brain.graph && brain.graph_search);
        assert!(!brain.timers && !brain.notes && !brain.meetings);

        let search_only = modules(&ready(&[(Tool::Gaze, &["memory.search"])]));
        assert!(!search_only.graph && !search_only.graph_search);

        let graph_only = modules(&ready(&[(Tool::Gaze, &["memory.graph.read"])]));
        assert!(graph_only.graph && !graph_only.graph_search);
    }

    #[cfg(unix)]
    fn fake_tool(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(format!("{name}.sh"));
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("script");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    #[cfg(unix)]
    fn capabilities_script(name: &str, capabilities: &str) -> String {
        format!(
            r#"case "$*" in
  "capabilities --json") echo '{{"schemaVersion":1,"ok":true,"command":"capabilities","data":{{"name":"{name}","version":"9.9.9","envelope":1,"capabilities":[{capabilities}],"emits":[]}}}}' ;;
  "migrate status --json") echo '{{"schemaVersion":1,"ok":true,"command":"migrate status","data":{{"migrated":true,"bitaDatabase":null,"migratedAt":null}}}}' ;;
  "list --json") echo '{{"schemaVersion":1,"ok":true,"command":"list","data":[]}}' ;;
  *) echo '{{"schemaVersion":1,"ok":false,"command":"error","error":{{"code":"USAGE_ERROR","message":"unknown"}}}}'; exit 2 ;;
esac"#
        )
    }

    #[cfg(unix)]
    fn register(dir: &Path, name: &str, bin: &Path, capabilities: &[&str]) {
        fs::write(
            dir.join(format!("{name}.json")),
            manifest_json(name, &[bin.to_str().expect("utf8")], capabilities),
        )
        .expect("manifest");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_empty_registry_hides_every_module() {
        let dir = scratch("empty");
        let registry = Registry::new(dir.join("tools.d"));
        let status = registry.status().await;
        assert_eq!(status.modules, Modules::default());
        assert!(status.tools.iter().all(|tool| tool.state == ToolState::Missing));
        assert_eq!(status.tool(Tool::Recap).expect("recap").install, "npm install -g @kikedealba/recap && recap setup");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    fn quoted(caps: &[&str]) -> String {
        caps.iter().map(|cap| format!("\"{cap}\"")).collect::<Vec<_>>().join(",")
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn a_registry_with_bita_alone_shows_timers_and_hoy_only() {
        let dir = scratch("bita-alone");
        let bita = fake_tool(&dir, "bita", &capabilities_script("bita", r#""time.entries.read","time.entries.write""#));
        register(&dir, "bita", &bita, &["time.entries.read"]);
        let registry = Registry::new(dir.clone());
        let status = registry.status().await;
        let found = status.tool(Tool::Bita).expect("bita");
        assert_eq!(found.state, ToolState::Ready);
        assert!(found.verified);
        assert_eq!(found.version.as_deref(), Some("9.9.9"));
        assert!(status.modules.timers && status.modules.hoy);
        assert!(!status.modules.jira && !status.modules.notes && !status.modules.entry_notes);
        assert!(!status.modules.backlog && !status.modules.atlassian && !status.modules.confluence_sync);
        assert!(!status.modules.meetings && !status.modules.meeting_kinds);
        assert_eq!(status.tool(Tool::Tally).expect("tally").state, ToolState::Missing);
        assert_eq!(
            status.tool(Tool::Tally).expect("tally").install,
            "npm install -g @kikedealba/tally && tally setup"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn bita_inkwell_and_tally_turn_on_their_modules() {
        let dir = scratch("trio");
        let bita = fake_tool(&dir, "bita", &capabilities_script("bita", r#""time.entries.read""#));
        let inkwell = fake_tool(&dir, "inkwell", &capabilities_script("inkwell", &quoted(INKWELL_CAPS)));
        let tally = fake_tool(&dir, "tally", &capabilities_script("tally", &quoted(TALLY_CAPS)));
        register(&dir, "bita", &bita, &[]);
        register(&dir, "inkwell", &inkwell, &[]);
        register(&dir, "tally", &tally, &[]);
        let registry = Registry::new(dir.clone());
        let status = registry.status().await;
        assert_eq!(status.inkwell_migrated, Some(true));
        let on = status.modules;
        assert!(on.timers && on.hoy && on.jira);
        assert!(on.notes && on.entry_notes && on.backlog && on.history && on.confluence_sync);
        assert!(!on.atlassian && !on.meetings);
        assert_eq!(status.tool(Tool::Tally).expect("tally").capabilities, TALLY_CAPS);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn adding_recap_turns_meetings_on() {
        let dir = scratch("bita-recap");
        let bita = fake_tool(&dir, "bita", &capabilities_script("bita", r#""time.entries.read""#));
        let recap = fake_tool(&dir, "recap", &capabilities_script("recap", r#""meeting.record""#));
        register(&dir, "bita", &bita, &[]);
        register(&dir, "recap", &recap, &[]);
        let registry = Registry::new(dir.clone());
        let status = registry.status().await;
        assert!(status.modules.meetings && status.modules.live_assistant && status.modules.meeting_kinds);
        assert_eq!(status.tool(Tool::Recap).expect("recap").capabilities, vec!["meeting.record"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn a_tool_that_does_not_answer_is_unresponsive_and_a_missing_binary_is_broken() {
        let dir = scratch("unresponsive");
        let mute = fake_tool(&dir, "mute", "exit 1");
        register(&dir, "recap", &mute, &["meeting.record"]);
        register(&dir, "atl", &dir.join("gone"), &[]);
        fs::write(dir.join("extra.json"), manifest_json("extra", &["/bin/sh"], &["x.y"])).expect("extra");
        let registry = Registry::new(dir.clone());
        let status = registry.status().await;
        assert_eq!(status.tool(Tool::Recap).expect("recap").state, ToolState::Unresponsive);
        assert_eq!(status.tool(Tool::Atl).expect("atl").state, ToolState::BrokenBin);
        assert!(!status.modules.meetings && !status.modules.atlassian);
        let extra = status.tools.iter().find(|tool| tool.name == "extra").expect("extra");
        assert!(!extra.known);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn invalidating_rescans_the_directory() {
        let dir = scratch("invalidate");
        let registry = Registry::new(dir.clone());
        assert!(!registry.status().await.modules.meetings);
        let recap = fake_tool(&dir, "recap", &capabilities_script("recap", ""));
        register(&dir, "recap", &recap, &[]);
        assert!(!registry.status().await.modules.meetings);
        registry.invalidate();
        assert!(registry.status().await.modules.meetings);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_override_script_runs_with_node_and_a_binary_runs_alone() {
        let dir = scratch("override");
        let script = dir.join("bita.ts");
        fs::write(&script, "console.log(1)\n").expect("script");
        let node = PathBuf::from("/usr/local/bin/node");
        let bin = override_bin(&script, Some(&node)).expect("bin");
        assert_eq!(bin[0], OsString::from("/usr/local/bin/node"));
        assert!(override_bin(&script, None).is_none());
        let binary = dir.join("recap");
        fs::write(&binary, "#!/bin/sh\necho\n").expect("binary");
        assert_eq!(override_bin(&binary, None).expect("bin").len(), 1);
        assert!(override_bin(&dir.join("absent"), None).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_tool_and_platform_variables_reach_a_tool() {
        assert!(passes_through("KIT_REGISTRY_DIR"));
        assert!(passes_through("INKWELL_DOCS_DIR"));
        assert!(passes_through("XDG_CONFIG_HOME"));
        assert!(passes_through("APPDATA"));
        assert!(passes_through("GAZE_HOME"));
        assert!(!passes_through("AWS_SECRET_ACCESS_KEY"));
        assert!(!passes_through("PATH"));
    }
}
