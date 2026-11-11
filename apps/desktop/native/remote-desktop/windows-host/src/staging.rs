//! Places the SYSTEM service's executables in a protected directory.
//!
//! Cindy installs per user by default, so its own directory is writable by the
//! account that installed it. A service started from there would let any
//! ordinary process on the machine replace a SYSTEM executable — permanently,
//! and without a prompt. Running the installer from Program Files is one way
//! to avoid that, but it makes every update ask for an administrator, so this
//! module takes the other route: while the user is already confirming the
//! administrator prompt for setup, copy the two helpers into a directory under
//! Program Files that only administrators and SYSTEM can write, and point the
//! service at that copy.
//!
//! What this does and does not protect:
//!
//! * It removes the standing risk. After setup, no ordinary process can reach
//!   the executable the service starts, so there is no unprompted path to
//!   SYSTEM.
//! * Packaged setup additionally checks that the host and input helpers carry
//!   the same valid Authenticode signer as the running Cindy executable before
//!   the elevated copy is made. Source-mode setup deliberately uses a separate
//!   development trust boundary: an unsigned Electron runtime and its locally
//!   built helpers are accepted only when the explicit development flag is
//!   present.
use crate::naming::*;
use crate::security;
use crate::win::*;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::os::windows::io::FromRawHandle;
use std::path::{Path, PathBuf};
use std::{mem, ptr};
use windows_sys::Win32::{
    Foundation::*, Security::Authorization::*, Security::*, Storage::FileSystem::*,
};

/// Owned by Administrators, written only by Administrators and SYSTEM, read
/// and executed by everyone. `P` blocks inheritance from Program Files, and
/// an explicit owner matters as much as the entries: an owner can always
/// rewrite the entries, so leaving the installing account as owner would hand
/// that account unprompted write access to a SYSTEM executable.
const DIRECTORY_RIGHTS: &str = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)";
const FILE_RIGHTS: &str = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;BU)";
/// Refuse anything far larger than the helpers, rather than reading without a
/// limit from a directory the current user can write.
const MAX_HELPER_BYTES: u64 = 64 * 1024 * 1024;

/// A security descriptor built from SDDL, freed when it goes out of scope.
struct Descriptor(PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
impl Descriptor {
    fn parse(sddl: &str) -> Staged<Self> {
        let mut raw = ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(sddl).as_ptr(),
                1,
                &mut raw,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(Failure::new(Step::StagePrepare, last_error()));
        }
        Ok(Self(raw))
    }
    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
    /// Applies this descriptor to an existing path, replacing whatever owner
    /// and entries it had. Only used on the staging directory itself, which
    /// this feature creates and owns.
    fn apply(&self, path: &Path) -> Staged<()> {
        let mut owner = ptr::null_mut();
        let mut defaulted = 0;
        let mut acl = ptr::null_mut();
        let mut present = 0;
        if unsafe { GetSecurityDescriptorOwner(self.0, &mut owner, &mut defaulted) } == 0
            || unsafe { GetSecurityDescriptorDacl(self.0, &mut present, &mut acl, &mut defaulted) }
                == 0
            || present == 0
        {
            return Err(Failure::new(Step::StagePrepare, last_error()));
        }
        let code = unsafe {
            SetNamedSecurityInfoW(
                wide(&path.to_string_lossy()).as_ptr().cast_mut(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION
                    | DACL_SECURITY_INFORMATION
                    | PROTECTED_DACL_SECURITY_INFORMATION,
                owner,
                ptr::null_mut(),
                acl,
                ptr::null_mut(),
            )
        };
        if code != ERROR_SUCCESS {
            return Err(Failure::new(Step::StagePrepare, code as i32));
        }
        Ok(())
    }
}

fn last_error() -> i32 {
    unsafe { GetLastError() as i32 }
}

/// Reads a helper from the installation while denying every other writer.
/// Holding the handle across the read means the bytes that land in the
/// protected copy are the bytes that were checked, not a replacement swapped
/// in afterwards.
fn read_exclusively(path: &Path) -> Staged<Vec<u8>> {
    let handle = Handle::new(unsafe {
        CreateFileW(
            wide(&path.to_string_lossy()).as_ptr(),
            FILE_GENERIC_READ,
            FILE_SHARE_READ,
            ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    })
    .stage(Step::StageRead)?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(Failure::new(Step::StageRead, last_error()));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return refuse(Step::StageRead);
    }
    let mut file = unsafe { std::fs::File::from_raw_handle(handle.0.cast()) };
    mem::forget(handle);
    let length = file.metadata().stage(Step::StageRead)?.len();
    if length == 0 || length > MAX_HELPER_BYTES {
        return refuse(Step::StageRead);
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.read_to_end(&mut bytes).stage(Step::StageRead)?;
    if bytes.len() as u64 != length {
        return refuse(Step::StageRead);
    }
    Ok(bytes)
}

/// Writes `bytes` to a file created with the fixed descriptor above. The old
/// file is removed first: Windows ignores the descriptor supplied to an open
/// of an existing file, so reusing one would silently keep its old owner.
fn write_protected(path: &Path, bytes: &[u8], rights: &Descriptor) -> Staged<()> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(Failure::new(
                Step::StageWrite,
                e.raw_os_error().unwrap_or(0),
            ))
        }
    }
    let attributes = rights.attributes();
    let handle = Handle::new(unsafe {
        CreateFileW(
            wide(&path.to_string_lossy()).as_ptr(),
            FILE_GENERIC_WRITE,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    })
    .stage(Step::StageWrite)?;
    let mut file = unsafe { std::fs::File::from_raw_handle(handle.0.cast()) };
    mem::forget(handle);
    file.write_all(bytes).stage(Step::StageWrite)?;
    file.sync_all().stage(Step::StageWrite)
}

