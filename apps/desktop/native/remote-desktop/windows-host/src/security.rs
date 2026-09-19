use crate::win::*;
use sha2::{Digest, Sha256};
use std::os::windows::fs::MetadataExt;
use std::{
    io, mem,
    path::{Path, PathBuf},
    ptr,
};
#[cfg(not(any(feature = "development", test)))]
use windows_sys::Win32::Security::Cryptography::*;
#[cfg(not(any(feature = "development", test)))]
use windows_sys::Win32::Security::WinTrust::*;
use windows_sys::Win32::{
    Foundation::*, Security::Authorization::*, Security::*, Storage::FileSystem::*,
    System::SystemServices::*, UI::Shell::*,
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

pub fn path_is_within(child: &Path, parent: &Path) -> bool {
    let (Ok(child), Ok(parent)) = (child.canonicalize(), parent.canonicalize()) else {
        return false;
    };
    let child: Vec<_> = child.components().collect();
    let parent: Vec<_> = parent.components().collect();
    child.len() >= parent.len()
        && child
            .iter()
            .zip(&parent)
            .all(|(a, b)| a.as_os_str().eq_ignore_ascii_case(b.as_os_str()))
}

fn is_excluded_data_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("userData") || name.eq_ignore_ascii_case("workspace")
}

fn same_listed_path(left: &Path, right: &Path) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

