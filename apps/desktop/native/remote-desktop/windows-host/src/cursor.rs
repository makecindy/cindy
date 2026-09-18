//! Read the host cursor without hiding, moving, or changing the physical pointer.
//! BGRA stays on the authenticated local pipe; Main encodes the existing PNG wire shape.
use base64::Engine;
use std::{mem, ptr};
use windows_sys::Win32::{Graphics::Gdi::*, UI::WindowsAndMessaging::*};

struct Icon(ICONINFO);
impl Drop for Icon {
    fn drop(&mut self) {
        unsafe {
            if !self.0.hbmMask.is_null() {
                DeleteObject(self.0.hbmMask);
            }
            if !self.0.hbmColor.is_null() {
                DeleteObject(self.0.hbmColor);
            }
        }
    }
}

struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
}
impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}
impl Surface {
    unsafe fn new(width: i32, height: i32) -> Option<Self> {
        let dc = CreateCompatibleDC(ptr::null_mut());
        if dc.is_null() {
            return None;
        }
        let mut info: BITMAPINFO = mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..mem::zeroed()
        };
        let mut pixels = ptr::null_mut();
        let bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut pixels, ptr::null_mut(), 0);
        if bitmap.is_null() || pixels.is_null() {
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            DeleteDC(dc);
            return None;
        }
        let old = SelectObject(dc, bitmap);
        if old.is_null() || old as isize == -1 {
            DeleteObject(bitmap);
            DeleteDC(dc);
            return None;
        }
        Some(Self { dc, bitmap, old })
    }

    unsafe fn draw(
        &self,
        handle: HCURSOR,
        width: i32,
        height: i32,
        background: u8,
    ) -> Option<Vec<u8>> {
        // Own the pixel buffer in Rust. CreateDIBSection's out-pointer starts
        // null; CodeQL cannot prove the FFI write, so do not dereference it.
        let mut info: BITMAPINFO = mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..mem::zeroed()
        };
        let mut pixels = vec![background; (width as usize) * (height as usize) * 4];
        if SetDIBits(
            self.dc,
            self.bitmap,
            0,
            height as u32,
            pixels.as_ptr().cast(),
            &info,
            DIB_RGB_COLORS,
        ) == 0
            || DrawIconEx(
                self.dc,
                0,
                0,
                handle,
                width,
                height,
                0,
                ptr::null_mut(),
                DI_NORMAL,
            ) == 0
        {
            return None;
        }
        GdiFlush();
        if GetDIBits(
            self.dc,
            self.bitmap,
            0,
            height as u32,
            pixels.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        ) == 0
        {
            return None;
        }
        Some(pixels)
    }
}

// Rendering against both backgrounds handles legacy AND/XOR masks as well as
// alpha cursors. Output is premultiplied BGRA, as Electron's bitmap API expects.
fn composite(black: &[u8], white: &[u8], width: usize) -> Vec<u8> {
    let mut result = black.to_vec();
    let mut inverted = Vec::new();
    for (i, (b, w)) in black.chunks_exact(4).zip(white.chunks_exact(4)).enumerate() {
        let out = &mut result[i * 4..i * 4 + 4];
        if (0..3).any(|c| w[c] < b[c]) {
            // A PNG cannot XOR arbitrary remote content. Use an outlined solid
            // silhouette for these pixels so legacy I-beams stay visible on both backgrounds.
            out.copy_from_slice(&[0, 0, 0, 255]);
            inverted.push(i);
        } else {
            out[3] = 255 - (0..3).map(|c| w[c] - b[c]).max().unwrap_or(255);
        }
    }
    let height = result.len() / 4 / width;
    for i in inverted {
        let x = i % width;
        let y = i / width;
        for ny in y.saturating_sub(1)..=(y + 1).min(height - 1) {
            for nx in x.saturating_sub(1)..=(x + 1).min(width - 1) {
                let pixel = &mut result[(ny * width + nx) * 4..(ny * width + nx) * 4 + 4];
                if pixel[3] == 0 {
                    pixel.copy_from_slice(&[255, 255, 255, 255]);
                }
            }
        }
    }
    result
}

