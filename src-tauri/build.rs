const AGENT_COMMANDS: &[&str] = &[
    "agent_spawn",
    "agent_attach",
    "agent_write",
    "agent_resize",
    "agent_send",
    "agent_kill",
    "agent_close",
    "agent_list",
    "agent_sessions",
    "agent_dirs",
    "agent_pick_folder",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "agents",
        tauri_build::InlinedPlugin::new()
            .commands(AGENT_COMMANDS)
            .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
    ))
    .expect("failed to run the tauri build script");
}
