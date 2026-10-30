mod args;
mod installation_version;
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
    #[serde(skip)]
    relaunch_on_close: bool,
    log_path: String,
}

impl StatusPayload {
    fn begin_retry(&mut self) -> Result<Self, String> {
        if !matches!(self.phase, Phase::Done | Phase::Failed) {
            return Err("in_progress".into());
        }
        if self.phase != Phase::Failed || !self.can_retry {
            return Err("unavailable".into());
        }
        let previous = self.clone();
        self.phase = Phase::Waiting;
        self.can_retry = false;
        self.relaunch_on_close = false;
        Ok(previous)
    }

    /// Taking the restart flag makes Close idempotent; an active attempt cannot
    /// be closed even before its first progress event has reached the WebView.
    fn take_close_relaunch(&mut self) -> Option<bool> {
        if !matches!(self.phase, Phase::Done | Phase::Failed) {
            return None;
        }
        self.can_retry = false;
        Some(std::mem::take(&mut self.relaunch_on_close))
    }
}

struct AppState {
    args: CliArgs,
    last_status: Arc<Mutex<StatusPayload>>,
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
fn quit_now(app: AppHandle, state: State<'_, AppState>) {
    let relaunch = state.last_status.lock().unwrap().take_close_relaunch();
    if let Some(relaunch) = relaunch {
        installer::abandon_retry(&state.args, relaunch);
        app.exit(0);
    }
}

#[tauri::command]
fn retry_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let mut status = state.last_status.lock().unwrap();
    // Publish the running state under the same mutex used by Close and Retry.
    // No second click can start a worker or exit between acceptance and spawn.
    let previous = status.begin_retry()?;
    let result = (|| {
        if !installer::retry_available(&installer::retry_archive(&state.args)) {
            return Err("archive_unavailable".into());
        }
        installer::ensure_retry_processes_closed(&state.args)?;
        start_installer(app, installer::retry_args(&state.args)).map_err(|error| {
            logger::error(format!("[command] retry_update worker failed: {error}"));
            "spawn_failed".to_string()
        })
    })();
    if let Err(error) = &result {
        *status = previous;
        if error == "archive_unavailable" {
            status.can_retry = false;
        }
    }
    result
}

/// First attempt and manual Retry use the same worker and installer, including
/// the original UAC handoff when permission is still required.
fn start_installer(handle: AppHandle, args: CliArgs) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("cindy-update".into())
        .spawn(move || {
            installer::run(args, |event| {
                let done = matches!(event, InstallerEvent::Done);
                let payload = event_to_payload(event, &handle);
                *handle.state::<AppState>().last_status.lock().unwrap() = payload.clone();
                let _ = handle.emit("update-status", payload);
                if done {
                    handle.exit(0);
                }
            });
        })
        .map(|_| ())
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
        relaunch_on_close: false,
        log_path: args.log.to_string_lossy().into(),
    };
    let last_status = Arc::new(Mutex::new(initial_status));
    let state = AppState {
        args: args.clone(),
        last_status: last_status.clone(),
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
                let handle = app.handle().clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        quit_now(handle.clone(), handle.state::<AppState>());
                    }
                });
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

            start_installer(app.handle().clone(), args.clone())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri failed to launch");
}

fn event_to_payload(event: InstallerEvent, handle: &AppHandle) -> StatusPayload {
    let log_path = handle.state::<AppState>().args.log.to_string_lossy().into();
    match event {
        InstallerEvent::Phase(phase, message) => StatusPayload {
            phase,
            message,
            progress: -1,
            error: None,
            can_retry: false,
            relaunch_on_close: false,
            log_path,
        },
        InstallerEvent::Progress(phase, message, progress) => StatusPayload {
            phase,
            message,
            progress,
            error: None,
            can_retry: false,
            relaunch_on_close: false,
            log_path,
        },
        InstallerEvent::Done => StatusPayload {
            phase: Phase::Done,
            message: "更新完成，正在启动新版本…".into(),
            progress: 100,
            error: None,
            can_retry: false,
            relaunch_on_close: false,
            log_path,
        },
        InstallerEvent::Failed {
            error,
            can_retry,
            relaunch_on_close,
        } => StatusPayload {
            phase: Phase::Failed,
            message: "更新失败".into(),
            progress: -1,
            error: Some(error),
            can_retry,
            relaunch_on_close,
            log_path,
        },
    }
}

#[cfg(test)]
mod retry_state_tests {
    use super::*;

    fn failed_status() -> StatusPayload {
        StatusPayload {
            phase: Phase::Failed,
            message: String::new(),
            progress: -1,
            error: None,
            can_retry: true,
            relaunch_on_close: true,
            log_path: String::new(),
        }
    }

    #[test]
    fn accepted_retry_blocks_duplicate_requests_and_close_before_worker_progress() {
        let mut status = failed_status();
        let previous = status.begin_retry().unwrap();
        assert_eq!(status.phase, Phase::Waiting);
        assert!(!status.can_retry);
        assert_eq!(status.begin_retry().err().as_deref(), Some("in_progress"));
        assert_eq!(status.take_close_relaunch(), None);
        // Thread creation failure restores the same retry and Close choices.
        status = previous;
        assert!(status.begin_retry().is_ok());
    }

    #[test]
    fn close_relaunches_at_most_once_even_when_retry_was_withdrawn() {
        let mut status = failed_status();
        status.can_retry = false;
        assert_eq!(status.take_close_relaunch(), Some(true));
        assert_eq!(status.take_close_relaunch(), Some(false));
        assert_eq!(status.begin_retry().err().as_deref(), Some("unavailable"));
    }

    #[test]
    fn active_install_cannot_close_and_broken_rollback_cannot_retry_or_restart() {
        for phase in [
            Phase::Waiting,
            Phase::RequestingElevation,
            Phase::BackingUp,
            Phase::Extracting,
            Phase::Replacing,
            Phase::Launching,
            Phase::RollingBack,
        ] {
            let mut status = failed_status();
            status.phase = phase;
            assert_eq!(status.take_close_relaunch(), None);
        }
        let mut status = failed_status();
        status.can_retry = false;
        status.relaunch_on_close = false;
        assert_eq!(status.begin_retry().err().as_deref(), Some("unavailable"));
        assert_eq!(status.take_close_relaunch(), Some(false));
        status.phase = Phase::Done;
        assert_eq!(status.begin_retry().err().as_deref(), Some("unavailable"));
    }
}
