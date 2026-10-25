use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Wry,
};

use crate::model::{LiveTimer, Problem, ProblemKind};

pub const ID: &str = "bita";

const TEMPLATE_ICON: &[u8] = include_bytes!("../icons/trayTemplate@2x.png");

const MAX_LABEL_CHARS: usize = 12;

const UNNAMED: &str = "sin nombre";

const UNNAMED_ROW: &str = "Sin nombre";

const TOOLTIP: &str = "Den — clic para ver los cronómetros";

const IDLE_HEADER: &str = "Ningún cronómetro corriendo";

const SEPARATOR: &str = " · ";

const SETTINGS_FILE: &str = "menubar.json";

pub const OPEN: &str = "tray-open";

pub const QUIT: &str = "tray-quit";

pub fn actions(macos: bool) -> &'static [(&'static str, &'static str)] {
    if macos {
        &[]
    } else {
        &[(OPEN, "Abrir Den"), (QUIT, "Salir de Den")]
    }
}

fn append_actions(app: &AppHandle, menu: &Menu<Wry>) -> tauri::Result<()> {
    let wanted = actions(cfg!(target_os = "macos"));
    if wanted.is_empty() {
        return Ok(());
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (id, label) in wanted {
        let item: MenuItem<Wry> = MenuItem::with_id(app, *id, *label, true, None::<&str>)?;
        let entry: &dyn IsMenuItem<Wry> = &item;
        menu.append(entry)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TraySettings {
    pub show_label: bool,
    pub hide_when_idle: bool,
}

impl Default for TraySettings {
    fn default() -> Self {
        Self { show_label: true, hide_when_idle: false }
    }
}

#[derive(Default)]
pub struct TrayList {
    shown: Mutex<Shown>,
    settings: Mutex<Option<TraySettings>>,
}

#[derive(Default)]
struct Shown {
    key: Option<String>,
    rows: Vec<(MenuItem<Wry>, String)>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(app, &[&MenuItem::new(app, IDLE_HEADER, false, None::<&str>)?])?;
    append_actions(app, &menu)?;

    TrayIconBuilder::with_id(ID)
        .icon(tray_icon(app)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;

    Ok(())
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(SETTINGS_FILE))
}

pub fn read_settings(path: &Path) -> TraySettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<TraySettings>(&text).ok())
        .unwrap_or_default()
}

pub fn write_settings(path: &Path, settings: &TraySettings) -> Result<(), Problem> {
    let unwritable = |error: std::io::Error| {
        Problem::new(ProblemKind::Unreadable, format!("No pude guardar {}: {error}", path.display()))
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(unwritable)?;
    }
    let text = serde_json::to_string_pretty(settings).unwrap_or_else(|_| "{}".into());
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    if let Err(error) = fs::write(&temp, text).and_then(|_| fs::rename(&temp, path)) {
        let _ = fs::remove_file(&temp);
        return Err(unwritable(error));
    }
    Ok(())
}

pub fn settings(app: &AppHandle) -> TraySettings {
    let state = app.state::<TrayList>();
    let mut cached = state.settings.lock().expect("tray settings poisoned");
    *cached.get_or_insert_with(|| settings_path(app).map(|path| read_settings(&path)).unwrap_or_default())
}

#[tauri::command]
pub fn menubar_settings(app: AppHandle) -> TraySettings {
    settings(&app)
}

#[tauri::command]
pub fn menubar_settings_set(app: AppHandle, settings: TraySettings) -> Result<TraySettings, Problem> {
    let path = settings_path(&app)
        .ok_or_else(|| Problem::new(ProblemKind::Unreadable, "No sé dónde guardar los ajustes de la barra de menús."))?;
    write_settings(&path, &settings)?;
    *app.state::<TrayList>().settings.lock().expect("tray settings poisoned") = Some(settings);
    Ok(settings)
}

pub fn icon_visible(running: &[LiveTimer], settings: TraySettings) -> bool {
    !(settings.hide_when_idle && running.is_empty())
}

pub fn set_visible(app: &AppHandle, visible: bool) {
    if let Some(tray) = app.tray_by_id(ID) {
        let _ = tray.set_visible(visible);
    }
}

pub fn update_list(app: &AppHandle, running: &[LiveTimer]) {
    let ordered = by_start(running);
    let key = list_key(&ordered);
    let texts: Vec<String> = ordered.iter().map(|timer| row_text(timer)).collect();
    let state = app.state::<TrayList>();
    let mut shown = state.shown.lock().expect("tray list poisoned");

    if shown.key.as_deref() == Some(key.as_str()) {
        for ((item, current), text) in shown.rows.iter_mut().zip(texts) {
            if *current != text {
                let _ = item.set_text(&text);
                *current = text;
            }
        }
        return;
    }

    let Some(tray) = app.tray_by_id(ID) else {
        return;
    };
    let Ok(rows) = build_rows(app, &texts) else {
        return;
    };
    let Ok(header) = MenuItem::new(app, header_text(ordered.len()), false, None::<&str>) else {
        return;
    };
    let Ok(menu) = Menu::with_items(app, &[&header]) else {
        return;
    };
    for (item, _) in &rows {
        let _ = menu.append(item);
    }
    let _ = append_actions(app, &menu);
    if tray.set_menu(Some(menu)).is_ok() {
        shown.key = Some(key);
        shown.rows = rows;
    }
}

fn build_rows(app: &AppHandle, texts: &[String]) -> tauri::Result<Vec<(MenuItem<Wry>, String)>> {
    texts
        .iter()
        .map(|text| Ok((MenuItem::new(app, text, false, None::<&str>)?, text.clone())))
        .collect()
}

fn by_start(running: &[LiveTimer]) -> Vec<&LiveTimer> {
    let mut ordered: Vec<&LiveTimer> = running.iter().collect();
    ordered.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then(left.id.cmp(&right.id))
    });
    ordered
}

