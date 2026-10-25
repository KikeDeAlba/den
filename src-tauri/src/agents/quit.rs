#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitDecision {
    Exit,
    Confirm,
    Wait,
}

pub fn decide(live: usize, quitting: bool, asking: bool, ending: bool) -> QuitDecision {
    if quitting || live == 0 {
        QuitDecision::Exit
    } else if asking || ending {
        QuitDecision::Wait
    } else {
        QuitDecision::Confirm
    }
}

const SYSTEM_QUIT_REASONS: [&[u8; 4]; 6] = [b"logo", b"rlgo", b"rrst", b"rsdn", b"rest", b"shut"];

pub fn is_system_quit_reason(reason: u32) -> bool {
    SYSTEM_QUIT_REASONS.iter().any(|code| u32::from_be_bytes(**code) == reason)
}

#[cfg(target_os = "macos")]
pub fn guard_terminate(app: &tauri::AppHandle) {
    mac::install(app);
}

#[cfg(not(target_os = "macos"))]
pub fn guard_terminate(_app: &tauri::AppHandle) {}

#[cfg(target_os = "macos")]
pub fn reply(app: &tauri::AppHandle, terminate: bool) {
    let _ = app.run_on_main_thread(move || mac::reply(terminate));
}

#[cfg(not(target_os = "macos"))]
pub fn reply(_app: &tauri::AppHandle, _terminate: bool) {}

#[cfg(target_os = "macos")]
mod mac {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::NSString;
    use tauri::AppHandle;

    use super::{is_system_quit_reason, QuitDecision};

    const TERMINATE_CANCEL: usize = 0;
    const TERMINATE_NOW: usize = 1;
    const TERMINATE_LATER: usize = 2;
    const POWER_OFF: &str = "NSWorkspaceWillPowerOffNotification";

    static HANDLE: OnceLock<AppHandle> = OnceLock::new();
    static POWERING_OFF: AtomicBool = AtomicBool::new(false);

    fn system_is_ending() -> bool {
        POWERING_OFF.load(Ordering::SeqCst) || quit_reason().is_some_and(is_system_quit_reason)
    }

    fn quit_reason() -> Option<u32> {
        unsafe {
            let manager: *mut AnyObject = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
            if manager.is_null() {
                return None;
            }
            let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
            if event.is_null() {
                return None;
            }
            let descriptor: *mut AnyObject =
                msg_send![event, attributeDescriptorForKeyword: u32::from_be_bytes(*b"why?")];
            if descriptor.is_null() {
                return None;
            }
            let reason: u32 = msg_send![descriptor, enumCodeValue];
            Some(reason)
        }
    }

    fn decide_terminate(app: &AppHandle) -> usize {
        match crate::agents::quit_decision(app) {
            QuitDecision::Exit => TERMINATE_NOW,
            _ if system_is_ending() => {
                crate::agents::end_for_shutdown(app);
                TERMINATE_LATER
            }
            QuitDecision::Wait => {
                let _ = crate::shell::show(app);
                TERMINATE_CANCEL
            }
            QuitDecision::Confirm => {
                crate::agents::confirm_before_reply(app);
                TERMINATE_LATER
            }
        }
    }

    extern "C-unwind" fn should_terminate(_this: &AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
        let Some(app) = HANDLE.get() else {
            return TERMINATE_NOW;
        };
        catch_unwind(AssertUnwindSafe(|| decide_terminate(app))).unwrap_or_else(|_| {
            eprintln!("den: deciding whether to quit failed; quitting");
            TERMINATE_NOW
        })
    }

    extern "C-unwind" fn will_power_off(_this: &AnyObject, _cmd: Sel, _note: *mut AnyObject) {
        POWERING_OFF.store(true, Ordering::SeqCst);
    }

    pub fn reply(terminate: bool) {
        unsafe {
            let shared: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if !shared.is_null() {
                let _: () = msg_send![shared, replyToApplicationShouldTerminate: Bool::new(terminate)];
            }
        }
    }

    unsafe fn add_method(class: *mut AnyClass, name: Sel, imp: Imp, types: &std::ffi::CStr) -> bool {
        let added = objc2::ffi::class_addMethod(class, name, imp, types.as_ptr()).as_bool();
        if !added {
            eprintln!("den: could not add {name} to the app delegate; quitting will not ask about live agent sessions");
        }
        added
    }

    pub fn install(app: &AppHandle) {
        let _ = HANDLE.set(app.clone());
        unsafe {
            let shared: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if shared.is_null() {
                eprintln!("den: there is no shared application to guard quitting");
                return;
            }
            let delegate: *mut AnyObject = msg_send![shared, delegate];
            if delegate.is_null() {
                eprintln!("den: the application has no delegate to guard quitting");
                return;
            }
            let class = (*delegate).class() as *const AnyClass as *mut AnyClass;
            let terminate: extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize = should_terminate;
            add_method(class, sel!(applicationShouldTerminate:), std::mem::transmute::<_, Imp>(terminate), c"Q@:@");
            let power: extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) = will_power_off;
            if add_method(class, sel!(denWillPowerOff:), std::mem::transmute::<_, Imp>(power), c"v@:@") {
                let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
                if workspace.is_null() {
                    return;
                }
                let center: *mut AnyObject = msg_send![workspace, notificationCenter];
                let name = NSString::from_str(POWER_OFF);
                let nothing: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![
                    center,
                    addObserver: delegate,
                    selector: sel!(denWillPowerOff:),
                    name: &*name,
                    object: nothing
                ];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decide, is_system_quit_reason, QuitDecision};

    #[test]
    fn without_live_sessions_den_quits_right_away() {
        assert_eq!(decide(0, false, false, false), QuitDecision::Exit);
        assert_eq!(decide(0, false, true, false), QuitDecision::Exit);
    }

    #[test]
    fn live_sessions_ask_for_confirmation() {
        assert_eq!(decide(1, false, false, false), QuitDecision::Confirm);
        assert_eq!(decide(4, false, false, false), QuitDecision::Confirm);
    }

    #[test]
    fn a_second_quit_while_asking_waits_for_the_open_dialog() {
        assert_eq!(decide(2, false, true, false), QuitDecision::Wait);
    }

    #[test]
    fn a_second_quit_while_the_sessions_end_does_not_ask_again() {
        assert_eq!(decide(2, false, false, true), QuitDecision::Wait);
    }

    #[test]
    fn once_confirmed_the_exit_goes_through_even_with_sessions_still_closing() {
        assert_eq!(decide(3, true, false, true), QuitDecision::Exit);
        assert_eq!(decide(3, true, true, false), QuitDecision::Exit);
    }

    #[test]
    fn logout_restart_and_shutdown_are_system_quits() {
        for code in [b"logo", b"rlgo", b"rrst", b"rsdn", b"rest", b"shut"] {
            assert!(is_system_quit_reason(u32::from_be_bytes(*code)));
        }
        assert!(!is_system_quit_reason(0));
        assert!(!is_system_quit_reason(u32::from_be_bytes(*b"quit")));
    }
}