/// Copies this installation's helpers into its protected directory and returns
/// the staged host executable. Runs in the elevated setup child, with the
/// service already stopped so the files it uses can be replaced.
pub fn stage(installation: &Installation) -> Staged<PathBuf> {
    let bundled = std::env::current_exe().stage(Step::StageRead)?;
    stage_from(installation, &bundled)
}

/// Stages an installation while running from the protected setup bootstrap.
/// The bootstrap itself is already in Program Files, so the helper from the
/// user-writable installation is treated strictly as input bytes.
pub fn stage_from(installation: &Installation, bundled: &Path) -> Staged<PathBuf> {
    stage_from_verified(installation, bundled, None, None)
}

/// Stages helpers after the unelevated launcher has measured both source
/// files. The elevated child re-reads them through non-reparse handles and
/// compares those bytes before anything reaches the SYSTEM service.
pub fn stage_from_verified(
    installation: &Installation,
    bundled: &Path,
    expected_host_hash: Option<&str>,
    expected_input_hash: Option<&str>,
) -> Staged<PathBuf> {
    let host = read_exclusively(bundled)?;
    let input = read_exclusively(&bundled.with_file_name(INPUT_EXE))?;
    if expected_host_hash.is_some_and(|expected| {
        !format!("{:x}", Sha256::digest(&host)).eq_ignore_ascii_case(expected)
    }) || expected_input_hash.is_some_and(|expected| {
        !format!("{:x}", Sha256::digest(&input)).eq_ignore_ascii_case(expected)
    }) {
        return refuse(Step::StageRead);
    }

    let directory_rights = Descriptor::parse(DIRECTORY_RIGHTS)?;
    let attributes = directory_rights.attributes();
    for directory in [
        installation.staged.parent().unwrap_or(&installation.staged),
        &installation.staged,
    ] {
        if unsafe { CreateDirectoryW(wide(&directory.to_string_lossy()).as_ptr(), &attributes) }
            == 0
        {
            let code = unsafe { GetLastError() };
            if code != ERROR_ALREADY_EXISTS {
                return Err(Failure::new(Step::StagePrepare, code as i32));
            }
            // A directory that already exists kept the descriptor it was
            // created with. Reassert ours rather than inheriting whatever an
            // earlier version, or a repaired Program Files, left behind.
            directory_rights.apply(directory)?;
        }
    }

    let file_rights = Descriptor::parse(FILE_RIGHTS)?;
    write_protected(&installation.host(), &host, &file_rights)?;
    write_protected(&installation.staged.join(INPUT_EXE), &input, &file_rights)?;
    write_protected(
        &installation.staged.join(INSTALL_RECORD),
        format!(
            "{}{}",
            installation.install.to_string_lossy(),
            if installation.development {
                "\ndevelopment"
            } else {
                ""
            }
        )
        .as_bytes(),
        &file_rights,
    )?;

    // Prove the result before anything is registered with the service manager.
    drop(security::protected_staging(&installation.staged)?);
    Ok(installation.host())
}

/// Removes a staged copy. Leaving a few megabytes behind is better than
/// refusing to finish a removal, so a file that will not go is reported but
/// does not abort the rest.
pub fn unstage(installation: &Installation) -> Staged<()> {
    match std::fs::remove_dir_all(&installation.staged) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(Failure::new(
                Step::StageRemove,
                e.raw_os_error().unwrap_or(0),
            ))
        }
    }
    // Take the shared folder with it once the last installation has gone.
    // Plain `remove_dir` fails while another installation still has a copy
    // there, which is exactly the wanted behaviour.
    if let Some(root) = installation.staged.parent() {
        let _ = std::fs::remove_dir(root);
    }
    Ok(())
}
