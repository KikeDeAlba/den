use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::WebviewWindow;
use tokio::sync::oneshot;
use tokio::time::{sleep, timeout};

use crate::cli::node;
use crate::model::{Problem, ProblemKind};

const PRINT_TIMEOUT: Duration = Duration::from_secs(90);
const SETTLE_POLL: Duration = Duration::from_millis(250);
const SETTLE_TRIES: usize = 40;
const NAME_MAX_CHARS: usize = 120;

pub(crate) fn sanitize(file_name: &str) -> String {
    sanitize_with(file_name, "pdf")
}

pub(crate) fn sanitize_with(file_name: &str, extension: &str) -> String {
    let trimmed = file_name.trim();
    let suffix = format!(".{extension}");
    let base = trimmed
        .len()
        .checked_sub(suffix.len())
        .filter(|&at| trimmed.is_char_boundary(at) && trimmed[at..].eq_ignore_ascii_case(&suffix))
        .map(|at| &trimmed[..at])
        .unwrap_or(trimmed);
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':') { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    let short: String = cleaned.chars().take(NAME_MAX_CHARS).collect();
    let short = short.trim().to_string();
    if short.is_empty() {
        "documento".into()
    } else {
        short
    }
}

pub(crate) fn unique_path(dir: &Path, stem: &str) -> PathBuf {
    unique_path_with(dir, stem, "pdf")
}

pub(crate) fn unique_path_with(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{extension}"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}).{extension}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or(first)
}

fn failed(message: impl Into<String>) -> Problem {
    Problem::new(ProblemKind::CliFailed, message)
}

#[tauri::command]
pub async fn export_pdf(window: WebviewWindow, file_name: String) -> Result<String, Problem> {
    let downloads = node::home()
        .map(|home| home.join("Downloads"))
        .ok_or_else(|| failed("No sé cuál es tu carpeta de inicio."))?;
    std::fs::create_dir_all(&downloads)
        .map_err(|error| failed(format!("No pude preparar {}: {error}", downloads.display())))?;
    let target = unique_path(&downloads, &sanitize(&file_name));

    let (sender, receiver) = oneshot::channel::<Result<(), String>>();
    let destination = target.clone();
    window
        .with_webview(move |webview| {
            platform::print(webview, &destination, sender);
        })
        .map_err(|error| failed(format!("No pude llegar a la ventana: {error}")))?;

    match timeout(PRINT_TIMEOUT, receiver).await {
        Err(_) => return Err(failed("El PDF tardó demasiado en generarse.")),
        Ok(Err(_)) => return Err(failed("La impresión terminó sin avisar.")),
        Ok(Ok(Err(message))) => return Err(failed(message)),
        Ok(Ok(Ok(()))) => {}
    }

    settle(&target).await?;
    let _ = crate::media::reveal(&target).await;
    Ok(target.display().to_string())
}

