//! UAC-approved installation identity. No password, bearer token, or PID is
//! persisted. Each new Main process is checked against protected application
//! code and the originally approved Windows user, including after service restart.
use crate::{
    installation::{self, Installation},
    legacy_cleanup, security,
    win::*,
};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
};

pub struct Approval {
    pub application: PathBuf,
    pub user_sid: String,
    pub executable: String,
    pub service: String,
}
impl Approval {
    pub fn for_client(pid: u32) -> Result<(Self, Handle)> {
        let source = std::env::current_exe()?.canonicalize()?;
        let development = installation::development_identity();
        let application = if let Some((application, _)) = &development {
            if !installation::is_local_application_path(application) {
                return denied();
            }
            application.clone()
        } else {
            let root = installation::package_root(&source)?;
            installation::validate_application_directory(&root)?;
            root
        };
        let (client, _) = security::authorize_client(pid, &application, None)?;
        let executable = if let Some((_, executable)) = development {
            executable.to_string_lossy().into_owned()
        } else {
            image(client.0)?
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(error)?
                .to_owned()
        };
        let user_sid = security::token_user_sid(token(client.0)?.0)?;
        Ok((
            Self {
                application,
                user_sid,
                executable,
                service: Installation::for_source(&source)?.name,
            },
            client,
        ))
    }
    fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": if cfg!(feature = "development") { 2 } else { 1 }, "application": self.application, "userSid": self.user_sid,
            "executable": self.executable, "service": self.service,
        }))
        .expect("serializable installation identity")
    }
    fn decode(bytes: &[u8]) -> Result<Self> {
        let value: serde_json::Value = serde_json::from_slice(bytes)?;
        let object = value.as_object().ok_or_else(error)?;
        let string = |key: &str| -> Result<String> {
            object
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty() && !s.contains('\0'))
                .map(String::from)
                .ok_or_else(error)
        };
        if object.len() != 5
            || value["version"] != if cfg!(feature = "development") { 2 } else { 1 }
        {
            return denied();
        }
        let approval = Self {
            application: PathBuf::from(string("application")?),
            user_sid: string("userSid")?,
            executable: string("executable")?,
            service: string("service")?,
        };
        if !installation::is_local_application_path(&approval.application)
            || !approval.user_sid.starts_with("S-1-")
        {
            return denied();
        }
        if let Some((application, executable)) = installation::development_identity() {
            if approval.application != application
                || PathBuf::from(&approval.executable) != executable
            {
                return denied();
            }
        } else if !["Cindy.exe", "CindyDev.exe"]
            .iter()
            .any(|name| approval.executable.eq_ignore_ascii_case(name))
        {
            return denied();
        }
        Ok(approval)
    }
    pub fn read() -> Result<Self> {
        let installation = Installation::current()?;
        let _guards =
            security::check_paths(vec![installation.directory.join(installation::APPROVAL)])?;
        let mut bytes = Vec::new();
        fs::File::open(installation.directory.join(installation::APPROVAL))?
            .take(8193)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 8192 {
            return denied();
        }
        let approval = Self::decode(&bytes)?;
        let source = approval
            .application
            .join("resources/tools/remote-desktop")
            .join(installation::HOST);
        if approval.service != installation.name
            || installation::approval_service_name(&source) != installation.name
        {
            return denied();
        }
        // The approved app drive may not be mounted yet at boot. The protected
        // record stores its canonical identity; live code/ACL checks happen on
        // connection, so startup neither accesses shares nor depends on Main.
        Ok(approval)
    }
    pub fn authorize(&self, caller: &Handle) -> Result<(Handle, u32, Vec<Handle>)> {
        let guards = if installation::development_identity().is_some() {
            Vec::new()
        } else {
            security::protect_application(&self.application)?
        };
        let (client, session) = security::authorize_client_process(
            duplicate(caller)?,
            &self.application,
            Some(&self.user_sid),
        )?;
        if !security::same_file(&image(client.0)?, &self.application.join(&self.executable)) {
            return denied();
        }
        Ok((client, session, guards))
    }
}

