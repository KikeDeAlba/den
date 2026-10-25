pub const TOPBAR_HEIGHT: f64 = 38.0;
pub const TRAFFIC_X: f64 = 16.0;
pub const TRAFFIC_BUTTON: f64 = 14.0;
pub const TRAFFIC_PITCH: f64 = 23.0;
pub const TRAFFIC_GAP: f64 = 8.0;

pub const fn inset_for(button_width: f64) -> f64 {
    TRAFFIC_X + 2.0 * TRAFFIC_PITCH + button_width + TRAFFIC_GAP
}

pub const fn traffic_inset() -> f64 {
    inset_for(TRAFFIC_BUTTON)
}

pub fn variables_script(height: f64, inset: f64) -> String {
    format!(
        "(function(){{var apply=function(){{var root=document.documentElement;if(!root){{return false;}}root.style.setProperty('--topbar-height','{height}px');root.style.setProperty('--traffic-inset','{inset}px');return true;}};if(apply()){{return;}}var watcher=new MutationObserver(function(){{if(apply()){{watcher.disconnect();}}}});watcher.observe(document,{{childList:true}});document.addEventListener('DOMContentLoaded',function(){{watcher.disconnect();apply();}},{{once:true}});}})();"
    )
}

pub fn css_script() -> String {
    variables_script(TOPBAR_HEIGHT, traffic_inset())
}

#[cfg(any(target_os = "macos", test))]
pub fn button_top(button_height: f64) -> f64 {
    (TOPBAR_HEIGHT - button_height) / 2.0
}

#[cfg(any(target_os = "macos", test))]
pub fn button_x(index: usize) -> f64 {
    TRAFFIC_X + index as f64 * TRAFFIC_PITCH
}

#[cfg(any(target_os = "macos", test))]
pub fn container_height(current: f64) -> f64 {
    current.max(TOPBAR_HEIGHT)
}

#[cfg(any(target_os = "macos", test))]
pub fn differs(a: f64, b: f64) -> bool {
    (a - b).abs() >= 0.01
}

#[cfg(target_os = "macos")]
pub use platform::{pin, refresh, unpin};

