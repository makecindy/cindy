//! Ephemeral physical-input gate, on the user's desktop, never the service's.
//! No event contents leave this process. Closing stdin or losing its heartbeat
//! exits the message loop and removes both hooks.
use std::{
    cell::RefCell,
    collections::HashSet,
    io::{self, BufRead, Read, Write},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*, System::Threading::GetCurrentThreadId, UI::WindowsAndMessaging::*,
};

#[derive(Default)]
struct Gate {
    phase: u8, // 0 armed, 1 draining input helper, 2 local dialog
    swallowed: HashSet<u32>,
}
impl Gate {
    fn consume(&mut self, physical: bool, press: Option<u32>, down: bool) -> (bool, bool) {
        if !physical {
            return (self.phase == 2, false);
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
thread_local! { static GATE: RefCell<Gate> = RefCell::new(Gate::default()); }
fn consume(physical: bool, press: Option<u32>, down: bool) -> bool {
    let (consume, notify) = GATE.with(|gate| gate.borrow_mut().consume(physical, press, down));
    if notify {
        println!("local-input");
        io::stdout().flush().ok();
    }
    consume
}
unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = &*(l as *const KBDLLHOOKSTRUCT);
        let down = w as u32 == WM_KEYDOWN || w as u32 == WM_SYSKEYDOWN;
        if consume(event.flags & LLKHF_INJECTED == 0, Some(event.vkCode), down) {
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
        if consume(event.flags & LLMHF_INJECTED == 0, press, down) {
            return 1;
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, w, l)
}
pub fn run() {
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
        const COMMAND: u32 = WM_APP + 1;
        std::thread::spawn(move || {
            let mut stdin = io::stdin().lock();
            loop {
                let mut bytes = Vec::new();
                match stdin.by_ref().take(17).read_until(b'\n', &mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let command = match bytes.as_slice() {
                            b"ping\n" => 0,
                            b"confirm\n" => 1,
                            b"resume\n" => 2,
                            _ => break,
                        };
                        if PostThreadMessageW(thread, COMMAND, command, 0) == 0 {
                            break;
                        }
                    }
                }
            }
            PostThreadMessageW(thread, WM_QUIT, 0, 0);
        });
        if SetTimer(std::ptr::null_mut(), 1, 1000, None) == 0 {
            std::process::exit(2);
        }
        let mut last_seen = Instant::now();
        let mut previous_window = std::ptr::null_mut();
        println!("ready");
        io::stdout().flush().ok();
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
            if message.message == COMMAND {
                last_seen = Instant::now();
                match message.wParam {
                    1 => {
                        previous_window = GetForegroundWindow();
                        GATE.with(|gate| gate.borrow_mut().phase = 2);
                        println!("confirmed");
                    }
                    2 => {
                        if !previous_window.is_null() {
                            SetForegroundWindow(previous_window);
                        }
                        GATE.with(|gate| gate.borrow_mut().phase = 0);
                        println!("ready");
                    }
                    _ => (),
                }
                io::stdout().flush().ok();
            } else if message.message == WM_TIMER && last_seen.elapsed() > Duration::from_secs(5) {
                break;
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
        assert_eq!(gate.consume(false, Some(13), true), (false, false));
        assert_eq!(gate.consume(true, Some(13), true), (true, true));
        assert_eq!(gate.consume(false, Some(13), false), (false, false)); // drain releases
        gate.phase = 2;
        assert_eq!(gate.consume(false, Some(13), true), (true, false));
        assert_eq!(gate.consume(true, Some(13), true), (true, false)); // held Enter
        assert_eq!(gate.consume(true, Some(13), false), (true, false));
        assert_eq!(gate.consume(true, Some(13), true), (false, false)); // fresh local press
        gate.phase = 0;
        assert_eq!(gate.consume(false, Some(13), true), (false, false));
    }
}