fn list_key(ordered: &[&LiveTimer]) -> String {
    ordered
        .iter()
        .map(|timer| {
            format!(
                "{}\u{1f}{}\u{1f}{}\u{1f}{}",
                timer.id,
                timer.title.as_deref().unwrap_or_default(),
                timer.project_name.as_deref().unwrap_or_default(),
                timer.draft
            )
        })
        .collect::<Vec<_>>()
        .join("\u{1e}")
}

pub fn header_text(count: usize) -> String {
    match count {
        0 => IDLE_HEADER.to_string(),
        1 => "1 cronómetro corriendo".to_string(),
        many => format!("{many} cronómetros corriendo"),
    }
}

pub fn row_text(timer: &LiveTimer) -> String {
    let title = timer
        .title
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(UNNAMED_ROW);
    let mut parts = vec![title.to_string()];
    if let Some(project) = timer.project_name.as_deref() {
        parts.push(project.to_string());
    }
    parts.push(format_clock(timer.elapsed_seconds));
    parts.join(SEPARATOR)
}

fn tray_icon(app: &AppHandle) -> tauri::Result<Image<'static>> {
    if !cfg!(target_os = "macos") {
        if let Some(icon) = app.default_window_icon() {
            return Ok(icon.clone().to_owned());
        }
    }
    Image::from_bytes(TEMPLATE_ICON)
}

pub fn set_title(app: &AppHandle, title: &str) {
    if let Some(tray) = app.tray_by_id(ID) {
        #[cfg(not(windows))]
        let _ = tray.set_title(Some(title));
        #[cfg(not(target_os = "macos"))]
        let _ = tray.set_tooltip(Some(tooltip_for(title)));
    }
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn tooltip_for(title: &str) -> String {
    if title.is_empty() {
        TOOLTIP.to_string()
    } else {
        format!("Den — {title}")
    }
}

pub fn format_title(running: &[LiveTimer], show_label: bool) -> String {
    let Some(leader) = running.iter().min_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then(left.id.cmp(&right.id))
    }) else {
        return String::new();
    };

    let clock = format_clock(leader.elapsed_seconds);

    if running.len() > 1 {
        return format!("{clock} +{}", running.len() - 1);
    }

    match label(leader).filter(|_| show_label) {
        Some(text) => format!("{clock} {text}"),
        None => clock,
    }
}