fn freeze_object(frozen: &mut Vec<(PathBuf, Handle)>, path: PathBuf) -> Result<Option<HANDLE>> {
    match open_for_hardening(&path) {
        Ok(handle) => {
            let raw = handle.0;
            frozen.push((path, handle));
            Ok(Some(raw))
        }
        Err(error) => {
            if check_paths(vec![path]).is_ok() {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

fn directory_children(handle: HANDLE) -> Result<Vec<(String, u32)>> {
    let mut children = Vec::new();
    let mut buffer = vec![0u8; 16_384];
    let mut restart = true;
    loop {
        let class = if restart {
            FileFullDirectoryRestartInfo
        } else {
            FileFullDirectoryInfo
        };
        if unsafe {
            GetFileInformationByHandleEx(
                handle,
                class,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
            )
        } == 0
        {
            let code = unsafe { GetLastError() };
            if code == ERROR_NO_MORE_FILES {
                break;
            }
            if code == ERROR_MORE_DATA {
                buffer.resize(buffer.len() * 2, 0);
                continue;
            }
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        restart = false;
        let mut offset = 0;
        loop {
            if offset + mem::size_of::<FILE_FULL_DIR_INFO>() > buffer.len() {
                return denied();
            }
            let info = unsafe { &*buffer[offset..].as_ptr().cast::<FILE_FULL_DIR_INFO>() };
            let name_bytes = info.FileNameLength as usize;
            let name_offset = mem::offset_of!(FILE_FULL_DIR_INFO, FileName);
            if offset + name_offset + name_bytes > buffer.len() || name_bytes % 2 != 0 {
                return denied();
            }
            let name =
                unsafe { std::slice::from_raw_parts(info.FileName.as_ptr(), name_bytes / 2) };
            let name = String::from_utf16_lossy(name);
            if name != "." && name != ".." {
                children.push((name, info.FileAttributes));
            }
            if info.NextEntryOffset == 0 {
                break;
            }
            offset += info.NextEntryOffset as usize;
        }
    }
    Ok(children)
}

fn freeze_tree(frozen: &mut Vec<(PathBuf, Handle)>, path: PathBuf) -> Result<()> {
    let Some(handle) = freeze_object(frozen, path.clone())? else {
        return Ok(());
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return denied();
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Ok(());
    }
    for (name, attributes) in directory_children(handle)? {
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return denied();
        }
        if is_excluded_data_name(&name) {
            continue;
        }
        freeze_tree(frozen, path.join(name))?;
        if frozen.len() > 100_000 {
            return denied();
        }
    }
    Ok(())
}

fn collect_code_paths(install: &Path) -> Result<Vec<PathBuf>> {
    if install.parent().is_none() || !install.join("resources/app.asar").is_file() {
        return denied();
    }
    let mut paths = Vec::new();
    let mut pending = vec![install.to_owned()];
    while let Some(path) = pending.pop() {
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return denied();
        }
        if metadata.is_dir() {
            for item in std::fs::read_dir(&path)? {
                let child = item?.path();
                let name = child
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(error)?;
                if is_excluded_data_name(name) {
                    continue;
                }
                pending.push(child);
            }
        }
        paths.push(path);
        if paths.len() + pending.len() > 100_000 {
            return denied();
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

// Code paths only: no userData, workspace, or parent-directory permission changes.
// Keep the same ASAR/native-code boundary as the packaged application.
pub fn application_paths(install: &Path) -> Result<Vec<PathBuf>> {
    collect_code_paths(install)
}

/// Pin ancestors, then freeze the packaged tree. Ordinary Electron siblings
/// (`.pak`, `locales`, extraResource directories) are included; `userData` and
/// `workspace` are not. CODE_DACL is not inherited, so a child restored after
/// an unprotected listing would stay user-writable. Capture consumes these
/// freeze handles.
pub fn freeze_code_tree(install: &Path) -> Result<(Vec<Handle>, Vec<(PathBuf, Handle)>)> {
    if install.parent().is_none() || !install.join("resources/app.asar").is_file() {
        return denied();
    }
    let ancestors = pin_ancestors(install)?;
    let mut frozen = Vec::new();
    let Some(root) = freeze_object(&mut frozen, install.to_owned())? else {
        return denied();
    };
    for (name, attributes) in directory_children(root)? {
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return denied();
        }
        if is_excluded_data_name(&name) {
            continue;
        }
        freeze_tree(&mut frozen, install.join(name))?;
    }
    Ok((ancestors, frozen))
}

pub fn confirm_frozen_tree(frozen: &[(PathBuf, Handle)]) -> Result<()> {
    for (path, handle) in frozen {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
        if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return denied();
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            continue;
        }
        for (name, attributes) in directory_children(handle.0)? {
            if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return denied();
            }
            if is_excluded_data_name(&name) {
                continue;
            }
            let child = path.join(name);
            if frozen
                .iter()
                .any(|(existing, _)| same_listed_path(existing, &child))
            {
                continue;
            }
            check_paths(vec![child])?;
        }
    }
    Ok(())
}

/// Never infer trust from the directory name. Pin and check every executable
/// object; pin ancestor directories against rename without changing their ACLs.
pub fn protect_application(install: &Path) -> Result<Vec<Handle>> {
    let (mut guards, frozen) = freeze_code_tree(install)?;
    let trusted = trusted_installer()?;
    for (_, handle) in &frozen {
        if !handle_is_protected(handle.0, trusted.0) {
            return denied();
        }
    }
    guards.extend(frozen.into_iter().map(|(_, handle)| handle));
    Ok(guards)
}

pub fn protected_service() -> Result<Vec<Handle>> {
    let installation = crate::installation::Installation::current()?;
    if !same_file(&std::env::current_exe()?, &installation.binary()) {
        return denied();
    }
    check_paths(vec![
        crate::installation::program_files()?,
        crate::installation::program_files()?.join("CindyRemoteDesktop"),
    ])?;
    let mut paths = vec![installation.directory.clone()];
    for name in [
        crate::installation::HOST,
        crate::installation::INPUT,
        crate::installation::APPROVAL,
    ] {
        paths.push(installation.directory.join(name));
    }
    let mut guards = pin_ancestors(&installation.directory)?;
    guards.extend(check_paths(paths)?);
    Ok(guards)
}

fn ancestor_pin_order(path: &Path) -> Vec<&Path> {
    let mut ancestors: Vec<_> = path.ancestors().collect();
    ancestors.reverse();
    ancestors
}

pub fn pin_ancestors(path: &Path) -> Result<Vec<Handle>> {
    let mut guards = Vec::new();
    for path in ancestor_pin_order(path) {
        guards.push(open_path(path, true)?);
    }
    Ok(guards)
}

fn open_path(path: &Path, allow_write: bool) -> Result<Handle> {
    let handle = Handle::new(unsafe {
        CreateFileW(
            wide(&path.to_string_lossy()).as_ptr(),
            // Metadata-only opens do not enforce Windows file sharing locks.
            // FILE_READ_DATA (LIST_DIRECTORY for directories) makes the
            // no-write/no-delete pin effective, including pre-existing writers.
            READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_READ_DATA,
            FILE_SHARE_READ | if allow_write { FILE_SHARE_WRITE } else { 0 },
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
    Ok(handle)
}

struct LocalSid(PSID);
impl Drop for LocalSid {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn trusted_installer() -> Result<LocalSid> {
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
    Ok(LocalSid(trusted_installer))
}

fn handle_is_protected(handle: HANDLE, trusted_installer: PSID) -> bool {
    let mut owner = ptr::null_mut();
    let mut acl = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    let code = unsafe {
        GetSecurityInfo(
            handle,
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
        return false;
    }
    if acl.is_null() || owner.is_null() || unsafe { IsValidAcl(acl) } == 0 {
        unsafe {
            LocalFree(descriptor);
        }
        return false;
    }
    let trusted = |sid| unsafe {
        IsWellKnownSid(sid, WinLocalSystemSid) != 0
            || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
            || EqualSid(sid, trusted_installer) != 0
    };
    let mut safe = trusted(owner);
    if safe {
        unsafe {
            if let Some(parsed) = acl.cast::<ACL>().as_ref() {
                for i in 0..parsed.AceCount as u32 {
                    let mut ace = ptr::null_mut();
                    if GetAce(acl, i, &mut ace) == 0 || ace.is_null() {
                        safe = false;
                        break;
                    }
                    let Some(header) = ace.cast::<ACE_HEADER>().as_ref() else {
                        safe = false;
                        break;
                    };
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
                    let Some(allow) = ace.cast::<ACCESS_ALLOWED_ACE>().as_ref() else {
                        safe = false;
                        break;
                    };
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
            } else {
                safe = false;
            }
        }
    }
    unsafe {
        LocalFree(descriptor);
    }
    safe
}

pub fn check_paths(paths: Vec<PathBuf>) -> Result<Vec<Handle>> {
    let trusted_installer = trusted_installer()?;
    let mut handles = Vec::new();
    for path in paths {
        // ACL changes do not revoke existing write handles. Refuse those too.
        let handle = open_path(&path, false)?;
        if !handle_is_protected(handle.0, trusted_installer.0) {
            return denied();
        }
        handles.push(handle);
    }
    Ok(handles)
}

pub fn authorize_client(pid: u32, install: &Path, user_sid: Option<&str>) -> Result<(Handle, u32)> {
    authorize_client_process(process(pid)?, install, user_sid)
}

pub fn authorize_client_process(
    client: Handle,
    install: &Path,
    user_sid: Option<&str>,
) -> Result<(Handle, u32)> {
    #[cfg_attr(not(feature = "development"), allow(unused_variables))]
    let pid = pid_of(client.0)?;
    if unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(client.0, 0) }
        != WAIT_TIMEOUT
    {
        return denied();
    }
    let client_token = token(client.0)?;
    let session = session(client_token.0)?;
    if session == 0
        || session
            != unsafe { windows_sys::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId() }
    {
        return denied();
    }
    let client_image = image(client.0)?;
    if user_sid
        .is_some_and(|expected| token_user_sid(client_token.0).ok().as_deref() != Some(expected))
    {
        return denied();
    }
    #[cfg(feature = "development")]
    {
        crate::development::check_client(
            pid,
            &client_image,
            install,
            &process_arguments(client.0)?,
        )?;
        return Ok((client, session));
    }
    #[cfg(not(feature = "development"))]
    {
        if !client_image.parent().is_some_and(|p| same_file(p, install))
            || !client_image.file_name().is_some_and(|n| {
                n.eq_ignore_ascii_case("Cindy.exe") || n.eq_ignore_ascii_case("CindyDev.exe")
            })
        {
            return denied();
        }
        if user_sid.is_some_and(|expected| {
            token_user_sid(client_token.0).ok().as_deref() != Some(expected)
        }) || !is_main_command_line(&process_arguments(client.0)?)
        {
            return denied();
        }
        Ok((client, session))
    }
}

pub fn token_user_sid(token: HANDLE) -> Result<String> {
    let mut data = [0usize; 128];
    let mut needed = 0;
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            data.as_mut_ptr().cast(),
            mem::size_of_val(&data) as u32,
            &mut needed,
        )
    } == 0
    {
        return Err(error());
    }
    let mut raw = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW((*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid, &mut raw) }
        == 0
    {
        return Err(error());
    }
    let sid = unsafe {
        let mut length = 0;
        while *raw.add(length) != 0 {
            length += 1;
        }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(raw, length));
        LocalFree(raw.cast());
        result
    };
    Ok(sid)
}

/// A normal, non-elevated Main must be able to authenticate the SCM/SYSTEM
/// endpoint before sending input. Grant identity-query rights only: never
/// process modification, token duplication, impersonation, or pipe authority.
pub fn allow_service_identity_queries() -> Result<()> {
    use windows_sys::Win32::System::Threading::*;
    fn grant(handle: HANDLE, rights: u32) -> Result<()> {
        let mut sid = [0usize; 16];
        let mut size = mem::size_of_val(&sid) as u32;
        if unsafe {
            CreateWellKnownSid(
                WinInteractiveSid,
                ptr::null_mut(),
                sid.as_mut_ptr().cast(),
                &mut size,
            )
        } == 0
        {
            return Err(error());
        }
        let mut old_acl = ptr::null_mut();
        let mut descriptor = ptr::null_mut();
        let status = unsafe {
            GetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut old_acl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(std::io::Error::from_raw_os_error(status as i32));
        }
        if old_acl.is_null() {
            unsafe {
                LocalFree(descriptor);
            }
            return denied();
        }
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: rights,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                ptstrName: sid.as_mut_ptr().cast(),
            },
        };
        let mut acl = ptr::null_mut();
        let mut status = unsafe { SetEntriesInAclW(1, &access, old_acl, &mut acl) };
        if status == ERROR_SUCCESS {
            status = unsafe {
                SetSecurityInfo(
                    handle,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    acl,
                    ptr::null_mut(),
                )
            };
        }
        unsafe {
            if !acl.is_null() {
                LocalFree(acl.cast());
            }
            LocalFree(descriptor);
        }
        if status != ERROR_SUCCESS {
            return Err(std::io::Error::from_raw_os_error(status as i32));
        }
        Ok(())
    }
    let process = unsafe { GetCurrentProcess() };
    let mut raw = ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY | READ_CONTROL | WRITE_DAC, &mut raw) } == 0 {
        return Err(error());
    }
    let token = Handle::new(raw)?;
    grant(process, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)?;
    grant(token.0, TOKEN_QUERY)
}

// The executable name alone is not a Main identity: plugin utility processes
// use the same image. Read the kernel's command line, never a client-supplied PID
// or role. Unknown Chromium/Node switches cannot opt into this privileged path.
fn process_arguments(process: HANDLE) -> Result<Vec<String>> {
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            process: HANDLE,
            class: u32,
            data: *mut core::ffi::c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
    }
    let mut data = vec![0usize; 16_384];
    let mut needed = 0;
    if unsafe {
        NtQueryInformationProcess(
            process,
            60,
            data.as_mut_ptr().cast(),
            (data.len() * mem::size_of::<usize>()) as u32,
            &mut needed,
        )
    } < 0
    {
        return denied();
    }
    let value = unsafe { &*data.as_ptr().cast::<UnicodeString>() };
    let start = data.as_ptr() as usize;
    let end = start + data.len() * mem::size_of::<usize>();
    let text_start = value.buffer as usize;
    if value.length % 2 != 0
        || text_start < start
        || text_start
            .checked_add(value.length as usize)
            .is_none_or(|p| p > end)
    {
        return denied();
    }
    let mut text =
        unsafe { std::slice::from_raw_parts(value.buffer, value.length as usize / 2) }.to_vec();
    text.push(0);
    let mut count = 0;
    let argv = unsafe { CommandLineToArgvW(text.as_ptr(), &mut count) };
    if argv.is_null() {
        return Err(error());
    }
    let result = unsafe {
        let result = std::slice::from_raw_parts(argv, count as usize)
            .iter()
            .map(|arg| {
                let mut len = 0;
                while *arg.add(len) != 0 {
                    len += 1;
                }
                String::from_utf16_lossy(std::slice::from_raw_parts(*arg, len))
            })
            .collect();
        LocalFree(argv.cast());
        result
    };
    Ok(result)
}

