use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const REPLY_FALLBACK: Duration = Duration::from_secs(2);
pub const POWER_OFF_WINDOW: Duration = Duration::from_secs(30);

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Ignore,
    EndAll,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Finish {
    pub reply: Option<bool>,
    pub exit: bool,
}

#[derive(Debug, Default)]
pub struct QuitState {
    quitting: AtomicBool,
    asking: AtomicBool,
    ending: AtomicBool,
    replying: AtomicBool,
    shutting_down: AtomicBool,
}

impl QuitState {
    pub fn decide(&self, live: usize) -> QuitDecision {
        decide(
            live,
            self.quitting.load(Ordering::SeqCst),
            self.asking.load(Ordering::SeqCst),
            self.ending.load(Ordering::SeqCst),
        )
    }

    pub fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    pub fn ask(&self, reply_pending: bool) {
        if reply_pending {
            self.replying.store(true, Ordering::SeqCst);
        }
        self.asking.store(true, Ordering::SeqCst);
    }

    pub fn answer(&self, confirmed: bool) -> Answer {
        self.asking.store(false, Ordering::SeqCst);
        if self.ending.load(Ordering::SeqCst) {
            Answer::Ignore
        } else if confirmed {
            Answer::EndAll
        } else {
            Answer::Cancel
        }
    }

    pub fn ending(&self) -> bool {
        self.ending.load(Ordering::SeqCst)
    }

    pub fn closing(&self) -> bool {
        self.ending() || self.quitting.load(Ordering::SeqCst)
    }

    pub fn start_ending(&self) -> bool {
        !self.ending.swap(true, Ordering::SeqCst)
    }

    pub fn shutdown(&self) -> bool {
        self.replying.store(true, Ordering::SeqCst);
        self.shutting_down.store(true, Ordering::SeqCst);
        self.start_ending()
    }

    pub fn shutting_down(&self) -> bool {
        self.ending() && self.shutting_down.load(Ordering::SeqCst)
    }

    pub fn finish(&self, terminate: bool) -> Finish {
        if terminate {
            self.mark_quitting();
        }
        let reply = self.replying.swap(false, Ordering::SeqCst).then_some(terminate);
        Finish {
            reply,
            exit: terminate && reply.is_none(),
        }
    }
}

#[derive(Debug, Default)]
struct PowerOffMark {
    at: Option<Instant>,
    seen: bool,
}

#[derive(Debug, Default)]
pub struct PowerOff(Mutex<PowerOffMark>);