fn label(timer: &LiveTimer) -> Option<String> {
    if let Some(project) = timer.project_name.as_deref() {
        return Some(truncate(project, MAX_LABEL_CHARS));
    }
    if timer.draft {
        return Some(UNNAMED.to_string());
    }
    None
}

fn format_clock(seconds: i64) -> String {
    let minutes = seconds.max(0) / 60;
    format!("{}:{:02}", minutes / 60, minutes % 60)
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit.saturating_sub(1)).collect();
    format!("{}\u{2026}", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::{
        actions, by_start, format_clock, format_title, header_text, icon_visible, list_key, read_settings, row_text,
        tooltip_for, truncate, write_settings, TraySettings, TOOLTIP,
    };
    use crate::model::LiveTimer;

    fn timer(
        id: i64,
        started_at: &str,
        elapsed: i64,
        project: Option<&str>,
        draft: bool,
    ) -> LiveTimer {
        LiveTimer {
            id,
            title: if draft { None } else { Some("Algo".into()) },
            doc_rel_path: None,
            sections_written: None,
            sections_total: None,
            touched_since_note: None,
            project_name: project.map(str::to_string),
            project_id: project.map(|_| 1),
            started_at: started_at.into(),
            start_local: started_at.into(),
            elapsed_seconds: elapsed,
            draft,
            kind: None,
        }
    }

    #[test]
    fn nothing_running_shows_no_title() {
        assert_eq!(format_title(&[], true), "");
    }

    #[test]
    fn one_timer_shows_the_clock_and_its_project() {
        let running = vec![timer(733, "2026-09-20T05:48:20Z", 3480, Some("Pharma STI"), false)];
        assert_eq!(format_title(&running, true), "0:58 Pharma STI");
    }

    #[test]
    fn a_draft_without_a_project_asks_to_be_named() {
        let running = vec![timer(734, "2026-09-20T06:42:46Z", 198, None, true)];
        assert_eq!(format_title(&running, true), "0:03 sin nombre");
    }

    #[test]
    fn a_named_timer_without_a_project_shows_only_the_clock() {
        let running = vec![timer(735, "2026-09-20T04:00:00Z", 7200, None, false)];
        assert_eq!(format_title(&running, true), "2:00");
    }

    #[test]
    fn several_timers_count_the_rest_behind_the_oldest() {
        let running = vec![
            timer(734, "2026-09-20T06:42:46Z", 198, None, true),
            timer(733, "2026-09-20T05:48:20Z", 3480, Some("Pharma STI"), false),
        ];
        assert_eq!(format_title(&running, true), "0:58 +1");
    }

    #[test]
    fn a_long_project_name_is_cut_so_the_menu_bar_stays_put() {
        let running = vec![timer(
            1,
            "2026-09-20T05:00:00Z",
            60,
            Some("Plataforma de Reservas"),
            false,
        )];
        assert_eq!(format_title(&running, true), "0:01 Plataforma\u{2026}");
    }

    #[test]
    fn the_clock_counts_whole_minutes_only() {
        assert_eq!(format_clock(0), "0:00");
        assert_eq!(format_clock(59), "0:00");
        assert_eq!(format_clock(60), "0:01");
        assert_eq!(format_clock(3599), "0:59");
        assert_eq!(format_clock(3600), "1:00");
        assert_eq!(format_clock(36_000), "10:00");
    }

    #[test]
    fn the_tooltip_carries_the_clock_where_there_is_no_title() {
        assert_eq!(tooltip_for(""), TOOLTIP);
        assert_eq!(tooltip_for("0:58 Pharma STI"), "Den — 0:58 Pharma STI");
    }

    #[test]
    fn truncation_keeps_short_names_whole() {
        assert_eq!(truncate("bita", 12), "bita");
        assert_eq!(truncate("Pharma STI", 12), "Pharma STI");
    }

    #[test]
    fn a_menu_row_shows_title_project_and_clock() {
        let named = timer(733, "2026-09-20T05:48:20Z", 3480, Some("Pharma STI"), false);
        assert_eq!(row_text(&named), "Algo · Pharma STI · 0:58");
        let draft = timer(734, "2026-09-20T06:42:46Z", 198, None, true);
        assert_eq!(row_text(&draft), "Sin nombre · 0:03");
    }

    #[test]
    fn the_menu_header_counts_the_timers() {
        assert_eq!(header_text(0), "Ningún cronómetro corriendo");
        assert_eq!(header_text(1), "1 cronómetro corriendo");
        assert_eq!(header_text(3), "3 cronómetros corriendo");
    }

    #[test]
    fn the_list_key_ignores_the_clock_but_not_the_names() {
        let before = timer(733, "2026-09-20T05:48:20Z", 60, Some("Pharma STI"), false);
        let later = timer(733, "2026-09-20T05:48:20Z", 3600, Some("Pharma STI"), false);
        let renamed = timer(733, "2026-09-20T05:48:20Z", 3600, Some("Otro"), false);
        assert_eq!(list_key(&[&before]), list_key(&[&later]));
        assert_ne!(list_key(&[&before]), list_key(&[&renamed]));
    }

    #[test]
    fn a_tie_on_start_time_leads_with_the_lower_id() {
        let running = vec![
            timer(9, "2026-09-20T05:00:00Z", 60, Some("Nueve"), false),
            timer(4, "2026-09-20T05:00:00Z", 60, Some("Cuatro"), false),
        ];
        assert_eq!(format_title(&running, true), "0:01 +1");
        let ordered: Vec<i64> = by_start(&running).iter().map(|row| row.id).collect();
        assert_eq!(ordered, vec![4, 9]);
    }

    #[test]
    fn three_timers_count_two_behind_the_oldest() {
        let running = vec![
            timer(3, "2026-09-20T07:00:00Z", 10, None, true),
            timer(1, "2026-09-20T05:00:00Z", 7200, Some("Pharma STI"), false),
            timer(2, "2026-09-20T06:00:00Z", 10, None, false),
        ];
        assert_eq!(format_title(&running, true), "2:00 +2");
    }

    #[test]
    fn the_menu_lists_timers_oldest_first_whatever_the_input_order() {
        let running = vec![
            timer(2, "2026-09-20T06:00:00Z", 10, None, false),
            timer(1, "2026-09-20T05:00:00Z", 10, None, false),
        ];
        let ordered: Vec<i64> = by_start(&running).iter().map(|row| row.id).collect();
        assert_eq!(ordered, vec![1, 2]);
        assert!(by_start(&[]).is_empty());
    }

    #[test]
    fn truncation_cuts_exactly_past_the_limit() {
        assert_eq!(truncate("123456789012", 12), "123456789012");
        assert_eq!(truncate("1234567890123", 12), "12345678901\u{2026}");
    }

    #[test]
    fn truncation_counts_characters_not_bytes() {
        assert_eq!(truncate("ñandú ñandú", 12), "ñandú ñandú");
        assert_eq!(truncate("áéíóúáéíóúáéíóú", 12), "áéíóúáéíóúá\u{2026}");
    }

    #[test]
    fn truncation_does_not_leave_a_space_before_the_ellipsis() {
        assert_eq!(truncate("Plataforma  de Reservas", 12), "Plataforma\u{2026}");
    }

    #[test]
    fn truncation_to_zero_or_one_keeps_only_the_ellipsis() {
        assert_eq!(truncate("bita", 0), "\u{2026}");
        assert_eq!(truncate("bita", 1), "\u{2026}");
    }

    #[test]
    fn a_negative_clock_reads_as_zero() {
        assert_eq!(format_clock(-90), "0:00");
        assert_eq!(format_clock(i64::MIN), "0:00");
    }

    #[test]
    fn a_blank_title_reads_as_unnamed_in_the_menu() {
        let mut blank = timer(1, "2026-09-20T05:00:00Z", 60, None, false);
        blank.title = Some("   ".into());
        assert_eq!(row_text(&blank), "Sin nombre · 0:01");
        blank.title = Some("".into());
        assert_eq!(row_text(&blank), "Sin nombre · 0:01");
    }

    #[test]
    fn a_menu_title_is_trimmed() {
        let mut padded = timer(1, "2026-09-20T05:00:00Z", 60, Some("Pharma STI"), false);
        padded.title = Some("  Revisión  ".into());
        assert_eq!(row_text(&padded), "Revisión · Pharma STI · 0:01");
    }

    #[test]
    fn a_menu_row_keeps_the_whole_project_name() {
        let long = timer(1, "2026-09-20T05:00:00Z", 60, Some("Plataforma de Reservas"), false);
        assert_eq!(row_text(&long), "Algo · Plataforma de Reservas · 0:01");
    }

    #[test]
    fn the_list_key_changes_with_membership_order_draft_and_title() {
        let one = timer(1, "2026-09-20T05:00:00Z", 60, Some("A"), false);
        let two = timer(2, "2026-09-20T06:00:00Z", 60, Some("B"), false);
        assert_ne!(list_key(&[&one]), list_key(&[&one, &two]));
        assert_ne!(list_key(&[&one, &two]), list_key(&[&two, &one]));
        let mut drafted = one.clone();
        drafted.draft = true;
        assert_ne!(list_key(&[&one]), list_key(&[&drafted]));
        let mut retitled = one.clone();
        retitled.title = Some("Otro".into());
        assert_ne!(list_key(&[&one]), list_key(&[&retitled]));
        assert_eq!(list_key(&[]), "");
    }

    #[test]
    fn the_list_key_does_not_confuse_a_missing_project_with_a_missing_title() {
        let mut titled = timer(1, "2026-09-20T05:00:00Z", 60, None, false);
        titled.title = Some("X".into());
        let mut projected = timer(1, "2026-09-20T05:00:00Z", 60, Some("X"), false);
        projected.title = None;
        assert_ne!(list_key(&[&titled]), list_key(&[&projected]));
    }

    #[test]
    fn the_menu_header_counts_one_as_singular_and_many_as_plural() {
        assert_eq!(header_text(2), "2 cronómetros corriendo");
        assert_eq!(header_text(10), "10 cronómetros corriendo");
    }

    #[test]
    fn hiding_the_label_leaves_only_the_clock() {
        let running = vec![timer(733, "2026-09-20T05:48:20Z", 3480, Some("Pharma STI"), false)];
        assert_eq!(format_title(&running, false), "0:58");
        let several = vec![
            timer(734, "2026-09-20T06:42:46Z", 198, None, true),
            timer(733, "2026-09-20T05:48:20Z", 3480, Some("Pharma STI"), false),
        ];
        assert_eq!(format_title(&several, false), "0:58 +1");
    }

    #[test]
    fn the_icon_hides_only_when_asked_and_idle() {
        let running = vec![timer(733, "2026-09-20T05:48:20Z", 60, None, false)];
        let hide = TraySettings { show_label: true, hide_when_idle: true };
        assert!(icon_visible(&[], TraySettings::default()));
        assert!(!icon_visible(&[], hide));
        assert!(icon_visible(&running, hide));
    }

    #[test]
    fn settings_round_trip_and_fall_back_to_defaults() {
        let dir = std::env::temp_dir().join(format!("den-menubar-{}", std::process::id()));
        let path = dir.join("menubar.json");
        assert_eq!(read_settings(&path), TraySettings::default());
        let chosen = TraySettings { show_label: false, hide_when_idle: true };
        write_settings(&path, &chosen).expect("settings written");
        assert_eq!(read_settings(&path), chosen);
        std::fs::write(&path, "{\"hideWhenIdle\": true}").expect("partial file written");
        assert_eq!(read_settings(&path), TraySettings { show_label: true, hide_when_idle: true });
        std::fs::write(&path, "not json").expect("broken file written");
        assert_eq!(read_settings(&path), TraySettings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_and_quit_stay_in_the_tray_menu_outside_macos() {
        assert!(actions(true).is_empty());
        let labels: Vec<&str> = actions(false).iter().map(|(_, label)| *label).collect();
        assert_eq!(labels, vec!["Abrir Den", "Salir de Den"]);
        assert_eq!(actions(false)[0].0, super::OPEN);
        assert_eq!(actions(false)[1].0, super::QUIT);
    }
}
