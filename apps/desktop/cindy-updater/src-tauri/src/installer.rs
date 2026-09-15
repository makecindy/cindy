use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use serde::Serialize;
use sysinfo::System;

use crate::args::{CliArgs, ThemeArg};
use crate::{logger, pid_wait};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Waiting,
    /// Probe found app_dir is not user-writable; we're calling
    /// ShellExecuteExW(runas) and waiting for the user to confirm the UAC
    /// prompt. Original (unelevated) updater stays in this phase until either
    /// the elevated child takes over (then we exit silently) or the user
    /// cancels (then we transition to Failed).
    RequestingElevation,
    BackingUp,
    Extracting,
    Replacing,
    Launching,
    RollingBack,
    Done,
    Failed,
}

pub enum InstallerEvent {
    Phase(Phase, String),
    Progress(Phase, String, i32),
    Done,
    Failed(String, bool),
}

const PID_WAIT_TIMEOUT: Duration = Duration::from_secs(60);
const FS_SETTLE_DELAY: Duration = Duration::from_secs(2);
/// Grace window for processes still running from app_dir after the main
/// process exited: how long we poll for a voluntary exit before killing.
const APPDIR_PROCESS_GRACE: Duration = Duration::from_secs(5);
/// After killing, how long we wait for the killed processes to disappear
/// (Windows needs a beat to release image locks post-TerminateProcess).
const APPDIR_PROCESS_KILL_WAIT: Duration = Duration::from_secs(3);
const APPDIR_PROCESS_POLL: Duration = Duration::from_millis(500);
/// How long we'll WAIT for the new process to register in sysinfo before
/// declaring the launch failed. Polled — happy path exits in 100-300ms
/// instead of always sleeping the full duration.
const LAUNCH_VERIFY_TIMEOUT: Duration = Duration::from_secs(3);
const LAUNCH_VERIFY_POLL: Duration = Duration::from_millis(100);

pub fn run<F: FnMut(InstallerEvent)>(mut args: CliArgs, mut emit: F) {
    if let Err(error) = bind_zip_sha256(&mut args) {
        logger::error(format!("[installer] FAILED: archive unavailable ({error})"));
        let _ = fs::remove_file(&args.lock);
        emit(InstallerEvent::Failed(
            "更新文件已不存在或无法读取，请重新检查更新".into(),
            false,
        ));
        return;
    }
    match run_inner(&args, &mut emit) {
        Ok(()) => emit(InstallerEvent::Done),
        Err(failure) => {
            let can_retry = failure.can_retry
                && prepare_retry_archive(&args)
                && retry_allowed(true, &retry_archive(&args), args.zip_sha256.as_deref());
            logger::error(format!("[installer] FAILED: {}", failure.message));
            let _ = fs::remove_file(&args.lock);
            emit(InstallerEvent::Failed(failure.message, can_retry));
        }
    }
}

#[derive(Debug)]
struct InstallerFailure {
    message: String,
    can_retry: bool,
}

impl InstallerFailure {
    fn new(message: impl Into<String>, can_retry: bool) -> Self {
        Self {
            message: message.into(),
            can_retry,
        }
    }
}

pub(crate) fn retry_available(zip: &Path) -> bool {
    File::open(zip)
        .and_then(|file| file.metadata())
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

fn sha256_hex(file: &mut File) -> io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn open_regular_file(zip: &Path) -> io::Result<File> {
    let file = File::open(zip)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("archive path is not a regular file: {}", zip.display()),
        ));
    }
    Ok(file)
}

