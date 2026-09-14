use crate::win::*;
use std::os::windows::fs::MetadataExt;
use std::{
    mem,
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::Authorization::*,
    Security::*,
    Storage::FileSystem::*,
    System::{Com::*, SystemServices::*},
    UI::Shell::*,
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

// Retain non-delete-sharing handles through caller authorization / worker spawn.
// Reject ACLs that we cannot prove safe rather than interpreting a path prefix as
// an integrity boundary. Installation does not silently repair administrator ACLs.
pub fn protected_install() -> Result<Vec<Handle>> {
    let mut raw = ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramFiles, 0, ptr::null_mut(), &mut raw) } < 0 || raw.is_null() {
        return denied();
    }
    let root = unsafe {
        let mut len = 0;
        while *raw.add(len) != 0 {
            len += 1;
        }
        let result = PathBuf::from(String::from_utf16_lossy(std::slice::from_raw_parts(
            raw, len,
        )));
        CoTaskMemFree(raw.cast());
        result
    };
    let executable = std::env::current_exe()?;
    let install = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(error)?;
    if !install.starts_with(&root) || install == root {
        return denied();
    }
    let mut trusted_installer = ptr::null_mut();
    // Exact Windows servicing identity, not all service SIDs.
    if unsafe {
        ConvertStringSidToSidW(
            wide("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464").as_ptr(),
            &mut trusted_installer,
        )
    } == 0
    {
        return Err(error());
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
    let mut paths = vec![
        install.join("resources/app.asar"),
        executable.clone(),
        executable.with_file_name("cindy-windows-desktop-host.node"),
        executable.with_file_name("cindy-windows-desktop-input.exe"),
    ];
    // Packaged exe identity is discovered only from the protected app directory.
    // No caller-selected executable or command line is accepted by the broker.
    for item in std::fs::read_dir(install)? {
        let path = item?.path();
        if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("exe") || e.eq_ignore_ascii_case("dll"))
        {
            paths.push(path);
        }
    }
    // Unpacked native code is part of the executable trust boundary too.
    let unpacked = install.join("resources/app.asar.unpacked");
    if unpacked.exists() {
        let mut pending = vec![unpacked];
        while let Some(path) = pending.pop() {
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return denied();
            }
            if metadata.is_dir() {
                for item in std::fs::read_dir(&path)? {
                    pending.push(item?.path());
                }
            }
            paths.push(path);
            if paths.len() + pending.len() > 100_000 {
                return denied();
            }
        }
    }
    let mut directory = executable.parent();
    while let Some(path) = directory {
        paths.push(path.to_owned());
        if path == root {
            break;
        }
        directory = path.parent();
    }
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
        })?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
        if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return denied();
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
            return denied();
        }
        if acl.is_null() || owner.is_null() || unsafe { IsValidAcl(acl) } == 0 {
            unsafe { LocalFree(descriptor); }
            return denied();
        }
        let trusted = |sid| unsafe {
            IsWellKnownSid(sid, WinLocalSystemSid) != 0
                || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
                || EqualSid(sid, trusted_installer.0) != 0
        };
        let mut safe = trusted(owner);
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
            return denied();
        }
        handles.push(handle);
    }
    Ok(handles)
}

pub fn authorize_client(pid: u32) -> Result<(Handle, u32)> {
    let client = process(pid)?;
    let session = session(token(client.0)?.0)?;
    if session == 0
        || session
            != unsafe { windows_sys::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId() }
    {
        return denied();
    }
    let client_image = image(client.0)?;
    let executable = std::env::current_exe()?;
    let install = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(error)?;
    if !client_image.parent().is_some_and(|p| same_file(p, install))
        || !client_image.file_name().is_some_and(|n| {
            n.eq_ignore_ascii_case("Cindy.exe") || n.eq_ignore_ascii_case("CindyDev.exe")
        })
    {
        return denied();
    }
    Ok((client, session))
}
