/// Update only Windows' installed-version metadata after a verified launch.
/// Embed the script so the elevated updater never executes a mutable .ps1 from
/// the installation directory. No new dependency or change to the apply result.
#[cfg(target_os = "windows")]
pub fn sync(exe: &std::path::Path, key: &str) {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const SCRIPT: &str = include_str!("../../../resources/windows-installation-version.ps1");
    // An elevated updater must not resolve powershell from its cwd or PATH.
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut system_dir = [0u16; 32768];
    // SAFETY: the buffer is writable and its declared length matches the array.
    let len = unsafe { GetSystemDirectoryW(system_dir.as_mut_ptr(), system_dir.len() as u32) } as usize;
    if len == 0 || len >= system_dir.len() {
        crate::logger::warn("[installer] system directory unavailable for metadata repair");
        return;
    }
    let powershell = std::path::PathBuf::from(String::from_utf16_lossy(&system_dir[..len]))
        .join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    let result = Command::new(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("CINDY_VERSION_SYNC_KEY", key)
        .env("CINDY_VERSION_SYNC_EXE", exe)
        .env_remove("CINDY_VERSION_SYNC_EXPECTED")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn();
    let Ok(mut child) = result else {
        crate::logger::warn("[installer] version metadata helper unavailable");
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    crate::logger::warn("[installer] version metadata repair failed");
                }
                return;
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                crate::logger::warn("[installer] version metadata repair timed out");
                return;
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn sync(_exe: &std::path::Path, _key: &str) {}
