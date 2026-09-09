//! Input belongs to the active Windows desktop, not permanently to Default.
//! This does not grant access: the OS still checks the process token. Secure
//! desktops require the session worker to be launched by the SYSTEM broker.
use windows_sys::Win32::System::StationsAndDesktops::*;

pub struct InputDesktop {
    handle: HDESK,
    original: HDESK,
    name: Vec<u16>,
}

impl InputDesktop {
    pub fn new() -> Self {
        Self {
            handle: std::ptr::null_mut(),
            original: unsafe {
                GetThreadDesktop(windows_sys::Win32::System::Threading::GetCurrentThreadId())
            },
            name: Vec::new(),
        }
    }

    /// Call only on the input thread, which must never own windows or hooks.
    /// Returns true after a transition; callers discard the transition batch
    /// so characters intended for the previous screen cannot reach a password
    /// prompt or another user's desktop.
    pub fn bind(&mut self) -> Result<bool, ()> {
        unsafe {
            let next = OpenInputDesktop(
                0,
                0,
                DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS | DESKTOP_SWITCHDESKTOP,
            );
            if next.is_null() {
                return Err(());
            }
            let mut name = vec![0u16; 256];
            let mut needed = 0;
            if GetUserObjectInformationW(
                next,
                UOI_NAME,
                name.as_mut_ptr().cast(),
                (name.len() * 2) as u32,
                &mut needed,
            ) == 0
            {
                CloseDesktop(next);
                return Err(());
            }
            name.truncate((needed as usize / 2).min(name.len()));
            if !self.handle.is_null() && name == self.name {
                CloseDesktop(next);
                return Ok(false);
            }
            if SetThreadDesktop(next) == 0 {
                CloseDesktop(next);
                return Err(());
            }
            let changed = !self.handle.is_null();
            if changed {
                CloseDesktop(self.handle);
            }
            self.handle = next;
            self.name = name;
            Ok(changed)
        }
    }
}

impl Drop for InputDesktop {
    fn drop(&mut self) {
        unsafe {
            // A desktop cannot be closed while still assigned to this thread.
            if !self.handle.is_null() && SetThreadDesktop(self.original) != 0 {
                CloseDesktop(self.handle);
            }
        }
    }
}
