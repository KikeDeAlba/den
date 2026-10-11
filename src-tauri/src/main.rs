mod activation;
mod ask;
mod atlassian_cmd;
mod cli;
mod commands;
mod coworkers;
mod docs;
mod doctor;
mod worked;
mod menu;
mod model;
mod notes;
mod media;
mod live;
mod live_wide;
mod meeting;
mod notes_cmd;
mod panel;
mod pay;
mod pdf;
mod report_export;
mod coworker_export;
mod platform;
mod proposals;
mod recap;
mod registry;
mod report;
mod reports;
#[cfg(target_os = "macos")]
mod screen;
mod state;
mod sync;
mod tools;
mod tray;
mod watch;

use std::time::Duration;

use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::{interval, MissedTickBehavior};

use panel::TrayAnchor;
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
            panel::toggle(app);
        }))
        .plugin(live::shortcut_plugin())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new())
        .manage(live::LiveSession::default())
        .manage(TrayAnchor::default())
        .manage(notes::NotesFocus::default())
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
            report::report,
            pay::get_pay,
            pay::set_pay,
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
            commands::open_notes,
            commands::open_reports,
            commands::notes_take_focus,
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
            commands::open_notes_meeting,
            commands::notes_take_meeting,
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
            live::live_open_settings,
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
            match event.id().as_ref() {
                menu::LIVE => live::toggle(app),
                menu::LIVE_WIDE => live::open_wide(app),
                _ => {}
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tools::migrate_app_settings(app.handle());
            menu::create(app.handle())?;
            tray::create(app.handle())?;
            panel::wire(app.handle());
            watch::spawn(app.handle().clone(), cli::database_path());
            tools::ensure_inkwell_watchers(app.handle());
            tools::spawn_watch(app.handle().clone());
            tools::warm(app.handle().clone());
            live::register_shortcut(app.handle());
            live::spawn_watch(app.handle().clone());
            spawn_refresh(app.handle().clone());
            spawn_tick(app.handle().clone());
            sync::spawn(app.handle().clone());
            if notes::opens_on_start() {
                notes::open(app.handle(), None)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Den");
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
        let mut shown_title = String::new();
        loop {
            ticker.tick().await;
            let snapshot = app.state::<AppState>().snapshot(Utc::now());
            let title = tray::format_title(&snapshot.running);
            if title != shown_title {
                tray::set_title(&app, &title);
                shown_title = title;
            }
            if panel::is_visible(&app) {
                let _ = app.emit(SNAPSHOT_EVENT, &snapshot);
            }
        }
    });
}
