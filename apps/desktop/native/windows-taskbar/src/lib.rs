//! Main-only taskbar bridge. Electron 41 always resizes overlays to 16 physical
//! pixels; pass the original DPI-sized image to the Shell instead.
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{HWND, RPC_E_CHANGED_MODE},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            Threading::GetCurrentProcessId,
        },
        UI::{
            Shell::{ITaskbarList3, TaskbarList},
            WindowsAndMessaging::{
                CreateIconFromResourceEx, DestroyIcon, GetWindowThreadProcessId, IsWindow,
                RegisterWindowMessageW, HICON, LR_DEFAULTCOLOR,
            },
        },
    },
};

fn failure(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(format!("Windows taskbar: {error}"))
}

// Only balance successful CoInitializeEx calls; Electron normally already owns
// the apartment. A different existing apartment is usable without reinitializing.
struct Apartment(bool);
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

struct Icon(HICON);
impl Drop for Icon {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            let _ = unsafe { DestroyIcon(self.0) };
        }
    }
}

fn window_from_bytes(bytes: &[u8]) -> napi::Result<HWND> {
    let handle: [u8; std::mem::size_of::<usize>()] = bytes
        .try_into()
        .map_err(|_| failure("invalid window handle"))?;
    let window = HWND(usize::from_le_bytes(handle) as *mut _);
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(window, Some(&mut pid));
        if !IsWindow(window).as_bool() || pid != GetCurrentProcessId() {
            return Err(failure("window is not owned by this process"));
        }
    }
    Ok(window)
}

fn png_size(bytes: &[u8]) -> napi::Result<i32> {
    if bytes.len() < 24 || bytes.len() > 128 * 1024 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(failure("invalid badge PNG"));
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width != height || !(16..=128).contains(&width) {
        return Err(failure("invalid badge dimensions"));
    }
    Ok(width as i32)
}

fn icon_from_png(bytes: &[u8]) -> napi::Result<Icon> {
    let size = png_size(bytes)?;
    // Windows Vista+ accepts a PNG-compressed icon resource. Keep its exact
    // physical dimensions: do not go through Electron's 16px bitmap conversion.
    unsafe { CreateIconFromResourceEx(bytes, true, 0x00030000, size, size, LR_DEFAULTCOLOR) }
        .map(Icon)
        .map_err(failure)
}

#[napi]
pub fn taskbar_button_created_message() -> u32 {
    unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) }
}

#[napi]
pub fn set_overlay_icon(
    handle: Buffer,
    png: Option<Buffer>,
    description: String,
) -> napi::Result<()> {
    let window = window_from_bytes(&handle)?;
    if description.len() > 4096 || description.contains('\0') {
        return Err(failure("invalid badge description"));
    }
    let icon = match png {
        Some(bytes) => icon_from_png(&bytes)?,
        None => Icon(HICON::default()),
    };
    let description: Vec<u16> = description.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return Err(failure(initialized));
        }
        let _apartment = Apartment(initialized.is_ok());
        let taskbar: ITaskbarList3 =
            CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER).map_err(failure)?;
        taskbar.HrInit().map_err(failure)?;
        // The Shell copies HICON before returning, so Icon can always release it.
        taskbar
            .SetOverlayIcon(window, icon.0, PCWSTR(description.as_ptr()))
            .map_err(failure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Gdi::{DeleteObject, GetObjectW, BITMAP};
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    // A 24px opaque PNG: 150% DPI must remain 24px after conversion to HICON.
    const PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 24, 0, 0, 0, 24, 8,
        6, 0, 0, 0, 224, 119, 61, 248, 0, 0, 0, 4, 115, 66, 73, 84, 8, 8, 8, 8, 124, 8, 100, 136,
        0, 0, 0, 1, 115, 82, 71, 66, 0, 174, 206, 28, 233, 0, 0, 0, 39, 73, 68, 65, 84, 72, 137,
        99, 100, 96, 96, 248, 207, 64, 67, 192, 68, 75, 195, 71, 45, 24, 181, 96, 212, 130, 81, 11,
        70, 45, 24, 181, 96, 212, 130, 81, 11, 168, 7, 0, 238, 203, 1, 47, 243, 63, 198, 173, 0, 0,
        0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];

    #[test]
    fn hicon_keeps_physical_resolution() {
        let icon = icon_from_png(PNG).unwrap();
        let mut info = ICONINFO::default();
        unsafe {
            GetIconInfo(icon.0, &mut info).unwrap();
            let mut bitmap = BITMAP::default();
            let result = GetObjectW(
                info.hbmColor,
                std::mem::size_of::<BITMAP>() as i32,
                Some((&mut bitmap as *mut BITMAP).cast()),
            );
            let _ = DeleteObject(info.hbmColor);
            let _ = DeleteObject(info.hbmMask);
            assert_ne!(result, 0);
            assert_eq!((bitmap.bmWidth, bitmap.bmHeight), (24, 24));
        }
    }

    #[test]
    fn rejects_invalid_dimensions_and_handles() {
        assert!(png_size(&[]).is_err());
        let mut nonsquare = PNG.to_vec();
        nonsquare[23] = 16;
        assert!(png_size(&nonsquare).is_err());
        assert!(window_from_bytes(&[0]).is_err());
        assert!(window_from_bytes(&[0; std::mem::size_of::<usize>()]).is_err());
    }
}
