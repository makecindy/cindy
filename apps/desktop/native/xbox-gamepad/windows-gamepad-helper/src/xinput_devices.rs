use std::collections::BTreeSet;
use windows::Win32::{Foundation::HANDLE, UI::Input::*};

/// Hardware products whose HID interface declares ownership by the XInput driver.
#[derive(Default)]
pub struct XInputProducts(BTreeSet<(u16, u16)>);

impl XInputProducts {
    fn update(&mut self, interfaces: &[(u16, u16, &str)], complete: bool) {
        if complete {
            self.0.clear();
        }
        for &(vendor, product, path) in interfaces {
            // Windows documents IG_ interfaces as XInput-owned. Match a hardware
            // component, not the display name (or a substring such as BIG_00).
            let path = path.to_ascii_uppercase();
            if path.split(['&', '#', '\\']).any(|component| {
                component.strip_prefix("IG_").is_some_and(|index| {
                    index.len() == 2 && index.bytes().all(|b| b.is_ascii_hexdigit())
                })
            }) {
                self.0.insert((vendor, product));
            }
        }
    }

    pub fn contains(&self, vendor: u16, product: u16) -> bool {
        self.0.contains(&(vendor, product))
    }

    pub fn refresh(&mut self) {
        let Some(devices) = device_list() else { return };
        let mut complete = true;
        let mut interfaces = Vec::new();
        for device in devices {
            if device.dwType != RIM_TYPEHID {
                continue;
            }
            match hid_interface(device.hDevice) {
                Some(info) => interfaces.push(info),
                None => complete = false,
            }
        }
        let borrowed: Vec<_> = interfaces
            .iter()
            .map(|(v, p, name)| (*v, *p, name.as_str()))
            .collect();
        // A racing removal/access failure must not forget an already excluded
        // duplicate. Successful complete enumeration retires stale products.
        self.update(&borrowed, complete);
    }
}

fn device_list() -> Option<Vec<RAWINPUTDEVICELIST>> {
    let mut count = 0;
    let size = std::mem::size_of::<RAWINPUTDEVICELIST>() as u32;
    // SAFETY: size matches the API structure; count is writable; first call has no output buffer.
    if unsafe { GetRawInputDeviceList(None, &mut count, size) } == u32::MAX || count > 4096 {
        return None;
    }
    if count == 0 {
        return Some(Vec::new());
    }
    let mut devices = vec![RAWINPUTDEVICELIST::default(); count as usize];
    // SAFETY: allocation holds count initialized records. API receives its true capacity.
    let read = unsafe { GetRawInputDeviceList(Some(devices.as_mut_ptr()), &mut count, size) };
    if read == u32::MAX || read as usize > devices.len() {
        return None;
    }
    devices.truncate(read as usize);
    Some(devices)
}

fn hid_interface(handle: HANDLE) -> Option<(u16, u16, String)> {
    let mut info = RID_DEVICE_INFO {
        cbSize: std::mem::size_of::<RID_DEVICE_INFO>() as u32,
        ..Default::default()
    };
    let mut size = info.cbSize;
    // SAFETY: handle came from Raw Input; info and size are valid initialized output storage.
    if unsafe {
        GetRawInputDeviceInfoW(
            Some(handle),
            RIDI_DEVICEINFO,
            Some((&mut info as *mut RID_DEVICE_INFO).cast()),
            &mut size,
        )
    } == u32::MAX
        || info.dwType != RIM_TYPEHID
    {
        return None;
    }
    // SAFETY: dwType was checked before accessing the HID union arm.
    let hid = unsafe { info.Anonymous.hid };
    let vendor = u16::try_from(hid.dwVendorId).ok()?;
    let product = u16::try_from(hid.dwProductId).ok()?;
    let mut chars = 0;
    // SAFETY: query required UTF-16 capacity without an output buffer.
    if unsafe { GetRawInputDeviceInfoW(Some(handle), RIDI_DEVICENAME, None, &mut chars) }
        == u32::MAX
        || chars == 0
        || chars > 4096
    {
        return None;
    }
    let mut name = vec![0u16; chars as usize];
    // SAFETY: name has the queried capacity in UTF-16 units, not bytes.
    let read = unsafe {
        GetRawInputDeviceInfoW(
            Some(handle),
            RIDI_DEVICENAME,
            Some(name.as_mut_ptr().cast()),
            &mut chars,
        )
    };
    if read == u32::MAX || read as usize > name.len() {
        return None;
    }
    let end = name.iter().position(|c| *c == 0).unwrap_or(read as usize);
    Some((vendor, product, String::from_utf16(&name[..end]).ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn third_party_xinput_is_excluded_without_an_xbox_name_or_microsoft_vendor() {
        let mut products = XInputProducts::default();
        products.update(
            &[(0x046d, 0xc21d, r"\\?\HID#VID_046D&PID_C21D&IG_00#device")],
            true,
        );
        assert!(products.contains(0x046d, 0xc21d));
        assert!(!products.contains(0x046d, 0xc216));
        assert!(!products.contains(0x054c, 0x0ce6));
    }

    #[test]
    fn unrelated_hid_and_misleading_names_do_not_claim_xinput_ownership() {
        let mut products = XInputProducts::default();
        products.update(
            &[
                (1, 2, r"\\?\HID#VID_0001&PID_0002#Xbox"),
                (3, 4, "BIG_00"),
                (5, 6, "&IG_0Z#"),
            ],
            true,
        );
        assert!(products.0.is_empty());
        products.update(&[(7, 8, r"\\?\hid#vid_0007&pid_0008&ig_01#device")], true);
        assert!(products.contains(7, 8));
    }

    #[test]
    fn partial_probe_failure_cannot_reintroduce_a_known_duplicate() {
        let mut products = XInputProducts::default();
        products.update(&[(1, 2, "&IG_00#")], true);
        products.update(&[(3, 4, "&IG_01#")], false);
        assert!(products.contains(1, 2));
        assert!(products.contains(3, 4));
        products.update(&[], true);
        assert!(products.0.is_empty());
    }
}
