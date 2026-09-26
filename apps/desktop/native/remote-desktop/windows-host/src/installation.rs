//! The privileged service lives independently of the user's chosen app directory.
//! One installation keeps the legacy service name, so upgrading cannot leave a
//! second privileged broker behind. Nothing is selected from environment variables.
use crate::win::*;
use sha2::{Digest, Sha256};
use std::{
    path::{Component, Path, PathBuf, Prefix},
    ptr,
};
use windows_sys::{
    core::GUID,
    Win32::{System::Com::CoTaskMemFree, UI::Shell::*},
};

pub const HOST: &str = "cindy-windows-desktop-host.exe";
pub const INPUT: &str = "cindy-windows-desktop-input.exe";
pub const APPROVAL: &str = "authorization.json";
pub const ACL_RESTORE: &str = "acl-restore.json";

pub fn development_identity() -> Option<(PathBuf, PathBuf)> {
    #[cfg(feature = "development")]
    return Some((
        PathBuf::from(env!("CINDY_DESKTOP_DEV_APP")),
        PathBuf::from(env!("CINDY_DESKTOP_DEV_EXECUTABLE")),
    ));
    #[cfg(not(feature = "development"))]
    None
}

pub fn approval_service_name(source: &Path) -> String {
    if let Some((application, _)) = development_identity() {
        let mut digest = Sha256::new();
        digest.update(b"development\0");
        digest.update(application.to_string_lossy().to_lowercase().as_bytes());
        return format!("CindyRemoteDesktop-{:x}", digest.finalize())[..35].to_owned();
    }
    name_for_source(source)
}

pub struct Installation {
    pub name: String,
    pub directory: PathBuf,
}

fn known_folder(folder: &GUID) -> Result<PathBuf> {
    let mut raw = ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(folder, 0, ptr::null_mut(), &mut raw) } < 0 || raw.is_null() {
        return denied();
    }
    let root = unsafe {
        let mut length = 0;
        while *raw.add(length) != 0 {
            length += 1;
        }
        let root = PathBuf::from(String::from_utf16_lossy(std::slice::from_raw_parts(
            raw, length,
        )));
        CoTaskMemFree(raw.cast());
        root
    };
    Ok(root)
}
pub fn program_files() -> Result<PathBuf> {
    known_folder(&FOLDERID_ProgramFiles)
}

pub fn name_for_source(path: &Path) -> String {
    format!(
        "CindyRemoteDesktop-{:x}",
        Sha256::digest(path.to_string_lossy().to_lowercase().as_bytes())
    )[..35]
        .to_owned()
}

