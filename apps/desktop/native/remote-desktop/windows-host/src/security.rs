use crate::win::*;
use std::{
    mem,
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::*, Security::Authorization::*, Security::*, Storage::FileSystem::*,
    System::SystemServices::*,
};

pub fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy()),
        _ => false,
    }
}

/// The OS error number of the call that just failed.
fn last_os() -> i32 {
    unsafe { GetLastError() as i32 }
}

/// Proves the staged directory still holds what the service may run: the two
/// executables, the record naming the installation they serve, the directory
/// itself and every directory up to Program Files.
///
/// Only this directory is checked. The installation that Cindy itself runs
/// from is deliberately outside the boundary — it is writable by the account
/// that installed Cindy, which is why the service runs from a copy rather than
/// from there.
pub fn protected_staging(staged: &Path) -> Staged<Vec<Handle>> {
    let root = crate::naming::program_files()?;
    if !staged.starts_with(&root) || staged == root {
        return refuse(Step::ProtectedRoot);
    }
    let mut paths = vec![
        staged.join(crate::naming::HOST_EXE),
        staged.join(crate::naming::INPUT_EXE),
        staged.join(crate::naming::INSTALL_RECORD),
        staged.to_owned(),
    ];
    ancestors(&mut paths, staged, &root);
    verify_protected(paths)
}

/// Adds every directory between `from` and the Program Files root: a writable
/// parent would let an attacker replace the whole subtree.
pub fn ancestors(paths: &mut Vec<PathBuf>, from: &Path, root: &Path) {
    let mut directory = from.parent();
    while let Some(path) = directory {
        paths.push(path.to_owned());
        if path == root {
            break;
        }
        directory = path.parent();
    }
}

/// Proves every path is owned by, and writable only by, SYSTEM, Administrators
/// or TrustedInstaller. The returned handles deny deletion for as long as the
/// caller holds them, so the files cannot be swapped after being checked.
pub fn verify_protected(paths: Vec<PathBuf>) -> Staged<Vec<Handle>> {
    let mut trusted_installer = ptr::null_mut();
    // Exact Windows servicing identity, not all service SIDs.
    if unsafe {
        ConvertStringSidToSidW(
            wide("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464").as_ptr(),
            &mut trusted_installer,
        )
    } == 0
    {
        return Err(Failure::new(Step::ProtectedOpen, last_os()));
    }
    struct LocalSid(PSID);
    impl Drop for LocalSid {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    let trusted_installer = LocalSid(trusted_installer);
    let mut handles = Vec::new();
    for path in paths {
        let handle = Handle::new(unsafe {
            CreateFileW(
                wide(&path.to_string_lossy()).as_ptr(),
                READ_CONTROL | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            )
        })
        .stage(Step::ProtectedOpen)?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
        if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
            return Err(Failure::new(Step::ProtectedOpen, last_os()));
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return refuse(Step::ProtectedReparse);
        }
        let mut owner = ptr::null_mut();
        let mut acl = ptr::null_mut();
        let mut descriptor = ptr::null_mut();
        let code = unsafe {
            GetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                ptr::null_mut(),
                &mut acl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        if code != ERROR_SUCCESS {
            return Err(Failure::new(Step::ProtectedOpen, code as i32));
        }
        if acl.is_null() || owner.is_null() || unsafe { IsValidAcl(acl) } == 0 {
            unsafe {
                LocalFree(descriptor);
            }
            return refuse(Step::ProtectedAcl);
        }
        let trusted = |sid| unsafe {
            IsWellKnownSid(sid, WinLocalSystemSid) != 0
                || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
                || EqualSid(sid, trusted_installer.0) != 0
        };
        // Separate codes: an untrusted owner and a stray writable ACE need
        // different answers from whoever reads the log.
        let mut failed = (!trusted(owner)).then_some(Step::ProtectedOwner);
        let mut safe = failed.is_none();
        if safe {
            unsafe {
                for i in 0..(*acl).AceCount as u32 {
                    let mut ace = ptr::null_mut();
                    if GetAce(acl, i, &mut ace) == 0 || ace.is_null() {
                        safe = false;
                        break;
                    }
                    let header = &*ace.cast::<ACE_HEADER>();
                    if header.AceFlags as u32 & INHERIT_ONLY_ACE != 0 {
                        continue;
                    }
                    if header.AceType as u32 == ACCESS_DENIED_ACE_TYPE {
                        continue;
                    }
                    if header.AceType as u32 != ACCESS_ALLOWED_ACE_TYPE {
                        safe = false;
                        break;
                    }
                    if (header.AceSize as usize) < mem::size_of::<ACCESS_ALLOWED_ACE>() {
                        safe = false;
                        break;
                    }
                    let allow = &*ace.cast::<ACCESS_ALLOWED_ACE>();
                    let mutations = GENERIC_ALL
                        | GENERIC_WRITE
                        | WRITE_DAC
                        | WRITE_OWNER
                        | DELETE
                        | FILE_WRITE_DATA
                        | FILE_APPEND_DATA
                        | FILE_WRITE_EA
                        | FILE_WRITE_ATTRIBUTES
                        | FILE_DELETE_CHILD;
                    if allow.Mask & mutations != 0
                        && !trusted((&allow.SidStart as *const u32).cast_mut().cast())
                    {
                        safe = false;
                        break;
                    }
                }
            }
        }
        unsafe {
            LocalFree(descriptor);
        }
        if !safe {
            return refuse(failed.take().unwrap_or(Step::ProtectedAcl));
        }
        handles.push(handle);
    }
    Ok(handles)
}

/// Accepts a Cindy process as the owner of this service's lease.
///
/// `install` is the directory the staged copy records as its installation.
/// That directory is writable by the account that installed Cindy, so the
/// image check below is a consistency check, not a trust boundary: what keeps
/// an arbitrary process from driving the service is that the caller must be
/// the exact process an administrator approved during setup, still alive and
/// still on the active console session.
pub fn authorize_client(pid: u32, install: &Path, development: bool) -> Result<(Handle, u32)> {
    let client = process(pid)?;
    let session = session(token(client.0)?.0)?;
    if session == 0
        || session
            != unsafe { windows_sys::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId() }
    {
        return denied();
    }
    let client_image = image(client.0)?;
    let packaged = client_image.parent().is_some_and(|p| same_file(p, install))
        && client_image.file_name().is_some_and(|n| {
            n.eq_ignore_ascii_case("Cindy.exe") || n.eq_ignore_ascii_case("CindyDev.exe")
        });
    // Source-mode Electron is named electron.exe and lives under
    // node_modules, so it cannot satisfy the packaged installation-parent
    // check. The PID is still the one explicitly approved by the elevated
    // setup flow and is retained by the service for every later pipe client.
    let development_electron = development
        && client_image
            .file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("electron.exe"));
    if !packaged && !development_electron {
        return denied();
    }
    Ok((client, session))
}

/// Whether two files hold exactly the same bytes. Used to confirm that the
/// elevated process asking the service to register a Cindy process is running
/// the very same helper build the service itself was started from.
pub fn same_contents(a: &Path, b: &Path) -> Result<bool> {
    let (a, b) = (std::fs::read(a)?, std::fs::read(b)?);
    Ok(a == b)
}
