use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::WebviewWindow;
use tokio::sync::oneshot;
use tokio::time::{sleep, timeout};

use crate::cli::node;
use crate::model::{Problem, ProblemKind};

const PRINT_TIMEOUT: Duration = Duration::from_secs(90);
const SETTLE_POLL: Duration = Duration::from_millis(250);
const SETTLE_TRIES: usize = 40;
const NAME_MAX_CHARS: usize = 120;
const CLAIM_TRIES: usize = 10_000;

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
        .map(|c| if c.is_control() || is_bidi(c) || matches!(c, '/' | '\\' | ':') { '-' } else { c })
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

fn is_bidi(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

pub(crate) fn create_unique(dir: &Path, stem: &str, extension: &str) -> io::Result<(PathBuf, File)> {
    for n in 1..=CLAIM_TRIES {
        let name = if n == 1 { format!("{stem}.{extension}") } else { format!("{stem} ({n}).{extension}") };
        let candidate = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "no free file name left"))
}

pub(crate) fn write_unique(dir: &Path, stem: &str, extension: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    if bytes.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "nothing to write"));
    }
    let (target, mut file) = create_unique(dir, stem, extension)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    match written {
        Ok(()) => Ok(target),
        Err(error) => {
            let _ = std::fs::remove_file(&target);
            Err(error)
        }
    }
}

struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new() -> io::Result<Self> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_nanos()).unwrap_or(0);
        let base = std::env::temp_dir();
        for _ in 0..CLAIM_TRIES {
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = base.join(format!("den-pdf-{}-{nanos}-{n}", std::process::id()));
            let mut builder = DirBuilder::new();
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            match builder.create(&dir) {
                Ok(()) => return Ok(Self { dir }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(io::ErrorKind::AlreadyExists, "no free scratch folder left"))
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn complete_pdf(bytes: &[u8]) -> bool {
    let tail = &bytes[bytes.len().saturating_sub(1024)..];
    bytes.starts_with(b"%PDF-") && tail.windows(5).any(|window| window == b"%%EOF")
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
    let scratch = Scratch::new().map_err(|error| failed(format!("No pude preparar una carpeta temporal: {error}")))?;
    let staging = scratch.file("print.pdf");

    let (sender, receiver) = oneshot::channel::<Result<(), String>>();
    let destination = staging.clone();
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

    let bytes = settle(&staging).await?;
    let target = write_unique(&downloads, &sanitize(&file_name), "pdf", &bytes)
        .map_err(|error| failed(format!("No pude guardar el PDF en {}: {error}", downloads.display())))?;
    drop(scratch);
    let _ = crate::media::reveal(&target).await;
    Ok(target.display().to_string())
}

async fn settle(staging: &Path) -> Result<Vec<u8>, Problem> {
    let mut last = 0;
    for _ in 0..SETTLE_TRIES {
        let size = std::fs::metadata(staging).map(|meta| meta.len()).unwrap_or(0);
        if size > 0 && size == last {
            let bytes = std::fs::read(staging).map_err(|error| failed(format!("No pude leer el PDF generado: {error}")))?;
            if complete_pdf(&bytes) {
                return Ok(bytes);
            }
        }
        last = size;
        sleep(SETTLE_POLL).await;
    }
    if last > 0 {
        return Err(failed("La impresión dejó un PDF incompleto."));
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
    use super::{complete_pdf, create_unique, sanitize, write_unique, Scratch};
    use std::path::{Path, PathBuf};

    fn claim(dir: &Path, stem: &str, extension: &str) -> PathBuf {
        create_unique(dir, stem, extension).expect("claim").0
    }
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
        assert_eq!(claim(&root, "pagina", "pdf"), root.join("pagina.pdf"));
        assert_eq!(claim(&root, "pagina", "pdf"), root.join("pagina (2).pdf"));
        fs::write(root.join("pagina (3).pdf"), "x").expect("third");
        assert_eq!(claim(&root, "pagina", "pdf"), root.join("pagina (4).pdf"));
        assert_eq!(fs::read(root.join("pagina (3).pdf")).expect("kept"), b"x");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_symlink_is_never_followed() {
        let root = std::env::temp_dir().join(format!("bita-pdf-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("root");
        let victim = root.join("victim.txt");
        fs::write(&victim, "secret").expect("victim");
        std::os::unix::fs::symlink(&victim, root.join("grabacion.mov")).expect("link");
        let (path, _) = create_unique(&root, "grabacion", "mov").expect("claim");
        assert_eq!(path, root.join("grabacion (2).mov"));
        assert_eq!(fs::read(&victim).expect("victim"), b"secret");
        let dangling = root.join("missing.txt");
        std::os::unix::fs::symlink(&dangling, root.join("otro.pdf")).expect("dangling");
        assert_eq!(claim(&root, "otro", "pdf"), root.join("otro (2).pdf"));
        assert!(!dangling.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bidi_controls_never_reach_a_file_name() {
        assert_eq!(sanitize("factura\u{202E}fdp.exe"), "factura-fdp.exe");
        assert_eq!(sanitize("a\u{2066}b\u{2069}c"), "a-b-c");
    }

    #[test]
    fn nothing_to_write_leaves_no_file_behind() {
        let root = std::env::temp_dir().join(format!("bita-pdf-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("root");
        assert!(write_unique(&root, "vacio", "pdf", b"").is_err());
        assert_eq!(fs::read_dir(&root).expect("list").count(), 0);
        let path = write_unique(&root, "lleno", "pdf", b"%PDF-1.7 x %%EOF").expect("write");
        assert_eq!(fs::read(&path).expect("read"), b"%PDF-1.7 x %%EOF");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_scratch_folder_is_private_and_gone_once_dropped() {
        let scratch = Scratch::new().expect("scratch");
        let staged = scratch.file("print.pdf");
        fs::write(&staged, b"partial").expect("stage");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(staged.parent().expect("dir")).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        let dir = staged.parent().expect("dir").to_path_buf();
        drop(scratch);
        assert!(!dir.exists());
    }

    #[test]
    fn only_a_finished_pdf_counts_as_complete() {
        assert!(complete_pdf(b"%PDF-1.7\n1 0 obj\n%%EOF\n"));
        assert!(!complete_pdf(b"%PDF-1.7\n1 0 obj\n"));
        assert!(!complete_pdf(b"hello %%EOF"));
        assert!(!complete_pdf(b""));
    }
}
