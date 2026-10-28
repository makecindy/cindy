//! Region screenshot snapshot helper (Windows).
//!
//! Long-lived during one screenshot: reads one JSON request per stdin line and
//! answers with one JSON line on stdout. All rectangles are physical screen
//! pixels `[left, top, right, bottom]` (the process is per-monitor DPI aware),
//! Electron converts them to DIP.
//!
//! - `{"id":1,"op":"windows"}` → visible top-level windows, top of the z-order
//!   first, using the DWM frame (without the invisible resize border).
//! - `{"id":2,"op":"elements","hwnd":N,"x":X,"y":Y}` → UI Automation elements of
//!   that window under the point, innermost first. The window is located from
//!   the snapshot instead of hit-testing the screen, because Cindy's overlay
//!   covers the screen while the user moves the cursor.
//!
//! Geometry plus explicitly requested physical key labels; no window titles or text fields.

use std::io::{self, BufRead, Write};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use base64::{engine::general_purpose::STANDARD, Engine};
use windows::Win32::Graphics::Gdi::*;
use windows::{
    core::Interface,
    Win32::{
        Foundation::{BOOL, HWND, LPARAM, RECT, POINT, WPARAM},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
        System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
        UI::{
            Accessibility::*,
            Input::KeyboardAndMouse::GetAsyncKeyState,
            HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
            WindowsAndMessaging::{
                EnumWindows, GetWindowLongW, GetWindowRect, IsIconic, IsWindowVisible, GWL_EXSTYLE,
                WS_EX_TRANSPARENT, WindowFromPoint, GetAncestor, GA_ROOT, PostMessageW, WM_MOUSEWHEEL,
            },
        },
    },
};

/// Upper bound for one element query; a slow or hung application must not
/// stall the overlay. The caller keeps the last good answer.
const ELEMENT_BUDGET: Duration = Duration::from_millis(250);
const MAX_DEPTH: usize = 40;
const MIN_SIDE: i32 = 4;

fn main() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let automation = create_automation();
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let response = match request.get("op").and_then(Value::as_str) {
            Some("scroll") => json!({ "id": id, "ok": scroll_region(&request) }),
            Some("keys") => json!({ "id": id, "keys": pressed_keys() }),
            Some("frame") => match capture_region(&request) {
                Some((width, height, pixels)) => json!({ "id": id, "width": width, "height": height, "pixels": STANDARD.encode(pixels) }),
                None => json!({ "id": id, "error": "capture-unavailable" }),
            },
            Some("windows") => json!({ "id": id, "windows": enumerate_windows() }),
            Some("elements") => {
                let hwnd = request.get("hwnd").and_then(Value::as_i64);
                let x = request.get("x").and_then(Value::as_i64);
                let y = request.get("y").and_then(Value::as_i64);
                match (&automation, hwnd, x, y) {
                    (Some(automation), Some(hwnd), Some(x), Some(y)) => json!({
                        "id": id,
                        "rects": element_chain(automation, hwnd as isize, x as i32, y as i32),
                    }),
                    (None, ..) => json!({ "id": id, "rects": [] }),
                    _ => json!({ "id": id, "error": "invalid-request" }),
                }
            }
            _ => json!({ "id": id, "error": "unknown-op" }),
        };
        if writeln!(stdout, "{response}").and_then(|_| stdout.flush()).is_err() {
            break;
        }
    }
}

