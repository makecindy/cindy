//! Region screenshot snapshot helper (Windows).
//!
//! Long-lived during one screenshot: reads one JSON request per stdin line and
//! answers with one JSON line on stdout. Opt-in `frame` requests with
//! `encoding: "bgra"` receive a JSON header then exactly `byteLength` raw bytes,
//! without a trailing newline. Other replies retain the original JSON format.
//! All rectangles are physical screen
//! pixels `[left, top, right, bottom]` (the process is per-monitor DPI aware),
//! Electron converts them to DIP.
//!
//! - `{"id":1,"op":"windows"}` → visible top-level windows, top of the z-order
//!   first, using the DWM frame (without the invisible resize border), plus
//!   bounded native child rectangles for synchronous default-region hit testing.
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
use windows::Win32::Graphics::Dxgi::Common::{DXGI_COLOR_SPACE_TYPE, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020};
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
                ChildWindowFromPointEx, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT,
                GetWindow, GW_CHILD, GW_HWNDNEXT,
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
    let mut hdr_cache = HdrCaptureCache::default();
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let response = match request.get("op").and_then(Value::as_str) {
            Some("scroll") => json!({ "id": id, "ok": scroll_region(&request) }),
            Some("keys") => json!({ "id": id, "keys": pressed_keys() }),
            Some("frame") => {
                let space = monitor_color_space(&request);
                match capture_region(&request, space, &mut hdr_cache) {
                    Some((width, height, pixels)) => {
                        if request.get("encoding").and_then(Value::as_str) == Some("bgra") {
                            let mut header = json!({ "id": id, "width": width, "height": height,
                                "encoding": "bgra", "byteLength": pixels.len() });
                            if request.get("displayProfile").and_then(Value::as_bool) == Some(true) {
                                if request.get("verifySdr").and_then(Value::as_bool) == Some(true) {
                                    header["sdrVerified"] = json!(space == Some(DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709));
                                }
                                // HDR10 outputs are normalized from scRGB FP16 to sRGB (with GDI fallback).
                                if space == Some(DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020) {
                                    header["sdrFromHdr"] = json!(true);
                                } else if let Some(profile) = display_profile(&request) {
                                    header["icc"] = json!(STANDARD.encode(profile));
                                }
                            }
                            if writeln!(stdout, "{header}")
                                .and_then(|_| stdout.write_all(&pixels))
                                .and_then(|_| stdout.flush()).is_err() { break; }
                            continue;
                        }
                        // Older hosts still expect one base64 JSON line.
                        json!({ "id": id, "width": width, "height": height, "pixels": STANDARD.encode(pixels) })
                    },
                    None => json!({ "id": id, "error": "capture-unavailable" }),
                }
            },
            Some("windows") => json!({ "id": id, "windows": enumerate_windows() }),
            Some("elements") => {
                let hwnd = request.get("hwnd").and_then(Value::as_i64);
                let x = request.get("x").and_then(Value::as_i64);
                let y = request.get("y").and_then(Value::as_i64);
                match (hwnd, x.and_then(|v| i32::try_from(v).ok()), y.and_then(|v| i32::try_from(v).ok())) {
                    (Some(hwnd), Some(x), Some(y)) => {
                        let native = content_rect(HWND(hwnd as isize as *mut _), x, y);
                        let (rects, document) = automation.as_ref()
                            .map(|a| element_chain(a, hwnd as isize, x, y)).unwrap_or_default();
                        json!({ "id": id, "rects": rects,
                            "preferredRect": native.or(document).or_else(|| window_rect(HWND(hwnd as isize as *mut _))).as_ref().map(rect_json) })
                    },
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

/// Capture just the host-validated physical rectangle. Both GDI and DXGI
/// Desktop Duplication exclude the mouse; the renderer optionally adds its
/// cursor overlay. On HDR10 outputs, capture the DWM scRGB FP16 composition
/// surface and normalize by the monitor's SDR white level so HDR-aware windows
/// (such as Chromium/Electron) match SDR displays without clipping or washout.
fn capture_region(
    request: &Value,
    space: Option<DXGI_COLOR_SPACE_TYPE>,
    hdr_cache: &mut HdrCaptureCache,
) -> Option<(i32, i32, Vec<u8>)> {
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
    if space == Some(DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020) {
        if let Some(frame) = hdr_cache.capture(x, y, width, height, out_w, out_h) {
            return Some(frame);
        }
    }
    capture_region_gdi(x, y, width, height, out_w, out_h)
}

/// Every GDI object is released.
fn capture_region_gdi(x: i32, y: i32, width: i32, height: i32, out_w: i32, out_h: i32) -> Option<(i32, i32, Vec<u8>)> {
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

use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D};
use windows::Win32::Graphics::Dxgi::IDXGIOutputDuplication;

struct HdrDuplicator {
    monitor: isize,
    device_name: [u16; 32],
    desktop_rect: RECT,
    max_luminance_nits: f32,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    gpu_frame: Option<ID3D11Texture2D>,
    tone_mapper: HdrToneMapper,
}

#[derive(Default)]
struct HdrCaptureCache {
    outputs: Vec<HdrDuplicator>,
}

impl HdrCaptureCache {
    fn capture(&mut self, x: i32, y: i32, width: i32, height: i32, out_w: i32, out_h: i32) -> Option<(i32, i32, Vec<u8>)> {
        let monitor = unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONULL) };
        if monitor.0.is_null() { return None; }
        let key = monitor.0 as isize;
        // Retry once if an existing duplicator lost access (e.g. mode/HDR change).
        for attempt in 0..2 {
            let pos = if let Some(idx) = self.outputs.iter().position(|d| d.monitor == key) {
                idx
            } else {
                let created = HdrDuplicator::new(monitor)?;
                self.outputs.push(created);
                self.outputs.len() - 1
            };
            match self.outputs[pos].capture_rect(x, y, width, height, out_w, out_h) {
                Ok(frame) => return Some(frame),
                Err(HdrCaptureError::AccessLost) if attempt == 0 => {
                    self.outputs.swap_remove(pos);
                }
                Err(_) => return None,
            }
        }
        None
    }
}

enum HdrCaptureError {
    AccessLost,
    Unavailable,
}

impl HdrDuplicator {
    fn new(monitor: HMONITOR) -> Option<Self> {
        use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
        use windows::Win32::Graphics::Direct3D11::{D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION};
        use windows::Win32::Graphics::Dxgi::Common::{
            DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED,
        };
        use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput5, IDXGIOutput6};

        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
            for a in 0.. {
                let Ok(adapter) = factory.EnumAdapters1(a) else { break };
                for i in 0.. {
                    let Ok(output) = adapter.EnumOutputs(i) else { break };
                    let Ok(desc) = output.GetDesc() else { continue };
                    if desc.Monitor != monitor { continue; }
                    let desc1 = output.cast::<IDXGIOutput6>().ok()?.GetDesc1().ok()?;
                    if desc1.ColorSpace != DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020 { return None; }
                    if desc1.Rotation != DXGI_MODE_ROTATION_IDENTITY && desc1.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED {
                        return None;
                    }
                    let mut device: Option<ID3D11Device> = None;
                    let mut context: Option<ID3D11DeviceContext> = None;
                    D3D11CreateDevice(
                        &adapter,
                        D3D_DRIVER_TYPE_UNKNOWN,
                        None,
                        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                        None,
                        D3D11_SDK_VERSION,
                        Some(&mut device),
                        None,
                        Some(&mut context),
                    ).ok()?;
                    let device = device?;
                    let context = context?;
                    let output5: IDXGIOutput5 = output.cast().ok()?;
                    let duplication = output5
                        .DuplicateOutput1(&device, 0, &[DXGI_FORMAT_R16G16B16A16_FLOAT])
                        .ok()?;
                    return Some(Self {
                        monitor: monitor.0 as isize,
                        device_name: desc1.DeviceName,
                        desktop_rect: desc1.DesktopCoordinates,
                        max_luminance_nits: desc1.MaxLuminance,
                        device,
                        context,
                        duplication,
                        gpu_frame: None,
                        tone_mapper: HdrToneMapper::default(),
                    });
                }
            }
        }
        None
    }

    fn capture_rect(
        &mut self,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        out_w: i32,
        out_h: i32,
    ) -> Result<(i32, i32, Vec<u8>), HdrCaptureError> {
        use windows::Win32::Graphics::Direct3D11::{
            D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
            D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
        };
        use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_SAMPLE_DESC};
        use windows::Win32::Graphics::Dxgi::{DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO};

        let desktop_w = self.desktop_rect.right - self.desktop_rect.left;
        let desktop_h = self.desktop_rect.bottom - self.desktop_rect.top;
        let local_x = x - self.desktop_rect.left;
        let local_y = y - self.desktop_rect.top;
        if local_x < 0 || local_y < 0 || local_x + width > desktop_w || local_y + height > desktop_h {
            return Err(HdrCaptureError::Unavailable);
        }

        unsafe {
            let need_initial = self.gpu_frame.is_none();
            let deadline = Instant::now() + Duration::from_millis(if need_initial { 400 } else { 20 });
            loop {
                let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut resource = None;
                let timeout_ms = if need_initial { 50 } else { 16 };
                match self.duplication.AcquireNextFrame(timeout_ms, &mut info, &mut resource) {
                    Ok(()) => {
                        let copied = if info.LastPresentTime != 0 {
                            if let Some(res) = resource.as_ref() {
                                if let Ok(tex) = res.cast::<ID3D11Texture2D>() {
                                    let mut tex_desc = D3D11_TEXTURE2D_DESC::default();
                                    tex.GetDesc(&mut tex_desc);
                                    if tex_desc.Format == DXGI_FORMAT_R16G16B16A16_FLOAT
                                        && tex_desc.Width == desktop_w as u32
                                        && tex_desc.Height == desktop_h as u32
                                    {
                                        if self.gpu_frame.is_none() {
                                            let gpu_desc = D3D11_TEXTURE2D_DESC {
                                                Width: tex_desc.Width,
                                                Height: tex_desc.Height,
                                                MipLevels: 1,
                                                ArraySize: 1,
                                                Format: DXGI_FORMAT_R16G16B16A16_FLOAT,
                                                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                                                Usage: D3D11_USAGE_DEFAULT,
                                                BindFlags: 0,
                                                CPUAccessFlags: 0,
                                                MiscFlags: 0,
                                            };
                                            let mut gpu_tex = None;
                                            if self.device.CreateTexture2D(&gpu_desc, None, Some(&mut gpu_tex)).is_ok() {
                                                self.gpu_frame = gpu_tex;
                                            }
                                        }
                                        if let Some(gpu_tex) = self.gpu_frame.as_ref() {
                                            self.context.CopyResource(gpu_tex, &tex);
                                            true
                                        } else { false }
                                    } else { false }
                                } else { false }
                            } else { false }
                        } else { false };
                        let _ = self.duplication.ReleaseFrame();
                        if copied || !need_initial {
                            break;
                        }
                        if Instant::now() >= deadline {
                            return Err(HdrCaptureError::Unavailable);
                        }
                    }
                    Err(err) if err.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                        if !need_initial { break; }
                        if Instant::now() >= deadline {
                            return Err(HdrCaptureError::Unavailable);
                        }
                    }
                    Err(err) if err.code() == DXGI_ERROR_ACCESS_LOST => {
                        return Err(HdrCaptureError::AccessLost);
                    }
                    Err(_) => return Err(HdrCaptureError::Unavailable),
                }
            }

            let Some(gpu_tex) = self.gpu_frame.as_ref() else {
                return Err(HdrCaptureError::Unavailable);
            };
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Width: width as u32,
                Height: height as u32,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_R16G16B16A16_FLOAT,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut staging = None;
            self.device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))
                .map_err(|_| HdrCaptureError::Unavailable)?;
            let staging = staging.ok_or(HdrCaptureError::Unavailable)?;
            let src_box = D3D11_BOX {
                left: local_x as u32,
                top: local_y as u32,
                front: 0,
                right: (local_x + width) as u32,
                bottom: (local_y + height) as u32,
                back: 1,
            };
            self.context.CopySubresourceRegion(&staging, 0, 0, 0, 0, gpu_tex, 0, Some(&src_box));

            let sdr_scale = query_sdr_white_scale(&self.device_name).unwrap_or(1.0);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|_| HdrCaptureError::Unavailable)?;
            let bgra = if mapped.pData.is_null() {
                None
            } else {
                Some(self.tone_mapper.convert(
                    mapped.pData as *const u8,
                    mapped.RowPitch as usize,
                    width as usize,
                    height as usize,
                    sdr_scale,
                    self.max_luminance_nits,
                ))
            };
            self.context.Unmap(&staging, 0);
            let Some(bgra) = bgra else { return Err(HdrCaptureError::Unavailable); };
            if out_w == width && out_h == height {
                Ok((out_w, out_h, bgra))
            } else {
                Ok((out_w, out_h, resize_bgra_area(&bgra, width as usize, height as usize, out_w as usize, out_h as usize)))
            }
        }
    }
}