pub(crate) fn is_main_command_line(args: &[String]) -> bool {
    if args.is_empty() {
        return false;
    }
    let mut arguments = args.iter().skip(1);
    while let Some(arg) = arguments.next() {
        if matches!(
            arg.as_str(),
            "--hidden"
                | "--minimized"
                | "--start-hidden"
                | "--autostart"
                | "--relaunch"
                | "--cindy-version-original"
        ) || arg.starts_with("cindy://")
            || arg.starts_with("xdt-maker://")
        {
            continue;
        }
        // Existing product entry arguments are data, not Electron/Node options.
        if let Some(profile) = arg.strip_prefix("--cindy-version-profile=") {
            if Path::new(profile).is_absolute() {
                continue;
            }
            return false;
        }
        if let Some(id) = arg.strip_prefix("--cindy-version-launch=") {
            if id.len() == 36
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
            {
                continue;
            }
            return false;
        }
        if matches!(arg.as_str(), "--open-folder" | "--open-share-file") {
            if arguments
                .next()
                .is_some_and(|path| Path::new(path).is_absolute())
            {
                continue;
            }
            return false;
        }
        if let Some(path) = arg
            .strip_prefix("--open-folder=")
            .or_else(|| arg.strip_prefix("--open-share-file="))
        {
            if Path::new(path).is_absolute() {
                continue;
            }
            return false;
        }
        let file = Path::new(arg);
        if file.is_absolute()
            && file.extension().is_some_and(|extension| {
                extension.eq_ignore_ascii_case("cindy") || extension.eq_ignore_ascii_case("cshare")
            })
        {
            continue;
        }
        return false;
    }
    true
}

const CODE_DACL: &str = "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)";
const SERVICE_DIRECTORY_DACL: &str = "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)";

/// Used only by the explicitly UAC-approved installer, on Cindy code paths.
/// Changing a user's chosen directory is unnecessary; its code can be protected
/// in place. Parent directories and user data are never hardened recursively.
pub fn secure_code(path: &Path) -> Result<()> {
    secure_code_with_descriptor(path, CODE_DACL)
}

fn open_acl_handle(path: &Path, share: u32) -> Result<Handle> {
    let handle = Handle::new(unsafe {
        CreateFileW(
            wide(&path.to_string_lossy()).as_ptr(),
            READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES | FILE_READ_DATA,
            share,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    })?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 && info.nNumberOfLinks != 1)
    {
        return denied();
    }
    Ok(handle)
}

fn open_for_acl(path: &Path) -> Result<Handle> {
    // Share read/write so a running image can stay mapped; never share
    // DELETE, so the object cannot be replaced while this handle is held.
    open_acl_handle(path, FILE_SHARE_READ | FILE_SHARE_WRITE)
}

fn open_for_hardening(path: &Path) -> Result<Handle> {
    // Capture-time pins must refuse writers and replacement. Reopening by
    // path later would follow a junction swapped in after the snapshot.
    open_acl_handle(path, FILE_SHARE_READ)
}

fn apply_descriptor(handle: HANDLE, descriptor: &str) -> Result<()> {
    let mut sd = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(descriptor).as_ptr(),
            1,
            &mut sd,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(error());
    }
    // Unlike SetSecurityInfo's tree propagation, update this exact open object.
    // App-owned code paths are enumerated explicitly; unrelated descendants
    // must keep their original permissions, even if located below the app root.
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) } == 0 {
        let code = unsafe { GetLastError() };
        unsafe {
            LocalFree(sd);
        }
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    let inheritance = if control & SE_DACL_PROTECTED != 0 {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    let result = unsafe {
        SetKernelObjectSecurity(
            handle,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | inheritance,
            sd,
        )
    };
    let code = unsafe { GetLastError() };
    unsafe {
        LocalFree(sd);
    }
    if result == 0 {
        return Err(std::io::Error::from_raw_os_error(code as i32));
    }
    Ok(())
}

fn secure_code_with_descriptor(path: &Path, descriptor: &str) -> Result<()> {
    let handle = open_for_acl(path)?;
    apply_descriptor(handle.0, descriptor)
}

fn restore_depth(a: &Path, b: &Path) -> std::cmp::Ordering {
    b.components()
        .count()
        .cmp(&a.components().count())
        .then_with(|| a.as_os_str().cmp(b.as_os_str()))
}

#[cfg(test)]
fn deepest_first(paths: &mut [(PathBuf, String)]) {
    paths.sort_by(|(a, _), (b, _)| restore_depth(a, b));
}

pub fn create_protected_directory(path: &Path) -> Result<()> {
    let mut sd = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(SERVICE_DIRECTORY_DACL).as_ptr(),
            1,
            &mut sd,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd,
        bInheritHandle: 0,
    };
    let result = unsafe { CreateDirectoryW(wide(&path.to_string_lossy()).as_ptr(), &attributes) };
    let code = unsafe { GetLastError() };
    unsafe {
        LocalFree(sd);
    }
    if result == 0 && code != ERROR_ALREADY_EXISTS {
        return Err(std::io::Error::from_raw_os_error(code as i32));
    }
    check_paths(vec![path.to_owned()])?;
    Ok(())
}

pub fn sharing_conflict(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(code) if code == ERROR_SHARING_VIOLATION as i32 || code == ERROR_LOCK_VIOLATION as i32
    )
}

fn read_descriptor_handle(handle: &Handle) -> Result<String> {
    let information =
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    let mut sd = ptr::null_mut();
    let code = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            information,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut sd,
        )
    };
    if code != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    let mut text = ptr::null_mut();
    let ok = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            sd,
            1,
            information,
            &mut text,
            ptr::null_mut(),
        )
    };
    let result = if ok == 0 || text.is_null() {
        Err(error())
    } else {
        unsafe {
            let mut length = 0;
            while *text.add(length) != 0 {
                length += 1;
            }
            Ok(String::from_utf16_lossy(std::slice::from_raw_parts(
                text, length,
            )))
        }
    };
    unsafe {
        if !text.is_null() {
            LocalFree(text.cast());
        }
        LocalFree(sd);
    }
    result
}

pub struct CapturedTree {
    pub snapshot: AclSnapshot,
    pins: Vec<Handle>,
    committed: bool,
}