impl Installation {
    pub fn for_source(source: &Path) -> Result<Self> {
        let name = approval_service_name(&source.canonicalize()?);
        Ok(Self {
            directory: program_files()?.join("CindyRemoteDesktop").join(&name),
            name,
        })
    }
    pub fn current() -> Result<Self> {
        let executable = std::env::current_exe()?.canonicalize()?;
        let base = program_files()?.join("CindyRemoteDesktop");
        // Only the fixed two-level installed layout can supply its own identity.
        if let Some(directory) = executable.parent() {
            if directory.parent().is_some_and(|parent| {
                parent.canonicalize().ok() == base.canonicalize().ok() && base.exists()
            }) {
                let name = directory
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(error)?;
                if name.len() == 35
                    && name.starts_with("CindyRemoteDesktop-")
                    && name[19..].bytes().all(|b| b.is_ascii_hexdigit())
                    && executable
                        .file_name()
                        .is_some_and(|n| n.eq_ignore_ascii_case(HOST))
                {
                    return Ok(Self {
                        name: name.to_owned(),
                        directory: directory.to_owned(),
                    });
                }
                return denied();
            }
        }
        Self::for_source(&executable)
    }
    pub fn binary(&self) -> PathBuf {
        self.directory.join(HOST)
    }
    pub fn pipe(&self) -> String {
        format!(r"\\.\pipe\{}", self.name)
    }
    pub fn payload_is_current(&self, source: &Path) -> Result<bool> {
        for name in [HOST, INPUT] {
            let expected = std::fs::read(source.with_file_name(name))?;
            let installed = std::fs::read(self.directory.join(name))?;
            if Sha256::digest(&expected) != Sha256::digest(&installed) {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// Durable leftover after a failed update or helper crash: the Program Files
/// directory still has authorization/restore/payload even if SCM is gone.
/// Uses the current helper identity so a Program Files copy is not re-hashed.
pub fn leftover_installation() -> Result<bool> {
    let installation = Installation::current()?;
    if !installation.directory.is_dir() {
        return Ok(false);
    }
    for name in [APPROVAL, ACL_RESTORE, HOST, INPUT] {
        if installation.directory.join(name).exists() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn package_root(binary: &Path) -> Result<PathBuf> {
    let root = binary
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(error)?;
    if binary
        != root
            .join("resources")
            .join("tools")
            .join("remote-desktop")
            .join(HOST)
    {
        return denied();
    }
    Ok(root.to_owned())
}

pub fn is_local_application_path(path: &Path) -> bool {
    path.is_absolute()
        && matches!(path.components().next(), Some(Component::Prefix(prefix))
        if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
}

pub fn validate_application_directory(root: &Path) -> Result<()> {
    let canonical = root.canonicalize()?;
    // A root/shared system or profile folder must never become an application
    // protection boundary, even if somebody puts a Cindy executable in it.
    if !is_local_application_path(&canonical)
        || canonical.parent().is_none()
        || canonical.join(".git").exists()
    {
        return denied();
    }
    let profiles = known_folder(&FOLDERID_UserProfiles)?.canonicalize()?;
    if canonical.parent() == Some(profiles.as_path()) {
        return denied();
    }
    for folder in [
        &FOLDERID_ProgramFiles,
        &FOLDERID_ProgramFilesX86,
        &FOLDERID_Windows,
        &FOLDERID_System,
        &FOLDERID_Profile,
        &FOLDERID_Desktop,
        &FOLDERID_Documents,
        &FOLDERID_Downloads,
        &FOLDERID_LocalAppData,
        &FOLDERID_RoamingAppData,
        &FOLDERID_UserProfiles,
    ] {
        if known_folder(folder)
            .and_then(|p| p.canonicalize())
            .is_ok_and(|path| path == canonical)
        {
            return denied();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_identity_is_stable_case_insensitively_and_install_scoped() {
        assert_eq!(
            name_for_source(Path::new(r"D:\Apps\Cindy\host.exe")),
            name_for_source(Path::new(r"d:\apps\cindy\HOST.EXE"))
        );
        assert_ne!(
            name_for_source(Path::new(r"D:\Apps\Cindy\host.exe")),
            name_for_source(Path::new(r"D:\Apps\CindyDev\host.exe"))
        );
    }
    #[test]
    fn source_layout_cannot_escape_the_packaged_app() {
        let root = Path::new(r"D:\Custom Apps\Cindy");
        let binary = root
            .join("resources")
            .join("tools")
            .join("remote-desktop")
            .join(HOST);
        assert_eq!(package_root(&binary).unwrap(), root);
        assert!(package_root(&root.join(HOST)).is_err());
    }
    #[test]
    fn leftover_installation_looks_at_the_protected_directory_not_scm() {
        let source = include_str!("installation.rs");
        assert!(source.contains("pub fn leftover_installation"));
        assert!(source.contains("APPROVAL"));
        assert!(source.contains("ACL_RESTORE"));
        let status = include_str!("main.rs")
            .split("Some(\"--status\")")
            .nth(1)
            .unwrap();
        assert!(status.contains("leftover_installation"));
        assert!(
            status.find("leftover_installation").unwrap() < status.find("\"missing\"").unwrap()
        );
    }
}