pub(crate) fn archive_matches_digest(zip: &Path, expected: &str) -> bool {
    open_regular_file(zip)
        .and_then(|mut file| sha256_hex(&mut file))
        .map(|digest| digest.eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

/// Capture the digest of the zip this process first opened. Later elevation
/// and retry reuse that digest so a TEMP replacement cannot be extracted.
pub(crate) fn bind_zip_sha256(args: &mut CliArgs) -> Result<String, String> {
    let mut file = open_regular_file(&args.zip).map_err(|_| "archive_unavailable".to_string())?;
    let digest = sha256_hex(&mut file).map_err(|_| "archive_unavailable".to_string())?;
    match args.zip_sha256.as_deref() {
        Some(expected) if expected.eq_ignore_ascii_case(&digest) => Ok(digest),
        Some(_) => Err("archive_unavailable".into()),
        None => {
            args.zip_sha256 = Some(digest.clone());
            Ok(digest)
        }
    }
}

/// Retry is safe only when the failed attempt left the install directory in a
/// known-good state and the original archive still matches the captured digest.
fn retry_allowed(can_retry: bool, zip: &Path, expected_sha256: Option<&str>) -> bool {
    match expected_sha256 {
        Some(digest) => can_retry && archive_matches_digest(zip, digest),
        None => false,
    }
}

pub(crate) fn retry_archive(args: &CliArgs) -> std::path::PathBuf {
    args.workdir.join("retry.zip")
}

fn prepare_retry_archive(args: &CliArgs) -> bool {
    let target = retry_archive(args);
    if args.zip == target || !args.zip.exists() {
        return retry_available(&target);
    }
    if target.exists() {
        return false;
    }
    match fs::rename(&args.zip, &target) {
        Ok(()) => retry_available(&target),
        Err(error) => {
            logger::warn(format!("[retry] could not isolate archive: {error}"));
            false
        }
    }
}

pub(crate) fn ensure_retry_processes_closed(args: &CliArgs) -> Result<(), String> {
    let mut sys = System::new();
    if collect_appdir_processes(&mut sys, &args.app_dir, std::process::id()).is_empty() {
        Ok(())
    } else {
        Err("processes_running".into())
    }
}

/// Recreate the original updater arguments from trusted Rust state for a user-initiated retry.
/// An elevated updater keeps its internal marker so a retry does not accidentally start an
/// elevated process as if it were unelevated; the original process omits it and follows UAC again.
pub(crate) fn retry_cli_args(args: &CliArgs) -> Vec<std::ffi::OsString> {
    let theme = match args.theme {
        ThemeArg::Light => "light",
        ThemeArg::Dark => "dark",
        ThemeArg::Auto => "auto",
    };
    let zip = retry_archive(args);
    let values = [
        ("--zip", zip.as_os_str()),
        ("--app-dir", args.app_dir.as_os_str()),
        ("--exe-name", std::ffi::OsStr::new(&args.exe_name)),
        ("--pid", std::ffi::OsStr::new("0")),
        ("--log", args.log.as_os_str()),
        ("--lock", args.lock.as_os_str()),
        ("--workdir", args.workdir.as_os_str()),
        ("--theme", std::ffi::OsStr::new(theme)),
    ];
    let mut result = values
        .into_iter()
        .flat_map(|(key, value)| [std::ffi::OsString::from(key), value.to_os_string()])
        .collect::<Vec<_>>();
    if let Some(digest) = args.zip_sha256.as_deref().filter(|digest| !digest.is_empty()) {
        result.push(std::ffi::OsString::from("--zip-sha256"));
        result.push(std::ffi::OsString::from(digest));
    }
    if args.elevated {
        result.push(std::ffi::OsString::from("--elevated"));
    }
    result
}

fn run_inner<F: FnMut(InstallerEvent)>(
    args: &CliArgs,
    emit: &mut F,
) -> Result<(), InstallerFailure> {
    logger::info(format!(
        "[installer] zip={} app_dir={} exe_name={} pid={}",
        args.zip.display(),
        args.app_dir.display(),
        args.exe_name,
        args.pid
    ));

    // 1. Wait for the main process to exit.
    emit(InstallerEvent::Phase(
        Phase::Waiting,
        format!("等待 PID {} 退出…", args.pid),
    ));
    let is_retry = args.zip == retry_archive(args);
    let exited = is_retry || pid_wait::wait_for_exit(args.pid, PID_WAIT_TIMEOUT);
    if !exited {
        return Err(InstallerFailure::new(
            "主程序在 60 秒内没有退出，更新中止",
            true,
        ));
    }
    std::thread::sleep(FS_SETTLE_DELAY);

    // 1.2. Terminate lingering processes that run FROM app_dir. pid_wait only
    //      covers the one main-process PID, but executables living inside the
    //      install dir can outlive it and keep image locks on files we're
    //      about to replace. Real-world case: the bundled Android adb.exe —
    //      any adb invocation self-forks a persistent `adb server` daemon
    //      that survives app exit and made both the replace AND the rollback
    //      fail with os error 32 (sharing violation). Windows never allows
    //      overwriting a running executable, so these must be gone first.
    if is_retry {
        ensure_retry_processes_closed(args)
            .map_err(|error| InstallerFailure::new(error, true))?;
    } else {
        terminate_appdir_processes(&args.app_dir, emit)
            .map_err(|error| InstallerFailure::new(error.to_string(), true))?;
    }

    // 1.5. Permission probe → optional self-elevation. Run BEFORE the lock
    //      write so cancelling UAC leaves zero on-disk state. If app_dir is
    //      not user-writable (e.g. installed under D:\ or C:\Program Files\
    //      with admin-only ACL), relaunch ourselves via ShellExecuteExW(runas)
    //      so the elevated child can replace the files. Default install path
    //      (%LOCALAPPDATA%\xdt-maker) probes successfully → no UAC, no change
    //      from prior behavior.
    match needs_elevation(&args.app_dir) {
        Ok(true) if !args.elevated => {
            logger::info(format!(
                "[elevate] app_dir {} not user-writable, requesting UAC elevation",
                args.app_dir.display()
            ));
            emit(InstallerEvent::Phase(
                Phase::RequestingElevation,
                "需要管理员权限，请在弹出的 UAC 提示中点击「是」…".into(),
            ));
            match self_elevate(args) {
                Ok(()) => {
                    logger::info("[elevate] elevated child spawned, exiting original updater");
                    // Hard-exit: the elevated child has its own UI and event
                    // loop. Returning Ok() here would emit Done → flash
                    // "更新完成" briefly in this (now-stale) window. No lock
                    // was created, no app_dir state was touched — clean exit.
                    std::process::exit(0);
                }
                Err(ElevateError::UserCancelled) => {
                    return Err(InstallerFailure::new(
                        "用户取消了管理员授权，更新已取消",
                        true,
                    ));
                }
                Err(ElevateError::Other(e)) => {
                    return Err(InstallerFailure::new(
                        format!("请求管理员权限失败：{}", e),
                        true,
                    ));
                }
            }
        }
        Ok(true) => {
            // Already elevated and STILL can't write — not a permission
            // problem. Most likely an antivirus / EDR holds a file open.
            // Bail with a directive error rather than looping UAC.
            return Err(InstallerFailure::new(
                format!(
                    "无法写入安装目录 {} (已使用管理员权限)。可能被杀软或其他进程锁定，请将该目录加入杀软白名单后重试",
                    args.app_dir.display()
                ),
                true,
            ));
        }
        Ok(false) => {
            // Writable; continue normal flow.
        }
        Err(e) => {
            // Probe itself errored unexpectedly. Don't block the update —
            // fall through to the existing copy_with_retry which has its own
            // diagnostics. Logged in needs_elevation already.
            logger::warn(format!(
                "[elevate] probe inconclusive ({}); proceeding without elevation",
                e
            ));
        }
    }

    // 2. Mark lock so a racing main-process restart waits.
    if let Some(parent) = args.lock.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&args.lock, b"updating")
        .map_err(|error| InstallerFailure::new(error.to_string(), true))?;

    // 3. Extract zip into a subdir of workdir. Child dirs preserve the
    //    parent's `{ts}` suffix so a copy-out for support still carries the
    //    attempt timestamp regardless of whether the parent context survives.
    //    A user retry reuses this workdir, so discard any partial staging from
    //    the previous attempt before rebuilding it.
    let ts = workdir_ts(&args.workdir);
    let extract_dir = args.workdir.join(format!("cindy-update-extract-{ts}"));
    let backup_dir = args.workdir.join(format!("cindy-update-rollback-{ts}"));
    remove_staging_dir(&extract_dir)
        .map_err(|error| InstallerFailure::new(error.to_string(), true))?;
    remove_staging_dir(&backup_dir)
        .map_err(|error| InstallerFailure::new(error.to_string(), true))?;
    fs::create_dir_all(&extract_dir)
        .map_err(|error| InstallerFailure::new(error.to_string(), true))?;
    logger::info(format!("[installer] extract_dir={}", extract_dir.display()));
    extract_zip(&args.zip, &extract_dir, args.zip_sha256.as_deref(), |done, total| {
        let pct = if total == 0 { -1 } else { (done * 100 / total).min(100) as i32 };
        emit(InstallerEvent::Progress(
            Phase::Extracting,
            format!("解压中 {}/{}", done, total),
            pct,
        ));
    })
    .map_err(|error| InstallerFailure::new(error.to_string(), true))?;

    // 3.5. Selective backup: copy *only* the files in app_dir that the new
    //      release is about to overwrite. Files that exist in the old version
    //      but not in the new release are left untouched (we never delete),
    //      so there's nothing to restore for them. Failure here aborts BEFORE
    //      app_dir is modified — install is safe to abort with no rollback.
    emit(InstallerEvent::Phase(
        Phase::BackingUp,
        "备份当前版本…".into(),
    ));
    fs::create_dir_all(&backup_dir)
        .map_err(|error| InstallerFailure::new(error.to_string(), true))?;
    logger::info(format!("[installer] backup_dir={}", backup_dir.display()));
    snapshot_overwritten_files(&extract_dir, &args.app_dir, &backup_dir, |done, total| {
        let pct = if total == 0 { -1 } else { (done * 100 / total).min(100) as i32 };
        emit(InstallerEvent::Progress(
            Phase::BackingUp,
            format!("备份 {}/{}", done, total),
            pct,
        ));
    })
    .map_err(|error| InstallerFailure::new(error.to_string(), true))?;

    // 4–6. The risky window: replace files, drop lock, launch, verify.
    //      Wrapped so any failure triggers rollback before bubbling out.
    let install_result: anyhow::Result<()> = (|| {
        // 4. Copy new files over app_dir.
        copy_tree(&extract_dir, &args.app_dir, |done, total| {
            let pct = if total == 0 { -1 } else { (done * 100 / total).min(100) as i32 };
            emit(InstallerEvent::Progress(
                Phase::Replacing,
                format!("替换 {}/{}", done, total),
                pct,
            ));
        })?;

        // 5. Drop lock so the new process won't busy-wait on it at startup.
        let _ = fs::remove_file(&args.lock);

        // 6. Verify exe exists, launch detached, verify it actually came up.
        let exe_path = args.app_dir.join(&args.exe_name);
        if !exe_path.exists() {
            anyhow::bail!(
                "新版本主程序缺失：{} 在替换后不存在",
                exe_path.display()
            );
        }
        emit(InstallerEvent::Phase(
            Phase::Launching,
            "启动新版本…".into(),
        ));
        launch_detached(&exe_path)?;
        if !poll_until_process_running(&args.exe_name, LAUNCH_VERIFY_TIMEOUT) {
            anyhow::bail!(
                "新进程 {} 在启动 {} 秒后未出现，可能被杀软拦截或新可执行文件损坏",
                args.exe_name,
                LAUNCH_VERIFY_TIMEOUT.as_secs()
            );
        }
        Ok(())
    })();

    // Always clean extracted files. Keep the zip only after a successful
    // rollback so the user can retry; retain the backup if rollback failed.
    let cleanup_staging = |remove_zip: bool| {
        let _ = fs::remove_dir_all(&extract_dir);
        if remove_zip {
            let _ = fs::remove_file(&args.zip);
        }
    };

    match install_result {
        Ok(()) => {
            logger::info(format!(
                "[installer] LAUNCH VERIFIED: {} is running",
                args.exe_name
            ));
            let _ = fs::remove_dir_all(&backup_dir);
            cleanup_staging(true);
            Ok(())
        }
        Err(install_err) => {
            logger::error(format!("[installer] install failed: {install_err}"));
            emit(InstallerEvent::Phase(
                Phase::RollingBack,
                "更新失败，正在回滚到旧版本…".into(),
            ));
            match rollback(&backup_dir, &args.app_dir, |done, total| {
                let pct = if total == 0 { -1 } else { (done * 100 / total).min(100) as i32 };
                emit(InstallerEvent::Progress(
                    Phase::RollingBack,
                    format!("回滚 {}/{}", done, total),
                    pct,
                ));
            }) {
                Ok(()) => {
                    logger::info("[installer] rollback succeeded");
                    let _ = fs::remove_dir_all(&backup_dir);
                    // Keep the archive so the user can retry after a failed
                    // replacement/launch once rollback restored the old app.
                    cleanup_staging(false);
                    // Remove the archive from Electron's auto-apply path BEFORE
                    // restarting the restored app. If isolation fails, retain
                    // the original no-retry cleanup behavior.
                    let can_retry = prepare_retry_archive(args);
                    if !can_retry {
                        let _ = fs::remove_file(&args.zip);
                    }
                    // Best-effort relaunch of the (now restored) old exe so
                    // the user isn't left without the app after a failed
                    // update. If it fails to start, the Failed UI still
                    // tells them what happened.
                    let exe_path = args.app_dir.join(&args.exe_name);
                    if exe_path.exists() {
                        if let Err(e) = launch_detached(&exe_path) {
                            logger::warn(format!(
                                "[installer] relaunch of old exe after rollback failed: {e}"
                            ));
                        } else {
                            logger::info(format!(
                                "[installer] relaunched old exe at {}",
                                exe_path.display()
                            ));
                        }
                    }
                    let _ = fs::remove_file(&args.lock);
                    return Err(InstallerFailure::new(
                        format!("{} (已回滚到旧版本)", install_err),
                        can_retry,
                    ));
                }
                Err(rb_err) => {
                    logger::error(format!(
                        "[installer] ROLLBACK ALSO FAILED: {rb_err} — appDir is now in an inconsistent state, see {}",
                        backup_dir.display()
                    ));
                    // KEEP backup_dir — user / support may need to manually
                    // restore. Staging is still cleaned (it's never useful
                    // for recovery, only the backup is).
                    cleanup_staging(true);
                    return Err(InstallerFailure::new(
                        format!(
                            "{} (回滚也失败：{}；备份保留在 {} 供手动恢复)",
                            install_err,
                            rb_err,
                            backup_dir.display()
                        ),
                        false,
                    ));
                }
            }
        }
    }
}

/// Remove a staging directory before reusing its path. A missing path is
/// already clean; a file at the directory path is an error rather than a
/// silently ignored collision.
fn remove_staging_dir(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("staging path is not a directory: {}", path.display()),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Sweep stale `xdt-update-*` dirs/files from %TEMP% that are older than
/// `MAX_AGE_DAYS`. Last-resort cleanup for backups left behind by failed
/// rollbacks (which we intentionally do NOT auto-delete at end-of-run).
/// Best-effort: any IO failure is ignored — sweeping is purely housekeeping.
pub fn sweep_stale_temp_dirs() {
    const MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60; // 7 days
    // Broad prefixes catch:
    //   - cindy-update-{ts}/           current workdir layout (2026-07 rebrand)
    //   - xdt-update-{ts}/             legacy workdir layout
    //   - xdt-update-extract-{ts}/     legacy (pre-workdir refactor)
    //   - xdt-update-rollback-{ts}/    legacy
    //   - xdt-updater-{ts}.exe         legacy standalone updater binary
    let prefixes = ["cindy-update", "xdt-update"];
    let now = std::time::SystemTime::now();
    let temp = std::env::temp_dir();
    let entries = match fs::read_dir(&temp) {
        Ok(it) => it,
        Err(_) => return,
    };
    let mut swept = 0u32;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !prefixes.iter().any(|p| name_str.starts_with(p)) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = match meta.modified() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let age_secs = now.duration_since(modified).map(|d| d.as_secs()).unwrap_or(0);
        if age_secs < MAX_AGE_SECS {
            continue;
        }
        let path = entry.path();
        let removed = if meta.is_dir() {
            fs::remove_dir_all(&path).is_ok()
        } else {
            fs::remove_file(&path).is_ok()
        };
        if removed {
            swept += 1;
            logger::info(format!(
                "[sweep] removed stale {} (age {}d)",
                path.display(),
                age_secs / (24 * 60 * 60),
            ));
        }
    }
    if swept > 0 {
        logger::info(format!("[sweep] cleaned {} stale temp entries", swept));
    }
}

/// Pull the `{ts}` slice out of a `xdt-update-{ts}` workdir basename so
/// child names can echo the same timestamp. Falls back to a fresh chrono
/// timestamp if the basename doesn't match the convention — the dir still
/// works either way, the suffix is just for human-readable forensics.
fn workdir_ts(workdir: &Path) -> String {
    workdir
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("cindy-update-").or_else(|| n.strip_prefix("xdt-update-")))
        .map(|s| s.to_string())
        .unwrap_or_else(|| chrono::Local::now().timestamp_millis().to_string())
}

