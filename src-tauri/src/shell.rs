use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::model::{Problem, ProblemKind};

pub const LABEL: &str = "main";
pub const NAVIGATE_EVENT: &str = "den://navigate";
pub const DOCS_CHANGED_EVENT: &str = "bita://docs-changed";

const WIDTH: f64 = 1280.0;
const HEIGHT: f64 = 820.0;
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 600.0;
const SCREEN_SHARE: f64 = 0.9;

pub fn navigation_allowed(url: &Url, dev: Option<&Url>) -> bool {
    let app_origin = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    app_origin || dev.is_some_and(|dev| dev.origin() == url.origin())
}

pub fn navigation_guard(app: &AppHandle) -> impl Fn(&Url) -> bool + Send + 'static {
    let dev = if tauri::is_dev() { app.config().build.dev_url.clone() } else { None };
    move |url| navigation_allowed(url, dev.as_ref())
}

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
        .initialization_script(crate::titlebar::css_script())
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                crate::titlebar::refresh(&window);
            }
        })
        .on_navigation(navigation_guard(app));

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    let window = builder.build()?;
    crate::titlebar::pin(&window);
    let target = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = target.hide();
        }
        WindowEvent::Destroyed => crate::titlebar::unpin(&target),
        _ => {}
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

pub fn mark_docs_stale(app: &AppHandle) {
    if is_showing(app) {
        let _ = app.emit(DOCS_CHANGED_EVENT, ());
    }
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
    use super::{fit, navigation_allowed, normalize, LABEL, NAVIGATE_EVENT};
    use tauri::Url;

    fn url(text: &str) -> Url {
        Url::parse(text).expect("url")
    }

    #[test]
    fn only_the_app_origin_and_the_dev_server_may_load() {
        let dev = url("http://localhost:1420");
        assert!(navigation_allowed(&url("tauri://localhost/index.html"), None));
        assert!(navigation_allowed(&url("http://tauri.localhost/live.html"), None));
        assert!(navigation_allowed(&url("http://localhost:1420/#/docs"), Some(&dev)));
        assert!(!navigation_allowed(&url("http://localhost:1420/"), None));
        assert!(!navigation_allowed(&url("http://localhost:8080/"), Some(&dev)));
        assert!(!navigation_allowed(&url("http://localhost/"), Some(&dev)));
        assert!(!navigation_allowed(&url("https://localhost:1420/"), Some(&dev)));
        assert!(!navigation_allowed(&url("https://example.com/"), Some(&dev)));
        assert!(!navigation_allowed(&url("tauri://evil/"), None));
        assert!(!navigation_allowed(&url("file:///etc/passwd"), None));
    }

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

    #[test]
    fn the_window_and_event_names_are_the_ones_the_frontend_listens_to() {
        assert_eq!(LABEL, "main");
        assert_eq!(NAVIGATE_EVENT, "den://navigate");
        let bita = include_str!("../../src/bita.ts");
        assert!(bita.contains(&format!("NAVIGATE_EVENT = '{NAVIGATE_EVENT}'")));
    }

    #[test]
    fn an_empty_or_bare_route_normalises_to_nothing() {
        assert_eq!(normalize(""), "");
        assert_eq!(normalize("#"), "");
        assert_eq!(normalize("#/"), "");
        assert_eq!(normalize("///"), "");
        assert_eq!(normalize("   "), "");
    }

    #[test]
    fn normalising_twice_changes_nothing() {
        for route in ["#/ajustes/asistente/", "/tiempo", " ahora ", "##/docs", "docs/den/readme"] {
            assert_eq!(normalize(&normalize(route)), normalize(route));
        }
    }

    #[test]
    fn a_nested_route_keeps_its_inner_slashes() {
        assert_eq!(normalize("#/docs/den/readme"), "docs/den/readme");
    }

    #[test]
    fn an_exact_fit_on_the_edge_of_the_share_is_kept() {
        assert_eq!(fit(1152.0, Some(1280.0), 900.0), 1152.0);
        assert_eq!(fit(1280.0, Some(1500.0), 900.0), 1280.0);
    }

    #[test]
    fn a_zero_or_negative_work_area_leaves_the_wanted_size() {
        assert_eq!(fit(1280.0, Some(0.0), 900.0), 1280.0);
        assert_eq!(fit(1280.0, Some(-10.0), 900.0), 1280.0);
    }

    #[test]
    fn a_wanted_size_below_the_minimum_is_raised_to_it() {
        assert_eq!(fit(500.0, Some(2000.0), 900.0), 900.0);
    }

    #[test]
    fn the_default_window_fits_the_minimum_screen_it_supports() {
        assert_eq!(fit(1280.0, Some(1000.0), 900.0), 900.0);
        assert_eq!(fit(820.0, Some(700.0), 600.0), 630.0);
    }
}