async fn settle(target: &Path) -> Result<(), Problem> {
    let mut last = 0;
    for _ in 0..SETTLE_TRIES {
        let size = std::fs::metadata(target).map(|meta| meta.len()).unwrap_or(0);
        if size > 0 && size == last {
            return Ok(());
        }
        last = size;
        sleep(SETTLE_POLL).await;
    }
    if last > 0 {
        return Ok(());
    }
    Err(failed("La impresión no dejó ningún PDF."))
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::{Cell, RefCell};
    use std::ffi::c_void;
    use std::path::Path;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject};
    use objc2::{define_class, msg_send, sel, AllocAnyThread, DefinedClass};
    use objc2_app_kit::{
        NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob, NSPrintingPaginationMode, NSWindow,
    };
    use objc2_foundation::{NSCopying, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot;

    type Done = oneshot::Sender<Result<(), String>>;

    const LETTER: NSSize = NSSize::new(612.0, 792.0);
    const MARGIN: f64 = 36.0;

    pub struct DelegateIvars {
        done: Cell<Option<Done>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "BitaPdfPrintDelegate"]
        #[ivars = DelegateIvars]
        pub struct PrintDelegate;

        impl PrintDelegate {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, _operation: &NSPrintOperation, success: Bool, _context: *mut c_void) {
                if let Some(done) = self.ivars().done.take() {
                    let outcome = if success.as_bool() {
                        Ok(())
                    } else {
                        Err("macOS no pudo generar el PDF.".to_string())
                    };
                    let _ = done.send(outcome);
                }
            }
        }
    );

    impl PrintDelegate {
        fn new(done: Done) -> Retained<Self> {
            let this = Self::alloc().set_ivars(DelegateIvars {
                done: Cell::new(Some(done)),
            });
            unsafe { msg_send![super(this), init] }
        }
    }

    thread_local! {
        static ACTIVE: RefCell<Option<Retained<PrintDelegate>>> = const { RefCell::new(None) };
    }

    pub fn print(webview: PlatformWebview, destination: &Path, done: Done) {
        let view = webview.inner().cast::<WKWebView>();
        let window = webview.ns_window().cast::<NSWindow>();
        let (Some(view), Some(window)) = (unsafe { view.as_ref() }, unsafe { window.as_ref() }) else {
            let _ = done.send(Err("La ventana no tiene una vista web que imprimir.".into()));
            return;
        };

        let info: Retained<NSPrintInfo> = NSPrintInfo::sharedPrintInfo().copy();
        unsafe {
            info.setJobDisposition(NSPrintSaveJob);
            let url = NSURL::fileURLWithPath(&NSString::from_str(&destination.display().to_string()));
            let dictionary = info.dictionary();
            let value: &AnyObject = &url;
            let _: () = msg_send![&*dictionary, setObject: value, forKey: NSPrintJobSavingURL];
        }
        info.setPaperSize(LETTER);
        info.setTopMargin(MARGIN);
        info.setBottomMargin(MARGIN);
        info.setLeftMargin(MARGIN);
        info.setRightMargin(MARGIN);
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        info.setVerticalPagination(NSPrintingPaginationMode::Automatic);

        let operation = unsafe { view.printOperationWithPrintInfo(&info) };
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        if let Some(printing) = operation.view() {
            printing.setFrame(view.bounds());
        }

        let delegate = PrintDelegate::new(done);
        let target: &AnyObject = &delegate;
        unsafe {
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                window,
                Some(target),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
        ACTIVE.with(|slot| {
            *slot.borrow_mut() = Some(delegate);
        });
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::cell::{Cell, RefCell};
    use std::path::Path;
    use std::rc::Rc;

    use gtk::glib;
    use gtk::{PageSetup, PaperSize, PrintSettings, Unit};
    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot;
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    type Done = oneshot::Sender<Result<(), String>>;

    const MARGIN_POINTS: f64 = 36.0;

    thread_local! {
        static ACTIVE: RefCell<Option<PrintOperation>> = const { RefCell::new(None) };
    }

    pub fn print(webview: PlatformWebview, destination: &Path, done: Done) {
        let uri = match glib::filename_to_uri(destination, None) {
            Ok(uri) => uri,
            Err(error) => {
                let _ = done.send(Err(format!("No pude preparar la ruta del PDF: {error}")));
                return;
            }
        };

        let settings = PrintSettings::new();
        settings.set_printer("Print to File");
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT.as_str(), Some("pdf"));
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI.as_str(), Some(uri.as_str()));

        let page = PageSetup::new();
        page.set_paper_size(&PaperSize::new(Some(gtk::PAPER_NAME_LETTER.as_str())));
        page.set_top_margin(MARGIN_POINTS, Unit::Points);
        page.set_bottom_margin(MARGIN_POINTS, Unit::Points);
        page.set_left_margin(MARGIN_POINTS, Unit::Points);
        page.set_right_margin(MARGIN_POINTS, Unit::Points);

        let operation = PrintOperation::new(&webview.inner());
        operation.set_print_settings(&settings);
        operation.set_page_setup(&page);

        let done = Rc::new(Cell::new(Some(done)));
        let on_failure = Rc::clone(&done);
        operation.connect_failed(move |_, error| {
            if let Some(sender) = on_failure.take() {
                let _ = sender.send(Err(format!("WebKitGTK no pudo generar el PDF: {error}")));
            }
        });
        operation.connect_finished(move |_| {
            if let Some(sender) = done.take() {
                let _ = sender.send(Ok(()));
            }
            ACTIVE.with(|slot| {
                slot.borrow_mut().take();
            });
        });

        ACTIVE.with(|slot| {
            *slot.borrow_mut() = Some(operation.clone());
        });
        operation.print();
    }
}