impl CapturedTree {
    pub fn capture(paths: &[PathBuf]) -> Result<Self> {
        let mut pins = Vec::new();
        for path in paths {
            match open_for_hardening(path) {
                Ok(handle) => pins.push((path.clone(), handle)),
                Err(error) => {
                    if check_paths(vec![path.clone()]).is_ok() {
                        continue;
                    }
                    return Err(error);
                }
            }
        }
        Self::from_frozen(pins)
    }

    pub fn from_frozen(frozen: Vec<(PathBuf, Handle)>) -> Result<Self> {
        let trusted = trusted_installer()?;
        let mut snapshot_paths = Vec::new();
        let mut pins = Vec::new();
        for (path, handle) in frozen {
            if handle_is_protected(handle.0, trusted.0) {
                continue;
            }
            let descriptor = read_descriptor_handle(&handle)?;
            snapshot_paths.push((path, descriptor));
            pins.push(handle);
        }
        Ok(Self {
            snapshot: AclSnapshot {
                paths: snapshot_paths,
            },
            pins,
            committed: false,
        })
    }

    pub fn harden(&self) -> Result<()> {
        self.apply_all(CODE_DACL)
    }

    #[cfg(test)]
    fn harden_as(&self, descriptor: &str) -> Result<()> {
        self.apply_all(descriptor)
    }

    fn apply_all(&self, descriptor: &str) -> Result<()> {
        for handle in &self.pins {
            apply_descriptor(handle.0, descriptor)?;
        }
        Ok(())
    }

    pub fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for CapturedTree {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        // Roll back through the capture-time pins, nested objects first.
        // Reopening by path would follow a junction swapped in after the snapshot.
        let mut order: Vec<_> = self.pins.iter().zip(&self.snapshot.paths).collect();
        order.sort_by(|(_, (a, _)), (_, (b, _))| restore_depth(a, b));
        for (handle, (_, descriptor)) in order {
            let _ = apply_descriptor(handle.0, descriptor);
        }
    }
}

#[derive(Clone)]
pub struct AclSnapshot {
    pub paths: Vec<(PathBuf, String)>,
}

impl AclSnapshot {
    pub fn capture(paths: &[PathBuf]) -> Result<Self> {
        let mut tree = CapturedTree::capture(paths)?;
        let snapshot = tree.snapshot.clone();
        tree.commit();
        Ok(snapshot)
    }

    pub fn merge(&self, later: &Self) -> Self {
        let mut paths = self.paths.clone();
        for (path, descriptor) in &later.paths {
            if paths.iter().any(|(existing, _)| {
                same_file(existing, path)
                    || existing
                        .as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&path.as_os_str().to_string_lossy())
            }) {
                continue;
            }
            paths.push((path.clone(), descriptor.clone()));
        }
        Self { paths }
    }

    pub fn combined(existing: Option<Self>, captured: Self) -> Option<Self> {
        let snapshot = match existing {
            Some(existing) => existing.merge(&captured),
            None => captured,
        };
        if snapshot.paths.is_empty() {
            None
        } else {
            Some(snapshot)
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "paths": self.paths.iter().map(|(path, descriptor)| {
                serde_json::json!({
                    "path": path,
                    "descriptor": descriptor,
                })
            }).collect::<Vec<_>>(),
        }))
        .expect("serializable ACL snapshot")
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| error())?;
        let object = value.as_object().ok_or_else(error)?;
        if object.len() != 2 || value["version"] != 1 {
            return denied();
        }
        let mut paths = Vec::new();
        for entry in value["paths"].as_array().ok_or_else(error)? {
            let path = PathBuf::from(entry["path"].as_str().ok_or_else(error)?);
            let descriptor = entry["descriptor"]
                .as_str()
                .filter(|value| !value.is_empty() && !value.contains('\0'))
                .map(String::from)
                .ok_or_else(error)?;
            if !crate::installation::is_local_application_path(&path) {
                return denied();
            }
            paths.push((path, descriptor));
        }
        Ok(Self { paths })
    }

    pub fn restore(&self) -> Result<()> {
        self.restore_allowed(|_| true)
    }

    pub fn restore_allowed(&self, allowed: impl Fn(&Path) -> bool) -> Result<()> {
        self.restore_in(None, allowed)
    }

    pub fn restore_in(&self, root: Option<&Path>, allowed: impl Fn(&Path) -> bool) -> Result<()> {
        // Pin the application (or each captured path) before canonicalize or
        // CreateFile. Intermediate junctions are followed by path lookup;
        // holding ancestors without DELETE stops a parent outside the snapshot
        // from being replaced between the range check and the ACL write.
        let mut ancestor_pins = Vec::new();
        if let Some(root) = root {
            if root.exists() {
                ancestor_pins.extend(pin_ancestors(root)?);
            }
        } else {
            for (path, _) in &self.paths {
                if crate::installation::is_local_application_path(path) && path.exists() {
                    ancestor_pins.extend(pin_ancestors(path)?);
                }
            }
        }
        // Pin shallowest-first without DELETE sharing while the tree is still
        // the captured one. CreateFile follows intermediate junctions; holding
        // the parent first stops a later swap from retargeting children.
        // Apply ACLs through those handles, deepest-first, so FILE_DELETE_CHILD
        // is not given back on a directory before its descendants are restored.
        let mut ordered: Vec<_> = self
            .paths
            .iter()
            .filter(|(path, _)| allowed(path))
            .cloned()
            .collect();
        ordered.sort_by(|(a, _), (b, _)| {
            a.components()
                .count()
                .cmp(&b.components().count())
                .then_with(|| a.as_os_str().cmp(b.as_os_str()))
        });
        let mut pinned = Vec::new();
        for (path, descriptor) in ordered {
            if path.exists() {
                let handle = open_for_acl(&path)?;
                pinned.push((path, handle, descriptor));
            }
        }
        pinned.sort_by(|(a, _, _), (b, _, _)| restore_depth(a, b));
        for (_, handle, descriptor) in &pinned {
            apply_descriptor(handle.0, descriptor)?;
        }
        drop(ancestor_pins);
        Ok(())
    }
}

fn hash_handle(handle: &Handle) -> Result<[u8; 32]> {
    if unsafe { SetFilePointerEx(handle.0, 0, ptr::null_mut(), FILE_BEGIN) } == 0 {
        return Err(error());
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let mut read = 0;
        if unsafe {
            ReadFile(
                handle.0,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(error());
        }
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read as usize]);
    }
    if unsafe { SetFilePointerEx(handle.0, 0, ptr::null_mut(), FILE_BEGIN) } == 0 {
        return Err(error());
    }
    Ok(hasher.finalize().into())
}

fn open_payload(path: &Path) -> Result<Handle> {
    let handle = open_path(path, false)?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
        || info.nNumberOfLinks != 1
    {
        return denied();
    }
    Ok(handle)
}