fn extract_zip<F: FnMut(u64, u64)>(
    zip_path: &Path,
    dest: &Path,
    expected_sha256: Option<&str>,
    mut on_progress: F,
) -> anyhow::Result<()> {
    let mut file = open_regular_file(zip_path)?;
    let digest = sha256_hex(&mut file)?;
    match expected_sha256 {
        Some(expected) if expected.eq_ignore_ascii_case(&digest) => {}
        Some(_) => anyhow::bail!("archive digest mismatch"),
        None => anyhow::bail!("archive digest missing"),
    }
    let mut archive = zip::ZipArchive::new(file)?;
    let total = archive.len() as u64;
    on_progress(0, total);

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let outpath = match entry.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        if entry.is_dir() {
            fs::create_dir_all(&outpath)?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out = File::create(&outpath)?;
            io::copy(&mut entry, &mut out)?;
        }
        on_progress((i as u64) + 1, total);
    }
    Ok(())
}

/// Walk `extract_dir` and copy every file that ALREADY exists at the
/// equivalent relative path under `app_dir` into `backup_dir`, mirroring
/// the directory structure. Files in app_dir that the new release does
/// NOT overwrite stay where they are — they're still intact post-rollback.
fn snapshot_overwritten_files<F: FnMut(u64, u64)>(
    extract_dir: &Path,
    app_dir: &Path,
    backup_dir: &Path,
    mut on_progress: F,
) -> anyhow::Result<()> {
    let entries: Vec<_> = walkdir::WalkDir::new(extract_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .collect();
    let total = entries.len() as u64;
    on_progress(0, total);

    for (idx, entry) in entries.iter().enumerate() {
        let rel = entry.path().strip_prefix(extract_dir)?;
        let appfile = app_dir.join(rel);
        if appfile.exists() {
            let backup_path = backup_dir.join(rel);
            if let Some(parent) = backup_path.parent() {
                fs::create_dir_all(parent)?;
            }
            copy_with_retry(&appfile, &backup_path)?;
        }
        on_progress((idx as u64) + 1, total);
    }
    Ok(())
}

/// Reverse of `snapshot_overwritten_files`: copy every file in `backup_dir`
/// back over `app_dir`. Any new files added by the failed install remain as
/// orphans in app_dir — harmless, the next clean install would remove them
/// — but the originals are restored so the old version still works. Backup
/// walk errors fail this function so callers keep the backup and disable retry.
fn rollback<F: FnMut(u64, u64)>(
    backup_dir: &Path,
    app_dir: &Path,
    mut on_progress: F,
) -> anyhow::Result<()> {
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(backup_dir) {
        let entry = entry?;
        if entry.file_type().is_file() {
            entries.push(entry);
        }
    }
    let total = entries.len() as u64;
    on_progress(0, total);

    for (idx, entry) in entries.iter().enumerate() {
        let rel = entry.path().strip_prefix(backup_dir)?;
        let target = app_dir.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        copy_with_retry(entry.path(), &target)?;
        on_progress((idx as u64) + 1, total);
    }
    Ok(())
}

fn copy_tree<F: FnMut(u64, u64)>(
    src: &Path,
    dst: &Path,
    mut on_progress: F,
) -> anyhow::Result<()> {
    let entries: Vec<_> = walkdir::WalkDir::new(src)
        .into_iter()
        .filter_map(Result::ok)
        .collect();
    let total = entries.len() as u64;
    on_progress(0, total);

    for (idx, entry) in entries.iter().enumerate() {
        let rel = entry.path().strip_prefix(src)?;
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            // overwrite is the whole point — file may be in use only if it was
            // never closed by the previous main process; we already pid-waited.
            copy_with_retry(entry.path(), &target)?;
        }
        on_progress((idx as u64) + 1, total);
    }
    Ok(())
}

