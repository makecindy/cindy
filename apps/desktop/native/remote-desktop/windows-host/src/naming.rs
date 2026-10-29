//! Names and locations derived from the Cindy installation that asked for
//! lock-screen control.
//!
//! The SYSTEM service runs from a copy in a protected directory rather than
//! from the installation, which may sit somewhere the current user can write.
//! Its own path therefore cannot be the shared identity. Every participant —
//! the copy inside the installation, the staged copy, and the Main-only
//! library — derives the same identity from the installation directory
//! instead, so none of them has to be told where the others are.
#![allow(dead_code)]
use crate::win::*;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::ptr;
use windows_sys::Win32::{System::Com::CoTaskMemFree, UI::Shell::*};

pub const HOST_EXE: &str = "cindy-windows-desktop-host.exe";
pub const INPUT_EXE: &str = "cindy-windows-desktop-input.exe";
/// A copy used only as the elevated setup bootstrap. It is never registered
/// as the service image and is removed with the staging directory.
pub const BOOTSTRAP_EXE: &str = "cindy-windows-desktop-bootstrap.exe";
/// Records which installation this staged copy serves. It lives in the
/// protected directory, so the service reads an administrator-written value
/// rather than trusting a path handed to it over the pipe.
pub const INSTALL_RECORD: &str = "install.txt";
/// One subdirectory per installation lives under this Program Files folder.
pub const STAGING_ROOT: &str = "Cindy Remote Desktop";

/// The installation directory a bundled helper belongs to. The helper ships at
/// `<install>/resources/tools/remote-desktop/<exe>`.
pub fn install_of(bundled_exe: &Path) -> Option<&Path> {
    bundled_exe
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
}

/// A stable id for one installation. Two installations — Cindy and CindyDev,
/// or two copies of the same edition — never share a service, a pipe or a
/// staged executable.
pub fn install_id(install: &Path) -> String {
    let path = install.to_string_lossy().to_lowercase();
    format!("{:x}", Sha256::digest(path.as_bytes()))[..32].to_string()
}

pub fn service_name(id: &str) -> String {
    format!("CindyRemoteDesktop-{id}")
}

pub fn pipe_name(service: &str) -> String {
    format!(r"\\.\pipe\{service}")
}

/// Where this installation's staged copy of the helpers lives.
pub fn staged_dir(program_files: &Path, id: &str) -> PathBuf {
    program_files.join(STAGING_ROOT).join(id)
}

/// The machine's Program Files directory — the only place this host accepts a
/// SYSTEM service executable from.
pub fn program_files() -> Staged<PathBuf> {
    let mut raw = ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramFiles, 0, ptr::null_mut(), &mut raw) } < 0
        || raw.is_null()
    {
        return refuse(Step::ProtectedRoot);
    }
    Ok(unsafe {
        let mut len = 0;
        while *raw.add(len) != 0 {
            len += 1;
        }
        let result = PathBuf::from(String::from_utf16_lossy(std::slice::from_raw_parts(
            raw, len,
        )));
        CoTaskMemFree(raw.cast());
        result
    })
}

/// Everything a helper inside the installation needs to address its own
/// staged copy.
pub struct Installation {
    pub install: PathBuf,
    pub id: String,
    pub staged: PathBuf,
    pub development: bool,
}

impl Installation {
    /// Derived by a helper running from inside the installation.
    ///
    /// The path is canonicalized first: the service, the setup command and the
    /// Main-only library each arrive here with a path of their own, and they
    /// have to agree on one id or they address different services.
    pub fn of_bundled(bundled_exe: &Path) -> Staged<Self> {
        let program_files = program_files()?;
        let bundled = bundled_exe.canonicalize().stage(Step::ProtectedOpen)?;
        let install = install_of(&bundled).ok_or(Failure::new(Step::ProtectedRoot, 0))?;
        let id = install_id(install);
        Ok(Self {
            staged: staged_dir(&program_files, &id),
            install: install.to_owned(),
            id,
            development: false,
        })
    }
    pub fn for_development(mut self) -> Self {
        self.development = true;
        self
    }
    pub fn service(&self) -> String {
        service_name(&self.id)
    }
    pub fn pipe(&self) -> String {
        pipe_name(&self.service())
    }
    pub fn host(&self) -> PathBuf {
        self.staged.join(HOST_EXE)
    }
    pub fn bootstrap(&self) -> PathBuf {
        self.staged.join(BOOTSTRAP_EXE)
    }
}