/// Only scroll the snapshotted source while it is still under the selected point.
/// Posting to that window avoids moving the user's cursor or sending clicks/keys.
fn scroll_region(request: &Value) -> bool {
    let Some(handle) = request.get("hwnd").and_then(Value::as_i64) else { return false; };
    let Some(x) = request.get("x").and_then(Value::as_i64).and_then(|n| i32::try_from(n).ok()) else { return false; };
    let Some(y) = request.get("y").and_then(Value::as_i64).and_then(|n| i32::try_from(n).ok()) else { return false; };
    let Some(delta) = request.get("delta").and_then(Value::as_i64).filter(|d| (-120..=-1).contains(d)) else { return false; };
    unsafe {
        let target = WindowFromPoint(POINT { x, y });
        let expected = HWND(handle as isize as *mut _);
        if target.0.is_null() || GetAncestor(target, GA_ROOT) != expected || !IsWindowVisible(expected).as_bool() { return false; }
        let position = ((y as u32 & 0xffff) << 16) | (x as u32 & 0xffff);
        PostMessageW(target, WM_MOUSEWHEEL, WPARAM(((delta as i16 as u16 as u32) << 16) as usize), LPARAM(position as isize)).is_ok()
    }
}

fn pressed_keys() -> Vec<String> {
    let mut result = Vec::new();
    for (code, label) in [(0x11, "Ctrl"), (0x12, "Alt"), (0x10, "Shift"), (0x5b, "Win"),
        (0x0d, "Enter"), (0x09, "Tab"), (0x20, "Space"), (0x08, "Backspace"),
        (0x25, "←"), (0x26, "↑"), (0x27, "→"), (0x28, "↓"), (0x2e, "Delete")] {
        if unsafe { GetAsyncKeyState(code) } < 0 { result.push(label.to_string()); }
    }
    for code in 0x30..=0x5a {
        if (code <= 0x39 || code >= 0x41) && unsafe { GetAsyncKeyState(code) } < 0 {
            result.push(char::from_u32(code as u32).unwrap().to_string());
        }
    }
    for code in 0x70..=0x7b {
        if unsafe { GetAsyncKeyState(code) } < 0 { result.push(format!("F{}", code - 0x70 + 1)); }
    }
    result.truncate(8);
    result
}

/// Capture just the host-validated physical rectangle. GDI excludes the mouse;
/// the renderer optionally adds its cursor overlay. Every GDI object is released.
fn capture_region(request: &Value) -> Option<(i32, i32, Vec<u8>)> {
    let x = i32::try_from(request.get("x")?.as_i64()?).ok()?;
    let y = i32::try_from(request.get("y")?.as_i64()?).ok()?;
    let width = i32::try_from(request.get("width")?.as_i64()?).ok()?;
    let height = i32::try_from(request.get("height")?.as_i64()?).ok()?;
    let edge = i32::try_from(request.get("edge")?.as_i64()?).ok()?;
    if width <= 0 || height <= 0 || width > 32768 || height > 32768 || !(32..=32768).contains(&edge) { return None; }
    let ratio = (edge as f64 / width.max(height) as f64).min(1.0);
    let out_w = (width as f64 * ratio).round().max(1.0) as i32;
    let out_h = (height as f64 * ratio).round().max(1.0) as i32;
    if i64::from(out_w) * i64::from(out_h) > 32_000_000 { return None; }
    unsafe {
        let desktop = GetDC(HWND::default());
        if desktop.0.is_null() { return None; }
        let memory = CreateCompatibleDC(desktop);
        if memory.0.is_null() { ReleaseDC(HWND::default(), desktop); return None; }
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = out_w;
        info.bmiHeader.biHeight = -out_h;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;
        let mut pixels = std::ptr::null_mut();
        let bitmap = CreateDIBSection(memory, &info, DIB_RGB_COLORS, &mut pixels, None, 0);
        let result = if let Ok(bitmap) = bitmap {
            let previous = SelectObject(memory, bitmap);
            let _ = SetStretchBltMode(memory, HALFTONE);
            let ok = StretchBlt(memory, 0, 0, out_w, out_h, desktop, x, y, width, height, SRCCOPY | CAPTUREBLT).as_bool();
            let _ = GdiFlush();
            let output = if ok && !pixels.is_null() {
                let mut data = std::slice::from_raw_parts(pixels as *const u8, (out_w * out_h * 4) as usize).to_vec();
                for pixel in data.chunks_exact_mut(4) { pixel[3] = 255; }
                Some((out_w, out_h, data))
            } else { None };
            SelectObject(memory, previous);
            let _ = DeleteObject(bitmap);
            output
        } else { None };
        let _ = DeleteDC(memory);
        ReleaseDC(HWND::default(), desktop);
        result
    }
}

