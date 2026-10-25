use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const LABEL: &str = "live-wide";

const WIDTH: f64 = 1280.0;
const HEIGHT: f64 = 820.0;
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 560.0;
#[cfg(target_os = "macos")]
const TRAFFIC_X: f64 = 16.0;
#[cfg(target_os = "macos")]
const TRAFFIC_Y: f64 = 18.0;

pub fn find(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

pub fn is_visible(app: &AppHandle) -> bool {
    find(app)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let (width, height) = crate::shell::initial_size(app, (WIDTH, HEIGHT), (MIN_WIDTH, MIN_HEIGHT));
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("live-wide.html".into()))
        .title("Asistente de reunión")
        .inner_size(width, height)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .content_protected(true)
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

#[cfg(target_os = "macos")]
fn protect(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::{NSWindow, NSWindowSharingType};
        let Ok(pointer) = target.ns_window() else {
            return;
        };
        if let Some(ns_window) = unsafe { pointer.cast::<NSWindow>().as_ref() } {
            ns_window.setSharingType(NSWindowSharingType::None);
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn protect(_window: &WebviewWindow) {}

pub fn open(app: &AppHandle, focus: bool) -> tauri::Result<()> {
    let window = match find(app) {
        Some(existing) => existing,
        None => build(app)?,
    };
    protect(&window);
    window.show()?;
    if focus {
        window.set_focus()?;
    }
    Ok(())
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = find(app) {
        let _ = window.hide();
    }
}
