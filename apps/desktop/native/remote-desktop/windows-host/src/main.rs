mod capture;
mod capture_protocol;
mod cursor;
mod naming;
mod pipe;
mod security;
mod service;
mod staging;
mod win;
use naming::Installation;
use sha2::{Digest, Sha256};
use std::path::Path;
use win::*;

/// The service name used before the executable moved into a protected
/// directory: a hash of this bundled helper's own path. Removal still looks
/// for it, so a machine that enabled the feature under an older build is not
/// left with a stale registration no one deletes.
fn legacy_service_name_for(path: &Path) -> Result<String> {
    let path = path.canonicalize()?.to_string_lossy().to_lowercase();
    Ok(format!("CindyRemoteDesktop-{:x}", Sha256::digest(path.as_bytes()))[..35].to_string())
}

fn legacy_service_name() -> Result<String> {
    legacy_service_name_for(&std::env::current_exe()?)
}

/// Stops both the current installation service and the pre-staging service
/// name. The latter used a hash of the bundled helper path, so an upgrade
/// running from the protected bootstrap must derive it from the source path
/// rather than from the bootstrap's own location. Windows rejects a second
/// service with the same display name even when its service name differs.
fn uninstall_before_install(installation: &Installation, bundled: &Path) -> Staged<()> {
    service::uninstall(&installation.service())?;
    if let Ok(legacy) = legacy_service_name_for(bundled) {
        if legacy != installation.service() {
            service::uninstall(&legacy)?;
        }
    }
    Ok(())
}

/// This executable's own installation, for the modes that run from inside one.
fn bundled() -> Staged<Installation> {
    bundled_from(&std::env::current_exe().stage(Step::ProtectedOpen)?)
}

fn bundled_from(path: &Path) -> Staged<Installation> {
    if !path
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case(naming::HOST_EXE))
    {
        return refuse(Step::ProtectedOpen);
    }
    Installation::of_bundled(path)
}

fn run() -> Staged<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--service") => service::run().stage(Step::Service),
        Some("--worker") if args.len() == 2 => service::worker(&args[1]).stage(Step::Worker),
        Some("--install") if args.len() == 2 || args.len() == 3 => {
            let pid = args[1]
                .parse::<u32>()
                .map_err(|_| Failure::new(Step::Args, 0))?;
            let development = args.get(2).is_some_and(|arg| arg == "--development");
            if args.len() == 3 && !development {
                return refuse(Step::Args);
            }
            let installation = if development {
                bundled()?.for_development()
            } else {
                bundled()?
            };
            // Stop first: setup also runs for an upgrade, and the staged files
            // cannot be replaced while the service it starts still holds them.
            let bundled = std::env::current_exe().stage(Step::ProtectedOpen)?;
            uninstall_before_install(&installation, &bundled)?;
            service::install(&installation)?;
            service::authorize(&installation, pid)
        }
        Some("--install-from") if args.len() == 5 || args.len() == 6 => {
            let source = std::path::PathBuf::from(&args[1]);
            let expected_host_hash = &args[2];
            let expected_input_hash = &args[3];
            let pid = args[4]
                .parse::<u32>()
                .map_err(|_| Failure::new(Step::Args, 0))?;
            let development = args.get(5).is_some_and(|arg| arg == "--development");
            if args.len() == 6 && !development
                || expected_host_hash.len() != 64
                || expected_input_hash.len() != 64
                || !expected_host_hash.bytes().all(|b| b.is_ascii_hexdigit())
                || !expected_input_hash.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return refuse(Step::Args);
            }
            let installation = if development {
                bundled_from(&source)?.for_development()
            } else {
                bundled_from(&source)?
            };
            // This process is the protected bootstrap. Stop the old service
            // before replacing its host and input binaries, then stage bytes
            // read from the user installation as data.
            uninstall_before_install(&installation, &source)?;
            staging::stage_from_verified(
                &installation,
                &source,
                Some(expected_host_hash),
                Some(expected_input_hash),
            )?;
            service::install_staged(&installation)?;
            service::authorize(&installation, pid)
        }
        Some("--uninstall-from") if args.len() == 2 => {
            let source = std::path::PathBuf::from(&args[1]);
            let installation = bundled_from(&source)?;
            service::uninstall(&installation.service())?;
            if let Ok(legacy) = legacy_service_name_for(&source) {
                service::uninstall(&legacy)?;
            }
            Ok(())
        }
        Some("--uninstall") => {
            let installation = bundled()?;
            service::uninstall(&installation.service())?;
            if let Ok(legacy) = legacy_service_name() {
                service::uninstall(&legacy)?;
            }
            staging::unstage(&installation)
        }
        Some("--elevate-install") if args.len() == 2 || args.len() == 3 => {
            let pid = args[1]
                .parse::<u32>()
                .map_err(|_| Failure::new(Step::Args, 0))?;
            let development = args.get(2).is_some_and(|arg| arg == "--development");
            if args.len() == 3 && !development {
                return refuse(Step::Args);
            }
            let installation = if development {
                bundled()?.for_development()
            } else {
                bundled()?
            };
            let (main, _) = security::authorize_client(pid, &installation.install, development)
                .stage(Step::ClientIdentity)?;
            let trusted_main = if development {
                None
            } else {
                Some(image(main.0).stage(Step::ClientIdentity)?)
            };
            service::elevate(
                &installation,
                &[
                    "--install-from".to_owned(),
                    pid.to_string(),
                    if development {
                        "--development".to_owned()
                    } else {
                        String::new()
                    },
                ][..if development { 3 } else { 2 }],
                trusted_main.as_deref(),
            )
        }
        Some("--elevate-uninstall") => {
            let installation = bundled()?;
            service::elevate(&installation, &["--uninstall-from".to_owned()], None)
        }
        Some("--status") => {
            let status = match bundled() {
                Ok(installation) if service::pid(&installation.service()).is_ok() => {
                    "ready".to_string()
                }
                Ok(_) => "missing".to_string(),
                // Setup cannot run at all on this machine. Name the step, so
                // the settings page does not have to guess behind a bare word.
                Err(failure) => format!("installRequired {}", failure.detail()),
            };
            println!("{status}");
            Ok(())
        }
        _ => refuse(Step::Args),
    }
}
fn main() {
    if let Err(failure) = run() {
        // One line for the Desktop log, and an exit code the unelevated parent
        // can decode when this process is the hidden elevated child.
        println!("{}", failure.line());
        std::process::exit(failure.exit_code() as i32);
    }
}
