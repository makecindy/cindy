//! Disposable permission fixture for the deep-link integration check.
//! Creates an ordinary sender through the verified same-user/session desktop.
//! Compiled only by the integration script, never by cindy-updater.
use std::{
    io, mem,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Security::{
        EqualSid, GetTokenInformation, TokenElevation, TokenSessionId, TokenUser, TOKEN_ELEVATION,
        TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
        InitializeProcThreadAttributeList, OpenProcess, OpenProcessToken,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
        EXTENDED_STARTUPINFO_PRESENT, PROCESS_CREATE_PROCESS, PROCESS_INFORMATION,
        PROCESS_QUERY_LIMITED_INFORMATION, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, STARTUPINFOEXW,
    },
    UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId},
};

struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
// Aligned storage for Windows' opaque attribute list, freed on every path.
struct Attributes(Vec<usize>);
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast());
        }
    }
}

fn last_error(operation: &str) -> io::Error {
    let error = io::Error::last_os_error();
    io::Error::new(
        error.kind(),
        format!("{operation}: Windows error {:?}", error.raw_os_error()),
    )
}

fn information<T>(token: HANDLE, class: i32) -> io::Result<T> {
    let mut result: T = unsafe { mem::zeroed() };
    let mut size = 0;
    if unsafe {
        GetTokenInformation(
            token,
            class,
            (&mut result as *mut T).cast(),
            mem::size_of::<T>() as u32,
            &mut size,
        )
    } == 0
    {
        return Err(last_error("GetTokenInformation"));
    }
    Ok(result)
}

fn user(token: HANDLE) -> io::Result<Vec<usize>> {
    let mut size = 0;
    unsafe {
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
    }
    if size == 0 || size > 65_536 {
        return Err(io::Error::other("invalid token user size"));
    }
    let mut buffer =
        vec![0usize; (size as usize + mem::size_of::<usize>() - 1) / mem::size_of::<usize>()];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(last_error("GetTokenInformation(user)"));
    }
    Ok(buffer)
}

