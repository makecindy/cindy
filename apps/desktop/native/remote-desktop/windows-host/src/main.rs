mod approval;
mod capture;
mod capture_protocol;
mod cursor;
#[cfg(feature = "development")]
mod development;
mod installation;
mod legacy_cleanup;
mod pipe;
mod security;
mod service;
mod win;
use win::*;

fn service_name() -> Result<String> {
    Ok(installation::Installation::current()?.name)
}
fn pipe_name() -> Result<String> {
    Ok(installation::Installation::current()?.pipe())
}
fn isolate_search_path() {
    unsafe {
        windows_sys::Win32::System::LibraryLoader::SetDllDirectoryW([0u16].as_ptr());
        windows_sys::Win32::System::LibraryLoader::SetDefaultDllDirectories(
            windows_sys::Win32::System::LibraryLoader::LOAD_LIBRARY_SEARCH_SYSTEM32,
        );
    }
}

fn run() -> Result<()> {
    isolate_search_path();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        #[cfg(feature = "development")]
        Some("--check-client") if args.len() == 2 => {
            approval::Approval::for_client(args[1].parse::<u32>().map_err(|_| error())?)?;
            println!("ready");
            Ok(())
        }
        Some("--service") => service::run(),
        Some("--worker") if args.len() == 2 => service::worker(&args[1]),
        Some("--install") if args.len() == 2 => {
            let pid = args[1].parse::<u32>().map_err(|_| error())?;
            approval::install(pid)
        }
        Some("--uninstall") if args.len() == 1 => approval::remove(true),
        Some("--uninstall") if args.as_slice() == ["--uninstall", "--skip-vault-cleanup"] => {
            approval::remove(false)
        }
        Some("--elevate-install") if args.len() == 2 => {
            let pid = args[1].parse::<u32>().map_err(|_| error())?;
            let (_approval, _main) = approval::Approval::for_client(pid)?;
            // Original-user vault cleanup must happen before UAC. The elevated
            // `--install` process enumerates the approving administrator.
            legacy_cleanup::remove_saved_credentials()?;
            service::elevate(&format!("--install {pid}"))
        }
        Some("--elevate-uninstall") if args.len() == 1 => {
            // Original-user vault cleanup must happen before UAC. The elevated
            // child must not enumerate the approving administrator's vault.
            legacy_cleanup::remove_saved_credentials()?;
            service::elevate("--uninstall --skip-vault-cleanup")
        }
        Some("--status") => {
            println!(
                "{}",
                if service::installed_pid().is_ok() {
                    if installation::Installation::current()?
                        .payload_is_current(&std::env::current_exe()?)?
                    {
                        "ready"
                    } else {
                        "updateRequired"
                    }
                } else if service::registered()? || installation::leftover_installation()? {
                    // SCM still has the AUTO_START service, or a failed update left
                    // the protected Program Files record after deleting the service.
                    // Neither is a missing grant; Settings must keep Remove.
                    "unavailable"
                } else {
                    "missing"
                }
            );
            Ok(())
        }
        _ => denied(),
    }
}
fn main() {
    if run().is_err() {
        println!("error");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn elevation_isolates_the_helper_search_path_before_uac() {
        let source = include_str!("main.rs");
        assert!(
            source.find("isolate_search_path()").unwrap()
                < source.find("std::env::args()").unwrap()
        );
        assert!(source.contains("SetDllDirectoryW"));
        assert!(source.contains("LOAD_LIBRARY_SEARCH_SYSTEM32"));
        assert!(!source.contains("LOAD_LIBRARY_SEARCH_USER_DIRS"));
        assert!(include_str!("../build.rs").contains("/DEPENDENTLOADFLAG:0x800"));
        assert!(
            source.find("isolate_search_path()").unwrap()
                < source.find("service::elevate").unwrap()
        );
    }
    #[test]
    fn elevated_uninstall_skips_the_approving_administrator_vault() {
        let run = include_str!("main.rs")
            .split("fn run()")
            .nth(1)
            .unwrap()
            .split("fn main()")
            .next()
            .unwrap();
        assert!(run.contains("approval::remove(true)"));
        assert!(run.contains("approval::remove(false)"));
        assert!(run.contains("--uninstall --skip-vault-cleanup"));
        let elevate = run
            .split("Some(\"--elevate-uninstall\")")
            .nth(1)
            .unwrap();
        assert!(elevate.contains("remove_saved_credentials()?"));
        assert!(elevate.contains("--uninstall --skip-vault-cleanup"));
        assert!(!elevate.contains("approval::remove(true)"));
    }
    #[test]
    fn status_reports_a_registered_stopped_service_as_unavailable() {
        let status = include_str!("main.rs")
            .split("Some(\"--status\")")
            .nth(1)
            .unwrap();
        assert!(status.contains("installed_pid"));
        assert!(status.contains("registered()?"));
        assert!(status.contains("leftover_installation"));
        assert!(
            status.find("registered()?").unwrap() < status.find("\"missing\"").unwrap(),
            "a registered service must not fall through to missing"
        );
        assert!(
            status.find("leftover_installation").unwrap() < status.find("\"missing\"").unwrap(),
            "a leftover protected install must not fall through to missing"
        );
        assert!(status.contains("\"unavailable\""));
    }
    #[test]
    fn overlay_upgrade_keeps_the_lock_screen_grant() {
        let uninit = include_str!("../../../../resources/installer.nsh")
            .split("!macro customUnInit")
            .nth(1)
            .unwrap()
            .split("!macroend")
            .next()
            .unwrap();
        assert!(
            uninit.find("${If} ${isUpdated}").unwrap() < uninit.find("--uninstall").unwrap(),
            "overlay upgrades must not run --uninstall"
        );
        assert!(
            uninit.find("cindy_remote_service_done").unwrap() < uninit.find("--uninstall").unwrap()
        );
        assert!(!uninit.contains("approval::remove"));
    }
}