#[cfg(not(any(feature = "development", test)))]
fn signer_thumbprint(path: &Path) -> Result<Vec<u8>> {
    let path = wide(&path.to_string_lossy());
    let mut store = ptr::null_mut();
    let mut message = ptr::null_mut();
    let mut encoding = 0;
    // Embedded Authenticode fills the PKCS#7 store and message. ppvContext
    // stays null for CERT_QUERY_CONTENT_PKCS7_SIGNED_EMBED; the signer is in
    // the message, not that pointer.
    if unsafe {
        CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            path.as_ptr().cast(),
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            &mut encoding,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut store,
            &mut message,
            ptr::null_mut(),
        )
    } == 0
        || store.is_null()
        || message.is_null()
    {
        if !message.is_null() {
            unsafe {
                CryptMsgClose(message);
            }
        }
        if !store.is_null() {
            unsafe {
                CertCloseStore(store, 0);
            }
        }
        return Err(error());
    }
    struct Query {
        store: HCERTSTORE,
        message: *mut core::ffi::c_void,
    }
    impl Drop for Query {
        fn drop(&mut self) {
            unsafe {
                CryptMsgClose(self.message);
                CertCloseStore(self.store, 0);
            }
        }
    }
    let query = Query { store, message };
    let mut size = 0;
    if unsafe {
        CryptMsgGetParam(
            query.message,
            CMSG_SIGNER_CERT_INFO_PARAM,
            0,
            ptr::null_mut(),
            &mut size,
        )
    } == 0
        || size == 0
    {
        return Err(error());
    }
    let mut info = vec![0u8; size as usize];
    if unsafe {
        CryptMsgGetParam(
            query.message,
            CMSG_SIGNER_CERT_INFO_PARAM,
            0,
            info.as_mut_ptr().cast(),
            &mut size,
        )
    } == 0
    {
        return Err(error());
    }
    let encoding = if encoding == 0 {
        X509_ASN_ENCODING | PKCS_7_ASN_ENCODING
    } else {
        encoding
    };
    let context = unsafe {
        CertFindCertificateInStore(
            query.store,
            encoding,
            0,
            CERT_FIND_SUBJECT_CERT,
            info.as_ptr().cast(),
            ptr::null(),
        )
    };
    if context.is_null() {
        return denied();
    }
    let mut thumbprint = Vec::new();
    let mut thumb_size = 0;
    let ok = unsafe {
        CertGetCertificateContextProperty(
            context,
            CERT_HASH_PROP_ID,
            ptr::null_mut(),
            &mut thumb_size,
        ) != 0
            && {
                thumbprint.resize(thumb_size as usize, 0);
                CertGetCertificateContextProperty(
                    context,
                    CERT_HASH_PROP_ID,
                    thumbprint.as_mut_ptr().cast(),
                    &mut thumb_size,
                ) != 0
            }
    };
    unsafe {
        CertFreeCertificateContext(context);
    }
    if !ok || thumbprint.is_empty() {
        return denied();
    }
    thumbprint.truncate(thumb_size as usize);
    Ok(thumbprint)
}

/// The service trusts this packaged Main after UAC. Authenticode matches the
/// elevated helper. Electron already seals `app.asar`. Windows has no
/// Authenticode catalog for unpacked JS/`.node`, so this path does not invent
/// a Cindy-private signed manifest for those files. Same-user rewrites of
/// unpacked files before UAC, or injection into a live Main, are outside this
/// broker's sandbox claim; Main remains the privilege boundary.
pub fn authenticate_application_code(
    install: &Path,
    executable: &str,
) -> Result<(Handle, [u8; 32])> {
    let main = install.join(executable);
    let handle = open_payload(&main)?;
    verify_authenticode(&main, handle.0)?;
    #[cfg(not(any(feature = "development", test)))]
    {
        let host = std::env::current_exe()?;
        if signer_thumbprint(&main)? != signer_thumbprint(&host)? {
            return denied();
        }
    }
    let hash = hash_handle(&handle)?;
    Ok((handle, hash))
}

pub fn confirm_application_code(handle: &Handle, path: &Path, expected: &[u8; 32]) -> Result<()> {
    verify_authenticode(path, handle.0)?;
    if hash_handle(handle)? != *expected {
        return denied();
    }
    Ok(())
}

pub fn process_still_running(process: HANDLE) -> bool {
    unsafe {
        windows_sys::Win32::System::Threading::WaitForSingleObject(process, 0) == WAIT_TIMEOUT
    }
}

fn verify_authenticode(path: &Path, handle: HANDLE) -> Result<()> {
    #[cfg(any(feature = "development", test))]
    {
        let _ = (path, handle);
        return Ok(());
    }
    #[cfg(not(any(feature = "development", test)))]
    {
        let path_wide = wide(&path.to_string_lossy());
        let mut file = WINTRUST_FILE_INFO {
            cbStruct: mem::size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: path_wide.as_ptr(),
            hFile: handle,
            pgKnownSubject: ptr::null_mut(),
        };
        let mut data = WINTRUST_DATA {
            cbStruct: mem::size_of::<WINTRUST_DATA>() as u32,
            pPolicyCallbackData: ptr::null_mut(),
            pSIPClientData: ptr::null_mut(),
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
            dwStateAction: WTD_STATEACTION_VERIFY,
            hWVTStateData: ptr::null_mut(),
            pwszURLReference: ptr::null_mut(),
            dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE,
            dwUIContext: WTD_UICONTEXT_INSTALL,
            pSignatureSettings: ptr::null_mut(),
        };
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let status = unsafe {
            WinVerifyTrust(
                INVALID_HANDLE_VALUE,
                &mut action,
                (&mut data as *mut WINTRUST_DATA).cast(),
            )
        };
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        unsafe {
            WinVerifyTrust(
                INVALID_HANDLE_VALUE,
                &mut action,
                (&mut data as *mut WINTRUST_DATA).cast(),
            );
        }
        if status != 0 {
            return denied();
        }
        Ok(())
    }
}