#[cfg(not(target_os = "macos"))]
pub fn pin(_window: &tauri::WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
pub fn refresh(_window: &tauri::WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
pub fn unpin(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::{Cell, RefCell};

    use objc2::rc::{Retained, Weak};
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSView, NSViewFrameDidChangeNotification, NSWindow, NSWindowButton,
        NSWindowDidBecomeKeyNotification, NSWindowDidChangeBackingPropertiesNotification,
        NSWindowDidChangeScreenNotification, NSWindowDidDeminiaturizeNotification,
        NSWindowDidEndLiveResizeNotification, NSWindowDidExitFullScreenNotification,
        NSWindowDidResignKeyNotification, NSWindowDidResizeNotification,
        NSWindowDidUpdateNotification, NSWindowStyleMask,
    };
    use objc2_foundation::{
        NSNotification, NSNotificationCenter, NSNotificationName, NSPoint, NSRect,
    };
    use tauri::{Manager, WebviewWindow};

    use super::{
        button_top, button_x, container_height, differs, inset_for, traffic_inset,
        variables_script, TOPBAR_HEIGHT,
    };

    const BUTTONS: [NSWindowButton; 3] = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ];

    pub struct PinIvars {
        window: Weak<NSWindow>,
        webview: WebviewWindow,
        placing: Cell<bool>,
        inset: Cell<f64>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "DenTrafficLightPin"]
        #[ivars = PinIvars]
        pub struct Pin;

        impl Pin {
            #[unsafe(method(reposition:))]
            fn reposition(&self, _notification: &NSNotification) {
                self.apply();
            }
        }
    );

    impl Pin {
        fn new(mtm: MainThreadMarker, window: &NSWindow, webview: WebviewWindow) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(PinIvars {
                window: Weak::from(window),
                webview,
                placing: Cell::new(false),
                inset: Cell::new(traffic_inset()),
            });
            unsafe { msg_send![super(this), init] }
        }

        fn apply(&self) {
            let ivars = self.ivars();
            if ivars.placing.replace(true) {
                return;
            }
            let width = ivars.window.load().and_then(|window| place(&window));
            ivars.placing.set(false);
            let Some(width) = width else {
                return;
            };
            let inset = inset_for(width);
            if differs(inset, ivars.inset.get()) {
                ivars.inset.set(inset);
                let _ = ivars.webview.eval(variables_script(TOPBAR_HEIGHT, inset));
            }
        }

        fn label(&self) -> &str {
            self.ivars().webview.label()
        }
    }

    thread_local! {
        static PINS: RefCell<Vec<Retained<Pin>>> = const { RefCell::new(Vec::new()) };
    }

    fn place(window: &NSWindow) -> Option<f64> {
        if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
            return None;
        }
        let close = window.standardWindowButton(NSWindowButton::CloseButton)?;
        let window_height = window.frame().size.height;
        if let Some(container) = unsafe { close.superview().and_then(|holder| holder.superview()) }
        {
            let mut frame = container.frame();
            let height = container_height(frame.size.height);
            if differs(frame.size.height, height) {
                frame.size.height = height;
                frame.origin.y = window_height - height;
                container.setFrame(frame);
            }
        }
        for (index, kind) in BUTTONS.into_iter().enumerate() {
            let Some(button) = window.standardWindowButton(kind) else {
                continue;
            };
            let Some(holder) = (unsafe { button.superview() }) else {
                continue;
            };
            let current = button.convertRect_toView(button.bounds(), None);
            let size = current.size;
            let wanted = NSRect::new(
                NSPoint::new(
                    button_x(index),
                    window_height - button_top(size.height) - size.height,
                ),
                size,
            );
            if differs(current.origin.x, wanted.origin.x)
                || differs(current.origin.y, wanted.origin.y)
            {
                let local = holder.convertRect_fromView(wanted, None);
                button.setFrameOrigin(local.origin);
            }
        }
        Some(close.frame().size.width)
    }

    fn observe(
        center: &NSNotificationCenter,
        pin: &Pin,
        name: &NSNotificationName,
        object: &AnyObject,
    ) {
        unsafe {
            center.addObserver_selector_name_object(
                pin,
                sel!(reposition:),
                Some(name),
                Some(object),
            )
        };
    }

    fn watch(pin: &Pin, window: &NSWindow) {
        let center = NSNotificationCenter::defaultCenter();
        let window_object: &AnyObject = window;
        for name in unsafe {
            [
                NSWindowDidResizeNotification,
                NSWindowDidEndLiveResizeNotification,
                NSWindowDidExitFullScreenNotification,
                NSWindowDidDeminiaturizeNotification,
                NSWindowDidChangeBackingPropertiesNotification,
                NSWindowDidUpdateNotification,
                NSWindowDidBecomeKeyNotification,
                NSWindowDidResignKeyNotification,
                NSWindowDidChangeScreenNotification,
            ]
        } {
            observe(&center, pin, name, window_object);
        }
        for kind in BUTTONS {
            if let Some(button) = window.standardWindowButton(kind) {
                let view: &NSView = &button;
                view.setPostsFrameChangedNotifications(true);
                observe(
                    &center,
                    pin,
                    unsafe { NSViewFrameDidChangeNotification },
                    view,
                );
            }
        }
        if let Some(container) = window
            .standardWindowButton(NSWindowButton::CloseButton)
            .and_then(|close| unsafe { close.superview() })
            .and_then(|holder| unsafe { holder.superview() })
        {
            container.setPostsFrameChangedNotifications(true);
            observe(
                &center,
                pin,
                unsafe { NSViewFrameDidChangeNotification },
                &container,
            );
        }
    }

    pub fn pin(window: &WebviewWindow) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let Ok(pointer) = target.ns_window() else {
                return;
            };
            let Some(ns_window) = (unsafe { pointer.cast::<NSWindow>().as_ref() }) else {
                return;
            };
            let label = target.label().to_string();
            drop_pins(&label);
            let pin = Pin::new(mtm, ns_window, target);
            pin.apply();
            watch(&pin, ns_window);
            PINS.with(|pins| pins.borrow_mut().push(pin));
        });
    }

    pub fn refresh(window: &WebviewWindow) {
        let label = window.label().to_string();
        let _ = window.run_on_main_thread(move || {
            PINS.with(|pins| {
                for pin in pins.borrow().iter().filter(|pin| pin.label() == label) {
                    pin.ivars().inset.set(traffic_inset());
                    pin.apply();
                }
            });
        });
    }

    pub fn unpin(window: &WebviewWindow) {
        let label = window.label().to_string();
        let _ = window
            .app_handle()
            .run_on_main_thread(move || drop_pins(&label));
    }

    fn drop_pins(label: &str) {
        let removed: Vec<Retained<Pin>> = PINS.with(|pins| {
            let mut pins = pins.borrow_mut();
            let (removed, kept) = pins.drain(..).partition(|pin| pin.label() == label);
            *pins = kept;
            removed
        });
        if removed.is_empty() {
            return;
        }
        let center = NSNotificationCenter::defaultCenter();
        for pin in removed {
            let observer: &AnyObject = &pin;
            unsafe { center.removeObserver(observer) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        button_top, button_x, container_height, css_script, differs, inset_for, traffic_inset,
        variables_script, TOPBAR_HEIGHT, TRAFFIC_BUTTON, TRAFFIC_X,
    };

    #[test]
    fn the_buttons_share_the_vertical_centre_of_the_top_bar() {
        for height in [12.0, 14.0, 16.0] {
            assert_eq!(button_top(height) + height / 2.0, TOPBAR_HEIGHT / 2.0);
        }
    }

    #[test]
    fn the_container_grows_to_the_bar_but_never_shrinks() {
        assert_eq!(container_height(27.0), TOPBAR_HEIGHT);
        assert_eq!(container_height(52.0), 52.0);
    }

    #[test]
    fn the_buttons_step_right_from_the_left_margin() {
        let xs: Vec<f64> = (0..3).map(button_x).collect();
        assert_eq!(xs, vec![TRAFFIC_X, TRAFFIC_X + 23.0, TRAFFIC_X + 46.0]);
    }

    #[test]
    fn a_frame_already_in_place_is_left_alone() {
        assert!(!differs(12.0, 12.004));
        assert!(differs(12.0, 9.0));
    }

    fn css_px(css: &str, property: &str) -> f64 {
        let start = css
            .find(&format!("{property}:"))
            .unwrap_or_else(|| panic!("{property} missing in shell.css"));
        let value = css[start + property.len() + 1..]
            .split(';')
            .next()
            .expect("value")
            .trim();
        value.trim_end_matches("px").parse().expect("number")
    }

    #[test]
    fn the_stylesheet_uses_the_same_bar_height_and_inset() {
        let css = include_str!("../../src/shell/shell.css");
        assert_eq!(css_px(css, "--topbar-height"), TOPBAR_HEIGHT);
        assert_eq!(css_px(css, "--traffic-inset"), traffic_inset());
        assert_eq!(traffic_inset(), 84.0);
    }

    #[test]
    fn the_window_sets_the_bar_variables_from_the_same_constants() {
        let script = css_script();
        assert!(script.contains("'--topbar-height','38px'"));
        assert!(script.contains("'--traffic-inset','84px'"));
    }

    #[test]
    fn the_variables_wait_for_the_document_element() {
        let script = css_script();
        assert!(script.contains("if(!root){return false;}"));
        assert!(script.contains("new MutationObserver"));
        assert!(script.contains("'DOMContentLoaded'"));
        assert!(!script.starts_with("document.documentElement"));
    }

    #[test]
    fn the_inset_follows_the_real_button_width() {
        assert_eq!(inset_for(TRAFFIC_BUTTON), traffic_inset());
        assert_eq!(inset_for(16.0), traffic_inset() + 2.0);
        assert!(variables_script(TOPBAR_HEIGHT, 86.0).contains("'--traffic-inset','86px'"));
    }
}
