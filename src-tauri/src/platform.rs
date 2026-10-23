use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[cfg(windows)]
const ESSENTIAL_ENV: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
];

#[cfg(target_os = "macos")]
const ESSENTIAL_ENV: &[&str] = &["TMPDIR", "LANG"];

#[cfg(all(unix, not(target_os = "macos")))]
const ESSENTIAL_ENV: &[&str] = &[
    "TMPDIR",
    "LANG",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
    "DBUS_SESSION_BUS_ADDRESS",
];

const LAUNCHING_EXTENSIONS: &[&str] = &[
    "app", "appimage", "bat", "cmd", "com", "command", "cpl", "desktop", "exe", "hta", "jar", "js", "jse", "lnk",
    "msc", "msi", "msp", "ps1", "reg", "run", "scr", "sh", "url", "vbe", "vbs", "ws", "wsf", "wsh",
];

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn home() -> Option<PathBuf> {
    home_from(env::var_os("HOME"), env::var_os("USERPROFILE"))
}

fn home_from(home: Option<OsString>, profile: Option<OsString>) -> Option<PathBuf> {
    home.filter(|value| !value.is_empty())
        .or_else(|| profile.filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

pub fn executable(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub fn on_path(file: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|directory| directory.join(file))
        .find(|candidate| candidate.is_file())
}

pub fn system_dirs() -> Vec<PathBuf> {
    if cfg!(windows) {
        let root = env::var_os("SystemRoot")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        vec![
            root.join("System32"),
            root.clone(),
            root.join("System32").join("Wbem"),
            root.join("System32").join("WindowsPowerShell").join("v1.0"),
        ]
    } else {
        ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].iter().map(PathBuf::from).collect()
    }
}

pub fn package_manager_dirs() -> Vec<PathBuf> {
    if cfg!(windows) {
        let mut directories = Vec::new();
        if let Some(app_data) = env_dir("APPDATA") {
            directories.push(app_data.join("npm"));
        }
        if let Some(local) = env_dir("LOCALAPPDATA") {
            directories.push(local.join("pnpm"));
            directories.push(local.join("Microsoft").join("WinGet").join("Links"));
        }
        if let Some(home) = home() {
            directories.push(home.join("scoop").join("shims"));
        }
        directories
    } else if cfg!(target_os = "macos") {
        vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]
    } else {
        vec![PathBuf::from("/usr/local/bin"), PathBuf::from("/home/linuxbrew/.linuxbrew/bin")]
    }
}

pub fn search_path<I>(first: I) -> OsString
where
    I: IntoIterator<Item = PathBuf>,
{
    join_dirs(first.into_iter().chain(system_dirs()))
}

fn join_dirs<I>(directories: I) -> OsString
where
    I: IntoIterator<Item = PathBuf>,
{
    let mut kept: Vec<PathBuf> = Vec::new();
    for directory in directories {
        if directory.as_os_str().is_empty() || kept.contains(&directory) {
            continue;
        }
        if env::join_paths([&directory]).is_err() {
            continue;
        }
        kept.push(directory);
    }
    env::join_paths(kept).unwrap_or_default()
}

pub fn essential_env() -> Vec<(&'static str, OsString)> {
    ESSENTIAL_ENV
        .iter()
        .filter_map(|key| env::var_os(key).map(|value| (*key, value)))
        .collect()
}

pub fn neutral_dir() -> PathBuf {
    if cfg!(windows) {
        home().unwrap_or_else(env::temp_dir)
    } else {
        PathBuf::from("/")
    }
}

pub fn quiet(command: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

pub fn simplified(path: &Path) -> PathBuf {
    simplified_text(&path.to_string_lossy()).map(PathBuf::from).unwrap_or_else(|| path.to_path_buf())
}

fn simplified_text(text: &str) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return Some(format!(r"\\{rest}"));
    }
    let rest = text.strip_prefix(r"\\?\")?;
    let bytes = rest.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Some(rest.to_string());
    }
    None
}

pub fn launches_on_open(path: &Path) -> bool {
    let by_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| LAUNCHING_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()));
    by_extension || is_executable(path)
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    false
}