fn create_automation() -> Option<IUIAutomation> {
    unsafe {
        // IUIAutomation2 lets us cap cross-process calls into unresponsive apps.
        if let Ok(automation) =
            CoCreateInstance::<_, IUIAutomation2>(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
        {
            let _ = automation.SetConnectionTimeout(100);
            let _ = automation.SetTransactionTimeout(50);
            return automation.cast().ok();
        }
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()
    }
}

fn rect_json(rect: &RECT) -> Value {
    json!([rect.left, rect.top, rect.right, rect.bottom])
}

fn usable(rect: &RECT) -> bool {
    rect.right - rect.left >= MIN_SIDE && rect.bottom - rect.top >= MIN_SIDE
}

fn window_rect(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    let frame = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if frame.is_err() && unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return None;
    }
    usable(&rect).then_some(rect)
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked: u32 = 0;
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
    }
    .is_ok()
        && cloaked != 0
}

unsafe extern "system" fn collect_window(hwnd: HWND, data: LPARAM) -> BOOL {
    let windows = &mut *(data.0 as *mut Vec<Value>);
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || is_cloaked(hwnd) {
        return true.into();
    }
    // Click-through windows (system overlays, notification layers) are never
    // what the user points at; skipping them keeps snapping under them working.
    if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT.0 != 0 {
        return true.into();
    }
    if let Some(rect) = window_rect(hwnd) {
        windows.push(json!({ "hwnd": hwnd.0 as isize, "rect": rect_json(&rect) }));
    }
    true.into()
}

fn enumerate_windows() -> Vec<Value> {
    let mut windows: Vec<Value> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect_window), LPARAM(&mut windows as *mut _ as isize));
    }
    windows
}

fn contains(rect: &RECT, x: i32, y: i32) -> bool {
    x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}

fn area(rect: &RECT) -> i64 {
    (rect.right - rect.left) as i64 * (rect.bottom - rect.top) as i64
}

/// Walks the control view from the window down, at each level taking the
/// smallest child that contains the point. Returns innermost first.
fn element_chain(automation: &IUIAutomation, hwnd: isize, x: i32, y: i32) -> Vec<Value> {
    let started = Instant::now();
    let mut chain: Vec<RECT> = Vec::new();
    let mut walk = || -> windows::core::Result<()> {
        unsafe {
            let cache = automation.CreateCacheRequest()?;
            cache.AddProperty(UIA_BoundingRectanglePropertyId)?;
            let condition = automation.ControlViewCondition()?;
            cache.SetTreeFilter(&condition)?;
            let mut current = automation.ElementFromHandle(HWND(hwnd as *mut _))?;
            for _ in 0..MAX_DEPTH {
                if started.elapsed() > ELEMENT_BUDGET {
                    break;
                }
                let children = current.FindAllBuildCache(TreeScope_Children, &condition, &cache)?;
                let mut best: Option<(i64, IUIAutomationElement, RECT)> = None;
                for index in 0..children.Length()? {
                    if started.elapsed() > ELEMENT_BUDGET {
                        break;
                    }
                    let Ok(child) = children.GetElement(index) else { continue };
                    let Ok(rect) = child.CachedBoundingRectangle() else { continue };
                    if !usable(&rect) || !contains(&rect, x, y) {
                        continue;
                    }
                    let size = area(&rect);
                    if best.as_ref().map_or(true, |(best_size, ..)| size < *best_size) {
                        best = Some((size, child, rect));
                    }
                }
                let Some((_, child, rect)) = best else { break };
                if chain.last() != Some(&rect) {
                    chain.push(rect);
                }
                current = child;
            }
            Ok(())
        }
    };
    let _ = walk();
    chain.iter().rev().map(rect_json).collect()
}
