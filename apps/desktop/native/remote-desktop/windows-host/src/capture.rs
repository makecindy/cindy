use crate::win::*;
use base64::Engine;
use std::{mem, ptr};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    UI::{HiDpi::*, WindowsAndMessaging::*},
};
#[path = "../../windows-input/src/desktop.rs"]
mod desktop;
const OVERLAY_JPEG_LIMIT: usize = 1_000_000;
const LEGACY_JPEG_LIMIT: usize = 180_000;
const OVERLAY_MAX_EDGE: i32 = 4096;
const LEGACY_MAX_EDGE: i32 = 1280;
const OVERLAY_FALLBACK_EDGE: i32 = 1280;

fn screen_copy_operation() -> u32 {
    let mut composed = 0;
    // DWM's screen surface already contains layered windows. CAPTUREBLT forces
    // a legacy layered-window pass that can hide/redraw the physical cursor on
    // every frame. Keep it only for a genuinely non-composited desktop.
    if unsafe { windows_sys::Win32::Graphics::Dwm::DwmIsCompositionEnabled(&mut composed) } >= 0
        && composed != 0
    {
        SRCCOPY
    } else {
        SRCCOPY | CAPTUREBLT
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OverlayBudget {
    quality: u8,
    max_edge: i32,
}

impl OverlayBudget {
    fn new(quality: u8) -> Self {
        Self {
            quality,
            max_edge: OVERLAY_MAX_EDGE,
        }
    }

    fn keep_quality(&mut self, quality: u8) {
        self.quality = quality;
    }

    fn keep_fallback_edge(&mut self) {
        self.max_edge = OVERLAY_FALLBACK_EDGE;
        self.quality = 10;
    }
}

fn overlay_qualities(quality: u8) -> Vec<u8> {
    let mut qualities = Vec::new();
    for candidate in [quality, 45, 25, 10] {
        if candidate <= quality && !qualities.contains(&candidate) {
            qualities.push(candidate);
        }
    }
    qualities
}

fn scale_size(width: i32, height: i32, max_edge: i32) -> (i32, i32) {
    let scale = (max_edge as f64 / width.max(height) as f64).min(1.0);
    (
        (width as f64 * scale).round().max(1.0) as i32,
        (height as f64 * scale).round().max(1.0) as i32,
    )
}

fn resize_bgra(data: &[u8], width: i32, height: i32, next_width: i32, next_height: i32) -> Vec<u8> {
    let mut resized = vec![0; (next_width * next_height * 4) as usize];
    for y in 0..next_height {
        for x in 0..next_width {
            let from = ((y * height / next_height * width + x * width / next_width) * 4) as usize;
            let to = ((y * next_width + x) * 4) as usize;
            resized[to..to + 4].copy_from_slice(&data[from..from + 4]);
        }
    }
    resized
}

fn encode_line(
    overlay: bool,
    data: &[u8],
    width: i32,
    height: i32,
    quality: u8,
    cursor: &Option<serde_json::Value>,
) -> Result<Option<Vec<u8>>> {
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, quality)
        .encode(
            data,
            width as u16,
            height as u16,
            jpeg_encoder::ColorType::Bgra,
        )
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))?;
    if jpeg.len()
        > if overlay {
            OVERLAY_JPEG_LIMIT
        } else {
            LEGACY_JPEG_LIMIT
        }
    {
        return Ok(None);
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(jpeg);
    let mut line = if overlay {
        serde_json::to_vec(&serde_json::json!({"jpeg":encoded, "cursor":cursor}))?
    } else {
        encoded.into_bytes()
    };
    line.push(b'\n');
    Ok(Some(line))
}

