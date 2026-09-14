use std::{io, ptr};
use windows_sys::Win32::{
    Foundation::*, Security::*, Storage::FileSystem::SYNCHRONIZE, System::Threading::*,
};
pub type Result<T> = io::Result<T>;
pub fn error() -> io::Error {
    io::Error::last_os_error()
}
pub fn denied<T>() -> Result<T> {
    Err(io::Error::from(io::ErrorKind::PermissionDenied))
}
pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
pub struct Handle(pub HANDLE);
unsafe impl Send for Handle {}
impl Handle {
    pub fn new(value: HANDLE) -> Result<Self> {
        if value.is_null() || value == INVALID_HANDLE_VALUE {
            Err(error())
        } else {
            Ok(Self(value))
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
pub fn process(pid: u32) -> Result<Handle> {
    Handle::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) })
}
pub fn token(process: HANDLE) -> Result<Handle> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(error());
    }
    Handle::new(token)
}
pub fn session(token: HANDLE) -> Result<u32> {
    let mut value = 0u32;
    let mut size = 0;
    if unsafe {
        GetTokenInformation(
            token,
            TokenSessionId,
            (&mut value as *mut u32).cast(),
            4,
            &mut size,
        )
    } == 0
    {
        return Err(error());
    }
    Ok(value)
}
pub fn system(token: HANDLE) -> Result<bool> {
    let mut data = [0usize; 128];
    let mut size = 0;
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            data.as_mut_ptr().cast(),
            std::mem::size_of_val(&data) as u32,
            &mut size,
        )
    } == 0
    {
        return Err(error());
    }
    Ok(unsafe {
        IsWellKnownSid(
            (*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid,
            WinLocalSystemSid,
        ) != 0
    })
}
pub fn image(process: HANDLE) -> Result<std::path::PathBuf> {
    let mut value = vec![0u16; 32768];
    let mut size = value.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, value.as_mut_ptr(), &mut size) } == 0 {
        return Err(error());
    }
    Ok(std::path::PathBuf::from(String::from_utf16_lossy(
        &value[..size as usize],
    )))
}
