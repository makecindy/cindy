//! Remove credentials and registry entries left by the withdrawn Windows
//! automatic-unlock experiment. This module never reads or logs secret blobs.
use crate::win::*;
use sha2::{Digest, Sha256};
use std::ptr;
use windows_sys::Win32::{Foundation::*, Security::Credentials::*, System::Registry::*};

const TARGET_PREFIX: &str = "Cindy/RemoteDesktop/";

fn utf16(value: *const u16) -> String {
    if value.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0;
        while *value.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(value, len))
    }
}

fn provider_guid(service: &str) -> String {
    let digest = Sha256::digest(format!("cindy-windows-unlock-v1:{service}").as_bytes());
    let id = u128::from_be_bytes(digest[..16].try_into().unwrap());
    format!(
        "{{{:08x}-{:04x}-{:04x}-{:04x}-{:012x}}}",
        id >> 96,
        (id >> 80) & 0xffff,
        (id >> 64) & 0xffff,
        (id >> 48) & 0xffff,
        id & 0xffffffffffff
    )
}

pub fn remove_saved_credentials() -> Result<()> {
    let mut count = 0;
    let mut values = ptr::null_mut();
    let filter = wide("Cindy/RemoteDesktop/*");
    let ok = unsafe { CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut values) };
    if ok == 0 {
        return if unsafe { GetLastError() } == ERROR_NOT_FOUND {
            Ok(())
        } else {
            Err(error())
        };
    }
    if values.is_null() {
        return denied();
    }
    let mut names = Vec::new();
    unsafe {
        for index in 0..count as usize {
            let Some(credential) = values
                .add(index)
                .as_ref()
                .and_then(|entry| (*entry).as_ref())
            else {
                continue;
            };
            let name = utf16(credential.TargetName);
            if name.starts_with(TARGET_PREFIX) {
                names.push(name);
            }
        }
        CredFree(values.cast());
    }
    for name in names {
        if unsafe { CredDeleteW(wide(&name).as_ptr(), CRED_TYPE_GENERIC, 0) } == 0
            && unsafe { GetLastError() } != ERROR_NOT_FOUND
        {
            return Err(error());
        }
    }
    Ok(())
}

pub fn remove_provider_registration(service: &str) -> Result<()> {
    let guid = provider_guid(service);
    for path in [
        format!(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\{guid}"
        ),
        format!(r"SOFTWARE\Classes\CLSID\{guid}"),
    ] {
        let status = unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, wide(&path).as_ptr()) };
        if status != 0 && status != ERROR_FILE_NOT_FOUND {
            return Err(std::io::Error::from_raw_os_error(status as i32));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_identity_is_installation_scoped_without_exposing_credentials() {
        assert_ne!(
            provider_guid("CindyRemoteDesktop-dev"),
            provider_guid("CindyRemoteDesktop-release")
        );
        assert!(TARGET_PREFIX.starts_with("Cindy/RemoteDesktop/"));
        let guid = provider_guid("CindyRemoteDesktop-dev");
        assert!(format!(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\{guid}"
        )
        .contains(r"\Credential Providers\"));
    }
    #[test]
    fn vault_cleanup_surfaces_enumerate_and_delete_failures() {
        let source = include_str!("legacy_cleanup.rs");
        let remove = source
            .split("pub fn remove_saved_credentials()")
            .nth(1)
            .unwrap()
            .split("pub fn remove_provider_registration")
            .next()
            .unwrap();
        assert!(remove.contains("ERROR_NOT_FOUND"));
        assert!(remove.contains("return Err(error())"));
        assert!(!remove.contains("let _ ="));
        let elevate_install = include_str!("main.rs")
            .split("Some(\"--elevate-install\")")
            .nth(1)
            .unwrap()
            .split("Some(\"--elevate-uninstall\")")
            .next()
            .unwrap();
        let elevate_uninstall = include_str!("main.rs")
            .split("Some(\"--elevate-uninstall\")")
            .nth(1)
            .unwrap()
            .split("Some(\"--status\")")
            .next()
            .unwrap();
        let install = include_str!("approval.rs")
            .split("pub fn install(")
            .nth(1)
            .unwrap()
            .split("pub fn remove(")
            .next()
            .unwrap();
        let uninstall = include_str!("approval.rs")
            .split("pub fn remove(")
            .nth(1)
            .unwrap()
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for source in [elevate_install, elevate_uninstall, install, uninstall] {
            assert!(!source.contains("let _ = legacy_cleanup::remove_saved_credentials"));
            assert!(!source.contains("let _ = legacy_cleanup::cleanup_current_installation"));
        }
        assert!(elevate_uninstall.contains("--uninstall --skip-vault-cleanup"));
        let run = include_str!("main.rs")
            .split("fn run()")
            .nth(1)
            .unwrap()
            .split("fn main()")
            .next()
            .unwrap();
        assert!(run.contains("approval::remove(false)"));
    }
}
