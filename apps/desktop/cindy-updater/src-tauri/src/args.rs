use std::path::PathBuf;

use clap::Parser;

/// CLI args delivered by the main Electron process when it spawns the updater.
/// Spec: see `executeUpdateWindows` in `apps/desktop/src/main/updateService.ts`.
#[derive(Parser, Debug, Clone)]
#[command(name = "cindy-updater", version)]
pub struct CliArgs {
    /// Path to the downloaded zip patch.
    #[arg(long)]
    pub zip: PathBuf,

    /// Application install directory (where the running exe lives).
    #[arg(long = "app-dir")]
    pub app_dir: PathBuf,

    /// File name of the main exe inside `app_dir`, e.g. `xdt-maker.exe`.
    #[arg(long = "exe-name")]
    pub exe_name: String,

    /// PID of the main Electron process to wait for before swapping files.
    #[arg(long)]
    pub pid: u32,

    /// Append-only log file path (shared with the legacy .cmd flow).
    #[arg(long)]
    pub log: PathBuf,

    /// Lock file path. Created before file swap, deleted after.
    #[arg(long)]
    pub lock: PathBuf,

    /// Working directory pre-created by the Electron main process. Houses
    /// the updater binary, the extract staging dir, and the rollback backup
    /// dir — keeping a single timestamped folder per update attempt rather
    /// than three siblings under %TEMP%.
    #[arg(long)]
    pub workdir: PathBuf,

    /// Color theme to render the UI in. The Electron main process passes the
    /// user's current xdt-maker theme so the updater window matches whatever
    /// the user is looking at — without this, the WebView would default to
    /// the OS preference, which can disagree with an in-app theme override.
    #[arg(long, value_enum, default_value_t = ThemeArg::Auto)]
    pub theme: ThemeArg,

    /// Re-entry marker: set by the updater itself when it relaunches as
    /// administrator via ShellExecuteExW(runas). Prevents an infinite UAC
    /// loop — if the elevated child STILL can't write to app_dir (e.g. AV
    /// holding a file open), it bails with a clear error instead of asking
    /// the user to authorize again. Never set by the Electron main process;
    /// only by the updater itself during self-elevation.
    #[arg(long, default_value_t = false)]
    pub elevated: bool,

    /// SHA-256 of the zip this updater process first opened. Elevation and
    /// retry pass the same digest so a later replacement of the TEMP file
    /// cannot be extracted by a still-elevated child.
    #[arg(long = "zip-sha256")]
    pub zip_sha256: Option<String>,
}

#[derive(Copy, Clone, Debug, clap::ValueEnum)]
pub enum ThemeArg {
    Light,
    Dark,
    Auto,
}
