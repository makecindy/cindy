//! Atomically replace one Windows directory entry with another.
//!
//! Node's rename cannot replace an existing directory junction. FileRenameInfoEx
//! with POSIX semantics publishes the replacement in one filesystem operation:
//! old handles stay valid and every later open sees the new entry.

#![cfg(windows)]

use std::{
    env,
    ffi::c_void,
    io,
    mem::{align_of, size_of},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr,
};

type Handle = *mut c_void;

#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        file_name: *const u16,
        desired_access: u32,
        share_mode: u32,
        security_attributes: *mut c_void,
        creation_disposition: u32,
        flags_and_attributes: u32,
        template_file: Handle,
    ) -> Handle;
    fn SetFileInformationByHandle(
        file: Handle,
        information_class: i32,
        information: *const c_void,
        buffer_size: u32,
    ) -> i32;
    fn CloseHandle(object: Handle) -> i32;
}

const DELETE: u32 = 0x0001_0000;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const FILE_SHARE_DELETE: u32 = 0x0000_0004;
const OPEN_EXISTING: u32 = 3;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_RENAME_INFO_EX: i32 = 22;
const FILE_RENAME_REPLACE_IF_EXISTS: u32 = 0x0000_0001;
const FILE_RENAME_POSIX_SEMANTICS: u32 = 0x0000_0002;

struct OwnedHandle(Handle);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn align_up(value: usize, alignment: usize) -> usize {
    (value + alignment - 1) & !(alignment - 1)
}

fn wide_null(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn absolute_same_parent(source: &Path, destination: &Path) -> io::Result<()> {
    if !source.is_absolute() || !destination.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "paths must be absolute",
        ));
    }
    if source == destination || source.parent() != destination.parent() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "source and destination must be distinct siblings",
        ));
    }
    Ok(())
}

fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    absolute_same_parent(source, destination)?;
    let source_wide = wide_null(source);
    let handle = unsafe {
        CreateFileW(
            source_wide.as_ptr(),
            DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        )
    };
    if handle as isize == -1 {
        return Err(io::Error::last_os_error());
    }
    let _handle = OwnedHandle(handle);

    let destination_wide: Vec<u16> = destination.as_os_str().encode_wide().collect();
    let root_offset = align_up(size_of::<u32>(), align_of::<Handle>());
    let length_offset = root_offset + size_of::<Handle>();
    let name_offset = length_offset + size_of::<u32>();
    let name_bytes = destination_wide
        .len()
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "destination path is too long")
        })?;
    let buffer_size = name_offset
        .checked_add(name_bytes)
        // SetFileInformationByHandle converts absolute DOS paths using a
        // NUL-terminated string. FileNameLength still excludes this terminator.
        .and_then(|length| length.checked_add(size_of::<u16>()))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "rename buffer is too large"))?;
    let buffer_size_u32 = u32::try_from(buffer_size)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "rename buffer is too large"))?;
    let name_bytes_u32 = u32::try_from(name_bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "destination path is too long"))?;

    let mut buffer = vec![0u8; buffer_size];
    buffer[..4].copy_from_slice(
        &(FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS).to_ne_bytes(),
    );
    buffer[length_offset..length_offset + 4].copy_from_slice(&name_bytes_u32.to_ne_bytes());
    for (index, code_unit) in destination_wide.iter().enumerate() {
        let offset = name_offset + index * 2;
        buffer[offset..offset + 2].copy_from_slice(&code_unit.to_ne_bytes());
    }

    let succeeded = unsafe {
        SetFileInformationByHandle(
            handle,
            FILE_RENAME_INFO_EX,
            buffer.as_ptr().cast(),
            buffer_size_u32,
        )
    };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn main() {
    let mut args = env::args_os().skip(1);
    let source = args.next().map(PathBuf::from);
    let destination = args.next().map(PathBuf::from);
    if source.is_none() || destination.is_none() || args.next().is_some() {
        eprintln!("usage: cindy-windows-atomic-rename <source> <destination>");
        std::process::exit(2);
    }
    if let Err(error) = atomic_replace(&source.unwrap(), &destination.unwrap()) {
        eprintln!("atomic directory entry replacement failed: {error}");
        std::process::exit(1);
    }
}
