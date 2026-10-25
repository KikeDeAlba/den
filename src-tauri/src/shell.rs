use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::model::{Problem, ProblemKind};

pub const LABEL: &str = "main";
pub const NAVIGATE_EVENT: &str = "den://navigate";

const WIDTH: f64 = 1280.0;
const HEIGHT: f64 = 820.0;
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 600.0;
const SCREEN_SHARE: f64 = 0.9;
#[cfg(target_os = "macos")]
const TRAFFIC_X: f64 = 16.0;
#[cfg(target_os = "macos")]
const TRAFFIC_Y: f64 = 13.0;

pub fn fit(wanted: f64, available: Option<f64>, minimum: f64) -> f64 {
    match available {
        Some(space) if space > 0.0 => wanted.min(space * SCREEN_SHARE).max(minimum),
        _ => wanted,
    }
}

pub fn initial_size(app: &AppHandle, wanted: (f64, f64), minimum: (f64, f64)) -> (f64, f64) {
    let screen = app.primary_monitor().ok().flatten().map(|monitor| {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        (
            f64::from(area.size.width) / scale,
            f64::from(area.size.height) / scale,
        )
    });
    (
        fit(wanted.0, screen.map(|(width, _)| width), minimum.0),
        fit(wanted.1, screen.map(|(_, height)| height), minimum.1),
    )
}

pub fn find(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

pub fn is_showing(app: &AppHandle) -> bool {
    find(app).is_some_and(|window| {
        window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
    })
}

pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = find(app) {
        return Ok(existing);
    }
    let (width, height) = initial_size(app, (WIDTH, HEIGHT), (MIN_WIDTH, MIN_HEIGHT));
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Den")
        .inner_size(width, height)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .center()
        .visible(false)
        .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("localhost"));

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(TRAFFIC_X, TRAFFIC_Y));

    let window = builder.build()?;
    let target = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = target.hide();
        }
    });
    Ok(window)
}

pub fn show(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = create(app)?;
    if window.is_minimized().unwrap_or(false) {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()?;
    Ok(window)
}

pub fn navigate(app: &AppHandle, route: &str) -> tauri::Result<()> {
    let window = show(app)?;
    window.emit_to(LABEL, NAVIGATE_EVENT, normalize(route))?;
    Ok(())
}

pub fn normalize(route: &str) -> String {
    route
        .trim()
        .trim_start_matches('#')
        .trim_matches('/')
        .to_string()
}

#[tauri::command]
pub fn navigate_to(app: AppHandle, route: String) -> Result<(), Problem> {
    navigate(&app, &route).map_err(|error| {
        Problem::new(
            ProblemKind::Unreadable,
            format!("No pude abrir la ventana de Den: {error}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{fit, normalize};

    #[test]
    fn a_large_screen_gets_the_full_size() {
        assert_eq!(fit(1280.0, Some(1728.0), 900.0), 1280.0);
    }

    #[test]
    fn a_small_screen_caps_the_window_at_most_of_it() {
        assert_eq!(fit(1280.0, Some(1280.0), 900.0), 1152.0);
    }

    #[test]
    fn the_minimum_still_holds_on_a_tiny_screen() {
        assert_eq!(fit(1280.0, Some(600.0), 900.0), 900.0);
    }

    #[test]
    fn without_a_monitor_the_wanted_size_stands() {
        assert_eq!(fit(1280.0, None, 900.0), 1280.0);
    }

    #[test]
    fn a_route_drops_the_hash_and_the_slashes_around_it() {
        assert_eq!(normalize("#/ajustes/asistente/"), "ajustes/asistente");
        assert_eq!(normalize("/tiempo"), "tiempo");
        assert_eq!(normalize(" ahora "), "ahora");
    }
}