fn read_restore_record(directory: &std::path::Path) -> Result<Option<security::AclSnapshot>> {
    let restore = directory.join(installation::ACL_RESTORE);
    if !restore.exists() {
        return Ok(None);
    }
    security::check_paths(vec![restore.clone()])?;
    let mut bytes = Vec::new();
    fs::File::open(&restore)?
        .take(1_048_577)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1_048_576 {
        return denied();
    }
    Ok(Some(security::AclSnapshot::decode(&bytes)?))
}

fn write_protected_record(directory: &std::path::Path, name: &str, bytes: &[u8]) -> Result<()> {
    let record = directory.join(name);
    let temporary = directory.join(format!("{name}.new"));
    if temporary.exists() {
        security::check_paths(vec![temporary.clone()])?;
        fs::remove_file(&temporary)?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    security::secure_code(&temporary)?;
    if record.exists() {
        security::check_paths(vec![record.clone()])?;
    }
    replace_protected_record(&temporary, &record)
}

fn replace_protected_record(temporary: &std::path::Path, record: &std::path::Path) -> Result<()> {
    // Replace in place so a crash cannot leave the protected directory without
    // the previous restore/approval record.
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            wide(&temporary.to_string_lossy()).as_ptr(),
            wide(&record.to_string_lossy()).as_ptr(),
            windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(error());
    }
    Ok(())
}

pub fn install(pid: u32) -> Result<()> {
    security::require_elevated()?;
    security::prepare_elevated_identity_query();
    let (approval, client) = Approval::for_client(pid)?;
    let source = std::env::current_exe()?.canonicalize()?;
    let target = Installation::for_source(&source)?;
    // Refuse missing/broken packages, unsigned Main, and live writers before
    // changing permissions. Reinstall must not wipe the first-install restore
    // record: capture skips already-protected paths and would otherwise persist
    // an empty snapshot. Keep the verified Main handle and the captured tree
    // pins through hardening so neither Main nor a directory can be replaced
    // after Authenticode/capture and before ACL/approval write.
    let mut snapshot = if installation::development_identity().is_none() {
        // Freeze before the path list is trusted. CODE_DACL is not inherited, so a
        // child that appears after an unprotected listing would stay user-writable.
        let (ancestors, frozen) = security::freeze_code_tree(&approval.application)?;
        let (main, hash) =
            security::authenticate_application_code(&approval.application, &approval.executable)?;
        security::confirm_frozen_tree(&frozen)?;
        let captured = security::CapturedTree::from_frozen(frozen)?;
        if !security::process_still_running(client.0) {
            return denied();
        }
        security::confirm_application_code(
            &main,
            &approval.application.join(&approval.executable),
            &hash,
        )?;
        // Tuple order is load-bearing: captured drops first on failure so
        // rollback still holds the ancestor pins.
        Some((ancestors, main, hash, captured))
    } else {
        None
    };
    let base = installation::program_files()?.join("CindyRemoteDesktop");
    security::create_protected_directory(&base)?;
    security::create_protected_directory(&target.directory)?;
    let _target = security::pin_ancestors(&target.directory)?;
    // Persist the first-install restore snapshot before any application ACL
    // change. A crash during harden() otherwise leaves the tree admin-only
    // with no record, and a retry skips already-protected paths.
    if let Some((_, main, hash, captured)) = &snapshot {
        if !security::process_still_running(client.0) {
            return denied();
        }
        security::confirm_application_code(
            main,
            &approval.application.join(&approval.executable),
            hash,
        )?;
        let existing = read_restore_record(&target.directory)?;
        if !(existing.is_some() && captured.snapshot.paths.is_empty()) {
            if let Some(combined) =
                security::AclSnapshot::combined(existing, captured.snapshot.clone())
            {
                write_protected_record(
                    &target.directory,
                    installation::ACL_RESTORE,
                    &combined.encode(),
                )?;
            }
        }
    }
    let _application = if let Some((_, main, hash, captured)) = &mut snapshot {
        captured.harden()?;
        if !security::process_still_running(client.0) {
            return denied();
        }
        security::confirm_application_code(
            main,
            &approval.application.join(&approval.executable),
            hash,
        )?;
        security::protect_application(&approval.application)?
    } else {
        Vec::new()
    };
    // This removes/replaces the legacy SCM registration under the same name.
    // Stop must finish before any privileged binary is replaced.
    crate::service::uninstall()?;
    for name in [installation::HOST, installation::INPUT] {
        let destination = target.directory.join(name);
        if destination.exists() {
            security::check_paths(vec![destination.clone()])?;
        }
        security::copy_protected_payload(&source.with_file_name(name), &destination)?;
        security::secure_code(&destination)?;
    }
    if let Some((_, main, hash, _)) = &snapshot {
        if !security::process_still_running(client.0) {
            return denied();
        }
        security::confirm_application_code(
            main,
            &approval.application.join(&approval.executable),
            hash,
        )?;
    }
    write_protected_record(
        &target.directory,
        installation::APPROVAL,
        &approval.encode(),
    )?;
    crate::service::install()?;
    // HKLM provider keys are cleaned after the service exists. Original-user
    // vault cleanup already ran unelevated before UAC; a leftover administrator
    // vault or registry key must not roll back a successful install.
    let _ = legacy_cleanup::remove_provider_registration(&target.name);
    if let Some((_, _, _, captured)) = snapshot.as_mut() {
        captured.commit();
    }
    Ok(())
}