/// What the staged copy can work out about itself from its own location,
/// before anything has been verified. The service manager starts it by path,
/// so its directory is the staging directory and that directory's name is the
/// installation id.
pub struct StagedCopy {
    pub dir: PathBuf,
    pub id: String,
}

#[derive(Clone)]
pub struct InstallRecord {
    pub path: PathBuf,
    pub development: bool,
}

impl StagedCopy {
    pub fn of(staged_exe: &Path) -> Staged<Self> {
        let dir = staged_exe
            .parent()
            .ok_or(Failure::new(Step::ProtectedRoot, 0))?
            .to_owned();
        let id = dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| {
                name.len() == 32
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or(Failure::new(Step::ProtectedRoot, 0))?;
        Ok(Self { dir, id })
    }
    pub fn service(&self) -> String {
        service_name(&self.id)
    }
    pub fn pipe(&self) -> String {
        pipe_name(&self.service())
    }
    /// The installation this copy serves. Read only after the directory has
    /// been proven writable by administrators alone, since the answer decides
    /// which process may drive the service.
    pub fn install(&self) -> Staged<InstallRecord> {
        let record =
            std::fs::read_to_string(self.dir.join(INSTALL_RECORD)).stage(Step::StageRecord)?;
        let mut lines = record.lines();
        let install = PathBuf::from(lines.next().unwrap_or_default().trim());
        let development = match lines.next().map(str::trim) {
            None | Some("") => false,
            Some("development") => true,
            Some(_) => return refuse(Step::StageRecord),
        };
        if lines.next().is_some() {
            return refuse(Step::StageRecord);
        }
        // The directory name is the hash of the installation path, so a record
        // naming a different installation cannot redirect this service.
        if !install.is_absolute() || install_id(&install) != self.id {
            return refuse(Step::StageRecord);
        }
        Ok(InstallRecord {
            path: install,
            development,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The service name is agreed on by three processes that each know a
    /// different path: the helper inside the installation, the staged copy the
    /// service manager starts, and the Node-API library in Cindy's main
    /// process. If these two derivations ever disagree, the setup command and
    /// the service it just installed address different pipes, and every
    /// connection fails with an identity error that names nothing useful.
    #[test]
    fn staged_copy_and_installation_agree_on_one_service_name() {
        let install = Path::new(r"C:\Users\someone\AppData\Local\Programs\Cindy");
        let id = install_id(install);
        let staged = staged_dir(Path::new(r"C:\Program Files"), &id);
        let copy = StagedCopy::of(&staged.join(HOST_EXE)).expect("staged layout is recognized");
        assert_eq!(copy.id, id);
        assert_eq!(copy.service(), service_name(&id));
        assert_eq!(copy.dir, staged);
    }

    #[test]
    fn installation_id_ignores_path_case_but_separates_installations() {
        let lower = install_id(Path::new(r"c:\program files\cindy"));
        let upper = install_id(Path::new(r"C:\Program Files\Cindy"));
        assert_eq!(
            lower, upper,
            "Windows paths differing only in case are one installation"
        );
        assert_ne!(
            upper,
            install_id(Path::new(r"C:\Program Files\CindyDev")),
            "separate installations must not share a service"
        );
        assert_eq!(upper.len(), 32);
    }

    /// The directory name becomes a service name and a pipe name, so a copy
    /// sitting somewhere unexpected must be refused rather than used to build
    /// those names out of arbitrary text.
    #[test]
    fn staged_copy_refuses_a_directory_that_is_not_an_installation_id() {
        for directory in [
            r"C:\Program Files\Cindy Remote Desktop\not-a-hash",
            r"C:\Program Files\Cindy Remote Desktop\ABCDEF0123456789abcdef0123456789",
            r"C:\Program Files\Cindy Remote Desktop\abc",
        ] {
            assert!(
                StagedCopy::of(&Path::new(directory).join(HOST_EXE)).is_err(),
                "{directory} should not be accepted as a staged copy"
            );
        }
    }

    #[test]
    fn installation_directory_is_found_above_the_bundled_helper() {
        let install = Path::new(r"C:\Program Files\Cindy");
        let bundled = install
            .join("resources")
            .join("tools")
            .join("remote-desktop")
            .join(HOST_EXE);
        assert_eq!(install_of(&bundled), Some(install));
    }
}
