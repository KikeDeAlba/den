mod activation;
mod agents;
mod ask;
mod atlassian_cmd;
mod cli;
mod commands;
mod coworkers;
mod docs;
mod doctor;
mod gaze;
mod worked;
mod menu;
mod model;
mod media;
mod live;
mod meeting;
mod minutes;
mod notes_cmd;
mod pay;
mod pdf;
mod report_export;
mod coworker_export;
mod platform;
mod proposals;
mod recap;
mod registry;
mod report;
mod shell;
mod state;
mod sync;
mod tools;
mod tray;
mod watch;

use std::time::Duration;

use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tokio::time::{interval, MissedTickBehavior};

use state::AppState;

const TICK: Duration = Duration::from_secs(1);
const REFRESH: Duration = Duration::from_secs(30);
const SNAPSHOT_EVENT: &str = "bita://snapshot";

fn main() {
    if tools::print_status_and_exit() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = shell::show(app);
        }))
        .plugin(live::shortcut_plugin())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(agents::plugin())
        .manage(AppState::new())
        .manage(live::LiveSession::default())
        .manage(tray::TrayList::default())
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            commands::refresh,
            commands::cli_info,
            commands::projects,
            commands::jira_projects,
            commands::start_timer,
            commands::stop_timer,
            commands::discard_timer,
            commands::amend_timer,
            commands::worked,
            commands::pending,
            commands::time_summary,
            report::report,
            pay::get_pay,
            pay::set_pay,
            tray::menubar_settings,
            tray::menubar_settings_set,
            coworkers::coworker_overtime,
            coworkers::overtime_excludes_list,
            coworkers::overtime_excludes_add,
            coworkers::overtime_excludes_remove,
            commands::scopes,
            commands::add_project,
            commands::set_scope,
            commands::unset_scope,
            commands::doctor_report,
            tools::tools_status,
            gaze::gaze_graph,
            gaze::gaze_show,
            gaze::gaze_search,
            notes_cmd::notes_tree,
            notes_cmd::notes_list,
            notes_cmd::notes_today,
            notes_cmd::notes_document,
            notes_cmd::page_document,
            notes_cmd::notes_search,
            notes_cmd::backlog_list,
            notes_cmd::backlog_set_status,
            notes_cmd::backlog_set_kind,
            notes_cmd::open_document,
            notes_cmd::page_asset,
            notes_cmd::open_external,
            notes_cmd::copy_text,
            meeting::meeting_for_entry,
            meeting::open_meeting_folder,
            meeting::meeting_by_id,
            minutes::meeting_transcript,
            minutes::meeting_summary,
            minutes::meeting_download,
            notes_cmd::notes_search_pages,
            notes_cmd::backlog_add,
            media::recap_list,
            media::search_transcripts,
            media::meeting_compress,
            media::meeting_strip_video,
            media::meeting_prune,
            media::meeting_delete,
            media::storage_report,
            media::reveal_in_finder,
            pdf::export_pdf,
            report_export::export_report,
            coworker_export::export_coworker_report,
            atlassian_cmd::atlassian_sites,
            atlassian_cmd::atlassian_site_add,
            atlassian_cmd::atlassian_site_test,
            atlassian_cmd::atlassian_site_remove,
            atlassian_cmd::project_atlassian,
            atlassian_cmd::confluence_sync,
            atlassian_cmd::confluence_sync_status,
            atlassian_cmd::confluence_resolve,
            live::live_state,
            live::live_show,
            live::live_hide,
            live::live_ask,
            live::live_cancel,
            live::live_sources,
            live::recap_config,
            live::recap_config_set,
            live::live_shortcut_set,
            live::open_source_file,
            live::live_transcript_full,
            live::live_mode_set,
            shell::navigate_to,
            proposals::docs_branch_diff,
            proposals::page_history,
            proposals::page_diff,
            proposals::page_restore,
            proposals::proposal_accept,
            proposals::proposal_reject,
            proposals::proposal_show,
            proposals::pending_proposals,
            commands::quit
        ])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(route) = menu::route_of(id) {
                let _ = shell::navigate(app, route);
                return;
            }
            match id {
                tray::OPEN => {
                    let _ = shell::show(app);
                }
                tray::QUIT | menu::QUIT => agents::request_quit(app),
                menu::LIVE => live::toggle(app),
                _ => {}
            }
        })
        .setup(|app| {
            activation::regular(app.handle());
            tools::migrate_app_settings(app.handle());
            menu::create(app.handle())?;
            tray::create(app.handle())?;
            shell::show(app.handle())?;
            watch::spawn(app.handle().clone(), cli::database_path());
            tools::ensure_inkwell_watchers(app.handle());
            tools::spawn_watch(app.handle().clone());
            tools::warm(app.handle().clone());
            live::register_shortcut(app.handle());
            live::spawn_watch(app.handle().clone());
            spawn_refresh(app.handle().clone());
            spawn_tick(app.handle().clone());
            sync::spawn(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Den")
        .run(on_run_event);
}

fn on_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::Exit = event {
        agents::hang_up_all(app);
        return;
    }
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = event {
        let _ = shell::show(app);
    }
}

fn spawn_refresh(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(REFRESH);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let state = app.state::<AppState>();
            state.refresh(&app).await;
        }
    });
}

fn spawn_tick(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(TICK);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut shown_title: Option<String> = None;
        let mut shown_icon: Option<bool> = None;
        loop {
            ticker.tick().await;
            let snapshot = app.state::<AppState>().snapshot(Utc::now());
            let settings = tray::settings(&app);
            let title = tray::format_title(&snapshot.running, settings.show_label);
            if shown_title.as_deref() != Some(title.as_str()) {
                tray::set_title(&app, &title);
                shown_title = Some(title);
            }
            let visible = tray::icon_visible(&snapshot.running, settings);
            if shown_icon != Some(visible) {
                tray::set_visible(&app, visible);
                shown_icon = Some(visible);
            }
            tray::update_list(&app, &snapshot.running);
            if shell::is_showing(&app) || live::is_visible(&app) {
                let _ = app.emit(SNAPSHOT_EVENT, &snapshot);
            }
        }
    });
}
