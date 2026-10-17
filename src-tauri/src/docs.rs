use serde_json::Value;

use crate::cli::{CallOptions, Cli};
use crate::model::{Problem, ProblemKind};
use crate::registry::{self, Modules, Tool, ToolsStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature {
    Notes,
    EntryNotes,
    Jira,
    Backlog,
    History,
    ConfluenceSync,
    Proposals,
    Meetings,
    Atlassian,
    Graph,
    GraphSearch,
}

impl Feature {
    fn enabled(self, modules: &Modules) -> bool {
        match self {
            Feature::Notes => modules.notes,
            Feature::EntryNotes => modules.entry_notes,
            Feature::Jira => modules.jira,
            Feature::Backlog => modules.backlog,
            Feature::History => modules.history,
            Feature::ConfluenceSync => modules.confluence_sync,
            Feature::Proposals => modules.proposals,
            Feature::Meetings => modules.meetings,
            Feature::Atlassian => modules.atlassian,
            Feature::Graph => modules.graph,
            Feature::GraphSearch => modules.graph_search,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Feature::Notes => "leer las páginas",
            Feature::EntryNotes => "las notas de cada cronómetro",
            Feature::Jira => "lo pendiente de pasar a Jira",
            Feature::Backlog => "el backlog",
            Feature::History => "el historial de las páginas",
            Feature::ConfluenceSync => "sincronizar con Confluence",
            Feature::Proposals => "los cambios propuestos",
            Feature::Meetings => "las reuniones",
            Feature::Atlassian => "las conexiones con Atlassian",
            Feature::Graph => "ver el cerebro de los proyectos",
            Feature::GraphSearch => "buscar en el cerebro",
        }
    }

    fn provider(self) -> Tool {
        match self {
            Feature::Notes
            | Feature::EntryNotes
            | Feature::Backlog
            | Feature::History
            | Feature::ConfluenceSync => Tool::Inkwell,
            Feature::Jira => Tool::Tally,
            Feature::Proposals | Feature::Meetings => Tool::Recap,
            Feature::Atlassian => Tool::Atl,
            Feature::Graph | Feature::GraphSearch => Tool::Gaze,
        }
    }
}

pub fn refusal(feature: Feature, status: &ToolsStatus) -> Option<Problem> {
    if feature.enabled(&status.modules) {
        return None;
    }
    let tool = match feature {
        Feature::Proposals if status.modules.meetings => Tool::Inkwell,
        other => other.provider(),
    };
    let present = status.tool(tool).is_some_and(|found| found.ready());
    let hint = status
        .tool(tool)
        .map(|found| found.install.clone())
        .unwrap_or_else(|| tool.default_install());
    let message = if present {
        format!("La versión instalada de {} no ofrece {}.", tool.name(), feature.label())
    } else {
        format!("Para {} hace falta instalar {}.", feature.label(), tool.name())
    };
    Some(Problem::new(ProblemKind::ToolMissing, message).with_hint(Some(hint)))
}

pub async fn require(feature: Feature) -> Result<ToolsStatus, Problem> {
    let status = registry::global().status().await;
    match refusal(feature, &status) {
        Some(problem) => Err(problem),
        None => Ok(status),
    }
}

pub async fn call(feature: Feature, args: &[&str], options: CallOptions) -> Result<(Option<Value>, Value), Problem> {
    require(feature).await?;
    let cli = Cli::for_tool(Tool::Inkwell).await?;
    cli.call_with_options::<Value>(args, options).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{ToolState, ToolStatus};

    fn status(ready: &[Tool], modules: Modules) -> ToolsStatus {
        ToolsStatus {
            registry_dir: "/r".into(),
            tools: registry::KNOWN
                .iter()
                .map(|tool| ToolStatus {
                    name: tool.name().into(),
                    known: true,
                    state: if ready.contains(tool) { ToolState::Ready } else { ToolState::Missing },
                    version: None,
                    capabilities: Vec::new(),
                    verified: false,
                    origin: None,
                    command: None,
                    manifest: None,
                    install: tool.default_install(),
                    purpose: None,
                })
                .collect(),
            invalid: Vec::new(),
            modules,
            inkwell_migrated: None,
        }
    }

    #[test]
    fn a_feature_that_is_off_names_the_tool_to_install() {
        let none = status(&[], Modules::default());
        let problem = refusal(Feature::Backlog, &none).expect("refused");
        assert_eq!(problem.kind, ProblemKind::ToolMissing);
        assert!(problem.message.contains("inkwell"));
        assert_eq!(problem.hint.as_deref(), Some("npm install -g @kikedealba/inkwell && inkwell setup"));

        let old = status(&[Tool::Inkwell], Modules { notes: true, ..Modules::default() });
        let problem = refusal(Feature::History, &old).expect("refused");
        assert!(problem.message.contains("no ofrece"));
        assert!(refusal(Feature::EntryNotes, &old).expect("refused").message.contains("no ofrece"));

        let bita = status(&[Tool::Bita], Modules { timers: true, hoy: true, ..Modules::default() });
        let jira = refusal(Feature::Jira, &bita).expect("refused");
        assert!(jira.message.contains("tally"));
        assert_eq!(jira.hint.as_deref(), Some("npm install -g @kikedealba/tally && tally setup"));
        assert!(refusal(Feature::EntryNotes, &bita).expect("refused").message.contains("inkwell"));
        assert!(refusal(Feature::Atlassian, &bita).expect("refused").message.contains("atl"));

        let meetings = status(&[Tool::Recap], Modules { meetings: true, ..Modules::default() });
        assert!(refusal(Feature::Meetings, &meetings).is_none());
        assert!(refusal(Feature::Proposals, &meetings).expect("refused").message.contains("inkwell"));
        assert!(refusal(Feature::Atlassian, &meetings).expect("refused").message.contains("atl"));

        let graph = refusal(Feature::Graph, &none).expect("refused");
        assert!(graph.message.contains("gaze"));
        assert_eq!(graph.hint.as_deref(), Some("cargo install --locked --git https://github.com/KikeDeAlba/gaze && gaze setup"));
        let brain = status(&[Tool::Gaze], Modules { graph: true, ..Modules::default() });
        assert!(refusal(Feature::Graph, &brain).is_none());
        assert!(refusal(Feature::GraphSearch, &brain).expect("refused").message.contains("no ofrece"));
    }
}
