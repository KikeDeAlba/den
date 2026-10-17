use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const LABEL: &str = "cerebro";

const WIDTH: f64 = 1280.0;
const HEIGHT: f64 = 820.0;
const MIN_WIDTH: f64 = 720.0;
const MIN_HEIGHT: f64 = 420.0;

pub fn find(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

pub fn open(app: &AppHandle) -> tauri::Result<()> {
    let window = match find(app) {
        Some(existing) => existing,
        None => {
            let created = build(app)?;
            wire(app, &created);
            created
        }
    };

    crate::activation::showing(app);
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let (width, height) = crate::notes::initial_size(app, (WIDTH, HEIGHT), (MIN_WIDTH, MIN_HEIGHT));
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("cerebro.html".into()))
        .title("Cerebro · Den")
        .inner_size(width, height)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .center()
        .visible(false)
        .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("localhost"));

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    builder.build()
}

fn wire(app: &AppHandle, window: &WebviewWindow) {
    let target = window.clone();
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            crate::activation::hiding(&handle, LABEL);
            let _ = target.hide();
        }
    });
}
