//! Win32 helpers shared by this crate's two targets: the setup/service
//! executable and the Main-only Node-API library. Each target uses a different
//! subset — the setup steps below belong to the executable — so items unused by
//! one of them are expected here rather than dead.
#![allow(dead_code)]
use std::{
    io,
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::{
    Foundation::*, Security::*, Storage::FileSystem::*, System::Threading::*,
};
pub type Result<T> = io::Result<T>;
pub fn error() -> io::Error {
    io::Error::last_os_error()
}
pub fn denied<T>() -> Result<T> {
    Err(io::Error::from(io::ErrorKind::PermissionDenied))
}

/// Resolves a Windows system binary without consulting the user's PATH.
/// Elevation must never launch a name that an ordinary process can shadow.
pub fn system_file(name: &str) -> Result<PathBuf> {
    let mut buffer = vec![0u16; 32_768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 || length as usize >= buffer.len() {
        return Err(error());
    }
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize])).join(name))
}

/// Keeps a bundled helper and its input companion from being replaced while
/// the protected PowerShell bootstrap copies them. The handle is held by the
/// unelevated helper until the elevated child has finished.
pub fn read_lock(path: &Path) -> Result<Handle> {
    let handle = Handle::new(unsafe {
        CreateFileW(
            wide(&path.to_string_lossy()).as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ,
            ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    })?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(error());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::from_raw_os_error(
            ERROR_REPARSE_TAG_INVALID as i32,
        ));
    }
    Ok(handle)
}

/// The elevated child is hidden, so its step and raw Win32 error have to cross
/// the UAC process boundary in the one value Windows gives us: the exit code.
/// The low byte is the step (plus one); the remaining 24 bits carry the usual
/// Win32 error range. A zero exit code remains success.
const EXIT_STEP_MASK: u32 = 0xff;

/// Declares every step that can fail during lock-screen setup, keeping the
/// textual code and the numeric form in one list so the two cannot drift apart.
macro_rules! steps {
    ($($variant:ident => $code:literal,)*) => {
        /// A named setup step. The code reaches the Desktop log and the settings
        /// page, so a failed setup says which step failed instead of only
        /// "failed". The numeric form travels back from the elevated child as
        /// its process exit code, because the child's console output is hidden
        /// from the parent. Codes carry no path, account or machine content.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Step { $($variant,)* }
        impl Step {
            pub fn code(self) -> &'static str {
                match self { $(Step::$variant => $code,)* }
            }
            /// Maps the low byte of an elevated child's exit code back to its
            /// failed step.
            pub fn from_exit(value: u32) -> Option<Step> {
                const ALL: &[Step] = &[$(Step::$variant,)*];
                (value & EXIT_STEP_MASK)
                    .checked_sub(1)
                    .and_then(|index| ALL.get(index as usize))
                    .copied()
            }
        }
    };
}

steps! {
    Args => "args",
    Service => "service",
    Worker => "worker",
    ProtectedRoot => "protected-root",
    ProtectedOpen => "protected-open",
    ProtectedReparse => "protected-reparse",
    ProtectedOwner => "protected-owner",
    ProtectedAcl => "protected-acl",
    StagePrepare => "stage-prepare",
    StageRead => "stage-read",
    StageWrite => "stage-write",
    StageRemove => "stage-remove",
    StageRecord => "stage-record",
    ScmOpen => "scm-open",
    ServiceCreate => "service-create",
    ServiceStart => "service-start",
    ServiceReady => "service-ready",
    ServiceStop => "service-stop",
    ServiceDelete => "service-delete",
    AuthorizeConnect => "authorize-connect",
    AuthorizeIdentity => "authorize-identity",
    AuthorizeReply => "authorize-reply",
    ClientIdentity => "client-identity",
    ElevateLaunch => "elevate-launch",
    ElevateTimeout => "elevate-timeout",
    ElevateChild => "elevate-child",
    ElevateBootstrap => "elevate-bootstrap",
}

/// A failed step plus the raw OS error number — the part that distinguishes
/// "access denied" from "not found" on an otherwise identical step.
pub struct Failure {
    pub step: Step,
    pub os: i32,
    /// Set when the failure actually happened inside the elevated child.
    pub child: Option<Step>,
}
pub type Staged<T> = std::result::Result<T, Failure>;

impl Failure {
    pub fn new(step: Step, os: i32) -> Self {
        Self {
            step,
            os,
            child: None,
        }
    }
    /// The step, the elevated child's own step when it came from there, and the
    /// OS error number. Appended to a status word, or printed after `error`.
    pub fn detail(&self) -> String {
        match self.child {
            Some(child) => format!("{}/{} {}", self.step.code(), child.code(), self.os),
            None => format!("{} {}", self.step.code(), self.os),
        }
    }
    /// The single line the process prints before exiting on failure.
    pub fn line(&self) -> String {
        format!("error {}", self.detail())
    }

    /// Encodes the failed step and raw OS error for a hidden elevated child.
    /// Win32 errors used by setup fit in the upper 24 bits; keeping the step in
    /// the low byte makes the value independently decodable by the unelevated
    /// parent without exposing paths or account names.
    pub fn exit_code(&self) -> u32 {
        (((self.os.max(0) as u32) & 0x00ff_ffff) << 8) | (self.step as u32 + 1)
    }

    pub fn from_exit_code(value: u32) -> Option<(Step, i32)> {
        let step = Step::from_exit(value)?;
        Some((step, (value >> 8) as i32))
    }
}

impl std::fmt::Debug for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail())
    }
}

/// Attaches a step name to an ordinary OS failure.
pub trait Stage<T> {
    fn stage(self, step: Step) -> Staged<T>;
}
impl<T> Stage<T> for Result<T> {
    fn stage(self, step: Step) -> Staged<T> {
        self.map_err(|e| Failure::new(step, e.raw_os_error().unwrap_or(0)))
    }
}
/// Rejects a step that failed a validation rule rather than an OS call.
pub fn refuse<T>(step: Step) -> Staged<T> {
    Err(Failure::new(step, 0))
}

pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevated_exit_code_round_trips_step_and_os_error() {
        let failure = Failure::new(Step::StageWrite, 5);
        assert_eq!(
            Failure::from_exit_code(failure.exit_code()),
            Some((Step::StageWrite, 5))
        );
    }

    #[test]
    fn elevated_exit_code_keeps_validation_failures_decodable() {
        let failure = Failure::new(Step::ProtectedRoot, 0);
        assert_eq!(
            Failure::from_exit_code(failure.exit_code()),
            Some((Step::ProtectedRoot, 0))
        );
    }
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
