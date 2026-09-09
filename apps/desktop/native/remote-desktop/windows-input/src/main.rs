use serde_json::Value;
use std::{
    collections::HashSet,
    io::{self, BufRead, Read, Write},
    sync::mpsc,
    time::Duration,
};
use windows_sys::Win32::UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*};
mod desktop;
mod selection;

static FAILED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn send(input: INPUT) -> bool {
    let ok = unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) == 1 };
    if !ok && !FAILED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        println!("error");
        io::stdout().flush().ok();
    }
    ok
}
fn key(code: u16, down: bool, unicode: bool) -> bool {
    let extended = [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e].contains(&code);
    send(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: if unicode { 0 } else { code },
                wScan: if unicode { code } else { 0 },
                dwFlags: (if down { 0 } else { KEYEVENTF_KEYUP })
                    | (if unicode {
                        KEYEVENTF_UNICODE
                    } else if extended {
                        KEYEVENTF_EXTENDEDKEY
                    } else {
                        0
                    }),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}
fn mouse(flags: u32, dx: i32, dy: i32, data: u32) -> bool {
    send(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}
fn button(b: u64, down: bool) -> bool {
    mouse(
        match (b, down) {
            (0, true) => MOUSEEVENTF_LEFTDOWN,
            (0, false) => MOUSEEVENTF_LEFTUP,
            (1, true) => MOUSEEVENTF_MIDDLEDOWN,
            (1, false) => MOUSEEVENTF_MIDDLEUP,
            (2, true) => MOUSEEVENTF_RIGHTDOWN,
            _ => MOUSEEVENTF_RIGHTUP,
        },
        0,
        0,
        0,
    )
}
fn code(s: &str) -> Option<u16> {
    if s.len() == 4 && s.starts_with("Key") && s.as_bytes()[3].is_ascii_uppercase() {
        return Some(s.as_bytes()[3] as u16);
    }
    if s.len() == 6 && s.starts_with("Digit") && s.as_bytes()[5].is_ascii_digit() {
        return Some(s.as_bytes()[5] as u16);
    }
    if let Some(n) = s.strip_prefix('F').and_then(|v| v.parse::<u16>().ok()) {
        if (1..=12).contains(&n) {
            return Some(0x6f + n);
        }
    }
    Some(match s {
        "Enter" => 13,
        "Escape" => 27,
        "Tab" => 9,
        "Space" => 32,
        "Backspace" => 8,
        "Delete" => 46,
        "Insert" => 45,
        "Home" => 36,
        "End" => 35,
        "PageUp" => 33,
        "PageDown" => 34,
        "ArrowUp" => 38,
        "ArrowDown" => 40,
        "ArrowLeft" => 37,
        "ArrowRight" => 39,
        "ShiftLeft" => 0xa0,
        "ControlLeft" => 0xa2,
        "AltLeft" => 0xa4,
        "MetaLeft" => 0x5b,
        "Minus" => 0xbd,
        "Equal" => 0xbb,
        "BracketLeft" => 0xdb,
        "BracketRight" => 0xdd,
        "Backslash" => 0xdc,
        "Semicolon" => 0xba,
        "Quote" => 0xde,
        "Backquote" => 0xc0,
        "Comma" => 0xbc,
        "Period" => 0xbe,
        "Slash" => 0xbf,
        _ => return None,
    })
}
fn release(keys: &mut HashSet<u16>, buttons: &mut HashSet<u64>) {
    for k in keys.clone() {
        if key(k, false, false) {
            keys.remove(&k);
        }
    }
    for b in buttons.clone() {
        if button(b, false) {
            buttons.remove(&b);
        }
    }
}
fn main() {
    if matches!(std::env::args().nth(1).as_deref(), Some("--clipboard-selection" | "--clipboard-content-selection")) {
        match selection::read(std::env::args().nth(1).as_deref() == Some("--clipboard-content-selection")) {
            Ok(text) => println!("{}", serde_json::json!({"text":text})),
            Err(_) => std::process::exit(2),
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--clipboard-version") {
        // The user-session clipboard must never masquerade as secure-desktop data.
        use windows_sys::Win32::System::{DataExchange::*, StationsAndDesktops::*};
        unsafe {
            let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
            if desktop.is_null() {
                std::process::exit(2);
            }
            let mut name = [0u16; 256];
            let mut needed = 0;
            let ok = GetUserObjectInformationW(
                desktop,
                UOI_NAME,
                name.as_mut_ptr().cast(),
                512,
                &mut needed,
            );
            CloseDesktop(desktop);
            let length = name.iter().position(|c| *c == 0).unwrap_or(name.len());
            if ok == 0 || String::from_utf16_lossy(&name[..length]) != "Default" {
                std::process::exit(2);
            }
            println!("{}", GetClipboardSequenceNumber());
        }
        return;
    }

    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let (tx, rx) = mpsc::sync_channel(64);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            // Bound allocation before reading, not after lines() has allocated
            // an arbitrarily large attacker-controlled string.
            let mut line = Vec::new();
            match input.by_ref().take(32_769).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 32_768 || line.last() != Some(&b'\n') => break,
                Ok(_) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut keys = HashSet::new();
    let mut buttons = HashSet::new();
    let mut desktop = desktop::InputDesktop::new();
    if desktop.bind().is_err() {
        println!("error");
        return;
    }
    println!("ready");
    io::stdout().flush().ok();
    'input: loop {
        let line = match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(_) => break,
        };
        match desktop.bind() {
            Ok(true) => {
                release(&mut keys, &mut buttons);
                break;
            }
            Ok(false) => (),
            Err(_) => {
                println!("error");
                io::stdout().flush().ok();
                break;
            }
        }
        let events: Vec<Value> = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(_) => break,
        };
        if events.len() > 64 {
            break;
        }
        for e in events {
            // Never replay a queued batch on a newly active secure desktop.
            if desktop.bind() != Ok(false) {
                break 'input;
            }
            if FAILED.load(std::sync::atomic::Ordering::SeqCst) {
                release(&mut keys, &mut buttons);
                break;
            }
            let kind = e["kind"].as_str().unwrap_or("");
            match kind {
                "release" => release(&mut keys, &mut buttons),
                "move" | "button" => {
                    if let (Some(x), Some(y)) = (e["x"].as_f64(), e["y"].as_f64()) {
                        unsafe {
                            let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
                            let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
                            let w = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2);
                            let h = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2);
                            mouse(
                                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                                (((x - left as f64) * 65535.0) / (w - 1) as f64) as i32,
                                (((y - top as f64) * 65535.0) / (h - 1) as f64) as i32,
                                0,
                            );
                        }
                    }
                    if kind == "button" {
                        if let (Some(b), Some(down)) = (e["button"].as_u64(), e["down"].as_bool()) {
                            if b <= 2 {
                                if down {
                                    buttons.insert(b);
                                }
                                if button(b, down) && !down {
                                    buttons.remove(&b);
                                }
                            }
                        }
                    }
                }
                "key" => {
                    if let (Some(c), Some(down)) =
                        (e["code"].as_str().and_then(code), e["down"].as_bool())
                    {
                        if down {
                            keys.insert(c);
                        }
                        if key(c, down, false) && !down {
                            keys.remove(&c);
                        }
                    }
                }
                "text" => {
                    if let Some(text) = e["text"].as_str() {
                        for c in text.encode_utf16().take(4096) {
                            if desktop.bind() != Ok(false) {
                                break 'input;
                            }
                            key(c, true, true);
                            key(c, false, true);
                        }
                    }
                }
                "scroll" => {
                    let dy = e["dy"].as_f64().unwrap_or(0.0).clamp(-2000.0, 2000.0) as i32;
                    let dx = e["dx"].as_f64().unwrap_or(0.0).clamp(-2000.0, 2000.0) as i32;
                    if dy != 0 {
                        mouse(MOUSEEVENTF_WHEEL, 0, 0, (-dy) as u32);
                    }
                    if dx != 0 {
                        mouse(MOUSEEVENTF_HWHEEL, 0, 0, dx as u32);
                    }
                }
                _ => (),
            }
        }
        if FAILED.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
    }
    release(&mut keys, &mut buttons);
}