/// Copy with a small retry loop. AV scanners or stale handles can briefly
/// hold a file open immediately after the main process exits, and a single
/// `fs::copy` will fail with PermissionDenied if it loses the race.
fn copy_with_retry(src: &Path, dst: &Path) -> io::Result<()> {
    const ATTEMPTS: u32 = 5;
    let mut last_err: Option<io::Error> = None;
    for attempt in 0..ATTEMPTS {
        match fs::copy(src, dst) {
            Ok(_) => return Ok(()),
            Err(e) => {
                logger::warn(format!(
                    "[copy] attempt {} failed for {}: {}",
                    attempt + 1,
                    dst.display(),
                    e
                ));
                last_err = Some(e);
                std::thread::sleep(Duration::from_millis(200 * (attempt + 1) as u64));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| io::Error::other("copy_with_retry exhausted")))
}

// io::Error::other has been stable since Rust 1.74; we require >= 1.74 in CI.

fn launch_detached(exe: &Path) -> io::Result<()> {
    use std::process::Command;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — orphan the child so
        // updater can exit immediately without taking the new app down with it.
        const FLAGS: u32 = 0x00000008 | 0x00000200;
        Command::new(exe).creation_flags(FLAGS).spawn()?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(exe).spawn()?;
    }
    Ok(())
}

