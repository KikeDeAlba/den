use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Wry,
};

use crate::model::LiveTimer;

pub const ID: &str = "bita";

const TEMPLATE_ICON: &[u8] = include_bytes!("../icons/trayTemplate@2x.png");

const MAX_LABEL_CHARS: usize = 12;

const UNNAMED: &str = "sin nombre";

const UNNAMED_ROW: &str = "Sin nombre";

const TOOLTIP: &str = "Den — clic para ver los cronómetros";

const IDLE_HEADER: &str = "Ningún cronómetro corriendo";

const SEPARATOR: &str = " · ";

#[derive(Default)]
pub struct TrayList {
    shown: Mutex<Shown>,
}

#[derive(Default)]
struct Shown {
    key: Option<String>,
    rows: Vec<(MenuItem<Wry>, String)>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(app, &[&MenuItem::new(app, IDLE_HEADER, false, None::<&str>)?])?;

    TrayIconBuilder::with_id(ID)
        .icon(tray_icon(app)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;

    Ok(())
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

pub fn format_title(running: &[LiveTimer]) -> String {
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

    match label(leader) {
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
    use super::{format_clock, format_title, header_text, list_key, row_text, tooltip_for, truncate, TOOLTIP};
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
        assert_eq!(format_title(&[]), "");
    }

    #[test]
    fn one_timer_shows_the_clock_and_its_project() {
        let running = vec![timer(733, "2026-09-20T05:48:20Z", 3480, Some("Pharma STI"), false)];
        assert_eq!(format_title(&running), "0:58 Pharma STI");
    }

    #[test]
    fn a_draft_without_a_project_asks_to_be_named() {
        let running = vec![timer(734, "2026-09-20T06:42:46Z", 198, None, true)];
        assert_eq!(format_title(&running), "0:03 sin nombre");
    }

    #[test]
    fn a_named_timer_without_a_project_shows_only_the_clock() {
        let running = vec![timer(735, "2026-09-20T04:00:00Z", 7200, None, false)];
        assert_eq!(format_title(&running), "2:00");
    }

    #[test]
    fn several_timers_count_the_rest_behind_the_oldest() {
        let running = vec![
            timer(734, "2026-09-20T06:42:46Z", 198, None, true),
            timer(733, "2026-09-20T05:48:20Z", 3480, Some("Pharma STI"), false),
        ];
        assert_eq!(format_title(&running), "0:58 +1");
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
        assert_eq!(format_title(&running), "0:01 Plataforma\u{2026}");
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
}
