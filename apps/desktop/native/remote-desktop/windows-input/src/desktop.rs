//! Input belongs to the active Windows desktop, not permanently to Default.
//! This does not grant access: the OS still checks the process token. Secure
//! desktops require the session worker to be launched by the SYSTEM broker.
use windows_sys::Win32::Foundation::GetLastError;
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
    /// prompt or another user's desktop. The error is the Win32 status of the
    /// call that failed, so a machine that cannot bind can be told apart in the
    /// field without a debugger.
    pub fn bind(&mut self) -> Result<bool, u32> {
        unsafe {
            let next = OpenInputDesktop(
                0,
                0,
                // An explicitly attached desktop needs JOURNALPLAYBACK access
                // for SendInput, even though we do not install journaling hooks.
                // Without it binding succeeds, then the first input fails with
                // ERROR_ACCESS_DENIED. The desktop ACL and UIPI still apply.
                DESKTOP_READOBJECTS
                    | DESKTOP_WRITEOBJECTS
                    | DESKTOP_SWITCHDESKTOP
                    | DESKTOP_JOURNALPLAYBACK,
            );
            if next.is_null() {
                return Err(GetLastError());
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
                // Read the status before closing: closing has its own result.
                let status = GetLastError();
                CloseDesktop(next);
                return Err(status);
            }
            name.truncate((needed as usize / 2).min(name.len()));
            if !self.handle.is_null() && name == self.name {
                CloseDesktop(next);
                return Ok(false);
            }
            if SetThreadDesktop(next) == 0 {
                let status = GetLastError();
                CloseDesktop(next);
                return Err(status);
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

#[cfg(test)]
mod tests {
    use super::InputDesktop;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;

    // Explicit native integration check: run on an unlocked interactive Windows
    // desktop. Zero relative movement never clicks, types or moves the pointer.
    fn accepts_zero_movement() -> bool {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_MOVE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) == 1 }
    }

    #[test]
    fn binding_and_rechecking_preserve_input_access() {
        assert!(
            accepts_zero_movement(),
            "requires an interactive Windows desktop"
        );
        {
            let mut desktop = InputDesktop::new();
            assert_eq!(desktop.bind(), Ok(false));
            assert!(
                accepts_zero_movement(),
                "binding must retain SendInput access"
            );
            assert_eq!(desktop.bind(), Ok(false));
            assert!(
                accepts_zero_movement(),
                "rechecking must retain SendInput access"
            );
        }
        assert!(
            accepts_zero_movement(),
            "drop must restore the original desktop"
        );
    }
}

/// Query only this process's user session. A secure input desktop can be UAC,
/// so its name alone is not proof that Windows locked the workstation.
pub fn locked() -> Option<bool> {
    use windows_sys::Win32::System::RemoteDesktop::*;
    unsafe {
        let mut data = std::ptr::null_mut();
        let mut size = 0;
        if WTSQuerySessionInformationW(std::ptr::null_mut(), u32::MAX, WTSSessionInfoEx,
                                      &mut data, &mut size) == 0 { return None; }
        let result = if size as usize >= std::mem::size_of::<WTSINFOEXW>() {
            let info = &*(data as *const WTSINFOEXW);
            if info.Level == 1 {
                match info.Data.WTSInfoExLevel1.SessionFlags as u32 {
                    WTS_SESSIONSTATE_LOCK => Some(true),
                    WTS_SESSIONSTATE_UNLOCK => Some(false),
                    _ => None,
                }
            } else { None }
        } else { None };
        WTSFreeMemory(data.cast());
        result
    }
}

pub fn lock() -> bool {
    use windows_sys::Win32::System::Shutdown::LockWorkStation;
    if locked() == Some(true) { return true; }
    if unsafe { LockWorkStation() } == 0 { return false; }
    // LockWorkStation only accepts the request; wait for session confirmation.
    for _ in 0..30 {
        if locked() == Some(true) { return true; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

/// Covers and hooks belong to Default, never to UAC or another secure desktop.
pub fn user_desktop_active() -> bool {
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() { return false; }
        let mut name = [0u16; 256];
        let mut needed = 0;
        let ok = GetUserObjectInformationW(desktop, UOI_NAME, name.as_mut_ptr().cast(), 512, &mut needed);
        CloseDesktop(desktop);
        let length = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        ok != 0 && String::from_utf16_lossy(&name[..length]) == "Default"
    }
}