/// None means the caller is already normal. Every Err occurs before a child
/// was created, so the detached fallback cannot duplicate a fixture launch.
/// Never change accounts, enable privileges, or alter ACLs to obtain a parent.
pub(crate) fn launch_via_desktop_shell(exe: &Path) -> io::Result<Option<OwnedHandle>> {
    let mut handle = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) } == 0 {
        return Err(last_error("OpenProcessToken(current)"));
    }
    let current = Token(handle);
    let elevation: TOKEN_ELEVATION = information(current.0, TokenElevation)?;
    if elevation.TokenIsElevated == 0 {
        return Ok(None);
    }
    let shell_window = unsafe { GetShellWindow() };
    let mut shell_pid = 0;
    if shell_window.is_null()
        || unsafe { GetWindowThreadProcessId(shell_window, &mut shell_pid) } == 0
    {
        return Err(io::Error::other("desktop shell unavailable"));
    }
    let shell_process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_CREATE_PROCESS,
            0,
            shell_pid,
        )
    };
    if shell_process.is_null() {
        return Err(last_error("OpenProcess(shell)"));
    }
    let shell_process = Token(shell_process);
    let mut desktop_pid = 0;
    if unsafe { GetShellWindow() } != shell_window
        || unsafe { GetWindowThreadProcessId(shell_window, &mut desktop_pid) } == 0
        || desktop_pid != shell_pid
    {
        return Err(io::Error::other(
            "desktop shell changed during verification",
        ));
    }
    let mut shell_token = ptr::null_mut();
    if unsafe { OpenProcessToken(shell_process.0, TOKEN_QUERY, &mut shell_token) } == 0 {
        return Err(last_error("OpenProcessToken(shell)"));
    }
    let shell_token = Token(shell_token);
    let shell_elevation: TOKEN_ELEVATION = information(shell_token.0, TokenElevation)?;
    let current_user = user(current.0)?;
    let shell_user = user(shell_token.0)?;
    let same_user = unsafe {
        EqualSid(
            (*(current_user.as_ptr() as *const TOKEN_USER)).User.Sid,
            (*(shell_user.as_ptr() as *const TOKEN_USER)).User.Sid,
        )
    } != 0;
    if !same_user
        || shell_elevation.TokenIsElevated != 0
        || information::<u32>(current.0, TokenSessionId)?
            != information::<u32>(shell_token.0, TokenSessionId)?
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "desktop token identity or elevation mismatch",
        ));
    }
    // This documented parent attribute inherits the verified shell token, not
    // the elevated test caller's token. Keep the opened process handle throughout,
    // so shell exit/PID reuse cannot select a different parent.
    // https://devblogs.microsoft.com/oldnewthing/20190425-00/?p=102443
    // Environment and cwd retain the test caller's context; specifying a parent
    // does not inherit Explorer's values.
    if !exe.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "executable path must be absolute",
        ));
    }
    let file: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    if file[..file.len() - 1].iter().any(|c| *c == 0 || *c == 34) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid executable path",
        ));
    }
    let mut command: Vec<u16> = std::iter::once(34)
        .chain(file[..file.len() - 1].iter().copied())
        .chain([34, 0])
        .collect();
    unsafe {
        let mut size = 0;
        InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size);
        if size == 0 || size > 65_536 {
            return Err(io::Error::other("invalid process attribute size"));
        }
        let mut buffer = vec![0usize; size.div_ceil(mem::size_of::<usize>())];
        if InitializeProcThreadAttributeList(buffer.as_mut_ptr().cast(), 1, 0, &mut size) == 0 {
            return Err(last_error("InitializeProcThreadAttributeList"));
        }
        let mut attributes = Attributes(buffer);
        if UpdateProcThreadAttribute(
            attributes.0.as_mut_ptr().cast(),
            0,
            PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
            (&shell_process.0 as *const HANDLE).cast(),
            mem::size_of::<HANDLE>(),
            ptr::null_mut(),
            ptr::null(),
        ) == 0
        {
            return Err(last_error("UpdateProcThreadAttribute(parent)"));
        }
        let mut startup: STARTUPINFOEXW = mem::zeroed();
        startup.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = attributes.0.as_mut_ptr().cast();
        let mut process: PROCESS_INFORMATION = mem::zeroed();
        if CreateProcessW(
            file.as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            ptr::null(),
            ptr::null(),
            &startup.StartupInfo,
            &mut process,
        ) == 0
        {
            return Err(last_error("CreateProcessW(desktop parent)"));
        }
        CloseHandle(process.hThread);
        Ok(Some(OwnedHandle::from_raw_handle(process.hProcess)))
    }
}

/// A fixed executable launch, never file associations or a UAC request. Both
/// branches return the created process; fallback is possible only before that.
pub(crate) fn spawn_detached(
    exe: &Path,
    on_shell_error: impl FnOnce(&io::Error),
) -> io::Result<OwnedHandle> {
    use std::os::windows::process::CommandExt;
    match launch_via_desktop_shell(exe) {
        Ok(Some(process)) => return Ok(process),
        Ok(None) => {}
        Err(error) => on_shell_error(&error),
    }
    std::process::Command::new(exe)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(Into::into)
}

/// Observe the exact created fixture process for a bounded window. None means
/// still alive; Some(code) is read only AFTER the handle is signalled, including
/// exit 259.
pub(crate) fn wait_for_exit(process: &OwnedHandle, timeout: Duration) -> io::Result<Option<u32>> {
    let millis = u32::try_from(timeout.as_millis())
        .ok()
        .filter(|value| *value < u32::MAX)
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "invalid process wait budget")
        })?;
    match unsafe { WaitForSingleObject(process.as_raw_handle(), millis) } {
        WAIT_TIMEOUT => Ok(None),
        WAIT_OBJECT_0 => {
            let mut code = 0;
            if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) } == 0 {
                return Err(last_error("GetExitCodeProcess(child)"));
            }
            Ok(Some(code))
        }
        _ => Err(last_error("WaitForSingleObject(child)")),
    }
}