pub fn open_path(path: &Path) -> Result<(), String> {
    tauri_plugin_opener::open_path(simplified(path), None::<&str>).map_err(|error| error.to_string())
}

pub fn open_url(url: &str) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| error.to_string())
}

pub fn reveal(path: &Path) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(simplified(path)).map_err(|error| error.to_string())
}

pub async fn open_as_text(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let status = tokio::process::Command::new("/usr/bin/open")
            .arg("-t")
            .arg(path)
            .status()
            .await
            .map_err(|error| error.to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("open terminó con {status}"));
    }
    let target = simplified(path);
    if cfg!(windows) {
        let notepad = system_dirs()
            .into_iter()
            .map(|directory| directory.join("notepad.exe"))
            .find(|candidate| candidate.is_file())
            .unwrap_or_else(|| PathBuf::from("notepad.exe"));
        let mut command = tokio::process::Command::new(notepad);
        command.arg(&target);
        return quiet(&mut command).spawn().map(|_| ()).map_err(|error| error.to_string());
    }
    if launches_on_open(&target) {
        return reveal(&target);
    }
    if open_with_text_editor(&target).await {
        return Ok(());
    }
    open_path(&target)
}

async fn open_with_text_editor(target: &Path) -> bool {
    let (Some(mime), Some(launcher)) = (on_path("xdg-mime"), on_path("gtk-launch")) else {
        return false;
    };
    let mut query = tokio::process::Command::new(mime);
    query.args(["query", "default", "text/plain"]);
    let Ok(output) = query.output().await else {
        return false;
    };
    let Some(application) = desktop_id(&String::from_utf8_lossy(&output.stdout)) else {
        return false;
    };
    let mut launch = tokio::process::Command::new(launcher);
    launch.arg(application).arg(target);
    launch.status().await.is_ok_and(|status| status.success())
}

fn desktop_id(answer: &str) -> Option<String> {
    let line = answer.lines().map(str::trim).find(|line| !line.is_empty())?;
    line.ends_with(".desktop").then(|| line.to_string())
}

pub struct ManagedRoot {
    pub root: PathBuf,
    pub tail: PathBuf,
}

fn managed(root: PathBuf, tail: &[&str]) -> ManagedRoot {
    ManagedRoot {
        root,
        tail: tail.iter().collect(),
    }
}

pub fn managed_node_roots(home: Option<&Path>) -> Vec<ManagedRoot> {
    let node = executable("node");
    let mut roots = Vec::new();
    if let Some(fnm) = env_dir("FNM_DIR") {
        roots.push(managed(fnm.join("node-versions"), &["installation", "bin", &node]));
        roots.push(managed(fnm.join("node-versions"), &["installation", &node]));
    }
    if cfg!(windows) {
        if let Some(nvm) = env_dir("NVM_HOME").or_else(|| env_dir("APPDATA").map(|dir| dir.join("nvm"))) {
            roots.push(managed(nvm, &[&node]));
        }
        if let Some(app_data) = env_dir("APPDATA") {
            roots.push(managed(app_data.join("fnm").join("node-versions"), &["installation", &node]));
        }
        return roots;
    }
    if let Some(home) = home {
        roots.push(managed(home.join(".nvm/versions/node"), &["bin", &node]));
        roots.push(managed(home.join(".local/share/fnm/node-versions"), &["installation", "bin", &node]));
        roots.push(managed(
            home.join("Library/Application Support/fnm/node-versions"),
            &["installation", "bin", &node],
        ));
        roots.push(managed(home.join(".asdf/installs/nodejs"), &["bin", &node]));
    }
    roots
}