fn is_process_running_by_name(name: &str) -> bool {
    let mut sys = System::new_all();
    sys.refresh_all();
    let target = name.to_lowercase();
    sys.processes().values().any(|p| {
        p.name()
            .to_string_lossy()
            .to_lowercase()
            .contains(&target)
    })
}

/// Poll sysinfo every `LAUNCH_VERIFY_POLL` until the process appears or
/// `timeout` elapses. Lets the happy path exit in ~100-300ms (typical
/// CreateProcess → tasklist register latency on Windows) instead of
/// sleeping a fixed long delay on every successful launch.
fn poll_until_process_running(name: &str, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if is_process_running_by_name(name) {
            logger::info(format!(
                "[installer] new process detected after {:?}",
                start.elapsed()
            ));
            return true;
        }
        std::thread::sleep(LAUNCH_VERIFY_POLL);
    }
    false
}

// ─────────────────── Lingering install-dir process sweep ──────────────────

/// Refresh `sys` and return `(pid, name)` of every process whose executable
/// path lives under `app_dir`, excluding ourselves. The updater runs from
/// %TEMP% (updateService copies it out of resources/ precisely so it never
/// locks the install dir), so the self-pid exclusion is just belt-and-braces.
fn collect_appdir_processes(
    sys: &mut System,
    app_dir: &Path,
    self_pid: u32,
) -> Vec<(u32, String)> {
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes()
        .iter()
        .filter_map(|(pid, p)| {
            let pid_u32 = pid.as_u32();
            if pid_u32 == self_pid {
                return None;
            }
            let exe = p.exe()?;
            if path_is_within(exe, app_dir) {
                Some((pid_u32, p.name().to_string_lossy().into_owned()))
            } else {
                None
            }
        })
        .collect()
}

