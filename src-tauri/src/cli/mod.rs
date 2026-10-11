pub mod node;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use std::{env, fs};

use serde::de::DeserializeOwned;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::model::{CliError, Envelope, Problem, ProblemKind, SUPPORTED_SCHEMA};
use crate::registry::{self, Origin, Tool};

const DB_OVERRIDE_ENV: &str = "BITA_DB_PATH";
const EDITOR_OVERRIDE_ENV: &str = "BITA_EDITOR";
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Default)]
pub struct CallOptions {
    pub timeout: Option<Duration>,
    pub stdin: Option<String>,
}

impl CallOptions {
    pub fn timeout(seconds: u64) -> Self {
        Self {
            timeout: Some(Duration::from_secs(seconds)),
            stdin: None,
        }
    }

    pub fn with_stdin(mut self, text: String) -> Self {
        self.stdin = Some(text);
        self
    }
}

#[derive(Debug, Clone)]
pub struct Cli {
    tool: Tool,
    bin: Vec<OsString>,
    origin: Origin,
    db_path: PathBuf,
}

impl Cli {
    pub async fn discover(_app: &AppHandle) -> Result<Self, Problem> {
        Self::for_tool(Tool::Bita).await
    }

    pub async fn for_tool(tool: Tool) -> Result<Self, Problem> {
        let resolved = registry::global()
            .resolve(tool)
            .await
            .ok_or_else(|| registry::missing_problem(tool))?;
        Ok(Self {
            tool,
            bin: resolved.bin,
            origin: resolved.origin,
            db_path: database_path(),
        })
    }

    pub fn origin(&self) -> Origin {
        self.origin
    }

    pub fn command_line(&self) -> String {
        self.bin
            .iter()
            .map(|part| part.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn database_path(&self) -> &PathBuf {
        &self.db_path
    }

    pub async fn call<T: DeserializeOwned>(&self, args: &[&str]) -> Result<T, Problem> {
        self.envelope::<T>(args).await?.ok_or_else(|| self.empty())
    }

    pub async fn run(&self, args: &[&str]) -> Result<(), Problem> {
        self.envelope::<serde_json::Value>(args).await.map(|_| ())
    }

    pub async fn call_with_meta<T: DeserializeOwned>(
        &self,
        args: &[&str],
    ) -> Result<(T, serde_json::Value), Problem> {
        let (data, meta) = self.envelope_with_meta::<T>(args).await?;
        let data = data.ok_or_else(|| self.empty())?;
        Ok((data, meta))
    }

    pub async fn call_with_options<T: DeserializeOwned>(
        &self,
        args: &[&str],
        options: CallOptions,
    ) -> Result<(Option<T>, serde_json::Value), Problem> {
        self.run_envelope::<T>(args, options).await
    }

    fn empty(&self) -> Problem {
        Problem::new(
            ProblemKind::Unreadable,
            format!("La respuesta de {} venía sin datos.", self.tool.name()),
        )
    }

    async fn envelope<T: DeserializeOwned>(&self, args: &[&str]) -> Result<Option<T>, Problem> {
        self.envelope_with_meta::<T>(args).await.map(|(data, _)| data)
    }

    async fn envelope_with_meta<T: DeserializeOwned>(
        &self,
        args: &[&str],
    ) -> Result<(Option<T>, serde_json::Value), Problem> {
        self.run_envelope::<T>(args, CallOptions::default()).await
    }

    fn arguments(&self, args: &[&str]) -> Vec<OsString> {
        let mut list: Vec<OsString> = args.iter().map(OsString::from).collect();
        list.push("--json".into());
        if self.tool == Tool::Bita {
            list.push("--db-path".into());
            list.push(self.db_path.clone().into_os_string());
        }
        list
    }

    pub async fn raw_envelope(&self, args: &[&str], options: CallOptions) -> Result<serde_json::Value, Problem> {
        let name = self.tool.name();
        let limit = options.timeout.unwrap_or(CALL_TIMEOUT);
        let mut command = registry::command(&self.bin, None).ok_or_else(|| registry::missing_problem(self.tool))?;
        command
            .args(self.arguments(args))
            .stdin(if options.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let output = timeout(limit, run_with_input(command, options.stdin))
            .await
            .map_err(|_| {
                Problem::new(
                    ProblemKind::CliFailed,
                    format!("{name} no respondió en {} s.", limit.as_secs()),
                )
            })?
            .map_err(|error| {
                Problem::new(
                    ProblemKind::CliFailed,
                    format!("No pude ejecutar {name}: {error}"),
                )
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        registry::last_envelope(&stdout).ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = if stdout.trim().is_empty() { stderr.trim().to_string() } else { stdout.trim().to_string() };
            Problem::new(
                ProblemKind::Unreadable,
                format!("{name} no devolvió una respuesta que entienda: {detail}"),
            )
        })
    }

    async fn run_envelope<T: DeserializeOwned>(
        &self,
        args: &[&str],
        options: CallOptions,
    ) -> Result<(Option<T>, serde_json::Value), Problem> {
        let name = self.tool.name();
        let line = self.raw_envelope(args, options).await?;

        let envelope: Envelope<T> = serde_json::from_value(line).map_err(|error| {
            Problem::new(
                ProblemKind::Unreadable,
                format!("No entiendo la respuesta de {name}: {error}"),
            )
        })?;

        if self.tool == Tool::Bita && envelope.schema_version != SUPPORTED_SCHEMA {
            return Err(Problem::new(
                ProblemKind::SchemaMismatch,
                format!(
                    "bita habla el esquema {} y esta app entiende el {}.",
                    envelope.schema_version, SUPPORTED_SCHEMA
                ),
            ));
        }

        if !envelope.ok {
            let CliError {
                code,
                message,
                hint,
            } = envelope
                .error
                .unwrap_or_else(|| CliError {
                    code: "UNKNOWN".to_string(),
                    message: format!("{name} falló sin decir por qué."),
                    hint: None,
                });
            return Err(
                Problem::new(ProblemKind::CliFailed, format!("{message} ({code})"))
                    .with_hint(hint),
            );
        }

        Ok((envelope.data, envelope.meta.unwrap_or(serde_json::Value::Null)))
    }
}

async fn run_with_input(
    mut command: Command,
    input: Option<String>,
) -> std::io::Result<std::process::Output> {
    let mut child = command.spawn()?;
    if let Some(text) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes()).await?;
            stdin.shutdown().await?;
            drop(stdin);
        }
    }
    child.wait_with_output().await
}

