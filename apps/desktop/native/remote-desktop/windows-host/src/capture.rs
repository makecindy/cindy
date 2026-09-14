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
pub struct Capture {
    desktop: desktop::InputDesktop,
    rect: [i32; 4],
}
impl Capture {
    pub fn new(rect: &serde_json::Value) -> Result<Self> {
        let rect = rect.as_array().filter(|r| r.len() == 4).ok_or_else(error)?;
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
            let scale = 1280.0 / (width.max(height) as f64);
            let scale = scale.min(1.0);
            let w = (width as f64 * scale).round().max(1.0) as i32;
            let h = (height as f64 * scale).round().max(1.0) as i32;
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
                SRCCOPY | CAPTUREBLT,
            );
            // The cursor is not necessarily included in the screen DC.
            let mut cursor: CURSORINFO = mem::zeroed();
            cursor.cbSize = mem::size_of::<CURSORINFO>() as u32;
            if ok != 0 && GetCursorInfo(&mut cursor) != 0 && cursor.flags == CURSOR_SHOWING {
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
            for quality in [65, 45, 25, 10] {
                let mut jpeg = Vec::new();
                jpeg_encoder::Encoder::new(&mut jpeg, quality)
                    .encode(&data, w as u16, h as u16, jpeg_encoder::ColorType::Bgra)
                    .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))?;
                if jpeg.len() <= 180000 {
                    let mut line = base64::engine::general_purpose::STANDARD
                        .encode(jpeg)
                        .into_bytes();
                    line.push(b'\n');
                    return Ok(line);
                }
            }
            Err(std::io::Error::from(std::io::ErrorKind::InvalidData))
        }
    }
}