/// Sweep processes still running from `app_dir` after the main process exited:
/// poll for voluntary exit up to APPDIR_PROCESS_GRACE, kill survivors, then
/// wait up to APPDIR_PROCESS_KILL_WAIT for their image locks to drop. If any
/// process survives the full grace+kill cycle, we bail (clean abort — no lock
/// was written, no files were touched yet). The user gets an error message
/// naming the culprit processes and can retry after manually ending them.
fn terminate_appdir_processes<F: FnMut(InstallerEvent)>(app_dir: &Path, emit: &mut F) -> anyhow::Result<()> {
    let self_pid = std::process::id();
    let mut sys = System::new();

    let mut lingering = collect_appdir_processes(&mut sys, app_dir, self_pid);
    if lingering.is_empty() {
        return Ok(());
    }
    logger::warn(format!(
        "[proc-sweep] {} process(es) still running from app_dir: {:?}",
        lingering.len(),
        lingering
    ));
    emit(InstallerEvent::Phase(
        Phase::Waiting,
        "等待残留进程退出…".into(),
    ));

    let grace_start = Instant::now();
    while !lingering.is_empty() && grace_start.elapsed() < APPDIR_PROCESS_GRACE {
        std::thread::sleep(APPDIR_PROCESS_POLL);
        lingering = collect_appdir_processes(&mut sys, app_dir, self_pid);
    }
    if lingering.is_empty() {
        logger::info("[proc-sweep] all lingering processes exited voluntarily");
        return Ok(());
    }

    emit(InstallerEvent::Phase(
        Phase::Waiting,
        "结束残留进程…".into(),
    ));
    for (pid, name) in &lingering {
        if let Some(p) = sys.process(sysinfo::Pid::from_u32(*pid)) {
            let killed = p.kill();
            logger::warn(format!(
                "[proc-sweep] kill {} (pid {}) → {}",
                name, pid, killed
            ));
        }
    }

    let kill_start = Instant::now();
    loop {
        lingering = collect_appdir_processes(&mut sys, app_dir, self_pid);
        if lingering.is_empty() {
            logger::info("[proc-sweep] all lingering processes gone after kill");
            return Ok(());
        }
        if kill_start.elapsed() >= APPDIR_PROCESS_KILL_WAIT {
            break;
        }
        std::thread::sleep(APPDIR_PROCESS_POLL);
    }

    let names: Vec<_> = lingering.iter().map(|(pid, name)| format!("{} (pid {})", name, pid)).collect();
    anyhow::bail!(
        "安装目录下仍有进程无法终止: {}。可能被杀软或系统保护，请手动结束后重试更新",
        names.join(", ")
    );
}