#[cfg(windows)]
mod platform {
    use std::cell::Cell;
    use std::path::Path;
    use std::rc::Rc;

    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2PrintSettings, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HRESULT, HSTRING};

    type Done = oneshot::Sender<Result<(), String>>;

    const LETTER_WIDTH_INCHES: f64 = 8.5;
    const LETTER_HEIGHT_INCHES: f64 = 11.0;
    const MARGIN_INCHES: f64 = 0.5;
    const E_NOINTERFACE: HRESULT = HRESULT(0x8000_4002_u32 as i32);

    pub fn print(webview: PlatformWebview, destination: &Path, done: Done) {
        let done = Rc::new(Cell::new(Some(done)));
        if let Err(message) = start(&webview, destination, Rc::clone(&done)) {
            if let Some(sender) = done.take() {
                let _ = sender.send(Err(message));
            }
        }
    }

    fn start(webview: &PlatformWebview, destination: &Path, done: Rc<Cell<Option<Done>>>) -> Result<(), String> {
        let failed = |error: windows_core::Error| format!("WebView2 no pudo generar el PDF: {error}");
        let outdated = |error: windows_core::Error| {
            if error.code() == E_NOINTERFACE {
                "Tu versión de WebView2 no sabe generar PDF; actualiza el runtime de WebView2.".to_string()
            } else {
                failed(error)
            }
        };
        let core = unsafe { webview.controller().CoreWebView2() }.map_err(failed)?;
        let core: ICoreWebView2_7 = core.cast().map_err(outdated)?;
        let environment: ICoreWebView2Environment6 = webview.environment().cast().map_err(outdated)?;
        let settings = unsafe { environment.CreatePrintSettings() }.map_err(failed)?;
        letter(&settings).map_err(failed)?;
        let path = HSTRING::from(destination.as_os_str());
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, success| {
            let outcome = match result {
                Err(error) => Err(format!("WebView2 no pudo generar el PDF: {error}")),
                Ok(()) if !success => Err("WebView2 no pudo generar el PDF.".to_string()),
                Ok(()) => Ok(()),
            };
            if let Some(sender) = done.take() {
                let _ = sender.send(outcome);
            }
            Ok(())
        }));
        unsafe { core.PrintToPdf(&path, &settings, &handler) }.map_err(failed)
    }

    fn letter(settings: &ICoreWebView2PrintSettings) -> windows_core::Result<()> {
        unsafe {
            settings.SetPageWidth(LETTER_WIDTH_INCHES)?;
            settings.SetPageHeight(LETTER_HEIGHT_INCHES)?;
            settings.SetMarginTop(MARGIN_INCHES)?;
            settings.SetMarginBottom(MARGIN_INCHES)?;
            settings.SetMarginLeft(MARGIN_INCHES)?;
            settings.SetMarginRight(MARGIN_INCHES)?;
            settings.SetShouldPrintBackgrounds(true)?;
            settings.SetShouldPrintHeaderAndFooter(false)?;
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod platform {
    use std::path::Path;

    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot;

    pub fn print(_webview: PlatformWebview, _destination: &Path, done: oneshot::Sender<Result<(), String>>) {
        let _ = done.send(Err("Exportar a PDF no está disponible en este sistema.".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::{sanitize, unique_path};
    use std::fs;

    #[test]
    fn a_title_becomes_a_safe_file_name() {
        assert_eq!(sanitize("Tanda 2 · públicos + infra"), "Tanda 2 · públicos + infra");
        assert_eq!(sanitize("a/b:c\\d"), "a-b-c-d");
        assert_eq!(sanitize("  ../secreto.pdf "), "-secreto");
        assert_eq!(sanitize("   "), "documento");
        assert_eq!(sanitize(&"x".repeat(300)).chars().count(), 120);
    }

    #[test]
    fn an_existing_file_gets_a_numbered_sibling() {
        let root = std::env::temp_dir().join(format!("bita-pdf-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("root");
        assert_eq!(unique_path(&root, "pagina"), root.join("pagina.pdf"));
        fs::write(root.join("pagina.pdf"), "x").expect("first");
        assert_eq!(unique_path(&root, "pagina"), root.join("pagina (2).pdf"));
        fs::write(root.join("pagina (2).pdf"), "x").expect("second");
        assert_eq!(unique_path(&root, "pagina"), root.join("pagina (3).pdf"));
        let _ = fs::remove_dir_all(&root);
    }
}