/// Query the monitor's Windows "SDR content brightness" white level as a
/// multiplier of 80 nits (the scRGB 1.0 reference), matching DWM composition.
fn query_sdr_white_scale(device_name: &[u16; 32]) -> Option<f32> {
    use windows::Win32::Devices::Display::{
        DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
        DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
        DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SDR_WHITE_LEVEL,
        DISPLAYCONFIG_SOURCE_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
    };
    use windows::Win32::Foundation::ERROR_SUCCESS;

    let target_len = device_name.iter().position(|&c| c == 0).unwrap_or(device_name.len());
    let target = &device_name[..target_len];
    unsafe {
        let mut path_count = 0u32;
        let mut mode_count = 0u32;
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count) != ERROR_SUCCESS {
            return None;
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut path_count,
            paths.as_mut_ptr(),
            &mut mode_count,
            modes.as_mut_ptr(),
            None,
        ) != ERROR_SUCCESS
        {
            return None;
        }
        for path in &paths[..path_count as usize] {
            let mut src = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            src.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            src.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            src.header.adapterId = path.sourceInfo.adapterId;
            src.header.id = path.sourceInfo.id;
            if DisplayConfigGetDeviceInfo(&mut src.header) != 0 { continue; }
            let src_len = src.viewGdiDeviceName.iter().position(|&c| c == 0).unwrap_or(src.viewGdiDeviceName.len());
            if &src.viewGdiDeviceName[..src_len] != target { continue; }

            let mut white = DISPLAYCONFIG_SDR_WHITE_LEVEL::default();
            white.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL;
            white.header.size = std::mem::size_of::<DISPLAYCONFIG_SDR_WHITE_LEVEL>() as u32;
            white.header.adapterId = path.targetInfo.adapterId;
            white.header.id = path.targetInfo.id;
            if DisplayConfigGetDeviceInfo(&mut white.header) == 0 && white.SDRWhiteLevel > 0 {
                return Some((white.SDRWhiteLevel as f32 / 1000.0).clamp(0.5, 20.0));
            }
            break;
        }
    }
    None
}