/// Component-wise "is `child` inside `parent`" check. On Windows both sides
/// are lowercased first: NTFS paths are case-insensitive and the two inputs
/// come from different sources (CLI arg vs. sysinfo) that can disagree on
/// casing (e.g. drive letter). Component-wise comparison (Path::starts_with)
/// keeps the boundary safe — `C:\a\xdt-maker2` is NOT within `C:\a\xdt-maker`.
fn path_is_within(child: &Path, parent: &Path) -> bool {
    if parent.as_os_str().is_empty() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        let child = std::path::PathBuf::from(child.to_string_lossy().to_lowercase());
        let parent = std::path::PathBuf::from(parent.to_string_lossy().to_lowercase());
        child.starts_with(&parent)
    }
    #[cfg(not(target_os = "windows"))]
    {
        child.starts_with(parent)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        archive_matches_digest, bind_zip_sha256, path_is_within, prepare_retry_archive,
        remove_staging_dir, retry_allowed, retry_available, retry_cli_args, rollback,
    };
    use crate::args::{CliArgs, ThemeArg};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    fn test_args() -> CliArgs {
        CliArgs {
            zip: PathBuf::from(r"C:\Users\Test User\update.zip"),
            app_dir: PathBuf::from(r"C:\Program Files\Cindy"),
            exe_name: "cindy.exe".into(),
            pid: 42,
            log: PathBuf::from(r"C:\Users\Test User\update.log"),
            lock: PathBuf::from(r"C:\Users\Test User\update.lock"),
            workdir: PathBuf::from(r"C:\Users\Test User\update-workdir"),
            theme: ThemeArg::Dark,
            elevated: true,
            zip_sha256: None,
        }
    }

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "cindy-updater-test-{}-{unique}-{seq}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create isolated test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn remove_staging_dir_is_idempotent_and_rejects_files() {
        let temp = TestDir::new();
        let missing = temp.0.join("missing");
        remove_staging_dir(&missing).expect("missing staging dir is already clean");

        let directory = temp.0.join("directory");
        fs::create_dir(&directory).expect("create staging directory");
        fs::write(directory.join("partial.txt"), b"partial").expect("create partial file");
        remove_staging_dir(&directory).expect("remove partial staging directory");
        assert!(!directory.exists());

        let file = temp.0.join("file");
        fs::write(&file, b"not a directory").expect("create conflicting staging file");
        assert!(remove_staging_dir(&file).is_err());
        assert!(file.exists());
    }

    #[test]
    fn retry_requires_a_readable_archive() {
        let temp = TestDir::new();
        let zip = temp.0.join("update.zip");
        fs::write(&zip, b"update").expect("create test archive");
        assert!(retry_available(&zip));
        fs::remove_file(&zip).expect("remove test archive");
        assert!(!retry_available(&zip));
        fs::create_dir(&zip).expect("create directory at archive path");
        assert!(!retry_available(&zip));
    }

    #[test]
    fn retry_is_allowed_only_when_failure_is_safe_and_archive_is_readable() {
        let temp = TestDir::new();
        let zip = temp.0.join("update.zip");
        fs::write(&zip, b"update").expect("create test archive");

        let digest = bind_zip_sha256(&mut CliArgs {
            zip: zip.clone(),
            ..test_args()
        })
        .expect("capture digest");
        assert!(retry_allowed(true, &zip, Some(&digest)));
        assert!(!retry_allowed(false, &zip, Some(&digest)));
        assert!(!retry_allowed(true, &zip, None));

        fs::remove_file(&zip).expect("remove test archive");
        assert!(!retry_allowed(true, &zip, Some(&digest)));
    }

    #[test]
    fn failed_archive_is_removed_from_electron_auto_apply_path() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.workdir = temp.0.join("workdir");
        fs::create_dir(&args.workdir).unwrap();
        args.zip = temp.0.join("update.zip");
        fs::write(&args.zip, b"archive").unwrap();
        let retry_zip = args.workdir.join("retry.zip");
        assert!(prepare_retry_archive(&args));
        assert!(!args.zip.exists());
        assert_eq!(fs::read(&retry_zip).unwrap(), b"archive");
        assert!(prepare_retry_archive(&args));
    }

    #[test]
    fn archive_isolation_does_not_overwrite_an_existing_retry_file() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.workdir = temp.0.clone();
        args.zip = temp.0.join("update.zip");
        fs::write(&args.zip, b"original").unwrap();
        fs::write(super::retry_archive(&args), b"existing").unwrap();
        assert!(!prepare_retry_archive(&args));
        assert_eq!(fs::read(&args.zip).unwrap(), b"original");
        assert_eq!(fs::read(super::retry_archive(&args)).unwrap(), b"existing");
    }

    #[test]
    fn rollback_restores_backed_up_files() {
        let temp = TestDir::new();
        let backup_dir = temp.0.join("backup");
        let app_dir = temp.0.join("app");
        fs::create_dir_all(backup_dir.join("nested")).unwrap();
        fs::create_dir_all(app_dir.join("nested")).unwrap();
        fs::write(backup_dir.join("root.txt"), b"old-root").unwrap();
        fs::write(backup_dir.join("nested").join("file.txt"), b"old-nested").unwrap();
        fs::write(app_dir.join("root.txt"), b"new-root").unwrap();
        fs::write(app_dir.join("nested").join("file.txt"), b"new-nested").unwrap();

        rollback(&backup_dir, &app_dir, |_, _| {}).expect("complete backup walk succeeds");
        assert_eq!(fs::read(app_dir.join("root.txt")).unwrap(), b"old-root");
        assert_eq!(
            fs::read(app_dir.join("nested").join("file.txt")).unwrap(),
            b"old-nested"
        );
    }

    #[test]
    fn rollback_fails_when_backup_entries_cannot_be_walked() {
        let temp = TestDir::new();
        let backup_dir = temp.0.join("missing-backup");
        let app_dir = temp.0.join("app");
        fs::create_dir(&app_dir).unwrap();
        fs::write(app_dir.join("restored.txt"), b"new").unwrap();

        let result = rollback(&backup_dir, &app_dir, |_, _| {});
        assert!(
            result.is_err(),
            "incomplete backup walk must fail rollback so retry stays disabled: {result:?}"
        );
        assert_eq!(fs::read(app_dir.join("restored.txt")).unwrap(), b"new");
    }

    #[test]
    fn retry_binds_to_the_archive_digest_captured_on_first_open() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.workdir = temp.0.join("workdir");
        fs::create_dir(&args.workdir).unwrap();
        args.zip = temp.0.join("update.zip");
        fs::write(&args.zip, b"trusted-archive").unwrap();

        bind_zip_sha256(&mut args).expect("capture digest from the first readable zip");
        let digest = args.zip_sha256.clone().expect("digest stored on args");
        assert!(archive_matches_digest(&args.zip, &digest));
        assert!(retry_allowed(true, &args.zip, args.zip_sha256.as_deref()));

        fs::write(&args.zip, b"replaced-archive").unwrap();
        assert!(!archive_matches_digest(&args.zip, &digest));
        assert!(!retry_allowed(true, &args.zip, args.zip_sha256.as_deref()));
        assert_eq!(
            bind_zip_sha256(&mut args).unwrap_err(),
            "archive_unavailable"
        );
    }

    #[test]
    fn retry_rejects_running_processes_without_terminating_them() {
        let temp = TestDir::new();
        let executable = temp.0.join("retry-process-fixture.exe");
        fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut child = Child(std::process::Command::new(&executable)
            .args(["--exact", "installer::tests::retry_process_fixture", "--ignored"])
            .stdout(std::process::Stdio::null())
            .spawn().unwrap());
        let mut args = test_args();
        args.app_dir = temp.0.clone();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while super::ensure_retry_processes_closed(&args).is_ok() {
            assert!(std::time::Instant::now() < deadline, "fixture did not appear");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(super::ensure_retry_processes_closed(&args), Err("processes_running".into()));
        assert!(child.0.try_wait().unwrap().is_none(), "retry must not kill the process");
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(super::ensure_retry_processes_closed(&args).is_ok());
    }

    #[test]
    #[ignore = "child process fixture, invoked only by the retry process test"]
    fn retry_process_fixture() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn retry_cli_args_reuses_trusted_values_and_elevation_marker() {
        let mut source = test_args();
        source.zip_sha256 = Some("abc123".into());
        let args = retry_cli_args(&source);
        let args: Vec<_> = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "--zip",
                &test_args().workdir.join("retry.zip").to_string_lossy(),
                "--app-dir",
                r"C:\Program Files\Cindy",
                "--exe-name",
                "cindy.exe",
                "--pid",
                "0",
                "--log",
                r"C:\Users\Test User\update.log",
                "--lock",
                r"C:\Users\Test User\update.lock",
                "--workdir",
                r"C:\Users\Test User\update-workdir",
                "--theme",
                "dark",
                "--zip-sha256",
                "abc123",
                "--elevated",
            ]
        );

        let mut unelevated = test_args();
        unelevated.elevated = false;
        assert!(!retry_cli_args(&unelevated)
            .iter()
            .any(|arg| arg == "--elevated"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn within_is_case_insensitive_on_windows() {
        assert!(path_is_within(
            Path::new(r"c:\users\u\appdata\local\XDT-Maker\resources\tools\adb.exe"),
            Path::new(r"C:\Users\u\AppData\Local\xdt-maker"),
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn sibling_dir_with_common_prefix_is_not_within() {
        assert!(!path_is_within(
            Path::new(r"C:\a\xdt-maker2\foo.exe"),
            Path::new(r"C:\a\xdt-maker"),
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn unrelated_path_is_not_within() {
        assert!(!path_is_within(
            Path::new(r"C:\Windows\System32\svchost.exe"),
            Path::new(r"C:\Users\u\AppData\Local\xdt-maker"),
        ));
    }

    #[test]
    fn empty_parent_never_matches() {
        assert!(!path_is_within(Path::new("/anything"), Path::new("")));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unix_within_and_boundary() {
        assert!(path_is_within(
            Path::new("/opt/xdt-maker/resources/adb"),
            Path::new("/opt/xdt-maker"),
        ));
        assert!(!path_is_within(
            Path::new("/opt/xdt-maker2/adb"),
            Path::new("/opt/xdt-maker"),
        ));
    }
}

// ─────────────────── Permission probe + self-elevation ───────────────────

/// Try to write a small probe file in `app_dir`. If creation is denied with
/// PermissionDenied, the current user can't update in place — caller should
/// elevate. Other errors (read-only FS, missing dir) are surfaced as Err so
/// the caller can decide whether to fall through or bail; for ambiguous
/// failures we currently fall through and let copy_with_retry produce the
/// real error message.
fn needs_elevation(app_dir: &Path) -> io::Result<bool> {
    // Unique per-process so concurrent updaters (defensive — shouldn't happen)
    // never collide on the same probe path.
    let probe = app_dir.join(format!(".cindy-update-write-probe-{}", std::process::id()));
    match fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&probe)
    {
        Ok(_) => {
            // Best-effort cleanup; if removal fails the file is empty + named
            // clearly as a probe, harmless leftover.
            let _ = fs::remove_file(&probe);
            Ok(false)
        }
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => Ok(true),
        Err(e) => {
            logger::warn(format!(
                "[probe] unexpected error writing to {}: {}",
                probe.display(),
                e
            ));
            Err(e)
        }
    }
}

#[derive(Debug)]
enum ElevateError {
    /// User clicked "No" on the UAC prompt (GetLastError == ERROR_CANCELLED).
    UserCancelled,
    Other(String),
}

impl std::fmt::Display for ElevateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ElevateError::UserCancelled => f.write_str("用户取消"),
            ElevateError::Other(s) => f.write_str(s),
        }
    }
}

/// Relaunch THIS updater binary with the same args plus `--elevated`, via
/// ShellExecuteExW(verb="runas"). Triggers the Windows UAC prompt. On
/// success the elevated child is spawned and the caller should exit; on
/// user cancel we surface UserCancelled so the original UI can show a
/// human-readable "已取消" message.
#[cfg(target_os = "windows")]
fn self_elevate(args: &CliArgs) -> Result<(), ElevateError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    const ERROR_CANCELLED: u32 = 1223;

    let exe = std::env::current_exe()
        .map_err(|e| ElevateError::Other(format!("current_exe failed: {}", e)))?;
    let arg_string = build_elevation_arg_string(args);

    logger::info(format!(
        "[elevate] ShellExecuteExW runas exe={} args={}",
        exe.display(),
        arg_string
    ));

    let exe_w: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb_w: Vec<u16> = OsStr::new("runas")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let params_w: Vec<u16> = OsStr::new(&arg_string)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb_w.as_ptr();
    info.lpFile = exe_w.as_ptr();
    info.lpParameters = params_w.as_ptr();
    info.nShow = SW_SHOWNORMAL as i32;

    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok != 0 {
        // Don't leak the child handle — we're not waiting on it.
        if !info.hProcess.is_null() {
            unsafe { CloseHandle(info.hProcess) };
        }
        Ok(())
    } else {
        let err = unsafe { GetLastError() };
        if err == ERROR_CANCELLED {
            Err(ElevateError::UserCancelled)
        } else {
            Err(ElevateError::Other(format!(
                "ShellExecuteExW failed, error code {}",
                err
            )))
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn self_elevate(_args: &CliArgs) -> Result<(), ElevateError> {
    Err(ElevateError::Other(
        "self-elevation is only supported on Windows".into(),
    ))
}

/// Build a Windows command-line string that re-creates the original CliArgs
/// for the elevated child, plus the `--elevated` re-entry marker. Each value
/// is quoted using CommandLineToArgvW rules so paths with spaces survive the
/// round-trip through ShellExecuteExW's single string parameter.
fn build_elevation_arg_string(args: &CliArgs) -> String {
    let theme_str = match args.theme {
        ThemeArg::Light => "light",
        ThemeArg::Dark => "dark",
        ThemeArg::Auto => "auto",
    };
    let mut pairs: Vec<(&str, String)> = vec![
        ("--zip", args.zip.to_string_lossy().into_owned()),
        ("--app-dir", args.app_dir.to_string_lossy().into_owned()),
        ("--exe-name", args.exe_name.clone()),
        ("--pid", args.pid.to_string()),
        ("--log", args.log.to_string_lossy().into_owned()),
        ("--lock", args.lock.to_string_lossy().into_owned()),
        ("--workdir", args.workdir.to_string_lossy().into_owned()),
        ("--theme", theme_str.to_string()),
    ];
    if let Some(digest) = args.zip_sha256.as_deref().filter(|digest| !digest.is_empty()) {
        pairs.push(("--zip-sha256", digest.to_string()));
    }
    let mut out = String::new();
    for (k, v) in &pairs {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(k);
        out.push(' ');
        out.push_str(&quote_cmdline_arg(v));
    }
    out.push_str(" --elevated");
    out
}

/// CommandLineToArgvW-compatible quoting. Required because ShellExecuteExW
/// takes a single string for parameters; if a path contains spaces we have
/// to quote it ourselves, and embedded quotes/backslashes have to follow the
/// MSDN doubling rules so clap on the other side parses identical tokens.
fn quote_cmdline_arg(s: &str) -> String {
    if !s.is_empty()
        && !s.contains(' ')
        && !s.contains('\t')
        && !s.contains('"')
        && !s.contains('\\')
    {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    let mut backslashes: usize = 0;
    for c in s.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                for _ in 0..=backslashes {
                    out.push('\\');
                }
                out.push('"');
                backslashes = 0;
            }
            _ => {
                for _ in 0..backslashes {
                    out.push('\\');
                }
                out.push(c);
                backslashes = 0;
            }
        }
    }
    // Trailing backslashes before the closing quote also need doubling, else
    // they'd escape the closing quote on parse.
    for _ in 0..(backslashes * 2) {
        out.push('\\');
    }
    out.push('"');
    out
}
