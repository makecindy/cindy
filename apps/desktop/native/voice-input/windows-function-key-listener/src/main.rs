#[cfg(any(windows, test))]
mod keys;
#[cfg(any(windows, test))]
mod press;

#[cfg(not(windows))]
fn main() {
    eprintln!("This helper is only supported on Windows.");
    std::process::exit(2);
}

#[cfg(windows)]
mod windows_listener {
    use std::io::{self, Write};
    use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};

    use crate::keys::{modifier_bit, other_key_slot, seed_other_key_slots};
    use crate::press::{
        initial_target_press, on_foreign_keydown, on_target_keydown, on_target_keyup, TargetPress,
    };

    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_F1, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_RCONTROL, VK_RMENU,
        VK_RSHIFT, VK_RWIN,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION,
        KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    static TARGET_VK: AtomicU32 = AtomicU32::new(0);
    static MODIFIERS_DOWN: AtomicU32 = AtomicU32::new(0);
    static OTHER_KEYS: [AtomicU64; 4] = [
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
    ];
    static TARGET_PRESS: AtomicU8 = AtomicU8::new(TargetPress::Idle as u8);

    pub fn run() -> i32 {
        let Some(function_number) = parse_function_number() else {
            emit_error("Expected exactly one argument from F1 through F24.");
            return 2;
        };
        let target_vk = VK_F1 as u32 + function_number - 1;
        TARGET_VK.store(target_vk, Ordering::Relaxed);
        MODIFIERS_DOWN.store(seed_modifier_state(), Ordering::Relaxed);
        seed_other_key_state(target_vk);
        let target_already_down = unsafe { GetAsyncKeyState(target_vk as i32) } < 0;
        TARGET_PRESS.store(
            initial_target_press(target_already_down) as u8,
            Ordering::Relaxed,
        );

        let module = unsafe { GetModuleHandleW(std::ptr::null()) };
        if module.is_null() {
            emit_error("Could not resolve the Windows function key listener module.");
            return 3;
        }
        let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0) };
        if hook.is_null() {
            emit_error("Could not install the Windows keyboard listener.");
            return 3;
        }

        emit_line("{\"type\":\"ready\"}");
        let mut message: MSG = unsafe { std::mem::zeroed() };
        while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {}

        unsafe { UnhookWindowsHookEx(hook) };
        0
    }

    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code != HC_ACTION as i32 {
            return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
        }

        let event = &*(lparam as *const KBDLLHOOKSTRUCT);
        let target_vk = TARGET_VK.load(Ordering::Relaxed);
        let message = wparam as u32;
        let key_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        let key_up = message == WM_KEYUP || message == WM_SYSKEYUP;
        let modifier_bit = modifier_bit(event.vkCode);

        if modifier_bit != 0 {
            if key_down {
                MODIFIERS_DOWN.fetch_or(modifier_bit, Ordering::Relaxed);
            } else if key_up {
                MODIFIERS_DOWN.fetch_and(!modifier_bit, Ordering::Relaxed);
            }
        } else if event.vkCode != target_vk {
            if key_down {
                set_other_key(event.vkCode, true);
            } else if key_up {
                set_other_key(event.vkCode, false);
            }
        }

        if key_down && event.vkCode != target_vk {
            let current = TargetPress::from_u8(TARGET_PRESS.load(Ordering::Relaxed));
            let effect = on_foreign_keydown(current);
            TARGET_PRESS.store(effect.next as u8, Ordering::Relaxed);
            if effect.emit_canceled {
                emit_canceled();
            }
        }

        if event.vkCode == target_vk {
            let current = TargetPress::from_u8(TARGET_PRESS.load(Ordering::Relaxed));
            if key_down {
                let exact_chord =
                    MODIFIERS_DOWN.load(Ordering::Relaxed) == 0 && !any_other_key_down();
                let effect = on_target_keydown(current, exact_chord);
                TARGET_PRESS.store(effect.next as u8, Ordering::Relaxed);
                if let Some(pressed) = effect.emit_pressed {
                    emit_pressed(pressed);
                }
                return if effect.swallow { 1 } else { 0 };
            }
            if key_up {
                let effect = on_target_keyup(current);
                TARGET_PRESS.store(effect.next as u8, Ordering::Relaxed);
                if let Some(pressed) = effect.emit_pressed {
                    emit_pressed(pressed);
                }
                return if effect.swallow { 1 } else { 0 };
            }
        }

        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    fn set_other_key(vk: u32, down: bool) {
        let Some((index, bit)) = other_key_slot(vk) else {
            return;
        };
        if down {
            OTHER_KEYS[index].fetch_or(bit, Ordering::Relaxed);
        } else {
            OTHER_KEYS[index].fetch_and(!bit, Ordering::Relaxed);
        }
    }

    fn any_other_key_down() -> bool {
        OTHER_KEYS
            .iter()
            .any(|slot| slot.load(Ordering::Relaxed) != 0)
    }

    fn seed_other_key_state(target_vk: u32) {
        let slots =
            seed_other_key_slots(target_vk, |vk| unsafe { GetAsyncKeyState(vk as i32) } < 0);
        for (index, value) in slots.iter().enumerate() {
            OTHER_KEYS[index].store(*value, Ordering::Relaxed);
        }
    }

    fn parse_function_number() -> Option<u32> {
        let value = std::env::args().nth(1)?;
        let number = value.strip_prefix('F')?.parse::<u32>().ok()?;
        (1..=24).contains(&number).then_some(number)
    }

    fn seed_modifier_state() -> u32 {
        [
            VK_LSHIFT,
            VK_RSHIFT,
            VK_LCONTROL,
            VK_RCONTROL,
            VK_LMENU,
            VK_RMENU,
            VK_LWIN,
            VK_RWIN,
        ]
        .into_iter()
        .fold(0, |state, vk| {
            let is_down = unsafe { GetAsyncKeyState(vk as i32) } < 0;
            if is_down {
                state | modifier_bit(vk as u32)
            } else {
                state
            }
        })
    }

    fn emit_pressed(pressed: bool) {
        emit_line(if pressed {
            "{\"type\":\"pressed\",\"pressed\":true}"
        } else {
            "{\"type\":\"pressed\",\"pressed\":false}"
        });
    }

    fn emit_canceled() {
        emit_line("{\"type\":\"canceled\"}");
    }

    fn emit_error(message: &str) {
        let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
        emit_line(&format!("{{\"type\":\"error\",\"message\":\"{escaped}\"}}"));
    }

    fn emit_line(line: &str) {
        let mut stdout = io::stdout().lock();
        if writeln!(stdout, "{line}").is_err() || stdout.flush().is_err() {
            std::process::exit(0);
        }
    }
}

#[cfg(windows)]
fn main() {
    std::process::exit(windows_listener::run());
}