pub fn copy_protected_payload(source: &Path, destination: &Path) -> Result<()> {
    let source_handle = open_payload(source)?;
    verify_authenticode(source, source_handle.0)?;
    let expected = hash_handle(&source_handle)?;
    #[cfg(not(any(feature = "development", test)))]
    {
        let host = std::env::current_exe()?;
        if signer_thumbprint(source)? != signer_thumbprint(&host)? {
            return denied();
        }
    }
    let destination_handle = Handle::new(unsafe {
        CreateFileW(
            wide(&destination.to_string_lossy()).as_ptr(),
            GENERIC_WRITE | GENERIC_READ | FILE_READ_ATTRIBUTES,
            0,
            ptr::null(),
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    })?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    if unsafe { GetFileInformationByHandle(destination_handle.0, &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return denied();
    }
    let mut buffer = [0u8; 8192];
    loop {
        let mut read = 0;
        if unsafe {
            ReadFile(
                source_handle.0,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(error());
        }
        if read == 0 {
            break;
        }
        let mut written = 0;
        if unsafe {
            WriteFile(
                destination_handle.0,
                buffer.as_ptr().cast(),
                read,
                &mut written,
                ptr::null_mut(),
            )
        } == 0
            || written != read
        {
            return Err(error());
        }
    }
    if unsafe { FlushFileBuffers(destination_handle.0) } == 0 {
        return Err(error());
    }
    drop(destination_handle);
    let copied = open_payload(destination)?;
    verify_authenticode(destination, copied.0)?;
    if hash_handle(&copied)? != expected {
        return denied();
    }
    Ok(())
}

pub fn require_elevated() -> Result<()> {
    let caller = token(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() })?;
    let mut elevation: TOKEN_ELEVATION = unsafe { mem::zeroed() };
    let mut needed = 0;
    if unsafe {
        GetTokenInformation(
            caller.0,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            mem::size_of_val(&elevation) as u32,
            &mut needed,
        )
    } == 0
        || elevation.TokenIsElevated == 0
    {
        return denied();
    }
    Ok(())
}

/// Over-the-shoulder UAC may run setup as a different administrator. Enable
/// only the installer's existing debug privilege so it can read the original
/// Main token. This is not granted to Cindy or persisted in the service record.
pub fn prepare_elevated_identity_query() {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    let mut raw = ptr::null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES,
            &mut raw,
        )
    } == 0
    {
        return;
    }
    let Ok(token) = Handle::new(raw) else {
        return;
    };
    let mut luid = unsafe { mem::zeroed() };
    if unsafe { LookupPrivilegeValueW(ptr::null(), wide("SeDebugPrivilege").as_ptr(), &mut luid) }
        == 0
    {
        return;
    }
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    unsafe {
        AdjustTokenPrivileges(token.0, 0, &privileges, 0, ptr::null_mut(), ptr::null_mut());
    }
    // Enterprise policy can withhold it. The subsequent real identity query
    // remains authoritative and fails closed if setup still cannot read Main.
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "cindy-lock-security-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let path = self.0.canonicalize().unwrap();
            assert!(path.starts_with(std::env::temp_dir().canonicalize().unwrap()));
            assert!(path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cindy-lock-security-"));
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    fn descriptor(path: &Path) -> String {
        let handle = open_path(path, true).unwrap();
        let information =
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
        let mut sd = ptr::null_mut();
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    handle.0,
                    SE_FILE_OBJECT,
                    information,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    &mut sd,
                )
            },
            ERROR_SUCCESS
        );
        let mut text = ptr::null_mut();
        assert_ne!(
            unsafe {
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    sd,
                    1,
                    information,
                    &mut text,
                    ptr::null_mut(),
                )
            },
            0
        );
        unsafe {
            let mut length = 0;
            while *text.add(length) != 0 {
                length += 1;
            }
            let result = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
            LocalFree(text.cast());
            LocalFree(sd);
            result
        }
    }
    #[test]
    fn protecting_a_code_directory_does_not_rewrite_descendant_data_permissions() {
        let fixture = Fixture::new();
        let app = fixture.0.join("app");
        let data = app.join("userData");
        let content = data.join("preferences.json");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(&content, b"fixture").unwrap();
        let before = (
            descriptor(&fixture.0),
            descriptor(&data),
            descriptor(&content),
        );
        let sid = token_user_sid(
            token(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() })
                .unwrap()
                .0,
        )
        .unwrap();
        // Exercise the exact production Win32 setter on an owned test directory;
        // the fixture keeps its own owner so the test requires no UAC.
        secure_code_with_descriptor(&app, &format!("O:{sid}D:P(A;;FA;;;{sid})")).unwrap();
        assert_eq!(
            before,
            (
                descriptor(&fixture.0),
                descriptor(&data),
                descriptor(&content)
            )
        );
        std::fs::write(&content, b"still writable").unwrap();
    }
    #[test]
    fn hardening_cannot_change_a_file_aliased_outside_the_installation() {
        let fixture = Fixture::new();
        let original = fixture.0.join("working-file");
        let alias = fixture.0.join("app.asar");
        std::fs::write(&original, b"fixture").unwrap();
        std::fs::hard_link(&original, &alias).unwrap();
        let before = descriptor(&original);
        let sid = token_user_sid(
            token(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() })
                .unwrap()
                .0,
        )
        .unwrap();
        assert!(
            secure_code_with_descriptor(&alias, &format!("O:{sid}D:P(A;;FR;;;{sid})")).is_err()
        );
        assert_eq!(descriptor(&original), before);
        std::fs::write(&original, b"still writable").unwrap();
    }
    #[test]
    fn program_code_cannot_keep_old_writers_or_be_replaced_while_authorized() {
        let fixture = Fixture::new();
        let code = fixture.0.join("app.asar");
        std::fs::write(&code, b"fixture").unwrap();
        let writer = std::fs::OpenOptions::new().write(true).open(&code).unwrap();
        assert!(
            open_path(&code, false).is_err(),
            "ACL hardening alone cannot revoke this writer"
        );
        drop(writer);
        let guard = open_path(&code, false).unwrap();
        assert!(std::fs::OpenOptions::new().write(true).open(&code).is_err());
        assert!(std::fs::rename(&code, fixture.0.join("replaced.asar")).is_err());
        drop(guard);
        std::fs::write(&code, b"released").unwrap();
    }
    #[test]
    fn captured_tree_pins_block_writers_and_replacement_through_hardening() {
        let fixture = Fixture::new();
        let code = fixture.0.join("Cindy.exe");
        std::fs::write(&code, b"fixture").unwrap();
        let sid = token_user_sid(
            token(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() })
                .unwrap()
                .0,
        )
        .unwrap();
        secure_code_with_descriptor(&code, &format!("O:{sid}D:(A;;FA;;;{sid})")).unwrap();
        let before = descriptor(&code);
        {
            let tree = CapturedTree::capture(&[code.clone()]).unwrap();
            assert_eq!(tree.snapshot.paths.len(), 1);
            assert!(
                std::fs::OpenOptions::new().write(true).open(&code).is_err(),
                "capture must keep a no-write pin so a later open_for_acl cannot follow a swapped path"
            );
            assert!(std::fs::rename(&code, fixture.0.join("replaced.exe")).is_err());
            tree.harden_as(&format!("O:{sid}D:P(A;;FRWO;;;{sid})"))
                .unwrap();
            assert_ne!(descriptor(&code), before);
        }
        assert_eq!(descriptor(&code), before);
        std::fs::write(&code, b"released").unwrap();
    }
    #[test]
    fn freeze_code_tree_pins_ordinary_electron_resources() {
        let fixture = Fixture::new();
        let app = fixture.0.join("Cindy");
        std::fs::create_dir_all(app.join("resources/locales")).unwrap();
        std::fs::create_dir_all(app.join("userData")).unwrap();
        std::fs::write(app.join("Cindy.exe"), b"fixture").unwrap();
        std::fs::write(app.join("resources/app.asar"), b"fixture").unwrap();
        std::fs::write(app.join("chrome_100_percent.pak"), b"fixture").unwrap();
        std::fs::write(app.join("resources.pak"), b"fixture").unwrap();
        std::fs::write(app.join("resources/locales/en-US.pak"), b"fixture").unwrap();
        std::fs::write(app.join("userData/preferences.json"), b"fixture").unwrap();
        let (_, frozen) = freeze_code_tree(&app).unwrap();
        let frozen_paths: Vec<_> = frozen.iter().map(|(path, _)| path.clone()).collect();
        assert!(frozen_paths.contains(&app.join("chrome_100_percent.pak")));
        assert!(frozen_paths.contains(&app.join("resources.pak")));
        assert!(frozen_paths.contains(&app.join("resources/locales")));
        assert!(frozen_paths.contains(&app.join("resources/locales/en-US.pak")));
        assert!(!frozen_paths
            .iter()
            .any(|path| path.starts_with(app.join("userData"))));
        confirm_frozen_tree(&frozen).unwrap();
    }
    #[test]
    fn freeze_code_tree_refuses_children_that_appear_after_the_first_listing() {
        let fixture = Fixture::new();
        let app = fixture.0.join("Cindy");
        std::fs::create_dir_all(app.join("resources/app.asar.unpacked/native")).unwrap();
        std::fs::write(app.join("Cindy.exe"), b"fixture").unwrap();
        std::fs::write(app.join("resources/app.asar"), b"fixture").unwrap();
        let restored = app.join("resources/app.asar.unpacked/native/addon.node");
        let (ancestors, frozen) = freeze_code_tree(&app).unwrap();
        assert!(!frozen.iter().any(|(path, _)| path == &restored));
        let write_while_frozen = std::fs::write(&restored, b"payload");
        if write_while_frozen.is_ok() {
            assert!(confirm_frozen_tree(&frozen).is_err());
        } else {
            assert!(confirm_frozen_tree(&frozen).is_ok());
        }
        drop(frozen);
        drop(ancestors);
        if write_while_frozen.is_err() {
            std::fs::write(&restored, b"payload").unwrap();
            let (_, restored_tree) = freeze_code_tree(&app).unwrap();
            assert!(restored_tree.iter().any(|(path, _)| path == &restored));
        }
    }
    #[test]
    fn live_writers_block_hardening_before_any_acl_change() {
        let fixture = Fixture::new();
        let code = fixture.0.join("Cindy.exe");
        std::fs::write(&code, b"fixture").unwrap();
        let before = descriptor(&code);
        let writer = std::fs::OpenOptions::new().write(true).open(&code).unwrap();
        let error = AclSnapshot::capture(&[code.clone()])
            .err()
            .expect("a live writer must prevent ACL capture");
        assert!(sharing_conflict(&error));
        assert_eq!(descriptor(&code), before);
        drop(writer);
        std::fs::write(&code, b"still writable").unwrap();
    }
    #[test]
    fn captured_permissions_are_restored_after_hardening() {
        let fixture = Fixture::new();
        let code = fixture.0.join("Cindy.exe");
        std::fs::write(&code, b"fixture").unwrap();
        let sid = token_user_sid(
            token(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() })
                .unwrap()
                .0,
        )
        .unwrap();
        // Use an explicit unprotected ACL. The machine's inherited AI bookkeeping
        // is not stable across SetKernelObjectSecurity, unlike the permissions
        // and inheritance-protection mode that this test must restore exactly.
        secure_code_with_descriptor(&code, &format!("O:{sid}D:(A;;FA;;;{sid})")).unwrap();
        let before = descriptor(&code);
        let snapshot = AclSnapshot::capture(&[code.clone()]).unwrap();
        // The fixture's user stands in for the privileged restorer: preserve
        // WRITE_OWNER, while denying data writes. Production grants the service
        // and administrators full access to restore the captured descriptor.
        secure_code_with_descriptor(&code, &format!("O:{sid}D:P(A;;FRWO;;;{sid})")).unwrap();
        assert_ne!(descriptor(&code), before);
        assert!(std::fs::OpenOptions::new().write(true).open(&code).is_err());
        snapshot.restore().unwrap();
        assert_eq!(descriptor(&code), before);
        std::fs::write(&code, b"writable again").unwrap();
        let restored = AclSnapshot::decode(&snapshot.encode()).unwrap();
        assert_eq!(restored.paths, snapshot.paths);
        assert!(AclSnapshot::decode(br"{}").is_err());
        assert!(AclSnapshot::decode(
            br#"{"version":1,"paths":[{"path":"\\\\server\\share\\Cindy.exe","descriptor":"O:BAD:P"}]}"#
        )
        .is_err());
    }
    #[test]
    fn restore_pins_the_tree_and_applies_nested_objects_first() {
        let fixture = Fixture::new();
        let nested = fixture.0.join("Cindy");
        let child = nested.join("resources");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(child.join("app.asar"), b"fixture").unwrap();
        let sid = token_user_sid(
            token(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() })
                .unwrap()
                .0,
        )
        .unwrap();
        // Test the protected case independently of the unprotected file above.
        for path in [&nested, &child] {
            secure_code_with_descriptor(path, &format!("O:{sid}D:P(A;;FA;;;{sid})")).unwrap();
        }
        let before_root = descriptor(&nested);
        let before_child = descriptor(&child);
        let tree = AclSnapshot::capture(&[nested.clone(), child.clone()]).unwrap();
        let mut order = tree.paths.clone();
        deepest_first(&mut order);
        assert!(
            order[0].0.components().count() >= order.last().unwrap().0.components().count(),
            "restore must apply nested objects before relaxing the root"
        );
        let sid = token_user_sid(
            token(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() })
                .unwrap()
                .0,
        )
        .unwrap();
        secure_code_with_descriptor(&nested, &format!("O:{sid}D:P(A;;FA;;;{sid})")).unwrap();
        secure_code_with_descriptor(&child, &format!("O:{sid}D:P(A;;FRWO;;;{sid})")).unwrap();
        assert!(std::fs::write(child.join("new-file"), b"denied").is_err());
        tree.restore().unwrap();
        assert_eq!(descriptor(&nested), before_root);
        assert_eq!(descriptor(&child), before_child);
        std::fs::write(child.join("app.asar"), b"writable again").unwrap();
        assert!(tree
            .restore_allowed(|path| path.ends_with("missing"))
            .is_ok());
    }
    #[test]
    fn reinstall_keeps_the_first_captured_restore_record() {
        let first = AclSnapshot {
            paths: vec![(PathBuf::from(r"D:\Custom Apps\Cindy.exe"), "O:FIRST".into())],
        };
        let empty = AclSnapshot { paths: Vec::new() };
        let kept = AclSnapshot::combined(Some(first.clone()), empty).unwrap();
        assert_eq!(kept.paths, first.paths);
        assert!(AclSnapshot::combined(None, AclSnapshot { paths: Vec::new() }).is_none());
        let extra = AclSnapshot {
            paths: vec![
                (
                    PathBuf::from(r"D:\Custom Apps\Cindy.exe"),
                    "O:SHOULD-NOT-REPLACE".into(),
                ),
                (PathBuf::from(r"D:\Custom Apps\resources"), "O:NEW".into()),
            ],
        };
        let merged = first.merge(&extra);
        assert_eq!(merged.paths.len(), 2);
        assert_eq!(merged.paths[0].1, "O:FIRST");
        assert_eq!(
            merged.paths[1].0,
            PathBuf::from(r"D:\Custom Apps\resources")
        );
    }
    #[test]
    fn exclusive_payload_copy_preserves_bytes_and_rejects_open_writers() {
        let fixture = Fixture::new();
        let source = fixture.0.join("cindy-windows-desktop-input.exe");
        let destination = fixture.0.join("copied.exe");
        std::fs::write(&source, b"trusted-payload").unwrap();
        copy_protected_payload(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"trusted-payload");
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap();
        assert!(copy_protected_payload(&source, &fixture.0.join("blocked.exe")).is_err());
        drop(writer);
    }
    #[test]
    fn application_code_authentication_requires_a_packaged_layout() {
        let fixture = Fixture::new();
        let app = fixture.0.join("Cindy");
        std::fs::create_dir_all(app.join("resources")).unwrap();
        std::fs::write(app.join("Cindy.exe"), b"fixture").unwrap();
        assert!(authenticate_application_code(&app, "Cindy.exe").is_err());
        std::fs::write(app.join("resources/app.asar"), b"fixture").unwrap();
        let (handle, hash) = authenticate_application_code(&app, "Cindy.exe").unwrap();
        confirm_application_code(&handle, &app.join("Cindy.exe"), &hash).unwrap();
        assert!(authenticate_application_code(&app, "missing.exe").is_err());
        drop(handle);
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(app.join("Cindy.exe"))
            .unwrap();
        assert!(authenticate_application_code(&app, "Cindy.exe").is_err());
        drop(writer);
    }
    #[test]
    fn ancestor_pins_open_parents_before_the_leaf() {
        let fixture = Fixture::new();
        let nested = fixture.0.join("Cindy").join("resources");
        std::fs::create_dir_all(&nested).unwrap();
        let order: Vec<_> = ancestor_pin_order(&nested)
            .into_iter()
            .map(|path| path.to_path_buf())
            .collect();
        assert_eq!(order.last(), Some(&nested));
        assert!(order[0].components().count() <= order.last().unwrap().components().count());
        for window in order.windows(2) {
            assert!(window[1].starts_with(&window[0]));
        }
        let _pins = pin_ancestors(&nested).unwrap();
    }
    #[test]
    fn application_restore_paths_cannot_escape_the_install_root() {
        let fixture = Fixture::new();
        let app = fixture.0.join("Cindy");
        let nested = app.join("resources");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("app.asar"), b"fixture").unwrap();
        assert!(path_is_within(&nested.join("app.asar"), &app));
        assert!(!path_is_within(&fixture.0, &app));
        assert!(!path_is_within(&fixture.0.join("Cindy.bak"), &app));
    }
    #[test]
    fn the_permission_plan_covers_runtime_code_not_workspaces_or_user_data() {
        let fixture = Fixture::new();
        let app = fixture.0.join("Custom Cindy Location");
        for directory in [
            "resources/app.asar.unpacked/native",
            "resources/tools/remote-desktop",
            "resources/tools/windows-taskbar",
            "resources/cindy-updater-runtime",
            "resources/locales",
            "userData",
            "workspace",
        ] {
            std::fs::create_dir_all(app.join(directory)).unwrap();
        }
        for file in [
            "Cindy.exe",
            "snapshot_blob.bin",
            "chrome_100_percent.pak",
            "resources.pak",
            "resources/app.asar",
            "resources/app.asar.unpacked/native/addon.node",
            "resources/tools/remote-desktop/cindy-windows-desktop-host.node",
            "resources/tools/windows-taskbar/cindy-windows-taskbar.node",
            "resources/cindy-updater-runtime/vcruntime140.dll",
            "resources/locales/en-US.pak",
            "userData/preferences.json",
            "workspace/notes.txt",
        ] {
            std::fs::write(app.join(file), b"fixture").unwrap();
        }
        crate::installation::validate_application_directory(&app).unwrap();
        let paths = application_paths(&app).unwrap();
        assert!(paths.contains(&app.join("snapshot_blob.bin")));
        assert!(paths.contains(&app.join("chrome_100_percent.pak")));
        assert!(paths.contains(&app.join("resources.pak")));
        assert!(paths.contains(&app.join("resources/locales")));
        assert!(paths.contains(&app.join("resources/locales/en-US.pak")));
        assert!(paths.contains(&app.join("resources/app.asar.unpacked/native/addon.node")));
        assert!(paths
            .contains(&app.join("resources/tools/remote-desktop/cindy-windows-desktop-host.node")));
        assert!(
            paths.contains(&app.join("resources/tools/windows-taskbar/cindy-windows-taskbar.node"))
        );
        assert!(paths.contains(&app.join("resources/cindy-updater-runtime/vcruntime140.dll")));
        assert!(paths.iter().all(|path| path.starts_with(&app)));
        assert!(!paths
            .iter()
            .any(|path| path.starts_with(app.join("userData"))
                || path.starts_with(app.join("workspace"))));
        assert!(
            check_paths(vec![app.join("resources/app.asar")]).is_err(),
            "ordinary user-writable code is not an authorized installation"
        );
        assert!(crate::installation::validate_application_directory(
            &crate::installation::program_files().unwrap()
        )
        .is_err());
    }
    #[test]
    fn directory_reparse_points_cannot_extend_the_protection_plan() {
        let fixture = Fixture::new();
        let app = fixture.0.join("app");
        let external = fixture.0.join("workspace");
        std::fs::create_dir_all(app.join("resources")).unwrap();
        std::fs::create_dir(&external).unwrap();
        std::fs::write(app.join("resources/app.asar"), b"fixture").unwrap();
        let link = app.join("resources/app.asar.unpacked");
        match std::os::windows::fs::symlink_dir(&external, &link) {
            Ok(()) => {
                assert!(application_paths(&app).is_err());
                assert!(open_path(&link, false).is_err());
                std::fs::remove_dir(link).unwrap();
            }
            Err(error) if error.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD as i32) => {
                // This Windows capability requires Developer Mode or elevation.
                // The remaining path/ACL tests still run without either.
            }
            Err(error) => panic!("cannot create reparse fixture: {error}"),
        }
    }
    #[test]
    fn utility_and_debug_processes_cannot_inherit_the_main_grant() {
        for args in [
            vec!["Cindy.exe"],
            vec!["Cindy.exe", "--hidden"],
            vec!["Cindy.exe", "cindy://test"],
            vec!["Cindy.exe", "xdt-maker://project/test"],
            vec!["Cindy.exe", "--open-folder", r"D:\Projects"],
            vec!["Cindy.exe", r"D:\Shared\example.cshare"],
            vec![
                "Cindy.exe",
                r"--cindy-version-profile=D:\Profiles\Cindy",
                "--cindy-version-launch=00000000-0000-0000-0000-000000000001",
            ],
        ] {
            assert!(is_main_command_line(
                &args.into_iter().map(String::from).collect::<Vec<_>>()
            ));
        }
        for arg in [
            "--type=utility",
            "--type=renderer",
            "--remote-debugging-port=9222",
            "--inspect",
            "--app=evil.js",
            "--require=evil.js",
            "evil.js",
            "--open-folder",
            "--open-folder=relative",
            "--cindy-version-profile=relative",
            "--cindy-version-helper=00000000-0000-0000-0000-000000000001",
            "--isolated",
            "--isolated=dev",
            "--passive",
        ] {
            assert!(!is_main_command_line(&["Cindy.exe".into(), arg.into()]));
        }
    }
    #[test]
    fn kernel_command_line_is_readable_without_a_self_reported_role() {
        let arguments = process_arguments(unsafe {
            windows_sys::Win32::System::Threading::GetCurrentProcess()
        })
        .unwrap();
        assert!(!arguments.is_empty());
        assert!(Path::new(&arguments[0]).file_name().is_some());
        assert!(token_user_sid(
            token(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() })
                .unwrap()
                .0
        )
        .unwrap()
        .starts_with("S-1-"));
    }
    #[test]
    fn service_identity_permission_additions_are_query_only() {
        use windows_sys::Win32::System::Threading::*;
        fn interactive_mask(handle: HANDLE) -> u32 {
            let mut acl = ptr::null_mut();
            let mut sd = ptr::null_mut();
            assert_eq!(
                unsafe {
                    GetSecurityInfo(
                        handle,
                        SE_KERNEL_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        &mut acl,
                        ptr::null_mut(),
                        &mut sd,
                    )
                },
                ERROR_SUCCESS
            );
            assert!(!acl.is_null());
            let mut mask = 0;
            unsafe {
                let Some(parsed) = acl.cast::<ACL>().as_ref() else {
                    LocalFree(sd);
                    return 0;
                };
                for index in 0..parsed.AceCount as u32 {
                    let mut ace = ptr::null_mut();
                    if GetAce(acl, index, &mut ace) == 0 {
                        continue;
                    }
                    let Some(header) = ace.cast::<ACE_HEADER>().as_ref() else {
                        continue;
                    };
                    if header.AceType as u32 != ACCESS_ALLOWED_ACE_TYPE {
                        continue;
                    }
                    let Some(entry) = ace.cast::<ACCESS_ALLOWED_ACE>().as_ref() else {
                        continue;
                    };
                    if IsWellKnownSid(
                        (&entry.SidStart as *const u32).cast_mut().cast(),
                        WinInteractiveSid,
                    ) != 0
                    {
                        mask |= entry.Mask;
                    }
                }
                LocalFree(sd);
            }
            mask
        }
        // Changes only this disposable test process/token, not a service or any
        // installed application. Requires no administrator permission.
        let process = unsafe { GetCurrentProcess() };
        let mut raw = ptr::null_mut();
        assert_ne!(
            unsafe { OpenProcessToken(process, TOKEN_QUERY | READ_CONTROL, &mut raw) },
            0
        );
        let token = Handle::new(raw).unwrap();
        let before_process = interactive_mask(process);
        let before_token = interactive_mask(token.0);
        allow_service_identity_queries().unwrap();
        assert_eq!(
            interactive_mask(process),
            before_process | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        );
        assert_eq!(interactive_mask(token.0), before_token | TOKEN_QUERY);
    }
}