pub fn remove(clean_vault: bool) -> Result<()> {
    let installation = Installation::current()?;
    // Vault cleanup belongs to the original user. Direct `--uninstall`
    // (installer / same-user admin) still enumerates that user's GENERIC
    // leftovers. The elevated half of `--elevate-uninstall` must skip this:
    // over-the-shoulder UAC would otherwise delete the approving
    // administrator's Cindy/RemoteDesktop entries, and a transient admin
    // vault error would block this installation's service removal.
    if clean_vault {
        legacy_cleanup::remove_saved_credentials()?;
    }
    crate::service::uninstall()?;
    if !installation.directory.exists() {
        let _ = legacy_cleanup::remove_provider_registration(&installation.name);
        return Ok(());
    }
    security::require_elevated()?;
    let _ = legacy_cleanup::remove_provider_registration(&installation.name);
    let ancestors = security::pin_ancestors(&installation.directory)?;
    security::check_paths(vec![installation.directory.clone()])?;
    let application = Approval::read().ok().map(|approval| approval.application);
    let snapshot = read_restore_record(&installation.directory)?;
    if let Some(snapshot) = &snapshot {
        snapshot.restore_in(application.as_deref(), |path| match &application {
            Some(root) => security::path_is_within(path, root),
            None => installation::is_local_application_path(path),
        })?;
    }
    for name in [
        installation::APPROVAL,
        "authorization.new",
        "authorization.json.new",
        installation::ACL_RESTORE,
        "acl-restore.json.new",
        installation::INPUT,
        installation::HOST,
    ] {
        let path = installation.directory.join(name);
        if path.exists() {
            security::check_paths(vec![path.clone()])?;
            fs::remove_file(path)?;
        }
    }
    drop(ancestors);
    fs::remove_dir(&installation.directory)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(feature = "development")]
    fn development_approval_is_bound_to_the_compiled_checkout_and_runtime() {
        let (application, executable) = installation::development_identity().unwrap();
        let approval = Approval {
            application: application.clone(),
            executable: executable.to_string_lossy().into_owned(),
            user_sid: "S-1-5-21-100-200-300-1001".into(),
            service: installation::approval_service_name(&application),
        };
        assert!(Approval::decode(&approval.encode()).is_ok());
        let mut value: serde_json::Value = serde_json::from_slice(&approval.encode()).unwrap();
        value["version"] = 1.into();
        assert!(Approval::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        value["version"] = 2.into();
        value["application"] = "D:\\different-checkout".into();
        assert!(Approval::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        value["application"] = application.to_string_lossy().as_ref().into();
        value["executable"] = "D:\\other-electron.exe".into();
        assert!(Approval::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        assert_eq!(
            installation::approval_service_name(&application.join("cache-one")),
            installation::approval_service_name(&application.join("cache-two"))
        );
    }
    #[test]
    #[cfg(not(feature = "development"))]
    fn restart_identity_is_user_and_installation_not_a_process_id() {
        let approval = Approval {
            application: PathBuf::from(r"D:\Custom Apps\Cindy"),
            user_sid: "S-1-5-21-100-200-300-1001".into(),
            executable: "Cindy.exe".into(),
            service: "CindyRemoteDesktop-0123456789abcdef".into(),
        };
        let restored = Approval::decode(&approval.encode()).unwrap();
        assert_eq!(restored.application, approval.application);
        assert_eq!(restored.user_sid, approval.user_sid);
        assert_eq!(restored.executable, approval.executable);
        let mut value: serde_json::Value = serde_json::from_slice(&approval.encode()).unwrap();
        value["pid"] = 123.into();
        assert!(Approval::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        value.as_object_mut().unwrap().remove("pid");
        value["executable"] = "../Cindy.exe".into();
        assert!(Approval::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        value["executable"] = "Cindy.exe".into();
        value["version"] = 99.into();
        assert!(Approval::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        value["version"] = 1.into();
        value["application"] = r"\\server\share\Cindy".into();
        assert!(Approval::decode(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    #[test]
    fn replacing_a_protected_record_keeps_the_previous_file_until_commit() {
        let directory = std::env::temp_dir().join(format!(
            "cindy-lock-record-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let record = directory.join("acl-restore.json");
        let temporary = directory.join("acl-restore.json.new");
        std::fs::write(&record, b"previous-restore").unwrap();
        std::fs::write(&temporary, b"next-restore").unwrap();
        assert_eq!(std::fs::read(&record).unwrap(), b"previous-restore");
        replace_protected_record(&temporary, &record).unwrap();
        assert_eq!(std::fs::read(&record).unwrap(), b"next-restore");
        assert!(!temporary.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn first_install_restore_record_is_written_before_hardening() {
        let install = include_str!("approval.rs")
            .split("pub fn install(")
            .nth(1)
            .unwrap()
            .split("pub fn remove(")
            .next()
            .unwrap();
        assert!(
            install.find("installation::ACL_RESTORE").unwrap()
                < install.find("captured.harden()").unwrap()
        );
        assert!(install.find("freeze_code_tree").unwrap() < install.find("from_frozen").unwrap());
        assert!(
            install.find("confirm_frozen_tree").unwrap() < install.find("from_frozen").unwrap()
        );
    }
    #[test]
    fn leftover_credentials_are_removed_before_service_uninstall() {
        let remove = include_str!("approval.rs")
            .split("pub fn remove(")
            .nth(1)
            .unwrap();
        assert!(remove.contains("if clean_vault"));
        assert!(
            remove.find("if clean_vault").unwrap() < remove.find("service::uninstall").unwrap()
        );
        assert!(
            !remove.contains("let _ = legacy_cleanup::remove_saved_credentials"),
            "vault cleanup failure must block uninstall"
        );
        let elevate_uninstall = include_str!("main.rs")
            .split("Some(\"--elevate-uninstall\")")
            .nth(1)
            .unwrap()
            .split("Some(\"--status\")")
            .next()
            .unwrap();
        assert!(
            elevate_uninstall.find("remove_saved_credentials").unwrap()
                < elevate_uninstall.find("service::elevate").unwrap()
        );
        assert!(elevate_uninstall.contains("--uninstall --skip-vault-cleanup"));
        assert!(!elevate_uninstall.contains("let _ = legacy_cleanup::remove_saved_credentials"));
        let run = include_str!("main.rs")
            .split("fn run()")
            .nth(1)
            .unwrap()
            .split("fn main()")
            .next()
            .unwrap();
        assert!(run.contains("approval::remove(false)"));
        assert!(
            run.find("approval::remove(true)").unwrap()
                < run.find("approval::remove(false)").unwrap()
        );
        let elevate_install = include_str!("main.rs")
            .split("Some(\"--elevate-install\")")
            .nth(1)
            .unwrap()
            .split("Some(\"--elevate-uninstall\")")
            .next()
            .unwrap();
        assert!(
            elevate_install.find("remove_saved_credentials").unwrap()
                < elevate_install.find("service::elevate").unwrap()
        );
        assert!(!elevate_install.contains("let _ = legacy_cleanup::remove_saved_credentials"));
        let install = include_str!("approval.rs")
            .split("pub fn install(")
            .nth(1)
            .unwrap()
            .split("pub fn remove(")
            .next()
            .unwrap();
        assert!(!install.contains("cleanup_current_installation"));
        assert!(!install.contains("let _ = legacy_cleanup::remove_saved_credentials"));
    }
}
