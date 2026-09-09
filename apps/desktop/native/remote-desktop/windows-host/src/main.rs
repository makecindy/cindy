mod capture;
mod pipe;
mod security;
mod service;
mod win;
use sha2::{Digest, Sha256};
use win::*;

fn service_name() -> Result<String> {
    let path = std::env::current_exe()?
        .canonicalize()?
        .to_string_lossy()
        .to_lowercase();
    Ok(format!("CindyRemoteDesktop-{:x}", Sha256::digest(path.as_bytes()))[..35].to_string())
}
fn pipe_name() -> Result<String> {
    Ok(format!(r"\\.\pipe\{}", service_name()?))
}
fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--service") => service::run(),
        Some("--worker") if args.len() == 2 => service::worker(&args[1]),
        Some("--install") if args.len() == 2 => {
            let pid = args[1].parse::<u32>().map_err(|_| error())?;
            service::install()?;
            service::authorize(pid)
        }
        Some("--uninstall") => service::uninstall(),
        Some("--elevate-install") if args.len() == 2 => {
            let pid = args[1].parse::<u32>().map_err(|_| error())?;
            let (_main, _) = security::authorize_client(pid)?;
            service::elevate(&format!("--install {pid}"))
        }
        Some("--elevate-uninstall") => service::elevate("--uninstall"),
        Some("--status") => {
            println!(
                "{}",
                if service::pid().is_ok() {
                    "ready"
                } else if security::protected_install().is_err() {
                    "installRequired"
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
