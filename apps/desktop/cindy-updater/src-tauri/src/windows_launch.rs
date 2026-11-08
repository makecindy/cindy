//! Updating Program Files needs elevation; running Cindy afterwards does not.
//! Ask the existing desktop shell only after verifying the SAME user/session,
//! never a newly-created (possibly elevated) Shell.Application.
use std::{io, mem, os::windows::ffi::OsStrExt, path::Path, ptr};
use windows::{
    core::{Interface, BSTR},
    Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, IDispatch, IServiceProvider,
                CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
            },
            Variant::VARIANT,
        },
        UI::Shell::{
            IShellBrowser, IShellDispatch2, IShellFolderViewDual, IShellWindows,
            SID_STopLevelBrowser, ShellWindows, SVGIO_BACKGROUND, SWC_DESKTOP, SWFO_NEEDDISPATCH,
        },
    },
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Security::{
        EqualSid, GetTokenInformation, TokenElevation, TokenSessionId, TokenUser, TOKEN_ELEVATION,
        TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
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
struct Apartment(bool);
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            if self.0 {
                CoUninitialize();
            }
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

/// False means the caller is already normal. Never change Windows accounts to
/// obtain a normal token; errors retain the original launch fallback.
pub(crate) fn launch_via_desktop_shell(exe: &Path) -> io::Result<bool> {
    let mut handle = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) } == 0 {
        return Err(last_error("OpenProcessToken(current)"));
    }
    let current = Token(handle);
    let elevation: TOKEN_ELEVATION = information(current.0, TokenElevation)?;
    if elevation.TokenIsElevated == 0 {
        return Ok(false);
    }
    let shell_window = unsafe { GetShellWindow() };
    let mut shell_pid = 0;
    if shell_window.is_null()
        || unsafe { GetWindowThreadProcessId(shell_window, &mut shell_pid) } == 0
    {
        return Err(io::Error::other("desktop shell unavailable"));
    }
    let shell_process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, shell_pid) };
    if shell_process.is_null() {
        return Err(last_error("OpenProcess(shell)"));
    }
    let shell_process = Token(shell_process);
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
    // Bind the desktop view inside the already-running shell. CoCreating
    // Shell.Application directly can instead create another elevated server.
    // https://devblogs.microsoft.com/oldnewthing/20131118-00/?p=2643
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return Err(io::Error::other(format!(
                "CoInitializeEx: HRESULT {initialized:?}"
            )));
        }
        let _apartment = Apartment(initialized.is_ok());
        let launch = || -> windows::core::Result<()> {
            let shell_windows: IShellWindows =
                CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)?;
            let location = VARIANT::from(0i32);
            let mut desktop_hwnd = 0;
            let desktop = shell_windows.FindWindowSW(
                &location,
                &location,
                SWC_DESKTOP,
                &mut desktop_hwnd,
                SWFO_NEEDDISPATCH,
            )?;
            let mut desktop_pid = 0;
            GetWindowThreadProcessId(desktop_hwnd as isize as *mut _, &mut desktop_pid);
            if desktop_pid != shell_pid {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x80070005u32 as i32,
                )));
            }
            let service: IServiceProvider = desktop.cast()?;
            let browser: IShellBrowser = service.QueryService(&SID_STopLevelBrowser)?;
            let view = browser.QueryActiveShellView()?;
            let background: IDispatch = view.GetItemObject(SVGIO_BACKGROUND)?;
            let folder: IShellFolderViewDual = background.cast()?;
            let application: IShellDispatch2 = folder.Application()?.cast()?;
            let file = BSTR::from_wide(&exe.as_os_str().encode_wide().collect::<Vec<_>>());
            application.ShellExecute(
                &file,
                &VARIANT::default(),
                &VARIANT::default(),
                &VARIANT::from("open"),
                &VARIANT::from(1i32),
            )
        };
        launch().map_err(|error| {
            io::Error::other(format!("desktop ShellExecute: HRESULT {:?}", error.code()))
        })?;
    }
    Ok(true)
}
