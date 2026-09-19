mod args;
mod installer;
mod installation_version;
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
    /// True when app_dir was never rewritten. Close still relaunches Cindy after
    /// a terminal pre-install Retry even though Retry itself is hidden.
    install_unmodified: bool,
    /// True after rollback restored the previous files. Close still relaunches
    /// Cindy if Retry was later withdrawn by the digest check.
    install_restored: bool,
    log_path: String,
}

struct AppState {
    args: CliArgs,
    last_status: Arc<Mutex<StatusPayload>>,
    retry_started: Arc<Mutex<bool>>,
    stopped_app: Arc<Mutex<bool>>,
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
    let (phase, can_retry, install_unmodified, install_restored) = {
        let status = state.last_status.lock().unwrap();
        (status.phase, status.can_retry, status.install_unmodified, status.install_restored)
    };
    let retry_in_progress = *state.retry_started.lock().unwrap();
    if installer::close_should_be_blocked(phase, retry_in_progress) {
        return;
    }
    let stopped_app = *state.stopped_app.lock().unwrap();
    installer::abandon_retry(
        &state.args,
        can_retry,
        retry_in_progress,
        stopped_app,
        install_unmodified,
        install_restored,
    );
    app.exit(0);
}

#[tauri::command]
fn retry_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut started = state.retry_started.lock().unwrap();
        if *started {
            return Err("in_progress".into());
        }
        let (phase, can_retry) = {
            let status = state.last_status.lock().unwrap();
            (status.phase, status.can_retry)
        };
        installer::retry_request_allowed(&state.args, phase, can_retry)?;
        installer::ensure_retry_processes_closed(&state.args)?;
        *started = true;
    }

    // Continue in this already-loaded process. A fresh spawn from the
    // Electron-created `%TEMP%` workdir would search that directory for
    // `vcruntime140*.dll` before System32; fallback-safe staging leaves those
    // DLLs absent, so a medium-integrity plant would load into an elevated retry.
    let args = installer::retry_args(&state.args);
    let held_lock = match installer::reopen_held_update_lock(&args.lock) {
        Some(lock) => Some(lock),
        None if args.lock.exists() => {
            *state.retry_started.lock().unwrap() = false;
            return Err("updater_busy".into());
        }
        None => None,
    };
    let last_status = state.last_status.clone();
    let retry_started = state.retry_started.clone();
    let stopped_app = state.stopped_app.clone();
    let handle = app.clone();
    logger::info("[command] retry_update continuing in-process");
    std::thread::spawn(move || {
        installer::run_with_lock(args, held_lock, |event| {
            if matches!(event, InstallerEvent::AppExited) {
                *stopped_app.lock().unwrap() = true;
                return;
            }
            let payload = event_to_payload(event, &handle);
            *last_status.lock().unwrap() = payload.clone();
            let _ = handle.emit("update-status", payload);
        });
        *retry_started.lock().unwrap() = false;
        let final_phase = last_status.lock().unwrap().phase;
        if final_phase == Phase::Done {
            handle.exit(0);
        }
    });
    Ok(())
}