#[inline]
fn f16_to_f32_non_neg(bits: u16) -> f32 {
    // Negative (bit 15 set) or NaN/Inf (exp == 31) clamp to 0.0 for sRGB output.
    if bits >= 0x7c00 { return 0.0; }
    let exp = (bits >> 10) as u32;
    let frac = (bits & 0x03ff) as u32;
    if exp == 0 {
        (frac as f32) * (1.0 / 16_777_216.0)
    } else {
        f32::from_bits(((exp + 112) << 23) | (frac << 13))
    }
}

#[inline]
fn f16_to_f32_signed(bits: u16) -> f32 {
    let mag = bits & 0x7fff;
    if mag >= 0x7c00 { return 0.0; }
    let v = f16_to_f32_non_neg(mag);
    if bits & 0x8000 != 0 { -v } else { v }
}

#[inline]
fn linear_to_srgb_u8(v: f32) -> u8 {
    if v <= 0.0 { return 0; }
    if v >= 1.0 { return 255; }
    let s = if v <= 0.0031308 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    };
    (s.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

#[derive(Clone, Copy, PartialEq)]
enum ToneMapMode {
    SdrExact,
    HdrShoulder { rolloff_a: f32 },
}

struct LockedToneMap {
    sdr_scale: f32,
    mode: ToneMapMode,
    lut: Vec<u8>,
    knee_h: u16,
}

/// Converts mapped `DXGI_FORMAT_R16G16B16A16_FLOAT` scRGB frames to 8-bit sRGB BGRA.
///
/// Locks the tone-map mode and LUT on the first frame of a capture session (and
/// only refreshes when the monitor's `SDRWhiteLevel` changes) so continuous
/// captures (recording, GIF, and scrolling screenshots) never shift brightness
/// or introduce stitching bands when HDR highlights enter or leave the region.
#[derive(Default)]
struct HdrToneMapper {
    locked: Option<LockedToneMap>,
}

impl HdrToneMapper {
    const KNEE: f32 = 0.80;

    unsafe fn convert(
        &mut self,
        src_ptr: *const u8,
        row_pitch: usize,
        width: usize,
        height: usize,
        sdr_scale: f32,
        max_luminance_nits: f32,
    ) -> Vec<u8> {
        let scale = sdr_scale.max(0.5);
        let inv_scale = 1.0 / scale;

        let needs_init = self
            .locked
            .as_ref()
            .is_none_or(|state| (state.sdr_scale - scale).abs() > 1e-4);
        if needs_init {
            let mut lut = vec![0u8; 0x7c00];
            let mut sdr_limit_h: u16 = 0;
            let mut knee_h: u16 = 0;
            for (h, entry) in lut.iter_mut().enumerate() {
                let lin = f16_to_f32_non_neg(h as u16) * inv_scale;
                if lin <= Self::KNEE { knee_h = h as u16; }
                if lin <= 1.02 { sdr_limit_h = h as u16; }
                *entry = linear_to_srgb_u8(lin);
            }

            // Detect true HDR highlights once for this session; evaluate Rec.709
            // luminance only on pixels exceeding SDR white so saturated P3 SDR
            // colors never dim SDR white.
            let mut peak_luma: f32 = 0.0;
            let mut peak_chan: f32 = 0.0;
            for y in 0..height {
                let row = std::slice::from_raw_parts(src_ptr.add(y * row_pitch) as *const u16, width * 4);
                for px in row.chunks_exact(4) {
                    let rh = px[0];
                    let gh = px[1];
                    let bh = px[2];
                    if (rh > sdr_limit_h && rh < 0x7c00)
                        || (gh > sdr_limit_h && gh < 0x7c00)
                        || (bh > sdr_limit_h && bh < 0x7c00)
                    {
                        let r = f16_to_f32_signed(rh) * inv_scale;
                        let g = f16_to_f32_signed(gh) * inv_scale;
                        let b = f16_to_f32_signed(bh) * inv_scale;
                        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                        if luma > peak_luma { peak_luma = luma; }
                        let m = r.max(g).max(b);
                        if m > peak_chan { peak_chan = m; }
                    }
                }
            }

            let mode = if peak_luma <= 1.02 {
                ToneMapMode::SdrExact
            } else {
                let headroom = 1.0 - Self::KNEE;
                let frame_peak = peak_chan.max(peak_luma);
                let display_peak = if max_luminance_nits > 0.0 {
                    (max_luminance_nits / (80.0 * scale)).clamp(2.0, 20.0)
                } else {
                    frame_peak
                };
                let d_max = display_peak.max(frame_peak).min(20.0) - Self::KNEE;
                let rolloff_a = (d_max - headroom) / (headroom * d_max);
                ToneMapMode::HdrShoulder { rolloff_a }
            };

            self.locked = Some(LockedToneMap {
                sdr_scale: scale,
                mode,
                lut,
                knee_h,
            });
        }

        let state = self.locked.as_ref().unwrap();
        let lut = &state.lut;
        let mut out = vec![0u8; width * height * 4];
        match state.mode {
            ToneMapMode::SdrExact => {
                for y in 0..height {
                    let row = std::slice::from_raw_parts(src_ptr.add(y * row_pitch) as *const u16, width * 4);
                    let dst_row = &mut out[y * width * 4..(y + 1) * width * 4];
                    for (src_px, dst_px) in row.chunks_exact(4).zip(dst_row.chunks_exact_mut(4)) {
                        let r = src_px[0] as usize;
                        let g = src_px[1] as usize;
                        let b = src_px[2] as usize;
                        dst_px[0] = if b < 0x7c00 { lut[b] } else { 0 };
                        dst_px[1] = if g < 0x7c00 { lut[g] } else { 0 };
                        dst_px[2] = if r < 0x7c00 { lut[r] } else { 0 };
                        dst_px[3] = 255;
                    }
                }
            }
            ToneMapMode::HdrShoulder { rolloff_a } => {
                let knee_h = state.knee_h;
                for y in 0..height {
                    let row = std::slice::from_raw_parts(src_ptr.add(y * row_pitch) as *const u16, width * 4);
                    let dst_row = &mut out[y * width * 4..(y + 1) * width * 4];
                    for (src_px, dst_px) in row.chunks_exact(4).zip(dst_row.chunks_exact_mut(4)) {
                        let rh = src_px[0];
                        let gh = src_px[1];
                        let bh = src_px[2];
                        if (rh <= knee_h || rh >= 0x7c00)
                            && (gh <= knee_h || gh >= 0x7c00)
                            && (bh <= knee_h || bh >= 0x7c00)
                        {
                            dst_px[0] = if bh < 0x7c00 { lut[bh as usize] } else { 0 };
                            dst_px[1] = if gh < 0x7c00 { lut[gh as usize] } else { 0 };
                            dst_px[2] = if rh < 0x7c00 { lut[rh as usize] } else { 0 };
                            dst_px[3] = 255;
                        } else {
                            let mut r = f16_to_f32_non_neg(rh) * inv_scale;
                            let mut g = f16_to_f32_non_neg(gh) * inv_scale;
                            let mut b = f16_to_f32_non_neg(bh) * inv_scale;
                            let m = r.max(g).max(b);
                            if m > Self::KNEE {
                                let d = m - Self::KNEE;
                                let mapped = Self::KNEE + d / (1.0 + rolloff_a * d);
                                let factor = mapped / m;
                                r *= factor;
                                g *= factor;
                                b *= factor;
                            }
                            dst_px[0] = linear_to_srgb_u8(b);
                            dst_px[1] = linear_to_srgb_u8(g);
                            dst_px[2] = linear_to_srgb_u8(r);
                            dst_px[3] = 255;
                        }
                    }
                }
            }
        }
        out
    }
}

struct AreaSpan {
    start: usize,
    end: usize,
    w_first: f32,
    w_last: f32,
    inv_weight: f32,
}

fn build_area_spans(src_len: usize, dst_len: usize) -> Vec<AreaSpan> {
    let scale = src_len as f64 / dst_len as f64;
    let mut spans = Vec::with_capacity(dst_len);
    for i in 0..dst_len {
        let lo = i as f64 * scale;
        let hi = ((i + 1) as f64 * scale).min(src_len as f64);
        let start = (lo.floor() as usize).min(src_len - 1);
        let end = (hi.ceil() as usize).clamp(start + 1, src_len);
        let (w_first, w_last, inv_weight) = if end == start + 1 {
            (1.0, 0.0, 1.0)
        } else {
            let wf = ((start + 1) as f64 - lo).max(0.0) as f32;
            let wl = (hi - (end - 1) as f64).max(0.0) as f32;
            let total = (hi - lo).max(1e-6) as f32;
            (wf, wl, 1.0 / total)
        };
        spans.push(AreaSpan { start, end, w_first, w_last, inv_weight });
    }
    spans
}

/// Separable exact box/area filter for antialiasing downscales (e.g. 4K -> 960p GIF)
/// so thin lines and small text are preserved instead of skipped by 2x2 bilinear taps.
fn resize_bgra_area(src: &[u8], src_w: usize, src_h: usize, dst_w: usize, dst_h: usize) -> Vec<u8> {
    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return Vec::new();
    }
    let x_spans = build_area_spans(src_w, dst_w);
    let y_spans = build_area_spans(src_h, dst_h);

    // Pass 1: horizontal area average (src_w x src_h -> dst_w x src_h, 3 f32 channels).
    let mut horiz = vec![0.0f32; dst_w * src_h * 3];
    for y in 0..src_h {
        let src_row = &src[y * src_w * 4..(y + 1) * src_w * 4];
        let tmp_row = &mut horiz[y * dst_w * 3..(y + 1) * dst_w * 3];
        for (dx, span) in x_spans.iter().enumerate() {
            let (mut b, mut g, mut r) = (0.0f32, 0.0f32, 0.0f32);
            if span.end == span.start + 1 {
                let si = span.start * 4;
                b = src_row[si] as f32;
                g = src_row[si + 1] as f32;
                r = src_row[si + 2] as f32;
            } else {
                let si_first = span.start * 4;
                b += src_row[si_first] as f32 * span.w_first;
                g += src_row[si_first + 1] as f32 * span.w_first;
                r += src_row[si_first + 2] as f32 * span.w_first;
                for sx in (span.start + 1)..(span.end - 1) {
                    let si = sx * 4;
                    b += src_row[si] as f32;
                    g += src_row[si + 1] as f32;
                    r += src_row[si + 2] as f32;
                }
                let si_last = (span.end - 1) * 4;
                b += src_row[si_last] as f32 * span.w_last;
                g += src_row[si_last + 1] as f32 * span.w_last;
                r += src_row[si_last + 2] as f32 * span.w_last;
                b *= span.inv_weight;
                g *= span.inv_weight;
                r *= span.inv_weight;
            }
            let di = dx * 3;
            tmp_row[di] = b;
            tmp_row[di + 1] = g;
            tmp_row[di + 2] = r;
        }
    }

    // Pass 2: vertical area average (dst_w x src_h -> dst_w x dst_h, BGRA u8).
    let mut dst = vec![0u8; dst_w * dst_h * 4];
    let mut acc = vec![0.0f32; dst_w * 3];
    for (dy, span) in y_spans.iter().enumerate() {
        let dst_row = &mut dst[dy * dst_w * 4..(dy + 1) * dst_w * 4];
        if span.end == span.start + 1 {
            let tmp_row = &horiz[span.start * dst_w * 3..(span.start + 1) * dst_w * 3];
            for dx in 0..dst_w {
                let ti = dx * 3;
                let di = dx * 4;
                dst_row[di] = (tmp_row[ti].clamp(0.0, 255.0) + 0.5) as u8;
                dst_row[di + 1] = (tmp_row[ti + 1].clamp(0.0, 255.0) + 0.5) as u8;
                dst_row[di + 2] = (tmp_row[ti + 2].clamp(0.0, 255.0) + 0.5) as u8;
                dst_row[di + 3] = 255;
            }
        } else {
            acc.fill(0.0);
            let first_row = &horiz[span.start * dst_w * 3..(span.start + 1) * dst_w * 3];
            for (a, &v) in acc.iter_mut().zip(first_row.iter()) {
                *a += v * span.w_first;
            }
            for sy in (span.start + 1)..(span.end - 1) {
                let mid_row = &horiz[sy * dst_w * 3..(sy + 1) * dst_w * 3];
                for (a, &v) in acc.iter_mut().zip(mid_row.iter()) {
                    *a += v;
                }
            }
            let last_row = &horiz[(span.end - 1) * dst_w * 3..span.end * dst_w * 3];
            for (a, &v) in acc.iter_mut().zip(last_row.iter()) {
                *a += v * span.w_last;
            }
            for dx in 0..dst_w {
                let ti = dx * 3;
                let di = dx * 4;
                dst_row[di] = ((acc[ti] * span.inv_weight).clamp(0.0, 255.0) + 0.5) as u8;
                dst_row[di + 1] = ((acc[ti + 1] * span.inv_weight).clamp(0.0, 255.0) + 0.5) as u8;
                dst_row[di + 2] = ((acc[ti + 2] * span.inv_weight).clamp(0.0, 255.0) + 0.5) as u8;
                dst_row[di + 3] = 255;
            }
        }
    }
    dst
}

