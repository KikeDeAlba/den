use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::cli;
use crate::registry::{self, Origin, Tool, ToolState, ToolStatus, ToolsStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Health {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    pub health: Health,
    pub title: String,
    pub detail: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCard {
    pub tool: String,
    pub title: String,
    pub purpose: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub checks: Vec<Check>,
    pub install: Vec<InstallCard>,
    pub blocked: bool,
    pub tools: ToolsStatus,
}

fn capability_line(status: &ToolStatus) -> String {
    if status.capabilities.is_empty() {
        return "sin capacidades declaradas".into();
    }
    status.capabilities.join(", ")
}

fn tool_check(status: &ToolStatus) -> Check {
    let version = status.version.as_deref().map(|value| format!(" {value}")).unwrap_or_default();
    let command = status.command.clone().unwrap_or_default();
    match status.state {
        ToolState::Ready => Check {
            id: format!("tool:{}", status.name),
            health: Health::Ok,
            title: match status.origin {
                Some(Origin::Override) => format!("{}{version}, desde la variable de entorno", status.name),
                _ => format!("{}{version}", status.name),
            },
            detail: format!("{command}\n{}", capability_line(status)),
            note: (!status.verified && status.known)
                .then(|| "No contestó capabilities --json: uso lo que declara.".into()),
        },
        ToolState::Unresponsive => Check {
            id: format!("tool:{}", status.name),
            health: Health::Warn,
            title: format!("{}{version} está registrado pero no responde", status.name),
            detail: command,
            note: Some(format!("Reinstálalo: {}", status.install)),
        },
        ToolState::BrokenBin => Check {
            id: format!("tool:{}", status.name),
            health: Health::Fail,
            title: format!("{} está registrado, pero su ejecutable ya no existe", status.name),
            detail: command,
            note: Some(format!("Reinstálalo: {}", status.install)),
        },
        ToolState::Missing => Check {
            id: format!("tool:{}", status.name),
            health: Health::Warn,
            title: format!("{} no está instalado", status.name),
            detail: status.purpose.clone().unwrap_or_default(),
            note: Some(status.install.clone()),
        },
    }
}

fn database_check(database: &Path) -> Check {
    if database.is_file() {
        let size = fs::metadata(database).map(|meta| meta.len()).unwrap_or(0);
        return Check {
            id: "database".into(),
            health: Health::Ok,
            title: format!("Tu bitácora, {} KB", size / 1024),
            detail: database.display().to_string(),
            note: None,
        };
    }
    Check {
        id: "database".into(),
        health: Health::Warn,
        title: "Todavía no hay bitácora".into(),
        detail: database.display().to_string(),
        note: Some("Se crea sola con el primer cronómetro.".into()),
    }
}

fn docs_check(status: &ToolsStatus, root: &Path) -> Check {
    let pending = status.inkwell_migrated == Some(false);
    Check {
        id: "docs".into(),
        health: if pending { Health::Warn } else { Health::Ok },
        title: "Las páginas y las notas de cada cronómetro se leen con inkwell".into(),
        detail: root.display().to_string(),
        note: pending.then(|| {
            "inkwell todavía no trae los docs ni las notas de bita: inkwell migrate --from-bita && inkwell migrate notes --from-bita".into()
        }),
    }
}

pub fn build(status: ToolsStatus, database: &Path) -> Report {
    let mut checks = vec![Check {
        id: "registry".into(),
        health: Health::Ok,
        title: "Registro de herramientas".into(),
        detail: status.registry_dir.clone(),
        note: None,
    }];
    checks.extend(status.tools.iter().map(tool_check));
    for invalid in &status.invalid {
        checks.push(Check {
            id: format!("invalid:{}", invalid.file),
            health: Health::Warn,
            title: format!("El manifiesto {}.json no es válido", invalid.file),
            detail: invalid.problems.join("\n"),
            note: None,
        });
    }
    if status.tool(Tool::Inkwell).is_some_and(|found| found.ready()) {
        checks.push(docs_check(&status, &registry::inkwell_docs_root()));
    }
    if status.tool(Tool::Bita).is_some_and(|found| found.ready()) {
        checks.push(database_check(database));
    }

    let install = status
        .tools
        .iter()
        .filter(|found| found.known && found.state != ToolState::Ready)
        .map(|found| InstallCard {
            tool: found.name.clone(),
            title: format!("Instalar {}", found.name),
            purpose: found.purpose.clone().unwrap_or_default(),
            command: found.install.clone(),
        })
        .collect();

    let blocked = !status.tools.iter().any(|found| found.known && found.ready());
    Report {
        checks,
        install,
        blocked,
        tools: status,
    }
}

pub async fn report() -> Report {
    let status = registry::global().status().await;
    build(status, &cli::database_path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{Modules, KNOWN};

    fn status_with(ready: &[Tool]) -> ToolsStatus {
        ToolsStatus {
            registry_dir: "/sandbox/tools.d".into(),
            tools: KNOWN
                .iter()
                .map(|tool| ToolStatus {
                    name: tool.name().into(),
                    known: true,
                    state: if ready.contains(tool) { ToolState::Ready } else { ToolState::Missing },
                    version: ready.contains(tool).then(|| "1.0.0".into()),
                    capabilities: Vec::new(),
                    verified: true,
                    origin: ready.contains(tool).then_some(Origin::Registry),
                    command: None,
                    manifest: None,
                    install: tool.default_install(),
                    purpose: Some(tool.purpose().into()),
                })
                .collect(),
            invalid: vec![registry::Invalid { file: "odd".into(), problems: vec!["name must be lowercase letters, digits and dashes".into()] }],
            modules: Modules::default(),
            inkwell_migrated: None,
        }
    }

    #[test]
    fn missing_tools_become_install_cards() {
        let report = build(status_with(&[Tool::Bita]), Path::new("/nope/bita.db"));
        assert!(!report.blocked);
        let names: Vec<&str> = report.install.iter().map(|card| card.tool.as_str()).collect();
        assert_eq!(names, vec!["inkwell", "tally", "atl", "recap", "gaze"]);
        assert_eq!(report.install[1].command, "npm install -g @kikedealba/tally && tally setup");
        assert!(report.install[1].purpose.contains("Jira"));
        assert!(report.checks.iter().any(|check| check.id == "database"));
        assert!(!report.checks.iter().any(|check| check.id == "docs"));
        assert!(report.checks.iter().any(|check| check.id == "invalid:odd"));
    }

    #[test]
    fn nothing_installed_blocks_the_app() {
        let report = build(status_with(&[]), Path::new("/nope/bita.db"));
        assert!(report.blocked);
        assert_eq!(report.install.len(), 6);
        assert!(!report.checks.iter().any(|check| check.id == "database"));
    }

    #[test]
    fn inkwell_reads_the_docs_and_says_when_it_still_has_to_migrate() {
        let mut status = status_with(&[Tool::Bita, Tool::Inkwell, Tool::Tally]);
        let report = build(status.clone(), Path::new("/nope/bita.db"));
        let docs = report.checks.iter().find(|check| check.id == "docs").expect("docs");
        assert_eq!(docs.health, Health::Ok);
        assert!(docs.note.is_none());
        let names: Vec<&str> = report.install.iter().map(|card| card.tool.as_str()).collect();
        assert_eq!(names, vec!["atl", "recap", "gaze"]);

        status.inkwell_migrated = Some(false);
        let report = build(status, Path::new("/nope/bita.db"));
        let docs = report.checks.iter().find(|check| check.id == "docs").expect("docs");
        assert_eq!(docs.health, Health::Warn);
        assert!(docs.note.as_deref().is_some_and(|note| note.contains("migrate notes")));
    }
}