impl PowerOff {
    pub const fn new() -> Self {
        Self(Mutex::new(PowerOffMark { at: None, seen: false }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, PowerOffMark> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn mark(&self, now: Instant) {
        self.lock().at = Some(now);
    }

    pub fn check(&self, now: Instant) -> bool {
        let mut mark = self.lock();
        if !mark.seen {
            mark.seen = mark.at.is_some_and(|at| now.saturating_duration_since(at) <= POWER_OFF_WINDOW);
        }
        mark.seen
    }

    pub fn clear(&self) {
        *self.lock() = PowerOffMark::default();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Terminate {
    Now,
    EndForShutdown,
    Later,
    Cancel,
    Confirm,
}

pub fn decide_terminate(decision: QuitDecision, shutting_down: bool, system_quit: impl FnOnce() -> bool) -> Terminate {
    match decision {
        QuitDecision::Exit => Terminate::Now,
        _ if shutting_down => Terminate::Later,
        _ if system_quit() => Terminate::EndForShutdown,
        QuitDecision::Wait => Terminate::Cancel,
        QuitDecision::Confirm => Terminate::Confirm,
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
pub fn forget_power_off() {
    mac::forget_power_off();
}

#[cfg(not(target_os = "macos"))]
pub fn forget_power_off() {}

#[cfg(target_os = "macos")]
mod mac {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::OnceLock;
    use std::time::Instant;

    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::NSString;
    use tauri::AppHandle;

    use super::{is_system_quit_reason, PowerOff, Terminate};

    const TERMINATE_CANCEL: usize = 0;
    const TERMINATE_NOW: usize = 1;
    const TERMINATE_LATER: usize = 2;
    const POWER_OFF: &str = "NSWorkspaceWillPowerOffNotification";

    static HANDLE: OnceLock<AppHandle> = OnceLock::new();
    static POWERING_OFF: PowerOff = PowerOff::new();

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

    pub fn forget_power_off() {
        POWERING_OFF.clear();
    }

    fn decide_terminate(app: &AppHandle) -> usize {
        let terminate = super::decide_terminate(
            crate::agents::quit_decision(app),
            crate::agents::quit_shutting_down(app),
            || POWERING_OFF.check(Instant::now()) || quit_reason().is_some_and(is_system_quit_reason),
        );
        match terminate {
            Terminate::Now => TERMINATE_NOW,
            Terminate::EndForShutdown => {
                crate::agents::end_for_shutdown(app);
                TERMINATE_LATER
            }
            Terminate::Later => TERMINATE_LATER,
            Terminate::Cancel => {
                let _ = crate::shell::show(app);
                TERMINATE_CANCEL
            }
            Terminate::Confirm => {
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
        POWERING_OFF.mark(Instant::now());
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
    use super::*;

    #[test]
    fn a_confirmed_dialog_ends_the_sessions_once() {
        let state = QuitState::default();
        assert_eq!(state.decide(2), QuitDecision::Confirm);
        state.ask(false);
        assert_eq!(state.decide(2), QuitDecision::Wait);
        assert_eq!(state.answer(true), Answer::EndAll);
        assert!(state.start_ending());
        assert!(!state.start_ending());
        assert_eq!(state.decide(2), QuitDecision::Wait);
        assert_eq!(state.finish(true), Finish { reply: None, exit: true });
        assert_eq!(state.decide(2), QuitDecision::Exit);
    }

    #[test]
    fn a_cancelled_dialog_leaves_den_ready_to_ask_again() {
        let state = QuitState::default();
        state.ask(false);
        assert_eq!(state.answer(false), Answer::Cancel);
        assert_eq!(state.finish(false), Finish { reply: None, exit: false });
        assert_eq!(state.decide(1), QuitDecision::Confirm);
    }

    #[test]
    fn the_system_gets_exactly_one_answer() {
        let state = QuitState::default();
        state.ask(true);
        assert_eq!(state.answer(true), Answer::EndAll);
        assert!(state.start_ending());
        assert_eq!(state.finish(true), Finish { reply: Some(true), exit: false });
        assert_eq!(state.finish(true), Finish { reply: None, exit: true });
        let cancelled = QuitState::default();
        cancelled.ask(true);
        assert_eq!(cancelled.answer(false), Answer::Cancel);
        assert_eq!(cancelled.finish(false), Finish { reply: Some(false), exit: false });
        assert_eq!(cancelled.finish(false), Finish { reply: None, exit: false });
    }

    #[test]
    fn a_second_quit_while_the_dialog_is_open_waits_and_still_gets_answered() {
        let state = QuitState::default();
        state.ask(true);
        assert_eq!(state.decide(1), QuitDecision::Wait);
        assert_eq!(state.decide(1), QuitDecision::Wait);
        assert_eq!(state.answer(true), Answer::EndAll);
        assert!(state.start_ending());
        let finish = state.finish(true);
        assert_eq!(finish.reply, Some(true));
        assert_eq!(state.decide(1), QuitDecision::Exit);
    }

    #[test]
    fn a_shutdown_during_the_dialog_takes_over_and_the_late_answer_is_ignored() {
        let state = QuitState::default();
        state.ask(true);
        assert!(state.shutdown());
        assert!(!state.shutdown());
        assert_eq!(state.answer(false), Answer::Ignore);
        assert_eq!(state.finish(true), Finish { reply: Some(true), exit: false });
    }

    #[test]
    fn a_power_off_mark_expires_and_is_cleared_when_den_finishes() {
        let marks = PowerOff::new();
        let now = Instant::now();
        assert!(!marks.check(now));
        marks.mark(now);
        assert!(!marks.check(now + POWER_OFF_WINDOW + Duration::from_secs(1)));
        marks.mark(now);
        assert!(marks.check(now + Duration::from_secs(1)));
        marks.clear();
        assert!(!marks.check(now + Duration::from_secs(1)));
    }

    #[test]
    fn a_power_off_mark_survives_repeated_checks_without_marking_again() {
        let marks = PowerOff::new();
        let now = Instant::now();
        marks.mark(now);
        assert!(marks.check(now + Duration::from_secs(1)));
        assert!(marks.check(now + Duration::from_secs(2)));
        assert!(marks.check(now + POWER_OFF_WINDOW + Duration::from_secs(5)));
    }

    #[test]
    fn a_second_terminate_request_during_a_shutdown_waits_instead_of_cancelling() {
        let state = QuitState::default();
        let marks = PowerOff::new();
        let now = Instant::now();
        marks.mark(now);
        let first = decide_terminate(state.decide(2), state.shutting_down(), || marks.check(now));
        assert_eq!(first, Terminate::EndForShutdown);
        assert!(state.shutdown());
        assert_eq!(state.decide(2), QuitDecision::Wait);
        let second = decide_terminate(state.decide(2), state.shutting_down(), || false);
        assert_eq!(second, Terminate::Later);
        let unmarked = decide_terminate(state.decide(2), false, || marks.check(now + Duration::from_secs(1)));
        assert_eq!(unmarked, Terminate::EndForShutdown);
        assert!(!state.shutdown());
        assert_eq!(state.finish(true), Finish { reply: Some(true), exit: false });
        marks.clear();
        assert_eq!(decide_terminate(state.decide(2), state.shutting_down(), || false), Terminate::Now);
    }

    #[test]
    fn a_terminate_request_while_a_confirmed_quit_ends_the_sessions_is_cancelled_unless_the_system_quits() {
        let state = QuitState::default();
        state.ask(false);
        assert_eq!(state.answer(true), Answer::EndAll);
        assert!(state.start_ending());
        assert!(!state.shutting_down());
        assert_eq!(decide_terminate(state.decide(1), state.shutting_down(), || false), Terminate::Cancel);
        assert_eq!(decide_terminate(state.decide(1), state.shutting_down(), || true), Terminate::EndForShutdown);
        assert!(!state.shutdown());
        assert!(state.shutting_down());
        assert_eq!(decide_terminate(state.decide(1), state.shutting_down(), || false), Terminate::Later);
    }

    #[test]
    fn ending_is_visible_until_den_quits() {
        let state = QuitState::default();
        assert!(!state.ending());
        assert!(state.shutdown());
        assert!(state.ending());
        state.finish(true);
        assert!(state.ending());
    }

    #[test]
    fn den_is_closing_once_the_sessions_end_or_it_quits() {
        let state = QuitState::default();
        state.ask(false);
        assert!(!state.closing());
        assert!(state.start_ending());
        assert!(state.closing());
        let quitting = QuitState::default();
        quitting.mark_quitting();
        assert!(quitting.closing());
    }

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