// Chromium can serialize a custom SDR and a custom HDR curve in the same
// textual form. Query the actual output when the host cannot distinguish them.
fn monitor_color_space(request: &Value) -> Option<DXGI_COLOR_SPACE_TYPE> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput6};
    let point = POINT { x: request["x"].as_i64()?.try_into().ok()?, y: request["y"].as_i64()?.try_into().ok()? };
    unsafe {
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONULL);
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        for a in 0.. {
            let Ok(adapter) = factory.EnumAdapters1(a) else { break };
            for i in 0.. {
                let Ok(output) = adapter.EnumOutputs(i) else { break };
                if output.GetDesc().ok().is_some_and(|desc| desc.Monitor == monitor) {
                    let desc = output.cast::<IDXGIOutput6>().ok()?.GetDesc1().ok()?;
                    return Some(desc.ColorSpace);
                }
            }
        }
    }
    None
}

fn display_profile(request: &Value) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::os::windows::ffi::OsStringExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::UI::ColorSystem::GetICMProfileW;

    let point = POINT { x: request["x"].as_i64()?.try_into().ok()?, y: request["y"].as_i64()?.try_into().ok()? };
    let mut name = vec![0u16; 32768];
    let mut length = name.len() as u32;
    unsafe {
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONULL);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of_val(&info) as u32;
        if !GetMonitorInfoW(monitor, &mut info.monitorInfo).as_bool() { return None; }
        let dc = CreateDCW(PCWSTR(info.szDevice.as_ptr()), PCWSTR(info.szDevice.as_ptr()), None, None);
        if dc.0.is_null() { return None; }
        let ok = GetICMProfileW(dc, &mut length, PWSTR(name.as_mut_ptr())).as_bool();
        let _ = DeleteDC(dc);
        if !ok { return None; }
    }
    let end = name.iter().position(|&c| c == 0)?;
    let path = std::ffi::OsString::from_wide(&name[..end]);
    let mut data = Vec::new();
    const LIMIT: usize = 4 * 1024 * 1024;
    std::fs::File::open(path).ok()?.take((LIMIT + 1) as u64).read_to_end(&mut data).ok()?;
    if !(128..=LIMIT).contains(&data.len()) || data.get(36..40)? != b"acsp"
        || data.get(16..20)? != b"RGB " || u32::from_be_bytes(data[..4].try_into().ok()?) as usize != data.len() {
        return None;
    }
    Some(data)
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
        let mut regions = Vec::new();
        let mut remaining = 256;
        snapshot_children(hwnd, &rect, 0, &mut remaining, &mut regions);
        windows.push(json!({ "hwnd": hwnd.0 as isize, "rect": rect_json(&rect), "snapRects": regions }));
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

