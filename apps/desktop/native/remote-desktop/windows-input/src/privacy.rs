//! Ephemeral physical-input gate, on the user's desktop, never the service's.
//! No event contents leave this process. Closing stdin or losing its heartbeat
//! removes both hooks in remote mode; away mode first locks the user session.
use std::{
    cell::RefCell,
    collections::HashSet,
    io::{self, BufRead, Read, Write},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*, System::Threading::GetCurrentThreadId, System::Shutdown::LockWorkStation, UI::WindowsAndMessaging::*,
};

#[derive(Default)]
struct Gate {
    away: bool,
    phase: u8, // 0 armed, 1 draining input helper, 2 local dialog
    swallowed: HashSet<u32>,
}
impl Gate {
    fn consume(
        &mut self,
        physical: bool,
        press: Option<u32>,
        down: bool,
        scroll: bool,
    ) -> (bool, bool) {
        if !physical {
            return (self.phase == 2 || (self.away && self.phase != 0), false);
        }
        if self.away {
            let notify = self.phase == 0 && (scroll || (down && press != Some(0x14)));
            if notify { self.phase = 1; }
            return (true, notify);
        }
        if scroll {
            let notify = self.phase == 0;
            if notify {
                self.phase = 1;
            }
            return (true, notify);
        }
        if let Some(press) = press {
            if self.swallowed.contains(&press) {
                if !down {
                    self.swallowed.remove(&press);
                }
                return (true, false);
            }
        }
        if self.phase == 0 && down {
            self.phase = 1;
            if let Some(press) = press {
                self.swallowed.insert(press);
            }
            return (true, true);
        }
        if self.phase == 1 {
            if down {
                if let Some(press) = press {
                    self.swallowed.insert(press);
                }
            }
            return (true, false);
        }
        (false, false)
    }
}
const COMMAND: u32 = WM_APP + 1;
fn status(word: &str) {
    // Main may have died: a broken stdout must not prevent the fail-safe lock.
    let _ = writeln!(io::stdout(), "{word}");
    let _ = io::stdout().flush();
}
thread_local! { static GATE: RefCell<Gate> = RefCell::new(Gate::default()); }
fn consume(physical: bool, press: Option<u32>, down: bool, scroll: bool) -> bool {
    let (consume, notify) =
        GATE.with(|gate| gate.borrow_mut().consume(physical, press, down, scroll));
    if notify {
        if GATE.with(|gate| gate.borrow().away) {
            status("reason input");
            unsafe { PostThreadMessageW(GetCurrentThreadId(), COMMAND, 3, 0); }
        } else { status("local-input"); }
    }
    consume
}
unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = &*(l as *const KBDLLHOOKSTRUCT);
        let down = w as u32 == WM_KEYDOWN || w as u32 == WM_SYSKEYDOWN;
        if consume(
            event.flags & LLKHF_INJECTED == 0,
            Some(event.vkCode),
            down,
            false,
        ) {
            return 1;
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, w, l)
}
unsafe extern "system" fn mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = &*(l as *const MSLLHOOKSTRUCT);
        let (press, down) = match w as u32 {
            WM_LBUTTONDOWN => (Some(0x10000), true),
            WM_LBUTTONUP => (Some(0x10000), false),
            WM_RBUTTONDOWN => (Some(0x10001), true),
            WM_RBUTTONUP => (Some(0x10001), false),
            WM_MBUTTONDOWN => (Some(0x10002), true),
            WM_MBUTTONUP => (Some(0x10002), false),
            WM_XBUTTONDOWN => (Some(0x10003 + (event.mouseData >> 16)), true),
            WM_XBUTTONUP => (Some(0x10003 + (event.mouseData >> 16)), false),
            _ => (None, false),
        };
        if consume(
            event.flags & LLMHF_INJECTED == 0,
            press,
            down,
            matches!(w as u32, WM_MOUSEWHEEL | WM_MOUSEHWHEEL),
        ) {
            return 1;
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, w, l)
}
pub fn run(away: bool) {
    if away && (!crate::desktop::user_desktop_active() || crate::desktop::locked() != Some(false)) {
        // Main falls back to a real lock instead of claiming a hidden cover works.
        std::process::exit(2);
    }
    GATE.with(|gate| gate.borrow_mut().away = away);
    unsafe {
        let mut message: MSG = std::mem::zeroed();
        // Create the queue before the stdin reader posts commands to it.
        PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        let thread = GetCurrentThreadId();
        let keyboard_hook =
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), std::ptr::null_mut(), 0);
        let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), std::ptr::null_mut(), 0);
        if keyboard_hook.is_null() || mouse_hook.is_null() {
            std::process::exit(2);
        }
        std::thread::spawn(move || {
            let mut stdin = io::stdin().lock();
            loop {
                let mut bytes = Vec::new();
                match stdin.by_ref().take(17).read_until(b'\n', &mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let command = match bytes.as_slice() {
                            b"ping\n" => 0,
                            b"confirm\n" if !away => 1,
                            b"resume\n" if !away => 2,
                            b"lock\n" if away => 3,
                            b"release\n" if away => 4,
                            _ => break,
                        };
                        if PostThreadMessageW(thread, COMMAND, command, 0) == 0 {
                            break;
                        }
                    }
                }
            }
            PostThreadMessageW(thread, if away { COMMAND } else { WM_QUIT }, 3, 0);
        });
        if SetTimer(std::ptr::null_mut(), 1, if away { 100 } else { 1000 }, None) == 0 {
            std::process::exit(2);
        }
        let mut last_seen = Instant::now();
        let mut previous_window = std::ptr::null_mut();
        status(if away { "away-ready" } else { "ready" });
        let mut locking: Option<Instant> = None;
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
            if message.message == COMMAND {
                last_seen = Instant::now();
                match message.wParam {
                    3 if away => {
                        if locking.is_none() {
                            GATE.with(|gate| gate.borrow_mut().phase = 1);
                            LockWorkStation();
                            locking = Some(Instant::now());
                        }
                    }
                    4 if away => { status("released"); break; }
                    1 => {
                        previous_window = GetForegroundWindow();
                        GATE.with(|gate| gate.borrow_mut().phase = 2);
                        status("confirmed");
                    }
                    2 => {
                        if !previous_window.is_null() {
                            SetForegroundWindow(previous_window);
                        }
                        GATE.with(|gate| gate.borrow_mut().phase = 0);
                        status("ready");
                    }
                    _ => (),
                }
                io::stdout().flush().ok();
            } else if message.message == WM_TIMER {
                if away && crate::desktop::locked() == Some(true) {
                    status("locked");
                    break;
                }
                if locking.is_some_and(|at| at.elapsed() > Duration::from_secs(3)) {
                    status("lock-failed");
                    break;
                }
                if away && !crate::desktop::user_desktop_active() && locking.is_none() {
                    status("reason desktop");
                    GATE.with(|gate| gate.borrow_mut().phase = 1);
                    LockWorkStation();
                    locking = Some(Instant::now());
                }
                if last_seen.elapsed() > Duration::from_secs(5) {
                    if !away { break; }
                    if locking.is_none() {
                        status("reason heartbeat");
                        GATE.with(|gate| gate.borrow_mut().phase = 1);
                        LockWorkStation();
                        locking = Some(Instant::now());
                    }
                }
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        UnhookWindowsHookEx(keyboard_hook);
        UnhookWindowsHookEx(mouse_hook);
    }
}