pub fn node_locations(home: Option<&Path>) -> Vec<PathBuf> {
    let node = executable("node");
    let mut found = Vec::new();
    if cfg!(windows) {
        if let Some(link) = env_dir("NVM_SYMLINK") {
            found.push(link.join(&node));
        }
        if let Some(local) = env_dir("LOCALAPPDATA") {
            found.push(local.join("Volta").join("bin").join(&node));
            found.push(local.join("pnpm").join(&node));
        }
        if let Some(home) = home {
            found.push(home.join("scoop").join("apps").join("nodejs").join("current").join(&node));
            found.push(home.join("scoop").join("apps").join("nodejs-lts").join("current").join(&node));
        }
        for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(programs) = env_dir(key) {
                found.push(programs.join("nodejs").join(&node));
                found.push(programs.join("Volta").join(&node));
            }
        }
        return found;
    }
    if let Some(home) = home {
        found.push(home.join(".volta/bin").join(&node));
        found.push(home.join("Library/pnpm").join(&node));
        found.push(home.join(".local/share/pnpm").join(&node));
        found.push(home.join(".local/bin").join(&node));
    }
    for directory in package_manager_dirs() {
        found.push(directory.join(&node));
    }
    found.push(PathBuf::from("/usr/bin").join(&node));
    found
}

pub fn file_manager_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "Finder"
    } else if cfg!(windows) {
        "el Explorador de archivos"
    } else {
        "el administrador de archivos"
    }
}

fn env_dir(key: &str) -> Option<PathBuf> {
    env::var_os(key).filter(|value| !value.is_empty()).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::PathBuf;

    use std::path::Path;

    use super::{desktop_id, executable, home_from, join_dirs, launches_on_open, search_path, simplified_text, system_dirs};

    #[test]
    fn home_prefers_home_and_falls_back_to_the_user_profile() {
        assert_eq!(home_from(Some("/h".into()), Some("C:\\Users\\a".into())), Some(PathBuf::from("/h")));
        assert_eq!(home_from(Some(OsString::new()), Some("C:\\Users\\a".into())), Some(PathBuf::from("C:\\Users\\a")));
        assert_eq!(home_from(None, None), None);
    }

    #[test]
    fn executables_carry_the_platform_extension() {
        if cfg!(windows) {
            assert_eq!(executable("node"), "node.exe");
        } else {
            assert_eq!(executable("node"), "node");
        }
    }

    #[test]
    fn the_search_path_puts_given_directories_first_and_ends_with_the_system() {
        let first = PathBuf::from(if cfg!(windows) { r"C:\node" } else { "/opt/node/bin" });
        let joined = search_path(vec![first.clone(), first.clone()]);
        let parts: Vec<PathBuf> = std::env::split_paths(&joined).collect();
        assert_eq!(parts.first(), Some(&first));
        assert_eq!(parts.iter().filter(|part| **part == first).count(), 1);
        assert_eq!(parts.last(), system_dirs().last());
    }

    #[test]
    fn verbatim_windows_paths_lose_their_prefix() {
        if cfg!(windows) {
            assert_eq!(simplified_text(r"\\?\C:\Users\a\doc.md").as_deref(), Some(r"C:\Users\a\doc.md"));
            assert_eq!(simplified_text(r"\\?\UNC\server\share\a").as_deref(), Some(r"\\server\share\a"));
            assert_eq!(simplified_text(r"\\?\Volume{x}\a"), None);
        } else {
            assert_eq!(simplified_text("/Users/a/doc.md"), None);
        }
    }

    #[test]
    fn programs_are_never_opened_as_documents() {
        assert!(launches_on_open(Path::new("setup.EXE")));
        assert!(launches_on_open(Path::new("run.bat")));
        assert!(launches_on_open(Path::new("app.desktop")));
        assert!(!launches_on_open(Path::new("notes-that-do-not-exist.md")));
    }

    #[test]
    fn directories_that_cannot_be_joined_are_dropped() {
        let broken = PathBuf::from(if cfg!(windows) { "a\"b" } else { "a:b" });
        let joined = join_dirs(vec![broken, PathBuf::from("ok"), PathBuf::new()]);
        assert_eq!(joined, OsString::from("ok"));
    }

    #[test]
    fn the_default_text_editor_is_read_from_xdg_mime() {
        assert_eq!(desktop_id("org.gnome.TextEditor.desktop\n").as_deref(), Some("org.gnome.TextEditor.desktop"));
        assert_eq!(desktop_id("\n  kate.desktop  \n").as_deref(), Some("kate.desktop"));
        assert_eq!(desktop_id(""), None);
        assert_eq!(desktop_id("no default\n"), None);
    }
}
