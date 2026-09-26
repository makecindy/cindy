//! Explicit source-development trust boundary, compiled only for one checkout
//! and Electron executable. No workspace or node_modules ACL is modified.
//! As with Dev's debugger, code running in that developer runtime is trusted.
use crate::{installation, security, win::*};
use std::{
    mem,
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::*,
    System::{Diagnostics::Debug::ReadProcessMemory, Threading::*},
};

#[repr(C)]
#[derive(Clone, Copy)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct BasicInformation {
    reserved: usize,
    peb: *const PebPrefix,
    reserved2: [usize; 2],
    pid: usize,
    parent: usize,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct PebPrefix {
    reserved: [u8; 4],
    mutant: HANDLE,
    image: usize,
    loader: usize,
    parameters: *const ParametersPrefix,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct ParametersPrefix {
    maximum_length: u32,
    length: u32,
    flags: u32,
    debug_flags: u32,
    console: HANDLE,
    console_flags: u32,
    input: HANDLE,
    output: HANDLE,
    error: HANDLE,
    current_directory: UnicodeString,
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

fn read_memory<T: Copy>(process: HANDLE, address: *const T) -> Result<T> {
    let mut value = mem::MaybeUninit::<T>::uninit();
    let mut read = 0;
    if address.is_null()
        || unsafe {
            ReadProcessMemory(
                process,
                address.cast(),
                value.as_mut_ptr().cast(),
                mem::size_of::<T>(),
                &mut read,
            )
        } == 0
        || read != mem::size_of::<T>()
    {
        return denied();
    }
    Ok(unsafe { value.assume_init() })
}

fn process_directory(pid: u32) -> Result<PathBuf> {
    let process =
        Handle::new(unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) })?;
    let mut info: BasicInformation = unsafe { mem::zeroed() };
    let mut needed = 0;
    if unsafe {
        NtQueryInformationProcess(
            process.0,
            0,
            (&mut info as *mut BasicInformation).cast(),
            mem::size_of_val(&info) as u32,
            &mut needed,
        )
    } < 0
    {
        return denied();
    }
    let peb = read_memory(process.0, info.peb)?;
    let parameters = read_memory(process.0, peb.parameters)?;
    let directory = parameters.current_directory;
    if directory.buffer.is_null()
        || directory.length == 0
        || directory.length % 2 != 0
        || directory.length > directory.maximum_length
    {
        return denied();
    }
    let mut value = vec![0u16; directory.length as usize / 2];
    let mut read = 0;
    if unsafe {
        ReadProcessMemory(
            process.0,
            directory.buffer.cast(),
            value.as_mut_ptr().cast(),
            directory.length as usize,
            &mut read,
        )
    } == 0
        || read != directory.length as usize
    {
        return denied();
    }
    Ok(PathBuf::from(String::from_utf16_lossy(&value)))
}

fn isolation_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Human-direct Dev flags that electron-forge forwards into the kernel command
/// line (`pnpm dev:desktop -- --isolated`, `--isolated=<name>`, `--passive`).
/// Keep this list exact so Node/Electron injection switches stay denied.
fn is_supported_dev_argument(arg: &str) -> bool {
    matches!(arg, "--isolated" | "--passive" | "--endpoints-cdn")
        || arg
            .strip_prefix("--isolated=")
            .is_some_and(|name| name == "@worktree" || isolation_name(name))
}

pub fn check_client(
    pid: u32,
    image: &Path,
    application: &Path,
    arguments: &[String],
) -> Result<()> {
    let (expected_app, executable) = installation::development_identity().ok_or_else(error)?;
    if !security::same_file(image, &executable)
        || !security::same_file(application, &expected_app)
        || arguments.is_empty()
    {
        return denied();
    }
    let mut remaining = vec![arguments[0].clone()];
    let mut application_argument = None;
    for arg in arguments.iter().skip(1) {
        if is_supported_dev_argument(arg) {
            continue;
        }
        if application_argument.is_none() {
            if arg.starts_with('-') {
                return denied();
            }
            application_argument = Some(arg.clone());
            continue;
        }
        remaining.push(arg.clone());
    }
    let Some(application_argument) = application_argument else {
        return denied();
    };
    if !security::is_main_command_line(&remaining) {
        return denied();
    }
    let target = Path::new(&application_argument);
    let target = if target.is_absolute() {
        target.to_owned()
    } else {
        process_directory(pid)?.join(target)
    };
    if !security::same_file(&target, &expected_app) {
        return denied();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_electron_entry_is_resolved_from_the_real_process_directory() {
        let directory = process_directory(std::process::id()).unwrap();
        assert_eq!(
            directory.canonicalize().unwrap(),
            std::env::current_dir().unwrap().canonicalize().unwrap()
        );
        let (app, executable) = installation::development_identity().unwrap();
        assert!(check_client(
            std::process::id(),
            &executable,
            &app,
            &["electron.exe".into(), "--type=utility".into()]
        )
        .is_err());
        assert!(check_client(
            std::process::id(),
            &executable,
            &app,
            &[
                "electron.exe".into(),
                app.to_string_lossy().into_owned(),
                "--type=renderer".into()
            ]
        )
        .is_err());
        assert!(check_client(
            std::process::id(),
            &executable,
            &app,
            &["electron.exe".into(), app.to_string_lossy().into_owned()]
        )
        .is_ok());
        assert!(check_client(
            std::process::id(),
            &executable,
            &app,
            &[
                "electron.exe".into(),
                std::env::temp_dir().to_string_lossy().into_owned()
            ]
        )
        .is_err());
    }
    #[test]
    fn supported_dev_launch_arguments_are_accepted_without_opening_injection_switches() {
        let (app, executable) = installation::development_identity().unwrap();
        let pid = std::process::id();
        let path = app.to_string_lossy().into_owned();
        for extra in [
            vec!["--isolated"],
            vec!["--isolated=dev"],
            vec!["--isolated=@worktree"],
            vec!["--passive"],
            vec!["--endpoints-cdn"],
            vec!["--isolated=feature-a", "--passive"],
        ] {
            let mut after = vec!["electron.exe".into(), path.clone()];
            after.extend(extra.iter().map(|arg| (*arg).to_string()));
            assert!(
                check_client(pid, &executable, &app, &after).is_ok(),
                "{after:?}"
            );
            let mut before = vec!["electron.exe".into()];
            before.extend(extra.iter().map(|arg| (*arg).to_string()));
            before.push(path.clone());
            assert!(
                check_client(pid, &executable, &app, &before).is_ok(),
                "{before:?}"
            );
        }
        assert!(check_client(
            pid,
            &executable,
            &app,
            &["electron.exe".into(), "--isolated".into()]
        )
        .is_err());
        assert!(check_client(
            pid,
            &executable,
            &app,
            &[
                "electron.exe".into(),
                path.clone(),
                "--isolated=我的沙箱".into()
            ]
        )
        .is_err());
        assert!(check_client(
            pid,
            &executable,
            &app,
            &[
                "electron.exe".into(),
                path.clone(),
                "--isolated".into(),
                "--inspect".into()
            ]
        )
        .is_err());
        assert!(check_client(
            pid,
            &executable,
            &app,
            &[
                "electron.exe".into(),
                "--isolated".into(),
                "--type=utility".into(),
                path
            ]
        )
        .is_err());
    }
}
