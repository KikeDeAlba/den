#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitDecision {
    Exit,
    Confirm,
    Wait,
}

pub fn decide(live: usize, quitting: bool, asking: bool) -> QuitDecision {
    if quitting || live == 0 {
        QuitDecision::Exit
    } else if asking {
        QuitDecision::Wait
    } else {
        QuitDecision::Confirm
    }
}

#[cfg(target_os = "macos")]
pub fn guard_terminate(app: &tauri::AppHandle) {
    mac::install(app);
}

#[cfg(not(target_os = "macos"))]
pub fn guard_terminate(_app: &tauri::AppHandle) {}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use tauri::AppHandle;

    use super::QuitDecision;

    const TERMINATE_CANCEL: usize = 0;
    const TERMINATE_NOW: usize = 1;

    static HANDLE: OnceLock<AppHandle> = OnceLock::new();

    extern "C-unwind" fn should_terminate(_this: &AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
        let Some(app) = HANDLE.get() else {
            return TERMINATE_NOW;
        };
        if crate::agents::quit_decision(app) == QuitDecision::Exit {
            return TERMINATE_NOW;
        }
        crate::agents::request_quit(app);
        TERMINATE_CANCEL
    }

    pub fn install(app: &AppHandle) {
        let _ = HANDLE.set(app.clone());
        unsafe {
            let shared: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if shared.is_null() {
                return;
            }
            let delegate: *mut AnyObject = msg_send![shared, delegate];
            if delegate.is_null() {
                return;
            }
            let class = (*delegate).class() as *const AnyClass as *mut AnyClass;
            let function: extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize = should_terminate;
            let imp: Imp = std::mem::transmute(function);
            objc2::ffi::class_addMethod(class, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decide, QuitDecision};

    #[test]
    fn without_live_sessions_den_quits_right_away() {
        assert_eq!(decide(0, false, false), QuitDecision::Exit);
        assert_eq!(decide(0, false, true), QuitDecision::Exit);
    }

    #[test]
    fn live_sessions_ask_for_confirmation() {
        assert_eq!(decide(1, false, false), QuitDecision::Confirm);
        assert_eq!(decide(4, false, false), QuitDecision::Confirm);
    }

    #[test]
    fn a_second_quit_while_asking_waits_for_the_open_dialog() {
        assert_eq!(decide(2, false, true), QuitDecision::Wait);
    }

    #[test]
    fn once_confirmed_the_exit_goes_through_even_with_sessions_still_closing() {
        assert_eq!(decide(3, true, false), QuitDecision::Exit);
        assert_eq!(decide(3, true, true), QuitDecision::Exit);
    }
}