fn canonical(path: PathBuf) -> PathBuf {
    fs::canonicalize(&path).unwrap_or(path)
}

pub fn script_entry(candidate: &Path) -> Option<PathBuf> {
    let resolved = canonical(candidate.to_path_buf());
    let text = fs::read_to_string(&resolved).ok()?;
    let first_line = text.lines().next().unwrap_or_default();
    if !first_line.starts_with("#!") || first_line.contains("node") {
        return Some(resolved);
    }
    let directory = resolved.parent()?;
    shim_targets(&text)
        .into_iter()
        .map(|relative| canonical(directory.join(relative)))
        .find(|target| target.is_file())
}

fn shim_targets(text: &str) -> Vec<&str> {
    const MARKER: &str = "\"$basedir/";
    let mut targets = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(MARKER) {
        let after = &rest[start + MARKER.len()..];
        let Some(end) = after.find('"') else { break };
        let target = &after[..end];
        if [".js", ".mjs", ".cjs", ".ts"].iter().any(|extension| target.ends_with(extension)) {
            targets.push(target);
        }
        rest = &after[end..];
    }
    targets
}

pub fn docs_root() -> PathBuf {
    registry::inkwell_docs_root()
}

pub fn docs_roots() -> Vec<PathBuf> {
    vec![docs_root()]
}

pub fn editor_override() -> Option<OsString> {
    env::var_os(EDITOR_OVERRIDE_ENV)
}

pub fn database_path() -> PathBuf {
    if let Some(explicit) = env::var_os(DB_OVERRIDE_ENV) {
        return PathBuf::from(explicit);
    }

    let data_home = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| node::home().map(|home| home.join(".local/share")))
        .unwrap_or_else(env::temp_dir);

    data_home.join("bita").join("bita.db")
}

#[cfg(test)]
mod tests {
    use super::{script_entry, shim_targets};
    use std::fs;
    use std::path::PathBuf;

    const PNPM_SHIM: &str = r#"#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/../global/v11/abc/node_modules/@kikedealba/bita/dist/bin/bita.js" "$@"
else
  exec node  "$basedir/../global/v11/abc/node_modules/@kikedealba/bita/dist/bin/bita.js" "$@"
fi
"#;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("bita-desktop-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch");
        directory
    }

    #[test]
    fn finds_the_javascript_behind_a_pnpm_shim() {
        assert_eq!(
            shim_targets(PNPM_SHIM),
            vec![
                "../global/v11/abc/node_modules/@kikedealba/bita/dist/bin/bita.js",
                "../global/v11/abc/node_modules/@kikedealba/bita/dist/bin/bita.js",
            ]
        );

        let root = scratch("shim");
        let bin = root.join("bin");
        let entry = root.join("global/v11/abc/node_modules/@kikedealba/bita/dist/bin/bita.js");
        fs::create_dir_all(&bin).expect("bin");
        fs::create_dir_all(entry.parent().expect("parent")).expect("entry dir");
        fs::write(&entry, "#!/usr/bin/env node\n").expect("entry");
        fs::write(bin.join("bita"), PNPM_SHIM).expect("shim");

        let resolved = script_entry(&bin.join("bita")).expect("resolved");
        assert_eq!(resolved, fs::canonicalize(&entry).expect("canonical"));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_a_node_script_or_a_symlink_to_one() {
        let root = scratch("node");
        let entry = root.join("bita.js");
        fs::write(&entry, "#!/usr/bin/env node\nconsole.log(1)\n").expect("entry");
        let link = root.join("bita");
        std::os::unix::fs::symlink(&entry, &link).expect("symlink");
        assert_eq!(script_entry(&link), Some(fs::canonicalize(&entry).expect("canonical")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_shell_script_without_a_javascript_target_is_skipped() {
        let root = scratch("other");
        let script = root.join("bita");
        fs::write(&script, "#!/bin/sh\necho hi\n").expect("script");
        assert_eq!(script_entry(&script), None);
        let _ = fs::remove_dir_all(&root);
    }
}