#[cfg(test)]
mod tests {
    use super::Gate;
    #[test]
    fn injected_input_passes_until_dialog_and_held_local_key_cannot_confirm() {
        let mut gate = Gate::default();
        assert_eq!(gate.consume(false, Some(13), true, false), (false, false));
        assert_eq!(gate.consume(true, Some(13), true, false), (true, true));
        assert_eq!(gate.consume(false, Some(13), false, false), (false, false)); // drain releases
        gate.phase = 2;
        assert_eq!(gate.consume(false, Some(13), true, false), (true, false));
        assert_eq!(gate.consume(true, Some(13), true, false), (true, false)); // held Enter
        assert_eq!(gate.consume(true, Some(13), false, false), (true, false));
        assert_eq!(gate.consume(true, Some(13), true, false), (false, false)); // fresh local press
        gate.phase = 0;
        assert_eq!(gate.consume(false, Some(13), true, false), (false, false));
    }
}

#[cfg(test)]
mod wheel_tests {
    use super::Gate;
    #[test]
    fn physical_wheel_triggers_once_and_never_reaches_the_covered_application() {
        let mut gate = Gate::default();
        assert_eq!(gate.consume(false, None, false, true), (false, false));
        assert_eq!(gate.consume(true, None, false, true), (true, true));
        assert_eq!(gate.consume(true, None, false, true), (true, false));
        assert_eq!(gate.consume(false, None, false, true), (false, false));
        gate.phase = 2;
        assert_eq!(gate.consume(true, None, false, true), (true, false));
        assert_eq!(gate.consume(false, None, false, true), (true, false));
        gate.phase = 0;
        assert_eq!(gate.consume(true, None, false, true), (true, true));
        assert!(gate.swallowed.is_empty());
    }
}

#[cfg(test)]
mod away_tests {
    use super::Gate;
    // Persistent covers consume physical input, tolerate drift/releases and only
    // report the first deliberate press. Agent input passes until locking begins.
    #[test]
    fn away_cover_separates_physical_presence_from_injection() {
        let mut gate = Gate { away: true, ..Gate::default() };
        assert_eq!(gate.consume(false, Some(13), true, false), (false, false));
        assert_eq!(gate.consume(true, None, false, false), (true, false));
        assert_eq!(gate.consume(true, Some(13), false, false), (true, false));
        assert_eq!(gate.consume(true, Some(0x14), true, false), (true, false));
        assert_eq!(gate.consume(true, Some(0x10000), true, false), (true, true));
        assert_eq!(gate.consume(true, Some(0x10000), true, false), (true, false));
        assert_eq!(gate.consume(false, Some(13), true, false), (true, false));
    }
}