pub struct Capture {
    desktop: desktop::InputDesktop,
    rect: [i32; 4],
    overlay: bool,
    budget: OverlayBudget,
}
impl Capture {
    pub fn new(init: &serde_json::Value) -> Result<Self> {
        let rect = init["rect"]
            .as_array()
            .filter(|r| r.len() == 4)
            .ok_or_else(error)?;
        let mut values = [0; 4];
        for (i, v) in rect.iter().enumerate() {
            values[i] = v
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .ok_or_else(error)?;
        }
        if !(1..=16384).contains(&values[2])
            || !(1..=16384).contains(&values[3])
            || values[0].unsigned_abs() > 65536
            || values[1].unsigned_abs() > 65536
        {
            return denied();
        }
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        Ok(Self {
            desktop: desktop::InputDesktop::new(),
            rect: values,
            overlay: init["cursorOverlay"] == true,
            budget: OverlayBudget::new(match init["bitrate"].as_u64() {
                Some(20_000_000) => 95,
                Some(8_000_000) => 80,
                _ => 65,
            }),
        })
    }
    pub fn frame(&mut self) -> Result<Vec<u8>> {
        self.desktop
            .bind()
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::PermissionDenied))?;
        let [x, y, width, height] = self.rect;
        unsafe {
            // Verify the requested region remains exactly one physical monitor.
            // A geometry change invalidates capture instead of sampling another screen.
            let monitor = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONULL);
            let mut info: MONITORINFO = mem::zeroed();
            info.cbSize = mem::size_of::<MONITORINFO>() as u32;
            if monitor.is_null()
                || GetMonitorInfoW(monitor, &mut info) == 0
                || info.rcMonitor.left != x
                || info.rcMonitor.top != y
                || info.rcMonitor.right - x != width
                || info.rcMonitor.bottom - y != height
            {
                return denied();
            }
            // The negotiated path is also the normal video source. Do not force
            // it through the legacy 1280px compatibility-preview ceiling.
            // After a high-detail overflow, later frames reuse the kept edge.
            let (w, h) = scale_size(
                width,
                height,
                if self.overlay {
                    self.budget.max_edge
                } else {
                    LEGACY_MAX_EDGE
                },
            );
            let scale = w as f64 / width as f64;
            let source = GetDC(ptr::null_mut());
            if source.is_null() {
                return Err(error());
            }
            let target = CreateCompatibleDC(source);
            if target.is_null() {
                ReleaseDC(ptr::null_mut(), source);
                return Err(error());
            }
            let mut bitmap: BITMAPINFO = mem::zeroed();
            bitmap.bmiHeader = BITMAPINFOHEADER {
                biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..mem::zeroed()
            };
            let mut pixels = ptr::null_mut();
            let dib = CreateDIBSection(
                source,
                &bitmap,
                DIB_RGB_COLORS,
                &mut pixels,
                ptr::null_mut(),
                0,
            );
            if dib.is_null() || pixels.is_null() {
                if !dib.is_null() {
                    DeleteObject(dib);
                }
                DeleteDC(target);
                ReleaseDC(ptr::null_mut(), source);
                return Err(error());
            }
            let old = SelectObject(target, dib);
            SetStretchBltMode(target, HALFTONE);
            let ok = StretchBlt(
                target,
                0,
                0,
                w,
                h,
                source,
                x,
                y,
                width,
                height,
                screen_copy_operation(),
            );
            // The cursor is not necessarily included in the screen DC.
            let mut cursor: CURSORINFO = mem::zeroed();
            cursor.cbSize = mem::size_of::<CURSORINFO>() as u32;
            if !self.overlay
                && ok != 0
                && GetCursorInfo(&mut cursor) != 0
                && cursor.flags == CURSOR_SHOWING
            {
                let mut icon: ICONINFO = mem::zeroed();
                if GetIconInfo(cursor.hCursor, &mut icon) != 0 {
                    DrawIconEx(
                        target,
                        ((cursor.ptScreenPos.x - x - icon.xHotspot as i32) as f64 * scale) as i32,
                        ((cursor.ptScreenPos.y - y - icon.yHotspot as i32) as f64 * scale) as i32,
                        cursor.hCursor,
                        (GetSystemMetrics(SM_CXCURSOR) as f64 * scale) as i32,
                        (GetSystemMetrics(SM_CYCURSOR) as f64 * scale) as i32,
                        0,
                        ptr::null_mut(),
                        DI_NORMAL,
                    );
                    if !icon.hbmMask.is_null() {
                        DeleteObject(icon.hbmMask);
                    }
                    if !icon.hbmColor.is_null() {
                        DeleteObject(icon.hbmColor);
                    }
                }
            }
            GdiFlush();
            let data = if ok != 0 {
                Some(std::slice::from_raw_parts(pixels.cast::<u8>(), (w * h * 4) as usize).to_vec())
            } else {
                None
            };
            SelectObject(target, old);
            DeleteObject(dib);
            DeleteDC(target);
            ReleaseDC(ptr::null_mut(), source);
            let data = data.ok_or_else(error)?;
            let cursor = if self.overlay {
                crate::cursor::read(self.rect)
            } else {
                None
            };
            encode_frame(self.overlay, data, w, h, &mut self.budget, &cursor)
        }
    }
}