/// Native content hosts remain available even when Chromium has not enabled UIA.
/// Start inside the captured window: screen hit testing would hit our overlay.
fn content_rect(root: HWND, x: i32, y: i32) -> Option<RECT> {
    let outer = window_rect(root)?;
    let mut current = root;
    let mut result = None;
    for _ in 0..MAX_DEPTH {
        let mut point = POINT { x, y };
        if !unsafe { ScreenToClient(current, &mut point) }.as_bool() { break; }
        let child = unsafe { ChildWindowFromPointEx(current, point, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT) };
        if child.0.is_null() || child == current { break; }
        let mut rect = RECT::default();
        if unsafe { GetWindowRect(child, &mut rect) }.is_ok() && usable(&rect)
            && contains(&rect, x, y) && area(&rect) < area(&outer) {
            result = Some(rect);
        }
        current = child;
    }
    result
}

/// Capture once, before the overlay appears. Descendants precede parents and
/// sibling subtrees retain native z-order, so the first containing region wins.
/// Clipping to ancestors prevents a child from snapping outside its host.
unsafe fn snapshot_children(parent: HWND, bounds: &RECT, depth: usize, remaining: &mut usize, regions: &mut Vec<Value>) {
    if depth >= MAX_DEPTH || *remaining == 0 { return; }
    let mut child = GetWindow(parent, GW_CHILD).unwrap_or_default();
    while !child.0.is_null() && *remaining > 0 {
        *remaining -= 1;
        if IsWindowVisible(child).as_bool()
            && GetWindowLongW(child, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT.0 == 0 {
            let mut rect = RECT::default();
            if GetWindowRect(child, &mut rect).is_ok() {
                rect.left = rect.left.max(bounds.left);
                rect.top = rect.top.max(bounds.top);
                rect.right = rect.right.min(bounds.right);
                rect.bottom = rect.bottom.min(bounds.bottom);
                if usable(&rect) {
                    snapshot_children(child, &rect, depth + 1, remaining, regions);
                    regions.push(rect_json(&rect));
                }
            }
        }
        child = GetWindow(child, GW_HWNDNEXT).unwrap_or_default();
    }
}

/// Explore overlapping siblings within one budget. Chrome can expose an empty
/// container before the equally sized branch that actually owns the document.
fn element_chain(automation: &IUIAutomation, hwnd: isize, x: i32, y: i32) -> (Vec<Value>, Option<RECT>) {
    let started = Instant::now();
    let mut best: Vec<RECT> = Vec::new();
    let mut preferred = None;
    let mut walk = || -> windows::core::Result<()> {
        unsafe {
            let cache = automation.CreateCacheRequest()?;
            cache.AddProperty(UIA_BoundingRectanglePropertyId)?;
            cache.AddProperty(UIA_ControlTypePropertyId)?;
            let condition = automation.ControlViewCondition()?;
            cache.SetTreeFilter(&condition)?;
            let root = automation.ElementFromHandle(HWND(hwnd as *mut _))?;
            let mut pending = vec![(root, Vec::<RECT>::new(), None::<RECT>, 0usize)];
            let mut visited = 0;
            while let Some((current, chain, document, depth)) = pending.pop() {
                if started.elapsed() > ELEMENT_BUDGET || visited >= 256 { break; }
                visited += 1;
                if (document.is_some() && preferred.is_none())
                    || (document.is_some() == preferred.is_some() && chain.len() > best.len()) {
                    best = chain.clone(); preferred = document;
                }
                if depth >= MAX_DEPTH { continue; }
                let Ok(children) = current.FindAllBuildCache(TreeScope_Children, &condition, &cache) else { continue };
                let mut candidates = Vec::new();
                for index in 0..children.Length()?.min(512) {
                    if started.elapsed() > ELEMENT_BUDGET { break; }
                    let Ok(child) = children.GetElement(index) else { continue };
                    let Ok(rect) = child.CachedBoundingRectangle() else { continue };
                    if !usable(&rect) || !contains(&rect, x, y) { continue; }
                    let document = document.or_else(|| (child.CachedControlType().ok() == Some(UIA_DocumentControlTypeId)).then_some(rect));
                    candidates.push((child, rect, document));
                }
                candidates.sort_by_key(|(_, rect, _)| area(rect));
                for (child, rect, document) in candidates.into_iter().rev() {
                    let mut next = chain.clone();
                    if next.last() != Some(&rect) { next.push(rect); }
                    pending.push((child, next, document, depth + 1));
                }
            }
            Ok(())
        }
    };
    let _ = walk();
    (best.iter().rev().map(rect_json).collect(), preferred)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f32_to_f16(v: f32) -> u16 {
        let bits = v.to_bits();
        let sign = ((bits >> 16) & 0x8000) as u16;
        let exp = ((bits >> 23) & 0xff) as i32;
        let frac = bits & 0x007f_ffff;
        if exp == 255 {
            return sign | 0x7c00 | if frac != 0 { 1 } else { 0 };
        }
        let half_exp = exp - 112;
        if half_exp <= 0 {
            if half_exp < -10 { return sign; }
            let mant = (frac | 0x0080_0000) >> (14 - half_exp);
            return sign | mant as u16;
        }
        if half_exp >= 31 { return sign | 0x7c00; }
        sign | ((half_exp as u16) << 10) | ((frac >> 13) as u16)
    }

    #[test]
    fn scrgb_sdr_frame_at_320_nits_matches_exact_srgb_without_washout() {
        // Real ROG HDR10 (SDRWhiteLevel = 4000 => 4.0x) scRGB samples:
        // dark sidebar (21,21,23), light-blue icon (141,191,244), pure white (255,255,255).
        let pixels: [[u16; 4]; 3] = [
            [f32_to_f16(0.03021), f32_to_f16(0.03026), f32_to_f16(0.03439), f32_to_f16(1.0)],
            [f32_to_f16(1.068), f32_to_f16(2.084), f32_to_f16(3.631), f32_to_f16(1.0)],
            [f32_to_f16(4.0), f32_to_f16(4.0), f32_to_f16(4.0), f32_to_f16(1.0)],
        ];
        let mut mapper = HdrToneMapper::default();
        let bgra = unsafe {
            mapper.convert(pixels.as_ptr() as *const u8, 24, 3, 1, 4.0, 1000.0)
        };
        assert_eq!(&bgra[0..4], &[23, 21, 21, 255]);
        assert_eq!(&bgra[4..8], &[244, 191, 141, 255]);
        assert_eq!(&bgra[8..12], &[255, 255, 255, 255]);
    }

    #[test]
    fn scrgb_hdr_highlights_preserve_sdr_midtones_and_compress_peaks() {
        // 5 pixels at sdr_scale = 2.0 (160 nits), display peak 640 nits (4.0x SDR):
        // dark (<= 0.80), SDR white (1.0), HDR highlight (2.0), HDR peak (4.0), plus negative/NaN.
        let pixels: [[u16; 4]; 5] = [
            [f32_to_f16(0.06), f32_to_f16(0.06), f32_to_f16(0.06), f32_to_f16(1.0)],
            [f32_to_f16(2.0), f32_to_f16(2.0), f32_to_f16(2.0), f32_to_f16(1.0)],
            [f32_to_f16(4.0), f32_to_f16(2.0), f32_to_f16(1.0), f32_to_f16(1.0)],
            [f32_to_f16(8.0), f32_to_f16(8.0), f32_to_f16(8.0), f32_to_f16(1.0)],
            [f32_to_f16(-0.5), 0x7e00, 0x7c00, f32_to_f16(1.0)],
        ];
        let mut mapper = HdrToneMapper::default();
        let bgra = unsafe {
            mapper.convert(pixels.as_ptr() as *const u8, 40, 5, 1, 2.0, 640.0)
        };
        // Dark pixel (linear 0.03) is completely untouched by the shoulder curve.
        assert_eq!(&bgra[0..4], &[48, 48, 48, 255]);
        // SDR white < HDR highlight < HDR peak == 255 (strictly monotonic, no flat clipping).
        let sdr_white = bgra[4];
        let hdr_mid_r = bgra[10];
        let hdr_peak = bgra[12];
        assert!(sdr_white >= 235 && sdr_white < hdr_mid_r && hdr_mid_r < hdr_peak && hdr_peak == 255,
            "unexpected progression: sdr={sdr_white} mid={hdr_mid_r} peak={hdr_peak}");
        // Negative / NaN / +Inf channels clamp safely to 0.
        assert_eq!(&bgra[16..20], &[0, 0, 0, 255]);
    }

    #[test]
    fn scrgb_saturated_p3_sdr_does_not_dim_sdr_white() {
        // Pure Display-P3 red in linear Rec.709 scRGB is (1.2249, -0.0420, -0.0197):
        // its red channel exceeds 1.0, but its luminance (~0.23) is SDR, so SDR white stays 255.
        let scale = 4.0;
        let pixels: [[u16; 4]; 2] = [
            [f32_to_f16(1.2249 * scale), f32_to_f16(-0.0420 * scale), f32_to_f16(-0.0197 * scale), f32_to_f16(1.0)],
            [f32_to_f16(scale), f32_to_f16(scale), f32_to_f16(scale), f32_to_f16(1.0)],
        ];
        let mut mapper = HdrToneMapper::default();
        let bgra = unsafe {
            mapper.convert(pixels.as_ptr() as *const u8, 16, 2, 1, scale, 1000.0)
        };
        assert_eq!(&bgra[0..4], &[0, 0, 255, 255]);
        assert_eq!(&bgra[4..8], &[255, 255, 255, 255]);
    }

    #[test]
    fn continuous_capture_keeps_unchanged_pixels_stable_when_highlights_enter_or_leave() {
        // Case 1: HDR capture where highlights intensify then leave the region.
        let scale = 2.0;
        let base_mid = [f32_to_f16(1.8), f32_to_f16(1.8), f32_to_f16(1.8), f32_to_f16(1.0)];
        let base_white = [f32_to_f16(2.0), f32_to_f16(2.0), f32_to_f16(2.0), f32_to_f16(1.0)];
        let frame_hdr_1 = [base_mid, base_white, [f32_to_f16(6.0), f32_to_f16(6.0), f32_to_f16(6.0), f32_to_f16(1.0)]];
        let frame_hdr_brighter = [base_mid, base_white, [f32_to_f16(16.0), f32_to_f16(16.0), f32_to_f16(16.0), f32_to_f16(1.0)]];
        let frame_sdr_only = [base_mid, base_white, [f32_to_f16(0.5), f32_to_f16(0.5), f32_to_f16(0.5), f32_to_f16(1.0)]];

        let mut hdr_session = HdrToneMapper::default();
        let out1 = unsafe { hdr_session.convert(frame_hdr_1.as_ptr() as *const u8, 24, 3, 1, scale, 1000.0) };
        let out2 = unsafe { hdr_session.convert(frame_hdr_brighter.as_ptr() as *const u8, 24, 3, 1, scale, 1000.0) };
        let out3 = unsafe { hdr_session.convert(frame_sdr_only.as_ptr() as *const u8, 24, 3, 1, scale, 1000.0) };
        assert_eq!(&out1[0..8], &out2[0..8]);
        assert_eq!(&out1[0..8], &out3[0..8]);

        // Case 2: SDR capture where an HDR highlight later enters the region (e.g. scrolling).
        let mut sdr_session = HdrToneMapper::default();
        let sdr1 = unsafe { sdr_session.convert(frame_sdr_only.as_ptr() as *const u8, 24, 3, 1, scale, 1000.0) };
        let sdr2 = unsafe { sdr_session.convert(frame_hdr_1.as_ptr() as *const u8, 24, 3, 1, scale, 1000.0) };
        assert_eq!(&sdr1[0..8], &sdr2[0..8]);
        assert_eq!(&sdr2[4..8], &[255, 255, 255, 255]);
    }

    #[test]
    fn area_downscale_preserves_thin_lines_without_skipping_pixels() {
        // 8x8 -> 2x2 (4:1 downscale, matching 4K -> 960p GIF). A 1px vertical white line
        // placed at any column in the left half (0..4) must contribute consistently (255 / 4 => 64)
        // instead of disappearing or flickering as bilinear 2x2 taps skip rows/columns.
        for line_col in 0..4usize {
            let mut src = vec![0u8; 8 * 8 * 4];
            for y in 0..8 {
                let idx = (y * 8 + line_col) * 4;
                src[idx] = 255;
                src[idx + 1] = 255;
                src[idx + 2] = 255;
                src[idx + 3] = 255;
            }
            let dst = resize_bgra_area(&src, 8, 8, 2, 2);
            assert_eq!(&dst[0..4], &[64, 64, 64, 255], "top-left pixel for col {line_col}");
            assert_eq!(&dst[4..8], &[0, 0, 0, 255], "top-right pixel for col {line_col}");
            assert_eq!(&dst[8..12], &[64, 64, 64, 255], "bottom-left pixel for col {line_col}");
            assert_eq!(&dst[12..16], &[0, 0, 0, 255], "bottom-right pixel for col {line_col}");
        }
    }
}
