mod args;
mod installer;
pub(crate) mod logger;
mod pid_wait;

use std::sync::{Arc, Mutex};

use args::{CliArgs, ThemeArg};
use clap::Parser;
use installer::{InstallerEvent, Phase};
use serde::Serialize;
use tauri::image::Image;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, State, Theme};

/// PNG embedded at compile time, decoded at runtime so the window/taskbar
/// icons are downsampled by the OS instead of pulling a pre-rasterized 32×32
/// out of icon.ico (which makes the wordmark look like a smudge at small
/// sizes). Mirrors how the Electron main app feeds icon.png to BrowserWindow.
static ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

#[derive(Clone, Serialize)]
struct StatusPayload {
    phase: Phase,
    message: String,
    /// 0..=100, only meaningful for `Extracting`/`Replacing`. -1 = indeterminate.
    progress: i32,
    error: Option<String>,
    can_retry: bool,
    log_path: String,
}

struct AppState {
    args: CliArgs,
    last_status: Arc<Mutex<StatusPayload>>,
    retry_started: Arc<Mutex<bool>>,
}

#[tauri::command]
fn get_status(state: State<'_, AppState>) -> StatusPayload {
    state.last_status.lock().unwrap().clone()
}

#[tauri::command]
fn open_log_dir(state: State<'_, AppState>) -> Result<(), String> {
    let log_path = state.args.log.clone();
    let dir = log_path.parent().ok_or("log path has no parent")?;
    logger::info(format!("[command] open_log_dir → {}", dir.display()));
    open::that(dir).map_err(|e| {
        logger::error(format!("[command] open::that failed: {e}"));
        e.to_string()
    })?;
    Ok(())
}

#[tauri::command]
fn quit_now(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn retry_update(state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut started = state.retry_started.lock().unwrap();
        if *started {
            return Err("in_progress".into());
        }
        let can_retry = {
            let status = state.last_status.lock().unwrap();
            status.phase == Phase::Failed && status.can_retry
        };
        if !can_retry {
            return Err("unavailable".into());
        }
        let archive = installer::retry_archive(&state.args);
        let digest = state.args.zip_sha256.as_deref().unwrap_or("");
        if digest.is_empty() || !installer::archive_matches_digest(&archive, digest) {
            return Err("archive_unavailable".into());
        }
        installer::ensure_retry_processes_closed(&state.args)?;
        *started = true;
    }

    let args = state.args.clone();
    let updater = std::env::current_exe().map_err(|error| {
        *state.retry_started.lock().unwrap() = false;
        error.to_string()
    })?;
    let mut command = std::process::Command::new(&updater);
    command
        .args(installer::retry_cli_args(&args))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const FLAGS: u32 = 0x00000008 | 0x00000200;
        command.creation_flags(FLAGS);
    }
    let child = command.spawn().map_err(|error| {
        *state.retry_started.lock().unwrap() = false;
        logger::error(format!("[command] retry_update spawn failed: {error}"));
        error.to_string()
    })?;
    logger::info(format!("[command] retry_update spawned pid={}", child.id()));
    std::process::exit(0);
}

pub fn run() {
    let args = CliArgs::parse();
    logger::init(&args.log);
    logger::info(format!(
        "[cindy-updater] starting, version={}, args={:?}",
        env!("CARGO_PKG_VERSION"),
        args
    ));
    // Best-effort sweep of >7-day-old current and legacy update leftovers in %TEMP%.
    // Catches backup dirs from prior failed rollbacks that we intentionally
    // kept around for manual recovery. Bounded so disk doesn't grow forever.
    installer::sweep_stale_temp_dirs();

    let initial_status = StatusPayload {
        phase: Phase::Waiting,
        message: "等待主程序退出…".into(),
        progress: -1,
        error: None,
        can_retry: false,
        log_path: args.log.to_string_lossy().into(),
    };
    let last_status = Arc::new(Mutex::new(initial_status));
    let retry_started = Arc::new(Mutex::new(false));
    let state = AppState {
        args: args.clone(),
        last_status: last_status.clone(),
        retry_started,
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_status,
            open_log_dir,
            quit_now,
            retry_update
        ])
        .setup(move |app| {
            let win = app.get_webview_window("main");

            // Override the (low-res) embedded .ico with a runtime-decoded PNG,
            // so Windows downsamples a 512×512 source for whatever DPI/size
            // the title bar and taskbar ask for.
            if let (Ok(icon), Some(w)) = (Image::from_bytes(ICON_PNG), win.as_ref()) {
                let _ = w.set_icon(icon);
            }

            // Window is created hidden (tauri.conf.json `visible: false`) so
            // we can paint its native background to match the resolved theme
            // BEFORE showing it. Without this, the user sees one white frame
            // between window-shown and the WebView's first CSS paint — even
            // when --theme=dark — because both the win32 surface and the
            // WebView default to white until HTML/CSS lands.
            if let Some(w) = win.as_ref() {
                let resolved = match app.state::<AppState>().args.theme {
                    ThemeArg::Light => Theme::Light,
                    ThemeArg::Dark => Theme::Dark,
                    // Fall back to the OS preference so auto still matches
                    // the @media (prefers-color-scheme) branch the CSS picks.
                    ThemeArg::Auto => w.theme().unwrap_or(Theme::Light),
                };
                // Mirrors --card-bg in ui/style.css (light #f8f8f6, dark #1f1f1e).
                let bg = match resolved {
                    Theme::Dark => Color(0x1f, 0x1f, 0x1e, 0xff),
                    _ => Color(0xf8, 0xf8, 0xf6, 0xff),
                };
                let _ = w.set_background_color(Some(bg));
                let _ = w.set_theme(Some(resolved));
                let _ = w.show();
            }

            let handle = app.handle().clone();
            let args = args.clone();
            let last_status = last_status.clone();
            std::thread::spawn(move || {
                installer::run(args, |event| {
                    let payload = event_to_payload(event, &handle);
                    *last_status.lock().unwrap() = payload.clone();
                    let _ = handle.emit("update-status", payload);
                });
                // Auto-exit on success: the new app is already running and
                // visible to the user — overlapping the updater splash on
                // top of it for any longer reads as lag. Exit immediately.
                // Failure path: keep the window so the user reads the error
                // and clicks "关闭" themselves (or "打开日志文件夹" first).
                let final_phase = last_status.lock().unwrap().phase;
                if final_phase == Phase::Done {
                    handle.exit(0);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri failed to launch");
}

fn event_to_payload(event: InstallerEvent, handle: &AppHandle) -> StatusPayload {
    let log_path = handle
        .state::<AppState>()
        .args
        .log
        .to_string_lossy()
        .into();
    match event {
        InstallerEvent::Phase(phase, message) => StatusPayload {
            phase,
            message,
            progress: -1,
            error: None,
            can_retry: false,
            log_path,
        },
        InstallerEvent::Progress(phase, message, progress) => StatusPayload {
            phase,
            message,
            progress,
            error: None,
            can_retry: false,
            log_path,
        },
        InstallerEvent::Done => StatusPayload {
            phase: Phase::Done,
            message: "更新完成，正在启动新版本…".into(),
            progress: 100,
            error: None,
            can_retry: false,
            log_path,
        },
        InstallerEvent::Failed(err, can_retry) => StatusPayload {
            phase: Phase::Failed,
            message: "更新失败".into(),
            progress: -1,
            error: Some(err),
            can_retry,
            log_path,
        },
    }
}