fn fit_overlay_frame(
    width: i32,
    height: i32,
    budget: &mut OverlayBudget,
    mut fits: impl FnMut(i32, i32, u8) -> Result<bool>,
) -> Result<Option<(i32, i32, u8)>> {
    let qualities = overlay_qualities(budget.quality);
    let downscale = width.max(height) > OVERLAY_FALLBACK_EDGE;
    let full_res: Vec<u8> = if downscale {
        qualities
            .into_iter()
            .filter(|quality| *quality != 10)
            .collect()
    } else {
        qualities
    };
    for quality in full_res {
        if fits(width, height, quality)? {
            budget.keep_quality(quality);
            return Ok(Some((width, height, quality)));
        }
    }
    if downscale {
        let (next_width, next_height) = scale_size(width, height, OVERLAY_FALLBACK_EDGE);
        if fits(next_width, next_height, 10)? {
            budget.keep_fallback_edge();
            return Ok(Some((next_width, next_height, 10)));
        }
    }
    Ok(None)
}

fn encode_frame(
    overlay: bool,
    data: Vec<u8>,
    width: i32,
    height: i32,
    budget: &mut OverlayBudget,
    cursor: &Option<serde_json::Value>,
) -> Result<Vec<u8>> {
    if overlay {
        let mut line = None;
        let chosen =
            fit_overlay_frame(width, height, budget, |next_width, next_height, quality| {
                let resized = if next_width == width && next_height == height {
                    None
                } else {
                    Some(resize_bgra(&data, width, height, next_width, next_height))
                };
                let pixels = resized.as_deref().unwrap_or(&data);
                match encode_line(true, pixels, next_width, next_height, quality, cursor)? {
                    Some(encoded) => {
                        line = Some(encoded);
                        Ok(true)
                    }
                    None => Ok(false),
                }
            })?;
        return line
            .filter(|_| chosen.is_some())
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidData));
    }
    for quality in [65, 45, 25, 10] {
        if let Some(encoded) = encode_line(false, &data, width, height, quality, cursor)? {
            return Ok(encoded);
        }
    }
    Err(std::io::Error::from(std::io::ErrorKind::InvalidData))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composed_layered_window_is_captured_without_the_cursor_disturbing_flag() {
        // Explicit Windows integration check. An owned 32px no-activate window
        // supplies known pixels; no desktop image or user content is saved.
        struct Fixture {
            window: HWND,
            brush: HBRUSH,
            class: Vec<u16>,
            instance: HINSTANCE,
            dpi: DPI_AWARENESS_CONTEXT,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                unsafe {
                    if !self.window.is_null() {
                        DestroyWindow(self.window);
                    }
                    UnregisterClassW(self.class.as_ptr(), self.instance);
                    DeleteObject(self.brush);
                    if !self.dpi.is_null() {
                        SetThreadDpiAwarenessContext(self.dpi);
                    }
                }
            }
        }
        unsafe {
            let mut composed = 0;
            if windows_sys::Win32::Graphics::Dwm::DwmIsCompositionEnabled(&mut composed) < 0
                || composed == 0
            {
                return;
            }
            let desktop = windows_sys::Win32::System::StationsAndDesktops::OpenInputDesktop(
                0,
                0,
                windows_sys::Win32::System::StationsAndDesktops::DESKTOP_READOBJECTS,
            );
            if desktop.is_null() {
                return;
            }
            windows_sys::Win32::System::StationsAndDesktops::CloseDesktop(desktop);
            assert_eq!(
                screen_copy_operation(),
                SRCCOPY,
                "requires a composited Windows desktop"
            );
            let instance = windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(ptr::null());
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let class = wide(&format!("CindyCaptureProbe-{}-{nonce}", std::process::id()));
            let marker = 0x0037b51d;
            let mut fixture = Fixture {
                window: ptr::null_mut(),
                brush: CreateSolidBrush(marker),
                class,
                instance,
                dpi: SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2),
            };
            let wc = WNDCLASSW {
                lpfnWndProc: Some(DefWindowProcW),
                hInstance: instance,
                hbrBackground: fixture.brush,
                lpszClassName: fixture.class.as_ptr(),
                ..mem::zeroed()
            };
            assert_ne!(RegisterClassW(&wc), 0);
            fixture.window = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                fixture.class.as_ptr(),
                wide("").as_ptr(),
                WS_POPUP,
                48,
                48,
                32,
                32,
                ptr::null_mut(),
                ptr::null_mut(),
                instance,
                ptr::null(),
            );
            assert!(!fixture.window.is_null());
            assert_ne!(
                SetLayeredWindowAttributes(fixture.window, 0, 255, LWA_ALPHA),
                0
            );
            SetWindowPos(
                fixture.window,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            );
            let until = std::time::Instant::now() + std::time::Duration::from_millis(200);
            while std::time::Instant::now() < until {
                let mut message: MSG = mem::zeroed();
                while PeekMessageW(&mut message, fixture.window, 0, 0, PM_REMOVE) != 0 {
                    DispatchMessageW(&message);
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            windows_sys::Win32::Graphics::Dwm::DwmFlush();
            let mut rect: RECT = mem::zeroed();
            GetWindowRect(fixture.window, &mut rect);
            let source = GetDC(ptr::null_mut());
            let target = CreateCompatibleDC(source);
            let bitmap = CreateCompatibleBitmap(source, 1, 1);
            let old = SelectObject(target, bitmap);
            let ok = StretchBlt(
                target,
                0,
                0,
                1,
                1,
                source,
                (rect.left + rect.right) / 2,
                (rect.top + rect.bottom) / 2,
                1,
                1,
                screen_copy_operation(),
            );
            let pixel = GetPixel(target, 0, 0);
            SelectObject(target, old);
            DeleteObject(bitmap);
            DeleteDC(target);
            ReleaseDC(ptr::null_mut(), source);
            assert_ne!(ok, 0);
            assert_eq!(
                pixel, marker,
                "the composed layered window must remain in the capture"
            );
        }
    }

    #[test]
    fn overlay_quality_ladder_drops_full_res_retries_after_first_overflow() {
        let mut budget = OverlayBudget::new(95);
        let mut attempts = Vec::new();
        let chosen = fit_overlay_frame(3840, 2160, &mut budget, |width, height, quality| {
            attempts.push((width, height, quality));
            Ok(quality == 45)
        })
        .unwrap();
        assert_eq!(chosen, Some((3840, 2160, 45)));
        assert_eq!(attempts, [(3840, 2160, 95), (3840, 2160, 45)]);
        assert_eq!(
            budget,
            OverlayBudget {
                quality: 45,
                max_edge: OVERLAY_MAX_EDGE
            }
        );

        attempts.clear();
        let chosen = fit_overlay_frame(3840, 2160, &mut budget, |width, height, quality| {
            attempts.push((width, height, quality));
            Ok(true)
        })
        .unwrap();
        assert_eq!(chosen, Some((3840, 2160, 45)));
        assert_eq!(attempts, [(3840, 2160, 45)]);
    }

    #[test]
    fn overlay_fallback_resolution_is_kept_for_the_connection() {
        let mut budget = OverlayBudget::new(80);
        let mut attempts = Vec::new();
        let chosen = fit_overlay_frame(3840, 2160, &mut budget, |width, height, quality| {
            attempts.push((width, height, quality));
            Ok(width.max(height) <= OVERLAY_FALLBACK_EDGE)
        })
        .unwrap();
        assert_eq!(chosen, Some((1280, 720, 10)));
        assert_eq!(
            attempts,
            [
                (3840, 2160, 80),
                (3840, 2160, 45),
                (3840, 2160, 25),
                (1280, 720, 10),
            ]
        );
        assert_eq!(
            budget,
            OverlayBudget {
                quality: 10,
                max_edge: OVERLAY_FALLBACK_EDGE
            }
        );

        attempts.clear();
        let (width, height) = scale_size(3840, 2160, budget.max_edge);
        let chosen = fit_overlay_frame(
            width,
            height,
            &mut budget,
            |next_width, next_height, quality| {
                attempts.push((next_width, next_height, quality));
                Ok(true)
            },
        )
        .unwrap();
        assert_eq!(chosen, Some((1280, 720, 10)));
        assert_eq!(attempts, [(1280, 720, 10)]);
    }
}