pub fn run() {
    let mut args = CliArgs::parse();
    logger::init(&args.log);
    logger::info(format!(
        "[cindy-updater] starting, version={}, args={:?}",
        env!("CARGO_PKG_VERSION"),
        args
    ));
    // Best-effort sweep of >7-day-old current and legacy update leftovers in %TEMP%.
    // Catches backup dirs from prior failed rollbacks that we intentionally
    // kept around for manual recovery. Bounded so disk doesn't grow forever.
    // Archive hashing runs in the installer worker after this window is shown.
    installer::pin_install_writable(&mut args);
    installer::sweep_stale_temp_dirs();

    let initial_status = StatusPayload {
        phase: Phase::Waiting,
        message: "等待主程序退出…".into(),
        progress: -1,
        error: None,
        can_retry: false,
        install_unmodified: true,
        install_restored: false,
        log_path: args.log.to_string_lossy().into(),
    };
    let last_status = Arc::new(Mutex::new(initial_status));
    let retry_started = Arc::new(Mutex::new(false));
    let stopped_app = Arc::new(Mutex::new(false));
    let state = AppState {
        args: args.clone(),
        last_status: last_status.clone(),
        retry_started,
        stopped_app: stopped_app.clone(),
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
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            let state = handle.state::<AppState>();
                            let phase = state.last_status.lock().unwrap().phase;
                            let retry_in_progress = *state.retry_started.lock().unwrap();
                            if installer::close_should_be_blocked(phase, retry_in_progress) {
                                api.prevent_close();
                            }
                        }
                        tauri::WindowEvent::Destroyed => {
                            let state = handle.state::<AppState>();
                            let (can_retry, install_unmodified, install_restored) = {
                                let status = state.last_status.lock().unwrap();
                                (status.can_retry, status.install_unmodified, status.install_restored)
                            };
                            let retry_in_progress = *state.retry_started.lock().unwrap();
                            let stopped_app = *state.stopped_app.lock().unwrap();
                            installer::abandon_retry(
                                &state.args,
                                can_retry,
                                retry_in_progress,
                                stopped_app,
                                install_unmodified,
                                install_restored,
                            );
                        }
                        _ => {}
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

            let handle = app.handle().clone();
            let args = args.clone();
            let last_status = last_status.clone();
            let stopped_app = stopped_app.clone();
            std::thread::spawn(move || {
                installer::run(args, |event| {
                    if matches!(event, InstallerEvent::AppExited) {
                        *stopped_app.lock().unwrap() = true;
                        return;
                    }
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

#[cfg(test)]
mod retry_update_contract {
    #[test]
    fn retry_update_reruns_the_installer_in_process() {
        let source = include_str!("lib.rs");
        let start = source
            .find("fn retry_update")
            .expect("retry_update command");
        let end = source[start..]
            .find("\npub fn run")
            .expect("run follows retry_update");
        let body = &source[start..start + end];
        assert!(
            body.contains("installer::run_with_lock") && body.contains("retry_args"),
            "Retry must continue in this already-loaded process:\n{body}"
        );
    }

    #[test]
    fn quit_now_releases_an_abandoned_retry_lock() {
        let source = include_str!("lib.rs");
        let start = source.find("fn quit_now").expect("quit_now");
        let end = source[start..]
            .find("\nfn retry_update")
            .expect("retry_update follows quit_now");
        let body = &source[start..start + end];
        assert!(
            body.contains("abandon_retry"),
            "Close must abandon Retry (release lock and relaunch restored Cindy):\n{body}"
        );
        assert!(
            source.contains("WindowEvent::Destroyed") && source.contains("abandon_retry"),
            "closing the updater window must also abandon Retry"
        );
        assert!(
            !body.contains("current_exe")
                && !body.contains("Command::new")
                && !body.contains("process::exit"),
            "Retry must not respawn the updater from %TEMP%:\n{body}"
        );
    }

    #[test]
    fn close_requested_is_blocked_while_retry_is_in_progress() {
        let source = include_str!("lib.rs");
        let start = source
            .find("w.on_window_event")
            .expect("window event handler");
        let end = source[start..]
            .find("let resolved = match")
            .expect("theme follows window events");
        let body = &source[start..start + end];
        assert!(
            body.contains("WindowEvent::CloseRequested") && body.contains("prevent_close"),
            "Alt+F4 must not destroy the updater while retry_started is hashing or replacing:\n{body}"
        );
        assert!(
            body.contains("close_should_be_blocked"),
            "close interception must wait for Done/Failed, not only retry_started:\n{body}"
        );
        assert!(
            body.contains("WindowEvent::Destroyed") && body.contains("abandon_retry"),
            "closing the updater window must still abandon Retry after a terminal status"
        );

        let quit_start = source.find("fn quit_now").expect("quit_now");
        let quit_end = source[quit_start..]
            .find("\nfn retry_update")
            .expect("retry_update follows quit_now");
        let quit_body = &source[quit_start..quit_start + quit_end];
        assert!(
            quit_body.contains("close_should_be_blocked"),
            "quit_now must not abandon or exit while the first install is still rewriting files:\n{quit_body}"
        );
    }

    #[test]
    fn run_does_not_hash_the_archive_before_showing_the_window() {
        let source = include_str!("lib.rs");
        let start = source.find("pub fn run()").expect("pub fn run");
        let end = source[start..]
            .find("tauri::Builder::default()")
            .expect("window builder follows startup");
        let body = &source[start..start + end];
        assert!(
            !body.contains("bind_zip_sha256"),
            "hashing a large ZIP before the window is shown leaves the user with no UI:\n{body}"
        );
    }

    #[test]
    fn run_pins_install_writable_before_cloning_into_app_state() {
        let source = include_str!("lib.rs");
        let start = source.find("pub fn run()").expect("pub fn run");
        let end = source[start..]
            .find("tauri::Builder::default()")
            .expect("window builder follows startup");
        let body = &source[start..start + end];
        let pin = body
            .find("pin_install_writable")
            .expect("pin before AppState");
        let clone = body.find("args.clone()").expect("AppState clones args");
        assert!(
            pin < clone,
            "Retry reads AppState.args; pin before that clone or Retry re-probes app_dir:\n{body}"
        );
    }
}

fn event_to_payload(event: InstallerEvent, handle: &AppHandle) -> StatusPayload {
    let state = handle.state::<AppState>();
    let log_path = state.args.log.to_string_lossy().into();
    let previous = state.last_status.lock().unwrap().clone();
    match event {
        InstallerEvent::Phase(phase, message) => StatusPayload {
            phase,
            message,
            progress: -1,
            error: None,
            can_retry: false,
            install_unmodified: previous.install_unmodified,
            install_restored: previous.install_restored,
            log_path,
        },
        InstallerEvent::Progress(phase, message, progress) => StatusPayload {
            phase,
            message,
            progress,
            error: None,
            can_retry: false,
            install_unmodified: previous.install_unmodified,
            install_restored: previous.install_restored,
            log_path,
        },
        InstallerEvent::Done => StatusPayload {
            phase: Phase::Done,
            message: "更新完成，正在启动新版本…".into(),
            progress: 100,
            error: None,
            can_retry: false,
            install_unmodified: false,
            install_restored: false,
            log_path,
        },
        InstallerEvent::Failed {
            error,
            can_retry,
            install_unmodified,
            install_restored,
        } => StatusPayload {
            phase: Phase::Failed,
            message: "更新失败".into(),
            progress: -1,
            error: Some(error),
            can_retry,
            install_unmodified,
            install_restored,
            log_path,
        },
        InstallerEvent::AppExited => unreachable!("AppExited is consumed before UI payload mapping"),
    }
}