unsafe fn raster(handle: HCURSOR) -> Option<(i32, i32, u32, u32, Vec<u8>)> {
    let mut icon = Icon(mem::zeroed());
    if GetIconInfo(handle, &mut icon.0) == 0 {
        return None;
    }
    let monochrome = icon.0.hbmColor.is_null();
    let bitmap = if monochrome {
        icon.0.hbmMask
    } else {
        icon.0.hbmColor
    };
    let mut info: BITMAP = mem::zeroed();
    if GetObjectW(
        bitmap,
        mem::size_of::<BITMAP>() as i32,
        (&mut info as *mut BITMAP).cast(),
    ) == 0
    {
        return None;
    }
    let width = info.bmWidth;
    let height = if monochrome {
        info.bmHeight / 2
    } else {
        info.bmHeight
    };
    if !(1..=256).contains(&width)
        || !(1..=256).contains(&height)
        || icon.0.xHotspot >= width as u32
        || icon.0.yHotspot >= height as u32
    {
        return None;
    }
    let surface = Surface::new(width, height)?;
    let black = surface.draw(handle, width, height, 0)?;
    let white = surface.draw(handle, width, height, 255)?;
    Some((
        width,
        height,
        icon.0.xHotspot,
        icon.0.yHotspot,
        composite(&black, &white, width as usize),
    ))
}

pub fn read(rect: [i32; 4]) -> Option<serde_json::Value> {
    unsafe {
        let mut cursor: CURSORINFO = mem::zeroed();
        cursor.cbSize = mem::size_of::<CURSORINFO>() as u32;
        if GetCursorInfo(&mut cursor) == 0 || cursor.hCursor.is_null() {
            return None;
        }
        let (width, height, hot_x, hot_y, pixels) = raster(cursor.hCursor)?;
        let [x, y, w, h] = rect;
        let cx = (cursor.ptScreenPos.x as f64 - x as f64) / w as f64;
        let cy = (cursor.ptScreenPos.y as f64 - y as f64) / h as f64;
        Some(serde_json::json!({
            "visible": cursor.flags == CURSOR_SHOWING && (0.0..1.0).contains(&cx) && (0.0..1.0).contains(&cy),
            "x": cx.clamp(0.0, 1.0), "y": cy.clamp(0.0, 1.0),
            "width": width, "height": height, "hotX": hot_x, "hotY": hot_y,
            "bgra": base64::engine::general_purpose::STANDARD.encode(pixels)
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_transparency_opaque_color_and_premultiplied_alpha() {
        let black = [0, 0, 0, 0, 20, 30, 40, 0, 10, 20, 30, 0];
        let white = [255, 255, 255, 0, 20, 30, 40, 0, 137, 147, 157, 0];
        assert_eq!(
            composite(&black, &white, 3),
            [0, 0, 0, 0, 20, 30, 40, 255, 10, 20, 30, 128]
        );
    }

    #[test]
    fn inverse_pixels_have_a_contrasting_outline() {
        let mut black = [0; 36];
        let mut white = [255; 36];
        black[16..20].fill(255);
        white[16..20].fill(0);
        let pixels = composite(&black, &white, 3);
        assert_eq!(&pixels[16..20], &[0, 0, 0, 255]);
        assert!(pixels
            .chunks_exact(4)
            .enumerate()
            .all(|(i, p)| i == 4 || p == [255, 255, 255, 255]));
    }

    #[test]
    fn rasterizes_system_shapes_without_moving_the_pointer() {
        unsafe {
            for name in [IDC_ARROW, IDC_IBEAM, IDC_HAND, IDC_WAIT, IDC_SIZEWE] {
                let handle = LoadCursorW(ptr::null_mut(), name);
                assert!(!handle.is_null());
                let (w, h, x, y, pixels) = raster(handle).expect("system cursor raster");
                assert_eq!(pixels.len(), (w * h * 4) as usize);
                assert!(x < w as u32 && y < h as u32);
                assert!(pixels.chunks_exact(4).any(|p| p[3] > 0));
            }
        }
    }

    #[test]
    fn repeated_cursor_reads_release_gdi_bitmaps_and_contexts() {
        use windows_sys::Win32::System::Threading::{GetGuiResources, GR_GDIOBJECTS};
        unsafe {
            let handle = LoadCursorW(ptr::null_mut(), IDC_ARROW);
            raster(handle).expect("warm cursor cache");
            let process = windows_sys::Win32::System::Threading::GetCurrentProcess();
            let before = GetGuiResources(process, GR_GDIOBJECTS);
            for _ in 0..200 {
                raster(handle).expect("cursor raster");
            }
            assert_eq!(GetGuiResources(process, GR_GDIOBJECTS), before);
        }
    }
}
