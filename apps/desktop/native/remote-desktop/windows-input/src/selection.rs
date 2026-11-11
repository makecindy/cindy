use windows::{
    core::Interface,
    Win32::{System::Com::*, UI::Accessibility::*},
};

pub fn read(portable: bool) -> windows::core::Result<String> {
    unsafe {
        require_normal_desktop()?;
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        struct Com;
        impl Drop for Com {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _com = Com;
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let element = automation.GetFocusedElement()?;
        if element.CurrentIsPassword()?.as_bool() {
            return Err(windows::core::Error::from_win32());
        }
        let text = match element.GetCurrentPattern(UIA_TextPatternId) {
            Ok(pattern) => {
                let pattern: IUIAutomationTextPattern = pattern.cast()?;
                let selection = pattern.GetSelection()?;
                // Disjoint selections have application-specific ordering.
                let count = selection.Length()?;
                if count < 0 || count > 1 {
                    return Err(windows::core::Error::from_win32());
                }
                if count == 0 { String::new() }
                else { selection.GetElement(0)?.GetText(16385)?.to_string() }
            }
            Err(error) if portable && error.code().0 as u32 == UIA_E_NOTSUPPORTED => String::new(),
            Err(error) => return Err(error),
        };
        if text.encode_utf16().count() > 16384
            || !automation
                .CompareElements(&element, &automation.GetFocusedElement()?)?
                .as_bool()
        {
            return Err(windows::core::Error::from_win32());
        }
        require_normal_desktop()?;
        if element.CurrentIsPassword()?.as_bool() {
            return Err(windows::core::Error::from_win32());
        }
        Ok(text)
    }
}

fn require_normal_desktop() -> windows::core::Result<()> {
    unsafe {
        // Never expose the ordinary user's selection while a secure desktop is active.
        use windows_sys::Win32::System::StationsAndDesktops::*;
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return Err(windows::core::Error::from_win32());
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
            return Err(windows::core::Error::from_win32());
        }
        Ok(())
    }
}
