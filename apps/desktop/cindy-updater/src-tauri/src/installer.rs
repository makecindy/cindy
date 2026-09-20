use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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
    Failed {
        error: String,
        can_retry: bool,
        install_unmodified: bool,
        install_restored: bool,
    },
    /// Cindy has exited (or this is an in-process Retry that no longer waits).
    /// Abandoning Retry must relaunch even if `.updating` was never acquired.
    AppExited,
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

pub fn run<F: FnMut(InstallerEvent)>(args: CliArgs, emit: F) {
    run_with_lock(args, None, emit);
}

pub(crate) fn run_with_lock<F: FnMut(InstallerEvent)>(
    mut args: CliArgs,
    held_lock: Option<UpdateLock>,
    mut emit: F,
) {
    pin_install_writable(&mut args);
    let lock = held_lock;
    if let Err(error) = bind_zip_sha256(&mut args) {
        logger::error(format!("[installer] FAILED: archive unavailable ({error})"));
        let (extract_dir, backup_dir) = staging_dirs(&args);
        remove_pre_install_staging(&extract_dir, &backup_dir);
        discard_staged_archives(&args);
        if let Some(lock) = lock {
            release_update_lock(lock);
        }
        // Electron already force-quit Cindy before this process started. This
        // path never reaches run_inner's PID wait, so Close would otherwise
        // leave the unmodified install shut down. Always de-elevate: the root
        // is not pinned yet, and a medium-writable parent can swap Cindy.exe.
        relaunch_unmodified_app_after_early_failure(&args);
        emit(InstallerEvent::Failed {
            error: "更新文件已不存在或无法读取，请重新检查更新".into(),
            can_retry: false,
            install_unmodified: false,
            install_restored: false,
        });
        return;
    }
    match run_inner(&args, lock, &mut emit) {
        Ok(lock) => {
            release_update_lock(lock);
            emit(InstallerEvent::Done);
        }
        Err(failure) => {
            let (extract_dir, backup_dir) = staging_dirs(&args);
            if !failure.keep_backup {
                remove_pre_install_staging(&extract_dir, &backup_dir);
            }
            let can_retry = if failure.can_retry {
                finalize_retry_state(&args, true)
            } else {
                if failure.discard_archive {
                    discard_staged_archives(&args);
                }
                false
            };
            logger::error(format!("[installer] FAILED: {}", failure.message));
            if let Some(lock) = failure.lock {
                if can_retry {
                    // Keep the `.updating` file so Cindy waits at startup, but close
                    // the handle so in-process Retry can reopen it. create_new still
                    // rejects a second updater while the file exists.
                    retain_update_lock_file(lock);
                } else {
                    release_update_lock(lock);
                }
            }
            let relaunched_restored = failure.install_restored
                && should_relaunch_after_rollback(can_retry);
            if relaunched_restored {
                relaunch_restored_app(&args);
            }
            emit(InstallerEvent::Failed {
                error: failure.message,
                can_retry,
                install_unmodified: failure.install_unmodified,
                install_restored: failed_event_install_restored(
                    failure.install_restored,
                    relaunched_restored,
                ),
            });
        }
    }
}

struct InstallerFailure {
    message: String,
    can_retry: bool,
    /// Terminal archive errors must delete Electron's staged ZIP. UAC cancel
    /// leaves a still-valid package in place so the next Cindy launch can
    /// apply it without a TEMP `runas` from this updater.
    discard_archive: bool,
    /// Keep the rollback directory only after a real rollback failure. Extract
    /// and snapshot errors happen before app_dir is rewritten, so their
    /// elevated staging under app_dir must be deleted.
    keep_backup: bool,
    /// True until copy_tree starts rewriting app_dir. Close must relaunch Cindy
    /// after a terminal pre-install Retry even when Retry is no longer offered.
    install_unmodified: bool,
    /// True after rollback restored the previous files. Close must relaunch
    /// Cindy if the later digest check withdraws Retry.
    install_restored: bool,
    lock: Option<UpdateLock>,
}

impl InstallerFailure {
    fn new(message: impl Into<String>, can_retry: bool) -> Self {
        Self {
            message: message.into(),
            can_retry,
            discard_archive: !can_retry,
            keep_backup: false,
            install_unmodified: true,
            install_restored: false,
            lock: None,
        }
    }

    /// Leave Electron's staged ZIP in place. Used when this updater must stop
    /// without taking ownership — UAC cancel, or another updater already holds
    /// `.updating` and may still need the same archive.
    fn keep_archive(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            can_retry: elevation_prompt_can_retry(),
            discard_archive: false,
            keep_backup: false,
            install_unmodified: true,
            install_restored: false,
            lock: None,
        }
    }

    fn with_lock(mut self, lock: UpdateLock) -> Self {
        self.lock = Some(lock);
        self
    }
}

/// Exclusive `.updating` lock. Cindy waits on this file at startup; a second
/// updater must fail closed instead of replacing files concurrently.
pub(crate) struct UpdateLock {
    path: PathBuf,
    _file: File,
}

pub(crate) fn acquire_update_lock(path: &Path) -> Result<UpdateLock, String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x00000001;
        options.share_mode(FILE_SHARE_READ);
    }
    let mut file = options.open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            "updater_busy".to_string()
        } else {
            error.to_string()
        }
    })?;
    file.write_all(format!("updating {}\n", std::process::id()).as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(UpdateLock {
        path: path.to_path_buf(),
        _file: file,
    })
}

pub(crate) fn release_update_lock(lock: UpdateLock) {
    drop(lock._file);
    let _ = fs::remove_file(&lock.path);
}

pub(crate) fn retain_update_lock_file(lock: UpdateLock) {
    drop(lock._file);
}

fn lock_file_owned_by_this_process(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|contents| contents == format!("updating {}\n", std::process::id()))
        .unwrap_or(false)
}

fn lock_contents_owned_by_this_process(contents: &str) -> bool {
    contents == format!("updating {}\n", std::process::id())
}

/// True when `.updating` exists and does not name this process. Cindy's 30s
/// startup wait can delete this window's leftover; a later updater then owns
/// the same path. Close must not relaunch into that replace window.
pub(crate) fn lock_owned_by_foreign_process(path: &Path) -> bool {
    path.exists() && !lock_file_owned_by_this_process(path)
}

/// Close / abandon Retry must delete a retained `.updating` file. Cindy's
/// startup lock loop cannot tell this leftover from a live updater and would
/// otherwise wait the full 30s timeout. Only delete a lock this process wrote;
/// a second updater that lost acquisition must not remove the first instance's
/// mutex by pathname.
pub(crate) fn release_abandoned_update_lock(path: &Path) {
    if lock_file_owned_by_this_process(path) {
        let _ = fs::remove_file(path);
    }
}

pub(crate) fn should_relaunch_after_abandoning_retry(
    can_retry: bool,
    retry_in_progress: bool,
    install_unmodified: bool,
    install_restored: bool,
) -> bool {
    !retry_in_progress && (can_retry || install_unmodified || install_restored)
}

/// Alt+F4 / 关闭 must not destroy the updater until the install worker has
/// reached Done or Failed. The first attempt never sets `retry_started`, so
/// blocking only on that flag would relaunch Cindy from a half-replaced tree.
pub(crate) fn close_should_be_blocked(phase: Phase, retry_in_progress: bool) -> bool {
    retry_in_progress || !matches!(phase, Phase::Done | Phase::Failed)
}

pub(crate) fn restored_app_relaunch_path(args: &CliArgs) -> Option<PathBuf> {
    let exe = args.app_dir.join(&args.exe_name);
    exe.exists().then_some(exe)
}

/// Launching Cindy.exe from this process inherits the updater token. A
/// medium-writable per-user install can be replaced before Close; do not
/// CreateProcess it while this process is still elevated.
pub(crate) fn may_relaunch_with_current_integrity(
    cli_elevated: bool,
    process_elevated: bool,
    install_writable: bool,
) -> bool {
    !(install_writable && (cli_elevated || process_elevated))
}

fn relaunch_restored_app(args: &CliArgs) {
    let Some(exe) = restored_app_relaunch_path(args) else {
        return;
    };
    match launch_app_exe(args, &exe) {
        Ok(AppLaunch::Started) => logger::info(format!(
            "[installer] relaunched restored exe after abandoning Retry at {}",
            exe.display()
        )),
        Ok(AppLaunch::Skipped) => {}
        Err(error) => logger::warn(format!(
            "[installer] relaunch of restored exe after abandoning Retry failed: {error}"
        )),
    }
}

/// Digest failure happens before `run_inner` pins `app_dir`. A medium-writable
/// parent can replace the directory and Cindy.exe after the unelevated parent
/// drops its handle; never inherit this process's high token.
fn relaunch_unmodified_app_after_early_failure(args: &CliArgs) {
    let Some(exe) = restored_app_relaunch_path(args) else {
        return;
    };
    match launch_de_elevated(&exe) {
        Ok(()) => logger::info(format!(
            "[installer] relaunched unmodified exe after archive validation failed at {}",
            exe.display()
        )),
        Err(error) => logger::warn(format!(
            "[installer] skip elevated CreateProcess after archive validation failed {}: {error}",
            exe.display()
        )),
    }
}

enum AppLaunch {
    Started,
    Skipped,
}

fn launch_app_exe(args: &CliArgs, exe: &Path) -> io::Result<AppLaunch> {
    if may_relaunch_with_current_integrity(
        args.elevated,
        process_is_elevated(),
        resolved_install_writable(
            args,
            install_writable_for_staging(
                args.elevated,
                medium_integrity_needs_elevation(&args.app_dir),
                install_is_user_owned_for(&args.app_dir, &args.exe_name),
            ),
        ),
    ) {
        launch_detached(exe)?;
        return Ok(AppLaunch::Started);
    }
    match launch_de_elevated(exe) {
        Ok(()) => Ok(AppLaunch::Started),
        Err(error) => {
            logger::warn(format!(
                "[installer] skip elevated CreateProcess of writable exe {}: {error}",
                exe.display()
            ));
            Ok(AppLaunch::Skipped)
        }
    }
}

pub(crate) fn should_relaunch_restored_app_on_abandon(
    can_retry: bool,
    retry_in_progress: bool,
    owned_lock: bool,
    stopped_app: bool,
    foreign_lock: bool,
    install_unmodified: bool,
    install_restored: bool,
) -> bool {
    should_relaunch_after_abandoning_retry(
        can_retry,
        retry_in_progress,
        install_unmodified,
        install_restored,
    ) && (owned_lock || stopped_app)
        && !foreign_lock
}

static ABANDONED_RETRY_LOCKS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// First Close / Destroyed for this lock path wins. `quit_now` then
/// `app.exit(0)` also fires `Destroyed`; the second call must not relaunch.
pub(crate) fn begin_abandon_retry(path: &Path) -> bool {
    let mut seen = ABANDONED_RETRY_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    if seen.iter().any(|p| p == path) {
        return false;
    }
    seen.push(path.to_path_buf());
    true
}

/// User closed the failure window instead of Retry. Drop this process's
/// retained lock, then relaunch the restored Cindy if Retry had kept it closed.
/// Retryable failures can happen before `.updating` exists, so relaunch also
/// when this updater already stopped Cindy. A second updater that never owned
/// the lock and never stopped Cindy must not relaunch.
pub(crate) fn abandon_retry(
    args: &CliArgs,
    can_retry: bool,
    retry_in_progress: bool,
    stopped_app: bool,
    install_unmodified: bool,
    install_restored: bool,
) {
    if !begin_abandon_retry(&args.lock) {
        return;
    }
    let owned = lock_file_owned_by_this_process(&args.lock);
    let foreign = lock_owned_by_foreign_process(&args.lock);
    release_abandoned_update_lock(&args.lock);
    if should_relaunch_restored_app_on_abandon(
        can_retry,
        retry_in_progress,
        owned,
        stopped_app,
        foreign,
        install_unmodified,
        install_restored,
    ) {
        relaunch_restored_app(args);
    }
}

/// Re-open a lock this process already created and kept during the failure
/// window. Missing, unreadable, or foreign-owned files mean another updater is
/// active — do not take over a later process's mutex.
pub(crate) fn reopen_held_update_lock(path: &Path) -> Option<UpdateLock> {
    let mut options = fs::OpenOptions::new();
    options.write(true).read(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x00000001;
        options.share_mode(FILE_SHARE_READ);
    }
    let mut file = options.open(path).ok()?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).ok()?;
    if !lock_contents_owned_by_this_process(&contents) {
        return None;
    }
    Some(UpdateLock {
        path: path.to_path_buf(),
        _file: file,
    })
}

pub(crate) fn should_relaunch_after_rollback(can_retry: bool) -> bool {
    !can_retry
}

/// Close must not start a second Cindy after `run_with_lock` already relaunched
/// the restored app because Retry was withdrawn.
pub(crate) fn failed_event_install_restored(
    install_restored: bool,
    already_relaunched: bool,
) -> bool {
    install_restored && !already_relaunched
}

/// Retry cannot request UAC. Failures before the permission probe must not
/// advertise Retry when this install still needs elevation.
pub(crate) fn pre_elevation_failure_can_retry(needs_uac: bool, already_elevated: bool) -> bool {
    already_elevated || !needs_uac
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
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Rust's default Windows share mode permits concurrent writers and
        // deleters. Digest verification and ZipArchive must hold one handle
        // that denies both for the entire verify-and-extract transaction.
        const FILE_SHARE_READ: u32 = 0x00000001;
        options.share_mode(FILE_SHARE_READ);
    }
    let file = options.open(zip)?;
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

/// Verify the archive against the manifest digest supplied by Electron. Later
/// elevation and retry reuse that digest so a TEMP replacement cannot be extracted.
pub(crate) fn bind_zip_sha256(args: &mut CliArgs) -> Result<String, String> {
    let expected = args
        .zip_sha256
        .as_deref()
        .filter(|digest| !digest.is_empty())
        .ok_or_else(|| "archive_unavailable".to_string())?;
    let mut file = open_regular_file(&args.zip).map_err(|_| "archive_unavailable".to_string())?;
    let digest = sha256_hex(&mut file).map_err(|_| "archive_unavailable".to_string())?;
    if expected.eq_ignore_ascii_case(&digest) {
        Ok(digest)
    } else {
        Err("archive_unavailable".into())
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

pub(crate) fn retry_archive(args: &CliArgs) -> PathBuf {
    args.workdir.join("retry.zip")
}

/// Recheck the persisted retry state. The digest must come from the same
/// `CliArgs` that Retry will spawn, not a copy that never received the bind.
pub(crate) fn retry_request_allowed(
    args: &CliArgs,
    phase: Phase,
    can_retry: bool,
) -> Result<(), String> {
    if phase != Phase::Failed || !can_retry {
        return Err("unavailable".into());
    }
    let digest = args.zip_sha256.as_deref().unwrap_or("");
    if digest.is_empty() || !archive_matches_digest(&retry_archive(args), digest) {
        return Err("archive_unavailable".into());
    }
    Ok(())
}

/// Elevated retries copy into a UAC-protected install dir. Staging under the
/// unelevated `%TEMP%` workdir would let a medium-integrity process replace
/// extracted files before `copy_tree`. Keep extract/backup next to the app
/// instead; unelevated installs stay in the temp workdir.
///
/// Electron's normal spawn omits `--elevated`. The updater is `asInvoker`, so a
/// Cindy that is already running elevated hands this process a high token with
/// `args.elevated == false`. Staging must follow the real token, not the flag.
///
/// Do not ask an already-elevated token whether `app_dir` is writable: after
/// UAC, Program Files looks writable and would send extract/backup back to the
/// unelevated `%TEMP%` workdir. `--elevated` is the pre-UAC classification of a
/// protected install. Inherited elevation must classify with the linked
/// medium-integrity token instead: a per-user install is still writable by the
/// same user's medium processes, so extract/backup stay in TEMP.
pub(crate) fn install_writable_for_staging(
    cli_elevated: bool,
    medium_integrity_needs_elevation: bool,
    user_owned: bool,
) -> bool {
    !cli_elevated && (!medium_integrity_needs_elevation || user_owned)
}

/// True when a same-login medium-integrity process can modify `app_dir`.
/// Ownership alone is not enough: an Administrators-owned directory can still
/// grant the current user modify access. Unknown AccessCheck fails toward
/// High-IL staging instead of treating the tree as protected.
pub(crate) fn install_is_user_owned_for(app_dir: &Path, exe_name: &str) -> bool {
    install_is_medium_writable_from_file_access(
        directory_medium_token_can_modify(app_dir),
        existing_install_files_medium_writable(app_dir, exe_name),
    ) || matches!(directory_owned_by_current_user(app_dir), Some(true))
        || install_root_parent_is_medium_replaceable(app_dir)
}

pub(crate) fn install_is_medium_writable_from_access(
    medium_can_modify: Option<bool>,
    owned_by_current_user: Option<bool>,
) -> bool {
    !matches!(medium_can_modify, Some(false)) || matches!(owned_by_current_user, Some(true))
}

/// Directory FILE_ADD_FILE can be denied while Cindy.exe itself remains
/// writable. That still needs High-IL staging and a de-elevated launch.
pub(crate) fn install_is_medium_writable_from_file_access(
    directory_can_modify: Option<bool>,
    files_can_modify: Option<bool>,
) -> bool {
    !matches!(directory_can_modify, Some(false)) || matches!(files_can_modify, Some(true))
}

fn existing_install_files_medium_writable(app_dir: &Path, exe_name: &str) -> Option<bool> {
    #[cfg(windows)]
    {
        existing_install_files_medium_writable_windows(app_dir, exe_name)
    }
    #[cfg(not(windows))]
    {
        let _ = exe_name;
        runtime_trees_pin_install_writable(app_dir).then_some(true)
    }
}

/// Existing loadable inputs a medium-integrity process can replace to hijack
/// an elevated launch: the main exe, `resources/app.asar`, app-local native
/// binaries, every unpacked file under `resources/app.asar.unpacked`
/// (Forge unpacks JS such as `node-pty` that production later `require`s),
/// extraResource natives under `resources/tools` (the Windows desktop host
/// `.node` is required into the main process), Forge extraResource
/// `resources/drizzle` companions that startup `require()`s, and the
/// `resources/windows-installation-version.ps1` extraResource that packaged
/// Windows startup reads and runs through System32 PowerShell.
pub(crate) fn medium_writable_install_file_candidates(
    app_dir: &Path,
    exe_name: &str,
) -> Vec<PathBuf> {
    let mut candidates = vec![
        app_dir.join(exe_name),
        app_dir.join("resources").join("app.asar"),
        app_dir
            .join("resources")
            .join("windows-installation-version.ps1"),
    ];
    let _ = collect_medium_writable_root_natives(app_dir, &mut candidates);
    let _ = collect_medium_writable_unpacked_files(
        &app_dir.join("resources").join("app.asar.unpacked"),
        &mut candidates,
    );
    let _ = collect_medium_writable_unpacked_files(
        &app_dir.join("resources").join("tools"),
        &mut candidates,
    );
    let _ = collect_medium_writable_unpacked_files(
        &app_dir.join("resources").join("drizzle"),
        &mut candidates,
    );
    candidates
}

fn is_medium_writable_native_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ext.eq_ignore_ascii_case("dll")
                || ext.eq_ignore_ascii_case("exe")
                || ext.eq_ignore_ascii_case("node")
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UnpackedWalk {
    Complete,
    Unreadable,
    Reparse,
}

pub(crate) fn unpacked_walk_pins_install_writable(walk: UnpackedWalk) -> bool {
    matches!(walk, UnpackedWalk::Unreadable | UnpackedWalk::Reparse)
}

fn runtime_trees_pin_install_writable(app_dir: &Path) -> bool {
    let mut sink = Vec::new();
    unpacked_walk_pins_install_writable(collect_medium_writable_root_natives(app_dir, &mut sink))
        || unpacked_walk_pins_install_writable(unpacked_tree_walk(app_dir))
        || unpacked_walk_pins_install_writable(extra_resource_tools_walk(app_dir))
        || unpacked_walk_pins_install_writable(extra_resource_drizzle_walk(app_dir))
}

fn extra_resource_tools_walk(app_dir: &Path) -> UnpackedWalk {
    let mut sink = Vec::new();
    collect_medium_writable_unpacked_files(&app_dir.join("resources").join("tools"), &mut sink)
}

fn extra_resource_drizzle_walk(app_dir: &Path) -> UnpackedWalk {
    let mut sink = Vec::new();
    collect_medium_writable_unpacked_files(&app_dir.join("resources").join("drizzle"), &mut sink)
}

pub(crate) fn loadable_input_is_reparse(path: &Path) -> bool {
    path.exists() && is_reparse_point(path)
}

fn unpacked_tree_walk(app_dir: &Path) -> UnpackedWalk {
    let mut sink = Vec::new();
    collect_medium_writable_unpacked_files(
        &app_dir.join("resources").join("app.asar.unpacked"),
        &mut sink,
    )
}

pub(crate) fn collect_medium_writable_root_natives(
    app_dir: &Path,
    out: &mut Vec<PathBuf>,
) -> UnpackedWalk {
    if is_reparse_point(app_dir) {
        return UnpackedWalk::Reparse;
    }
    let entries = match fs::read_dir(app_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return UnpackedWalk::Complete;
        }
        Err(_) => return UnpackedWalk::Unreadable,
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => return UnpackedWalk::Unreadable,
        };
        let path = entry.path();
        if !is_medium_writable_native_file(&path) {
            continue;
        }
        if is_reparse_point(&path) {
            return UnpackedWalk::Reparse;
        }
        out.push(path);
    }
    UnpackedWalk::Complete
}

/// GENERIC_WRITE, FILE_WRITE_DATA / FILE_APPEND_DATA, DELETE, or parent
/// FILE_DELETE_CHILD / FILE_ADD_FILE each lets a medium-integrity process
/// replace a loadable input before Close. GENERIC_WRITE is denied unless every
/// mapped write right is granted, so data/append must be probed on their own.
pub(crate) fn file_is_medium_replaceable_from_access(
    generic_write: Option<bool>,
    delete: Option<bool>,
    parent_delete_child: Option<bool>,
    parent_add_file: Option<bool>,
    write_data: Option<bool>,
    append_data: Option<bool>,
) -> Option<bool> {
    if matches!(generic_write, Some(true))
        || matches!(delete, Some(true))
        || matches!(parent_delete_child, Some(true))
        || matches!(parent_add_file, Some(true))
        || matches!(write_data, Some(true))
        || matches!(append_data, Some(true))
    {
        return Some(true);
    }
    if matches!(generic_write, Some(false))
        && matches!(delete, Some(false))
        && matches!(parent_delete_child, Some(false))
        && matches!(parent_add_file, Some(false))
        && matches!(write_data, Some(false))
        && matches!(append_data, Some(false))
    {
        return Some(false);
    }
    None
}

/// WRITE_DAC / WRITE_OWNER are enough to replace Cindy.exe after UAC even when
/// the current DACL denies add/write/delete. Unknown ACL-control fails open
/// toward High-IL staging and a de-elevated launch.
pub(crate) fn acl_control_pins_install_writable(
    write_dac: Option<bool>,
    write_owner: Option<bool>,
) -> bool {
    !matches!(write_dac, Some(false)) || !matches!(write_owner, Some(false))
}

/// FILE_DELETE_CHILD / FILE_ADD_FILE, directory DELETE / FILE_ADD_SUBDIRECTORY,
/// or ACL-control on a higher ancestor lets a medium process swap a package
/// directory to a junction after classification.
pub(crate) fn ancestor_control_pins_install_writable(
    delete_child: Option<bool>,
    add_file: Option<bool>,
    write_dac: Option<bool>,
    write_owner: Option<bool>,
    delete: Option<bool>,
    add_subdirectory: Option<bool>,
) -> bool {
    matches!(delete_child, Some(true))
        || matches!(add_file, Some(true))
        || matches!(delete, Some(true))
        || matches!(add_subdirectory, Some(true))
        || acl_control_pins_install_writable(write_dac, write_owner)
}

/// Parent FILE_DELETE_CHILD / FILE_ADD_SUBDIRECTORY or ACL-control lets a
/// medium user replace a protected-looking `app_dir` across the UAC handoff.
pub(crate) fn install_root_parent_pins_install_writable(
    delete_child: Option<bool>,
    add_subdirectory: Option<bool>,
    write_dac: Option<bool>,
    write_owner: Option<bool>,
) -> bool {
    matches!(delete_child, Some(true))
        || matches!(add_subdirectory, Some(true))
        || acl_control_pins_install_writable(write_dac, write_owner)
}

/// Directories above `app_dir` that can replace the whole install path.
/// Immediate parent is not enough: DELETE on `D:\Games` plus
/// FILE_ADD_SUBDIRECTORY on `D:\` recreates `Games\Cindy` after UAC.
pub(crate) fn install_root_ancestors(app_dir: &Path) -> Vec<PathBuf> {
    let mut ancestors = Vec::new();
    let mut current = match app_dir.parent() {
        Some(parent) => parent,
        None => return ancestors,
    };
    loop {
        ancestors.push(current.to_path_buf());
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => break,
        }
    }
    ancestors
}

/// Directories between a loadable input and `app_dir`, excluding `app_dir`.
/// Immediate parent is not enough: `node_modules/node-pty` can be replaced
/// while `lib/` still denies delete.
pub(crate) fn runtime_path_ancestors(path: &Path, app_dir: &Path) -> Vec<PathBuf> {
    let mut ancestors = Vec::new();
    let mut current = match path.parent() {
        Some(parent) => parent,
        None => return ancestors,
    };
    loop {
        if current == app_dir {
            break;
        }
        ancestors.push(current.to_path_buf());
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => break,
        }
    }
    ancestors
}

pub(crate) fn collect_medium_writable_unpacked_files(
    dir: &Path,
    out: &mut Vec<PathBuf>,
) -> UnpackedWalk {
    if is_reparse_point(dir) {
        return UnpackedWalk::Reparse;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return UnpackedWalk::Complete;
        }
        Err(_) => return UnpackedWalk::Unreadable,
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => return UnpackedWalk::Unreadable,
        };
        let path = entry.path();
        if is_reparse_point(&path) {
            return UnpackedWalk::Reparse;
        }
        let Ok(file_type) = entry.file_type() else {
            return UnpackedWalk::Unreadable;
        };
        if file_type.is_dir() {
            let nested = collect_medium_writable_unpacked_files(&path, out);
            if unpacked_walk_pins_install_writable(nested) {
                return nested;
            }
            continue;
        }
        if file_type.is_file() {
            out.push(path);
        }
    }
    UnpackedWalk::Complete
}

/// CreateFile GENERIC_WRITE can fail because the image is mapped, not because
/// the DACL denies write. Sharing/lock is not proof the file is protected.
pub(crate) fn file_write_probe_from_os_error(
    kind: io::ErrorKind,
    raw: Option<i32>,
) -> Option<bool> {
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    match raw {
        Some(ERROR_SHARING_VIOLATION) | Some(ERROR_LOCK_VIOLATION) => Some(true),
        Some(ERROR_ACCESS_DENIED) => Some(false),
        _ if kind == io::ErrorKind::PermissionDenied => Some(false),
        _ => None,
    }
}

fn directory_medium_token_can_modify(app_dir: &Path) -> Option<bool> {
    #[cfg(windows)]
    {
        directory_medium_token_can_modify_windows(app_dir)
    }
    #[cfg(not(windows))]
    {
        let _ = app_dir;
        None
    }
}

fn directory_owned_by_current_user(app_dir: &Path) -> Option<bool> {
    #[cfg(windows)]
    {
        directory_owned_by_current_user_windows(app_dir)
    }
    #[cfg(not(windows))]
    {
        let _ = app_dir;
        None
    }
}

fn install_root_parent_is_medium_replaceable(app_dir: &Path) -> bool {
    #[cfg(windows)]
    {
        install_root_parent_is_medium_replaceable_windows(app_dir)
    }
    #[cfg(not(windows))]
    {
        let _ = app_dir;
        false
    }
}

pub(crate) fn install_is_protected_system_for(app_dir: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| windows_path_is_within(app_dir, root))
}

/// Case-insensitive Windows path prefix, used even when this crate is tested
/// on macOS so LocalAppData / Program Files classification stays honest.
fn windows_path_is_within(child: &Path, parent: &Path) -> bool {
    let child = child.to_string_lossy().replace('/', "\\").to_lowercase();
    let parent = parent.to_string_lossy().replace('/', "\\").to_lowercase();
    if parent.is_empty() {
        return false;
    }
    child == parent
        || child.starts_with(&format!("{parent}\\"))
}

pub(crate) fn pin_install_writable(args: &mut CliArgs) {
    if args.install_writable.is_some() {
        return;
    }
    args.install_writable = Some(install_writable_for_staging(
        args.elevated,
        !args.elevated && medium_integrity_needs_elevation(&args.app_dir),
        install_is_user_owned_for(&args.app_dir, &args.exe_name),
    ));
}

fn resolved_install_writable(args: &CliArgs, probed: bool) -> bool {
    args.install_writable.unwrap_or(probed)
}

pub(crate) fn staging_dirs(args: &CliArgs) -> (PathBuf, PathBuf) {
    let process_elevated = process_is_elevated();
    let probed = install_writable_for_staging(
        args.elevated,
        !args.elevated && medium_integrity_needs_elevation(&args.app_dir),
        install_is_user_owned_for(&args.app_dir, &args.exe_name),
    );
    staging_dirs_for(args, process_elevated, resolved_install_writable(args, probed))
}

pub(crate) fn uses_protected_staging(
    cli_elevated: bool,
    process_elevated: bool,
    install_writable: bool,
) -> bool {
    (cli_elevated || process_elevated) && !install_writable
}

/// Elevated + medium-writable: `app_dir` and `%TEMP%` are both plantable.
/// Stage under a High-IL directory the same-login medium token cannot write.
pub(crate) fn uses_elevated_private_staging(
    cli_elevated: bool,
    process_elevated: bool,
    install_writable: bool,
) -> bool {
    (cli_elevated || process_elevated) && install_writable
}

pub(crate) fn elevated_private_staging_root(args: &CliArgs) -> PathBuf {
    protected_staging_base().join(format!("cindy-update-{}", workdir_ts(&args.workdir)))
}

fn protected_staging_base() -> PathBuf {
    trusted_staging_ancestor()
}

fn trusted_staging_ancestor() -> PathBuf {
    #[cfg(windows)]
    {
        program_data_dir()
    }
    #[cfg(not(windows))]
    {
        std::env::temp_dir().join("cindy-update-elevated")
    }
}

/// System ProgramData, independent of an inherited `ProgramData` environment
/// variable a medium-integrity process could override.
#[cfg(windows)]
pub(crate) fn program_data_dir() -> PathBuf {
    known_folder_program_data().unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
}

#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn program_data_dir() -> PathBuf {
    PathBuf::from(r"C:\ProgramData")
}

#[cfg(windows)]
fn known_folder_program_data() -> Option<PathBuf> {
    known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_ProgramData)
}

#[cfg(windows)]
fn known_folder(folder_id: &windows_sys::core::GUID) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::SHGetKnownFolderPath;

    let mut path: windows_sys::core::PWSTR = std::ptr::null_mut();
    let hr = unsafe { SHGetKnownFolderPath(folder_id, 0, std::ptr::null_mut(), &mut path) };
    if hr != 0 || path.is_null() {
        return None;
    }
    let wide = unsafe {
        let mut len = 0usize;
        while *path.add(len) != 0 {
            len += 1;
        }
        std::slice::from_raw_parts(path, len)
    };
    let os = std::ffi::OsString::from_wide(wide);
    unsafe {
        CoTaskMemFree(path.cast());
    }
    Some(PathBuf::from(os))
}

pub(crate) fn uses_private_staging_acl(path: &Path, private_root: &Path) -> bool {
    path.starts_with(private_root)
}

pub(crate) fn staging_dirs_for(
    args: &CliArgs,
    process_elevated: bool,
    install_writable: bool,
) -> (PathBuf, PathBuf) {
    let ts = workdir_ts(&args.workdir);
    let install_writable = resolved_install_writable(args, install_writable);
    let private_root;
    let root = if uses_protected_staging(args.elevated, process_elevated, install_writable) {
        &args.app_dir
    } else if uses_elevated_private_staging(args.elevated, process_elevated, install_writable) {
        private_root = elevated_private_staging_root(args);
        &private_root
    } else {
        &args.workdir
    };
    (
        root.join(format!("cindy-update-extract-{ts}")),
        root.join(format!("cindy-update-rollback-{ts}")),
    )
}

/// True when this process already holds an elevated Windows token.
/// `--elevated` is only set by our own `runas` child; inherited elevation from
/// an elevated Cindy spawn does not set that flag.
#[cfg(target_os = "windows")]
fn process_is_elevated() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);
        ok != 0 && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(target_os = "windows"))]
fn process_is_elevated() -> bool {
    false
}

fn medium_integrity_needs_elevation(app_dir: &Path) -> bool {
    matches!(probe_medium_integrity_needs_elevation(app_dir), Ok(true))
}

/// Writability as a same-login medium-integrity process would see it.
/// An elevated token makes Program Files look writable; impersonate the
/// linked limited token so inherited elevation does not reclassify a
/// protected install, and so per-user installs are not treated as protected.
fn probe_medium_integrity_needs_elevation(app_dir: &Path) -> io::Result<bool> {
    #[cfg(target_os = "windows")]
    {
        if process_is_elevated() {
            return match with_medium_integrity(|| needs_elevation(app_dir)) {
                Some(result) => result,
                None => {
                    logger::warn(
                        "[probe] no linked medium token; treating install as writable for staging",
                    );
                    Ok(false)
                }
            };
        }
    }
    needs_elevation(app_dir)
}

#[cfg(target_os = "windows")]
fn with_medium_integrity<T>(f: impl FnOnce() -> T) -> Option<T> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, ImpersonateLoggedOnUser, RevertToSelf, TokenLinkedToken,
        TOKEN_LINKED_TOKEN, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct LinkedImpersonation {
        token: HANDLE,
    }
    impl Drop for LinkedImpersonation {
        fn drop(&mut self) {
            unsafe {
                let _ = RevertToSelf();
                if !self.token.is_null() {
                    let _ = CloseHandle(self.token);
                }
            }
        }
    }

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut linked = TOKEN_LINKED_TOKEN {
            LinkedToken: std::ptr::null_mut(),
        };
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenLinkedToken,
            (&mut linked as *mut TOKEN_LINKED_TOKEN).cast(),
            std::mem::size_of::<TOKEN_LINKED_TOKEN>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);
        if ok == 0 || linked.LinkedToken.is_null() {
            return None;
        }
        if ImpersonateLoggedOnUser(linked.LinkedToken) == 0 {
            let _ = CloseHandle(linked.LinkedToken);
            return None;
        }
        let _impersonation = LinkedImpersonation {
            token: linked.LinkedToken,
        };
        Some(f())
    }
}

#[cfg(windows)]
const CROSS_DEVICE_ERRNO: i32 = 17; // ERROR_NOT_SAME_DEVICE
#[cfg(unix)]
const CROSS_DEVICE_ERRNO: i32 = 18; // EXDEV
#[cfg(not(any(windows, unix)))]
const CROSS_DEVICE_ERRNO: i32 = 18;

fn is_cross_device(error: &io::Error) -> bool {
    error.raw_os_error() == Some(CROSS_DEVICE_ERRNO)
}

fn prepare_retry_archive(args: &CliArgs) -> bool {
    let target = retry_archive(args);
    if args.zip == target || !args.zip.exists() {
        return retry_available(&target);
    }
    isolate_archive_with(
        &args.zip,
        &target,
        args.zip_sha256.as_deref(),
        |src, dst| fs::rename(src, dst),
    )
}

fn isolate_archive_with<F>(
    src: &Path,
    dst: &Path,
    expected_sha256: Option<&str>,
    rename: F,
) -> bool
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    if dst.exists() {
        return false;
    }
    match rename(src, dst) {
        Ok(()) => retry_available(dst),
        Err(error) if is_cross_device(&error) => copy_verified_archive(src, dst, expected_sha256),
        Err(error) => {
            logger::warn(format!("[retry] could not isolate archive: {error}"));
            false
        }
    }
}

fn copy_verified_archive(src: &Path, dst: &Path, expected_sha256: Option<&str>) -> bool {
    let Some(expected) = expected_sha256.filter(|digest| !digest.is_empty()) else {
        logger::warn("[retry] refusing cross-device copy without a trusted digest");
        return false;
    };
    let mut source = match open_regular_file(src) {
        Ok(file) => file,
        Err(error) => {
            logger::warn(format!("[retry] could not open archive for copy: {error}"));
            return false;
        }
    };
    let digest = match sha256_hex(&mut source) {
        Ok(digest) => digest,
        Err(error) => {
            logger::warn(format!("[retry] could not hash archive before copy: {error}"));
            return false;
        }
    };
    if !digest.eq_ignore_ascii_case(expected) {
        logger::warn("[retry] archive digest changed before cross-device copy");
        return false;
    }
    let copied = (|| -> io::Result<()> {
        let mut dest = File::create(dst)?;
        io::copy(&mut source, &mut dest)?;
        dest.sync_all()?;
        Ok(())
    })();
    if let Err(error) = copied {
        logger::warn(format!("[retry] cross-device copy failed: {error}"));
        let _ = fs::remove_file(dst);
        return false;
    }
    if !archive_matches_digest(dst, expected) {
        logger::warn("[retry] isolated copy did not match the trusted digest");
        let _ = fs::remove_file(dst);
        return false;
    }
    // Windows opened the source with FILE_SHARE_READ only, so deletion is
    // denied until this handle is gone.
    drop(source);
    if let Err(error) = fs::remove_file(src) {
        logger::warn(format!(
            "[retry] isolated copy but could not remove source {}: {error}",
            src.display()
        ));
        let _ = fs::remove_file(dst);
        return false;
    }
    retry_available(dst)
}

/// Retryable failures isolate the archive away from Electron's auto-apply path.
/// Terminal archive failures must delete that staged ZIP (and any isolated copy)
/// so the next Cindy launch downloads a fresh file instead of relaunching the
/// same deterministic extract error until applyAttempts is exhausted.
pub(crate) fn finalize_retry_state(args: &CliArgs, can_retry: bool) -> bool {
    if can_retry
        && prepare_retry_archive(args)
        && retry_allowed(true, &retry_archive(args), args.zip_sha256.as_deref())
    {
        true
    } else {
        discard_staged_archives(args);
        false
    }
}

fn remove_pre_install_staging(extract_dir: &Path, backup_dir: &Path) {
    if extract_dir.exists() {
        match fs::remove_dir_all(extract_dir) {
            Ok(()) => logger::info(format!(
                "[installer] removed pre-install extract staging {}",
                extract_dir.display()
            )),
            Err(error) => logger::warn(format!(
                "[installer] could not remove extract staging {}: {error}",
                extract_dir.display()
            )),
        }
    }
    if backup_dir.exists() {
        match fs::remove_dir_all(backup_dir) {
            Ok(()) => logger::info(format!(
                "[installer] removed pre-install backup staging {}",
                backup_dir.display()
            )),
            Err(error) => logger::warn(format!(
                "[installer] could not remove backup staging {}: {error}",
                backup_dir.display()
            )),
        }
    }
}

fn discard_staged_archives(args: &CliArgs) {
    let retry = retry_archive(args);
    if args.zip != retry {
        if fs::remove_file(&args.zip).is_ok() {
            logger::info(format!(
                "[retry] removed terminal archive from staged path {}",
                args.zip.display()
            ));
        }
    }
    if fs::remove_file(&retry).is_ok() {
        logger::info(format!(
            "[retry] removed terminal archive from {}",
            retry.display()
        ));
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
/// Retry continues in the already-loaded process so Windows does not search `%TEMP%`
/// for `vcruntime140*.dll` beside a freshly spawned updater executable.
pub(crate) fn retry_args(args: &CliArgs) -> CliArgs {
    CliArgs {
        zip: retry_archive(args),
        app_dir: args.app_dir.clone(),
        exe_name: args.exe_name.clone(),
        install_key: args.install_key.clone(),
        pid: 0,
        log: args.log.clone(),
        lock: args.lock.clone(),
        workdir: args.workdir.clone(),
        theme: args.theme,
        elevated: args.elevated,
        zip_sha256: args.zip_sha256.clone(),
        install_writable: args.install_writable,
    }
}

#[cfg(test)]
pub(crate) fn retry_cli_args(args: &CliArgs) -> Vec<std::ffi::OsString> {
    let retry = retry_args(args);
    let theme = match retry.theme {
        ThemeArg::Light => "light",
        ThemeArg::Dark => "dark",
        ThemeArg::Auto => "auto",
    };
    let values = [
        ("--zip", retry.zip.as_os_str()),
        ("--app-dir", retry.app_dir.as_os_str()),
        ("--exe-name", std::ffi::OsStr::new(&retry.exe_name)),
        ("--pid", std::ffi::OsStr::new("0")),
        ("--log", retry.log.as_os_str()),
        ("--lock", retry.lock.as_os_str()),
        ("--workdir", retry.workdir.as_os_str()),
        ("--theme", std::ffi::OsStr::new(theme)),
    ];
    let mut result = values
        .into_iter()
        .flat_map(|(key, value)| [std::ffi::OsString::from(key), value.to_os_string()])
        .collect::<Vec<_>>();
    if let Some(digest) = retry
        .zip_sha256
        .as_deref()
        .filter(|digest| !digest.is_empty())
    {
        result.push(std::ffi::OsString::from("--zip-sha256"));
        result.push(std::ffi::OsString::from(digest));
    }
    if retry.elevated {
        result.push(std::ffi::OsString::from("--elevated"));
    }
    result
}

fn run_inner<F: FnMut(InstallerEvent)>(
    args: &CliArgs,
    held_lock: Option<UpdateLock>,
    emit: &mut F,
) -> Result<UpdateLock, InstallerFailure> {
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
    let needs_uac = matches!(needs_elevation(&args.app_dir), Ok(true));
    let process_elevated = args.elevated || process_is_elevated();
    let pre_elevation_retry = pre_elevation_failure_can_retry(needs_uac, process_elevated);
    if !exited {
        return Err(InstallerFailure::new(
            "主程序在 60 秒内没有退出，更新中止",
            pre_elevation_retry,
        ));
    }
    emit(InstallerEvent::AppExited);
    let identity = capture_install_dir_identity(&args.app_dir).map_err(|error| {
        InstallerFailure::new(
            format!("无法钉住安装目录 {}：{error}", args.app_dir.display()),
            false,
        )
    })?;
    if identity.is_reparse {
        return Err(InstallerFailure::new(
            format!("安装目录是重解析点，拒绝继续：{}", args.app_dir.display()),
            false,
        ));
    }
    std::thread::sleep(FS_SETTLE_DELAY);
    ensure_install_dir_unchanged(&identity, &args.app_dir)
        .map_err(|error| InstallerFailure::new(error, false))?;
    let pinned = open_install_dir_handle(&args.app_dir, &identity).map_err(|error| {
        InstallerFailure::new(
            format!("无法钉住安装目录 {}：{error}", args.app_dir.display()),
            false,
        )
    })?;

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
            .map_err(|error| InstallerFailure::new(error, pre_elevation_retry))?;
    } else {
        terminate_appdir_processes(&args.app_dir, emit)
            .map_err(|error| InstallerFailure::new(error.to_string(), pre_elevation_retry))?;
    }

    // 1.5. Permission probe → optional self-elevation. Run BEFORE the lock
    //      write so cancelling UAC leaves zero on-disk state. If app_dir is
    //      not user-writable (e.g. installed under D:\ or C:\Program Files\
    //      with admin-only ACL), relaunch ourselves via ShellExecuteExW(runas)
    //      so the elevated child can replace the files. Default install path
    //      (%LOCALAPPDATA%\xdt-maker) probes successfully → no UAC, no change
    //      from prior behavior.
    match needs_elevation(&args.app_dir) {
        Ok(true) if !process_elevated => {
            logger::info(format!(
                "[elevate] app_dir {} not user-writable, requesting UAC elevation",
                args.app_dir.display()
            ));
            emit(InstallerEvent::Phase(
                Phase::RequestingElevation,
                "需要管理员权限，请在弹出的 UAC 提示中点击「是」…".into(),
            ));
            if !may_self_elevate(is_retry) {
                return Err(InstallerFailure::keep_archive(
                    "需要管理员权限，但无法从当前更新器再次请求授权。请关闭此窗口后重新检查更新",
                ));
            }
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
                    return Err(InstallerFailure::keep_archive(
                        "用户取消了管理员授权，更新已取消",
                    ));
                }
                Err(ElevateError::Other(e)) => {
                    return Err(InstallerFailure::keep_archive(format!(
                        "请求管理员权限失败：{}",
                        e
                    )));
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

    // Acquire the exclusive lock only after any UAC handoff. The unelevated
    // parent must not leave `.updating` behind for the elevated child.
    let lock = match held_lock {
        Some(lock) => lock,
        None => acquire_update_lock(&args.lock).map_err(|_| {
            InstallerFailure::keep_archive(
                "另一项更新正在进行，请关闭此窗口后重新检查更新",
            )
        })?,
    };

    let install = (|| -> Result<(), InstallerFailure> {
        let (extract_dir, backup_dir) = staging_dirs(args);
        remove_staging_dir(&extract_dir)
            .map_err(|error| InstallerFailure::new(error.to_string(), true))?;
        remove_staging_dir(&backup_dir)
            .map_err(|error| InstallerFailure::new(error.to_string(), true))?;
        ensure_staging_directory(&extract_dir, args)
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
    .map_err(|error| {
        let can_retry = extract_error_can_retry(&error);
        InstallerFailure {
            message: error.to_string(),
            can_retry,
            discard_archive: !can_retry,
            keep_backup: false,
            install_unmodified: true,
            install_restored: false,
            lock: None,
        }
    })?;

    // 3.5. Selective backup: copy *only* the files in app_dir that the new
    //      release is about to overwrite. Files that exist in the old version
    //      but not in the new release are left untouched (we never delete),
    //      so there's nothing to restore for them. Failure here aborts BEFORE
    //      app_dir is modified — install is safe to abort with no rollback.
    emit(InstallerEvent::Phase(
        Phase::BackingUp,
        "备份当前版本…".into(),
    ));
    pinned
        .ensure()
        .map_err(|error| InstallerFailure::new(error.to_string(), true))?;
    ensure_staging_directory(&backup_dir, args)
        .map_err(|error| InstallerFailure::new(error.to_string(), true))?;
    logger::info(format!("[installer] backup_dir={}", backup_dir.display()));
    snapshot_overwritten_files(&extract_dir, &pinned, &backup_dir, |done, total| {
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
        // 4. Copy new files over app_dir through the pinned directory handle.
        copy_tree_into_pinned(&extract_dir, &pinned, |done, total| {
            let pct = if total == 0 { -1 } else { (done * 100 / total).min(100) as i32 };
            emit(InstallerEvent::Progress(
                Phase::Replacing,
                format!("替换 {}/{}", done, total),
                pct,
            ));
        })?;

        // 5. Verify exe exists, launch detached, verify it actually came up.
        //    The exclusive lock stays held until `run` finishes so a racing
        //    Cindy start waits at the .updating file.
        let exe_path = pinned
            .join(Path::new(&args.exe_name))
            .map_err(|error| anyhow::anyhow!(error))?;
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
        match launch_app_exe(args, &exe_path)? {
            AppLaunch::Started => {
                if !poll_until_process_running(&args.exe_name, LAUNCH_VERIFY_TIMEOUT) {
                    anyhow::bail!(
                        "新进程 {} 在启动 {} 秒后未出现，可能被杀软拦截或新可执行文件损坏",
                        args.exe_name,
                        LAUNCH_VERIFY_TIMEOUT.as_secs()
                    );
                }
            }
            AppLaunch::Skipped => {
                anyhow::bail!(
                    "已替换文件，但无法在不继承管理员权限的情况下启动 Cindy"
                );
            }
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
            // Best-effort metadata only, outside the file replacement/rollback
            // transaction. Reuse existing elevation for HKLM, never request it.
            if let Some(key) = installation_version_key(args) {
                crate::installation_version::sync(&args.app_dir.join(&args.exe_name), &key);
            }
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
            if let Err(error) = pinned.ensure() {
                return Err(InstallerFailure::new(error.to_string(), false));
            }
            match rollback_into_pinned(&backup_dir, &pinned, |done, total| {
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
                    // Keep Cindy closed while Retry is still available. Isolation
                    // here is preliminary: finalize_retry_state may still withdraw
                    // Retry after a digest check, and only then may we relaunch.
                    logger::info(
                        "[installer] skipping Cindy relaunch until Retry is finally allowed or withdrawn",
                    );
                    return Err(InstallerFailure {
                        message: format!("{} (已回滚到旧版本)", install_err),
                        can_retry,
                        discard_archive: !can_retry,
                        keep_backup: false,
                        install_unmodified: false,
                        install_restored: true,
                        lock: None,
                    });
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
                    return Err(InstallerFailure {
                        message: format!(
                            "{} (回滚也失败：{}；备份保留在 {} 供手动恢复)",
                            install_err,
                            rb_err,
                            backup_dir.display()
                        ),
                        can_retry: false,
                        discard_archive: true,
                        keep_backup: true,
                        install_unmodified: false,
                        install_restored: false,
                        lock: None,
                    });
                }
            }
        }
    }
        })();
        match install {
            Ok(()) => Ok(lock),
            Err(failure) => Err(failure.with_lock(lock)),
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
    // TEMP still uses the historical prefixes:
    //   - cindy-update-{ts}/           current workdir layout (2026-07 rebrand)
    //   - xdt-update-{ts}/             legacy workdir layout
    //   - xdt-update-extract-{ts}/     legacy (pre-workdir refactor)
    //   - xdt-update-rollback-{ts}/    legacy
    //   - xdt-updater-{ts}.exe         legacy standalone updater binary
    // ProgramData only deletes this updater's `cindy-update-{millis}` roots.
    let now = std::time::SystemTime::now();
    sweep_stale_under(&std::env::temp_dir(), SweepNameFilter::TempPrefixes, now);
    sweep_stale_under(
        &protected_staging_base(),
        SweepNameFilter::ProgramDataOwned,
        now,
    );
}

#[derive(Clone, Copy)]
enum SweepNameFilter {
    TempPrefixes,
    ProgramDataOwned,
}

/// Exact `cindy-update-{ascii-digits}` used as the High-IL private root.
/// Prefix matches such as `cindy-update-service` are not this updater's.
pub(crate) fn is_owned_program_data_staging_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("cindy-update-") else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
}

fn name_matches_sweep(name: &str, filter: SweepNameFilter) -> bool {
    match filter {
        SweepNameFilter::TempPrefixes => {
            name.starts_with("cindy-update") || name.starts_with("xdt-update")
        }
        SweepNameFilter::ProgramDataOwned => is_owned_program_data_staging_name(name),
    }
}

fn sweep_stale_under(root: &Path, filter: SweepNameFilter, now: std::time::SystemTime) {
    const MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60; // 7 days
    let entries = match fs::read_dir(root) {
        Ok(it) => it,
        Err(_) => return,
    };
    let mut swept = 0u32;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_matches_sweep(&name_str, filter) {
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

fn extract_error_can_retry(error: &anyhow::Error) -> bool {
    !error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<zip::result::ZipError>(),
            Some(
                zip::result::ZipError::InvalidArchive(_)
                    | zip::result::ZipError::UnsupportedArchive(_)
            )
        )
    })
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
    app_dir: &PinnedInstallDir,
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
        let appfile = app_dir.join(rel)?;
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

fn rollback_into_pinned<F: FnMut(u64, u64)>(
    backup_dir: &Path,
    app_dir: &PinnedInstallDir,
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
        let target = app_dir.join(rel)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let target = app_dir.join(rel)?;
        copy_with_retry(entry.path(), &target)?;
        on_progress((idx as u64) + 1, total);
    }
    Ok(())
}

pub(crate) fn copy_tree_into_pinned<F: FnMut(u64, u64)>(
    src: &Path,
    dst: &PinnedInstallDir,
    mut on_progress: F,
) -> anyhow::Result<()> {
    dst.ensure()?;
    let entries: Vec<_> = walkdir::WalkDir::new(src)
        .into_iter()
        .filter_map(Result::ok)
        .collect();
    let total = entries.len() as u64;
    on_progress(0, total);

    for (idx, entry) in entries.iter().enumerate() {
        let rel = entry.path().strip_prefix(src)?;
        let target = dst.join(rel)?;
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
            dst.join(rel)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let target = dst.join(rel)?;
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

/// Launch Cindy with the linked medium token so a writable per-user install
/// does not inherit this process's high integrity.
fn launch_de_elevated(exe: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        return launch_with_linked_medium_token(exe);
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(io::Error::other(format!(
            "refusing to inherit elevation when launching {}",
            exe.display()
        )))
    }
}

fn ensure_staging_directory(path: &Path, args: &CliArgs) -> io::Result<()> {
    let private_root = elevated_private_staging_root(args);
    if uses_private_staging_acl(path, &private_root) {
        create_protected_staging_tree(path, &trusted_staging_ancestor())
    } else {
        fs::create_dir_all(path)
    }
}

static CREATED_PROTECTED_STAGING: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn record_created_protected_dir(path: &Path) {
    let mut seen = CREATED_PROTECTED_STAGING
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if !seen.iter().any(|p| p == path) {
        seen.push(path.to_path_buf());
    }
}

fn dir_created_by_this_process(path: &Path) -> bool {
    CREATED_PROTECTED_STAGING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|p| p == path)
}

/// Create `path` under a verified ancestor. Existing planted directories are
/// refused: applying a DACL after `create_dir_all` does not revoke handles a
/// medium-integrity process already holds. Missing components are born with
/// the High-IL descriptor.
pub(crate) fn create_protected_staging_tree(
    path: &Path,
    trusted_ancestor: &Path,
) -> io::Result<()> {
    if !path.starts_with(trusted_ancestor) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "staging path {} is outside {}",
                path.display(),
                trusted_ancestor.display()
            ),
        ));
    }
    verify_trusted_ancestor(trusted_ancestor)?;
    if path == trusted_ancestor {
        return Ok(());
    }
    let rel = path.strip_prefix(trusted_ancestor).unwrap_or(path);
    let mut cur = trusted_ancestor.to_path_buf();
    for component in rel.components() {
        cur.push(component);
        if dir_created_by_this_process(&cur) && cur.exists() && !is_reparse_point(&cur) {
            continue;
        }
        match create_directory_with_high_integrity(&cur) {
            Ok(()) => record_created_protected_dir(&cur),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "refusing pre-created staging path {}",
                        cur.display()
                    ),
                ));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InstallDirIdentity {
    pub is_reparse: bool,
    device: u64,
    inode: u64,
}

pub(crate) fn capture_install_dir_identity(path: &Path) -> io::Result<InstallDirIdentity> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() && !meta.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("install path is not a directory: {}", path.display()),
        ));
    }
    #[cfg(unix)]
    let (device, inode) = (file_device(&meta), file_inode(&meta));
    #[cfg(windows)]
    let (device, inode) = file_identity(path)?;
    Ok(InstallDirIdentity {
        is_reparse: is_reparse_point(path),
        device,
        inode,
    })
}

pub(crate) fn install_dir_identity_unchanged(
    expected: &InstallDirIdentity,
    path: &Path,
) -> bool {
    match capture_install_dir_identity(path) {
        Ok(actual) => {
            !actual.is_reparse
                && !expected.is_reparse
                && actual.device == expected.device
                && actual.inode == expected.inode
        }
        Err(_) => false,
    }
}

fn ensure_install_dir_unchanged(
    expected: &InstallDirIdentity,
    path: &Path,
) -> Result<(), String> {
    if install_dir_identity_unchanged(expected, path) {
        Ok(())
    } else {
        Err(format!(
            "安装目录在更新过程中被替换或变成重解析点，拒绝继续：{}",
            path.display()
        ))
    }
}

/// Open handle to `app_dir` that keeps the directory from being replaced for
/// the rest of backup/copy/rollback. Writes go through `join`, which
/// revalidates identity so a swapped junction cannot receive files.
pub(crate) struct PinnedInstallDir {
    path: PathBuf,
    identity: InstallDirIdentity,
    _hold: File,
}

pub(crate) fn open_install_dir_handle(
    path: &Path,
    identity: &InstallDirIdentity,
) -> io::Result<PinnedInstallDir> {
    if identity.is_reparse {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("install path is a reparse point: {}", path.display()),
        ));
    }
    let hold = open_directory_handle(path)?;
    let pinned = PinnedInstallDir {
        path: path.to_path_buf(),
        identity: identity.clone(),
        _hold: hold,
    };
    pinned.ensure()?;
    Ok(pinned)
}

impl PinnedInstallDir {
    fn ensure(&self) -> io::Result<()> {
        ensure_install_dir_unchanged(&self.identity, &self.path)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))
    }

    pub(crate) fn join(&self, rel: &Path) -> io::Result<PathBuf> {
        self.ensure()?;
        if rel.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("refusing absolute install path {}", rel.display()),
            ));
        }
        let mut cur = self.path.clone();
        for component in rel.components() {
            match component {
                std::path::Component::Normal(name) => cur.push(name),
                std::path::Component::CurDir => continue,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("refusing install path component {}", rel.display()),
                    ));
                }
            }
            if cur.exists() && is_reparse_point(&cur) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("install path is a reparse point: {}", cur.display()),
                ));
            }
        }
        Ok(cur)
    }
}

fn open_directory_handle(path: &Path) -> io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        options
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    }
    let file = options.open(path)?;
    if is_reparse_point(path) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("install path is a reparse point: {}", path.display()),
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn directory_medium_token_can_modify_windows(app_dir: &Path) -> Option<bool> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, WRITE_DAC, WRITE_OWNER,
    };
    let check = || match directory_grants_add_file(app_dir) {
        Some(true) => Some(true),
        other => {
            if acl_control_pins_install_writable(
                path_grants_access(app_dir, WRITE_DAC, FILE_FLAG_BACKUP_SEMANTICS),
                path_grants_access(app_dir, WRITE_OWNER, FILE_FLAG_BACKUP_SEMANTICS),
            ) {
                Some(true)
            } else {
                other
            }
        }
    };
    if process_is_elevated() {
        with_medium_integrity(check).flatten()
    } else {
        check()
    }
}

#[cfg(windows)]
fn directory_grants_add_file(app_dir: &Path) -> Option<bool> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_SHARE_READ, OPEN_EXISTING,
    };

    let wide: Vec<u16> = app_dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY,
            FILE_SHARE_READ,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        let err = io::Error::last_os_error();
        if err.kind() == io::ErrorKind::PermissionDenied {
            return Some(false);
        }
        return None;
    }
    unsafe {
        let _ = CloseHandle(handle);
    }
    Some(true)
}

#[cfg(windows)]
fn existing_install_files_medium_writable_windows(app_dir: &Path, exe_name: &str) -> Option<bool> {
    let check = || {
        if runtime_trees_pin_install_writable(app_dir) {
            return Some(true);
        }
        let mut saw_existing = false;
        for path in medium_writable_install_file_candidates(app_dir, exe_name) {
            if !path.exists() {
                continue;
            }
            if loadable_input_is_reparse(&path) {
                return Some(true);
            }
            saw_existing = true;
            match file_is_medium_replaceable(&path, app_dir) {
                Some(true) => return Some(true),
                Some(false) | None => {}
            }
        }
        saw_existing.then_some(false)
    };
    if process_is_elevated() {
        with_medium_integrity(check).flatten()
    } else {
        check()
    }
}

#[cfg(windows)]
fn file_is_medium_replaceable(path: &Path, app_dir: &Path) -> Option<bool> {
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL,
        FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS, FILE_WRITE_DATA, WRITE_DAC, WRITE_OWNER,
    };

    let ancestors = runtime_path_ancestors(path, app_dir);
    let parent = ancestors.first().map(|dir| dir.as_path());
    let replaceable = file_is_medium_replaceable_from_access(
        file_grants_generic_write(path),
        path_grants_access(path, DELETE, FILE_ATTRIBUTE_NORMAL),
        parent.and_then(|dir| {
            path_grants_access(dir, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS)
        }),
        parent.and_then(|dir| path_grants_access(dir, FILE_ADD_FILE, FILE_FLAG_BACKUP_SEMANTICS)),
        path_grants_access(path, FILE_WRITE_DATA, FILE_ATTRIBUTE_NORMAL),
        path_grants_access(path, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL),
    );
    if matches!(replaceable, Some(true)) {
        return Some(true);
    }
    if acl_control_pins_install_writable(
        path_grants_access(path, WRITE_DAC, FILE_ATTRIBUTE_NORMAL),
        path_grants_access(path, WRITE_OWNER, FILE_ATTRIBUTE_NORMAL),
    ) {
        return Some(true);
    }
    for dir in &ancestors {
        if loadable_input_is_reparse(dir) {
            return Some(true);
        }
        if ancestor_control_pins_install_writable(
            path_grants_access(dir, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS),
            path_grants_access(dir, FILE_ADD_FILE, FILE_FLAG_BACKUP_SEMANTICS),
            path_grants_access(dir, WRITE_DAC, FILE_FLAG_BACKUP_SEMANTICS),
            path_grants_access(dir, WRITE_OWNER, FILE_FLAG_BACKUP_SEMANTICS),
            path_grants_access(dir, DELETE, FILE_FLAG_BACKUP_SEMANTICS),
            path_grants_access(dir, FILE_ADD_SUBDIRECTORY, FILE_FLAG_BACKUP_SEMANTICS),
        ) {
            return Some(true);
        }
    }
    replaceable
}

#[cfg(windows)]
fn file_grants_generic_write(path: &Path) -> Option<bool> {
    use windows_sys::Win32::Foundation::GENERIC_WRITE;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    path_grants_access(path, GENERIC_WRITE, FILE_ATTRIBUTE_NORMAL)
}

#[cfg(windows)]
fn install_root_parent_is_medium_replaceable_windows(app_dir: &Path) -> bool {
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ADD_SUBDIRECTORY, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS, WRITE_DAC,
        WRITE_OWNER,
    };
    let check = || {
        for ancestor in install_root_ancestors(app_dir) {
            if loadable_input_is_reparse(&ancestor) {
                return true;
            }
            if ancestor_control_pins_install_writable(
                path_grants_access(&ancestor, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS),
                None,
                path_grants_access(&ancestor, WRITE_DAC, FILE_FLAG_BACKUP_SEMANTICS),
                path_grants_access(&ancestor, WRITE_OWNER, FILE_FLAG_BACKUP_SEMANTICS),
                path_grants_access(&ancestor, DELETE, FILE_FLAG_BACKUP_SEMANTICS),
                path_grants_access(&ancestor, FILE_ADD_SUBDIRECTORY, FILE_FLAG_BACKUP_SEMANTICS),
            ) {
                return true;
            }
        }
        false
    };
    if process_is_elevated() {
        with_medium_integrity(check).unwrap_or(true)
    } else {
        check()
    }
}

#[cfg(windows)]
fn path_grants_access(path: &Path, desired_access: u32, flags: u32) -> Option<bool> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, OPEN_EXISTING};

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            desired_access,
            FILE_SHARE_READ,
            std::ptr::null(),
            OPEN_EXISTING,
            flags,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        let err = io::Error::last_os_error();
        return file_write_probe_from_os_error(err.kind(), err.raw_os_error());
    }
    unsafe {
        let _ = CloseHandle(handle);
    }
    Some(true)
}

#[cfg(unix)]
fn file_device(meta: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.dev()
}

#[cfg(unix)]
fn file_inode(meta: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.ino()
}

#[cfg(windows)]
fn file_identity(path: &Path) -> io::Result<(u64, u64)> {
    use std::mem::MaybeUninit;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, GetFileInformationByHandle,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(io::Error::last_os_error());
    }

    let mut info = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let result = unsafe { GetFileInformationByHandle(handle, info.as_mut_ptr()) };
    if result == 0 {
        let error = io::Error::last_os_error();
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err(error);
    }
    let info = unsafe { info.assume_init() };
    unsafe {
        let _ = CloseHandle(handle);
    }

    let file_index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    Ok((info.dwVolumeSerialNumber as u64, file_index))
}

#[cfg(windows)]
fn directory_owned_by_current_user_windows(app_dir: &Path) -> Option<bool> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree, ERROR_SUCCESS};
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, OWNER_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
        TokenUser,
    };
    use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let wide: Vec<u16> = app_dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut owner = std::ptr::null_mut();
    let mut sd = std::ptr::null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if status != ERROR_SUCCESS || owner.is_null() {
        if !sd.is_null() {
            unsafe {
                let _ = LocalFree(sd);
            }
        }
        return None;
    }
    struct SdGuard(*mut core::ffi::c_void);
    impl Drop for SdGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = LocalFree(self.0);
                }
            }
        }
    }
    let _sd = SdGuard(sd);

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        struct TokenGuard(HANDLE);
        impl Drop for TokenGuard {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe {
                        let _ = CloseHandle(self.0);
                    }
                }
            }
        }
        let token = TokenGuard(token);
        let mut returned = 0u32;
        GetTokenInformation(
            token.0,
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut returned,
        );
        if returned == 0 {
            return None;
        }
        let mut buffer = vec![0u8; returned as usize];
        if GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            returned,
            &mut returned,
        ) == 0
        {
            return None;
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        if user.User.Sid.is_null() {
            return None;
        }
        Some(EqualSid(owner, user.User.Sid) != 0)
    }
}

fn verify_trusted_ancestor(path: &Path) -> io::Result<()> {
    if is_reparse_point(path) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("trusted ancestor is a reparse point: {}", path.display()),
        ));
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("trusted ancestor is not a directory: {}", path.display()),
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn is_reparse_point(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn create_directory_with_high_integrity(path: &Path) -> io::Result<()> {
    fs::create_dir(path)
}

#[cfg(target_os = "windows")]
fn high_integrity_security_descriptor() -> io::Result<ProtectedSecurityDescriptor> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::PSECURITY_DESCRIPTOR;

    // Admins + SYSTEM, protected DACL, High mandatory label with NO_WRITE_UP.
    let sddl: Vec<u16> = std::ffi::OsStr::new(
        "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)S:(ML;;NW;;;HI)",
    )
    .encode_wide()
    .chain(std::iter::once(0))
    .collect();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || sd.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(ProtectedSecurityDescriptor(sd))
}

#[cfg(target_os = "windows")]
struct ProtectedSecurityDescriptor(windows_sys::Win32::Security::PSECURITY_DESCRIPTOR);

#[cfg(target_os = "windows")]
impl Drop for ProtectedSecurityDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = windows_sys::Win32::Foundation::LocalFree(self.0);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn is_reparse_point(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let attrs = unsafe { GetFileAttributesW(wide.as_ptr()) };
    attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0
}

#[cfg(target_os = "windows")]
fn create_directory_with_high_integrity(path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;

    if is_reparse_point(path) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("staging path is a reparse point: {}", path.display()),
        ));
    }
    let sd = high_integrity_security_descriptor()?;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    let ok = unsafe { CreateDirectoryW(wide.as_ptr(), &attrs) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn launch_with_linked_medium_token(exe: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        DuplicateTokenEx, GetTokenInformation, SecurityImpersonation, TokenLinkedToken,
        TokenPrimary, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_LINKED_TOKEN, TOKEN_QUERY,
        TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessWithTokenW, GetCurrentProcess, OpenProcessToken, CREATE_NEW_PROCESS_GROUP,
        DETACHED_PROCESS, PROCESS_INFORMATION, STARTUPINFOW,
    };

    let exe_w: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let dir_w: Vec<u16> = exe
        .parent()
        .map(|dir| {
            dir.as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        })
        .unwrap_or_default();

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut linked = TOKEN_LINKED_TOKEN {
            LinkedToken: std::ptr::null_mut(),
        };
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenLinkedToken,
            (&mut linked as *mut TOKEN_LINKED_TOKEN).cast(),
            std::mem::size_of::<TOKEN_LINKED_TOKEN>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);
        if ok == 0 || linked.LinkedToken.is_null() {
            return Err(io::Error::other("no linked medium token"));
        }
        let mut primary: HANDLE = std::ptr::null_mut();
        let duplicated = DuplicateTokenEx(
            linked.LinkedToken,
            TOKEN_ASSIGN_PRIMARY
                | TOKEN_DUPLICATE
                | TOKEN_QUERY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_SESSIONID,
            std::ptr::null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        );
        let launch_token = if duplicated != 0 && !primary.is_null() {
            let _ = CloseHandle(linked.LinkedToken);
            primary
        } else {
            linked.LinkedToken
        };
        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut info: PROCESS_INFORMATION = std::mem::zeroed();
        let created = CreateProcessWithTokenW(
            launch_token,
            0,
            exe_w.as_ptr(),
            std::ptr::null_mut(),
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            std::ptr::null(),
            if dir_w.is_empty() {
                std::ptr::null()
            } else {
                dir_w.as_ptr()
            },
            &startup,
            &mut info,
        );
        let _ = CloseHandle(launch_token);
        if created == 0 {
            return Err(io::Error::last_os_error());
        }
        if !info.hThread.is_null() {
            let _ = CloseHandle(info.hThread);
        }
        if !info.hProcess.is_null() {
            let _ = CloseHandle(info.hProcess);
        }
        Ok(())
    }
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
        acquire_update_lock, archive_matches_digest, bind_zip_sha256, close_should_be_blocked,
        extract_error_can_retry, create_protected_staging_tree, elevated_private_staging_root,
        finalize_retry_state,
        install_writable_for_staging, is_owned_program_data_staging_name,
        lock_owned_by_foreign_process, may_relaunch_with_current_integrity, may_self_elevate,
        path_is_within, pre_elevation_failure_can_retry, prepare_retry_archive, program_data_dir,
        release_abandoned_update_lock, release_update_lock, remove_staging_dir,
        retain_update_lock_file, retry_allowed, retry_args, retry_available, retry_cli_args,
        retry_request_allowed, rollback, run, should_relaunch_after_abandoning_retry,
        should_relaunch_after_rollback, staging_dirs, staging_dirs_for,
        uses_elevated_private_staging, uses_private_staging_acl, uses_protected_staging, Phase,
    };
    use crate::args::{CliArgs, ThemeArg};
    use clap::Parser;
    use sha2::Digest;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    fn test_args() -> CliArgs {
        CliArgs {
            zip: PathBuf::from(r"C:\Users\Test User\update.zip"),
            app_dir: PathBuf::from(r"C:\Program Files\Cindy"),
            exe_name: "cindy.exe".into(),
            install_key: None,
            pid: 42,
            log: PathBuf::from(r"C:\Users\Test User\update.log"),
            lock: PathBuf::from(r"C:\Users\Test User\update.lock"),
            workdir: PathBuf::from(r"C:\Users\Test User\update-workdir"),
            theme: ThemeArg::Dark,
            elevated: true,
            zip_sha256: None,
            install_writable: None,
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
    fn program_data_sweep_keeps_unrelated_cindy_update_prefix_dirs() {
        assert!(is_owned_program_data_staging_name("cindy-update-1710000000000"));
        assert!(
            !is_owned_program_data_staging_name("cindy-update-ts"),
            "workdir leftovers that are not a millisecond timestamp are not ProgramData staging"
        );
        assert!(
            !is_owned_program_data_staging_name("cindy-update-service"),
            "a ProgramData service directory is not this updater's timestamped staging root"
        );
        assert!(!is_owned_program_data_staging_name("cindy-update"));
        assert!(!is_owned_program_data_staging_name("xdt-update-extract-1"));

        let temp = TestDir::new();
        let stale_staging = temp.0.join("cindy-update-1710000000000");
        let service = temp.0.join("cindy-update-service");
        fs::create_dir(&stale_staging).unwrap();
        fs::write(stale_staging.join("keep-marker"), b"staging").unwrap();
        fs::create_dir(&service).unwrap();
        fs::write(service.join("payload"), b"unrelated").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 60 * 60);
        fs::File::open(&stale_staging)
            .unwrap()
            .set_modified(old)
            .unwrap();
        fs::File::open(&service).unwrap().set_modified(old).unwrap();
        super::sweep_stale_under(
            &temp.0,
            super::SweepNameFilter::ProgramDataOwned,
            std::time::SystemTime::now(),
        );
        assert!(
            !stale_staging.exists(),
            "timestamped private staging older than seven days is still eligible"
        );
        assert!(
            service.exists(),
            "ProgramData sweep must not delete cindy-update-service"
        );
        assert_eq!(fs::read(service.join("payload")).unwrap(), b"unrelated");
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

        let digest = format!("{:x}", sha2::Sha256::digest(b"update"));
        bind_zip_sha256(&mut CliArgs {
            zip: zip.clone(),
            zip_sha256: Some(digest.clone()),
            ..test_args()
        })
        .expect("verify trusted digest");
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

    #[cfg(target_os = "windows")]
    #[test]
    fn archive_handle_denies_concurrent_writes_and_deletes() {
        use std::os::windows::fs::OpenOptionsExt;

        let temp = TestDir::new();
        let zip = temp.0.join("update.zip");
        fs::write(&zip, b"trusted-archive").unwrap();
        let _reader = super::open_regular_file(&zip).expect("open protected archive handle");

        assert!(fs::OpenOptions::new().write(true).open(&zip).is_err());
        assert!(fs::OpenOptions::new()
            .write(true)
            .share_mode(0x00000001 | 0x00000002 | 0x00000004)
            .open(&zip)
            .is_err());
        assert!(fs::remove_file(&zip).is_err());
    }

    #[test]
    fn deterministic_zip_format_errors_are_not_retryable() {
        let invalid = anyhow::Error::new(zip::result::ZipError::InvalidArchive(
            "invalid central directory",
        ));
        let unsupported = anyhow::Error::new(zip::result::ZipError::UnsupportedArchive(
            "unsupported compression",
        ));

        assert!(!extract_error_can_retry(&invalid));
        assert!(!extract_error_can_retry(&unsupported));
    }

    #[test]
    fn terminal_archive_errors_delete_the_electron_staged_zip() {
        let invalid = anyhow::Error::new(zip::result::ZipError::InvalidArchive(
            "invalid central directory",
        ));
        let temp = TestDir::new();
        let mut args = test_args();
        args.workdir = temp.0.join("workdir");
        fs::create_dir(&args.workdir).unwrap();
        args.zip = temp.0.join("update.zip");
        fs::write(&args.zip, b"not-a-zip").unwrap();
        fs::write(super::retry_archive(&args), b"isolated-copy").unwrap();

        assert!(!extract_error_can_retry(&invalid));
        assert!(!finalize_retry_state(
            &args,
            extract_error_can_retry(&invalid)
        ));
        assert!(
            !args.zip.exists(),
            "terminal ZIP must leave Electron's staged path so the next launch downloads a fresh copy"
        );
        assert!(
            !super::retry_archive(&args).exists(),
            "an isolated retry copy must not keep the same terminal archive around"
        );
    }

    #[test]
    fn retryable_failure_still_isolates_the_archive_for_manual_retry() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.workdir = temp.0.join("workdir");
        fs::create_dir(&args.workdir).unwrap();
        args.zip = temp.0.join("update.zip");
        fs::write(&args.zip, b"archive").unwrap();
        args.zip_sha256 = Some(format!("{:x}", sha2::Sha256::digest(b"archive")));

        assert!(finalize_retry_state(&args, true));
        assert!(!args.zip.exists());
        assert_eq!(fs::read(super::retry_archive(&args)).unwrap(), b"archive");
    }

    #[test]
    fn retry_args_reuse_trusted_state_without_respawning() {
        let mut source = test_args();
        source.zip_sha256 = Some("abc123".into());
        let retry = retry_args(&source);
        assert_eq!(retry.zip, source.workdir.join("retry.zip"));
        assert_eq!(retry.pid, 0);
        assert_eq!(retry.app_dir, source.app_dir);
        assert_eq!(retry.workdir, source.workdir);
        assert_eq!(retry.zip_sha256.as_deref(), Some("abc123"));
        assert!(retry.elevated);

        source.elevated = false;
        assert!(!retry_args(&source).elevated);
    }

    #[test]
    fn retry_must_not_rerequest_uac_from_the_temp_updater() {
        assert!(
            may_self_elevate(false),
            "the first attempt may still ShellExecute the TEMP updater once"
        );
        assert!(
            !may_self_elevate(true),
            "Retry must not runas current_exe from the Electron-created TEMP workdir"
        );
    }

    #[test]
    fn cancelled_or_failed_uac_prompt_is_not_retryable() {
        assert!(!super::elevation_prompt_can_retry());
    }

    #[test]
    fn retryable_rollback_does_not_relaunch_cindy() {
        assert!(!should_relaunch_after_rollback(true));
        assert!(should_relaunch_after_rollback(false));
    }

    #[test]
    fn install_dir_identity_rejects_a_swapped_reparse_point() {
        let temp = TestDir::new();
        let app_dir = temp.0.join("Cindy");
        fs::create_dir(&app_dir).unwrap();
        let identity = super::capture_install_dir_identity(&app_dir).expect("capture");
        assert!(
            !identity.is_reparse,
            "a normal install directory must not look like a junction"
        );
        assert!(super::install_dir_identity_unchanged(&identity, &app_dir));

        fs::remove_dir(&app_dir).unwrap();
        let planted = temp.0.join("planted");
        fs::create_dir(&planted).unwrap();
        std::os::unix::fs::symlink(&planted, &app_dir).unwrap();
        assert!(
            !super::install_dir_identity_unchanged(&identity, &app_dir),
            "elevated Retry must not copy through a junction swapped in after the first check"
        );
        assert!(
            super::capture_install_dir_identity(&app_dir)
                .expect("capture junction")
                .is_reparse
        );
    }

    #[test]
    fn elevated_retry_revalidates_app_dir_after_the_settle_delay() {
        let source = include_str!("installer.rs");
        let start = source
            .find("fn run_inner")
            .expect("run_inner");
        let end = source[start..]
            .find("copy_tree_into_pinned(&extract_dir, &pinned")
            .expect("copy_tree follows identity checks");
        let body = &source[start..start + end];
        assert!(
            body.contains("capture_install_dir_identity"),
            "pin app_dir before the settle delay, not only as a one-shot reparse check:\n{body}"
        );
        let sleep = body
            .find("FS_SETTLE_DELAY")
            .expect("settle delay");
        let after = &body[sleep..];
        assert!(
            after.contains("ensure_install_dir_unchanged"),
            "revalidate the pinned directory after the two-second window a junction can be planted:\n{after}"
        );
        let copy = source
            .find("copy_tree_into_pinned(&extract_dir, &pinned")
            .expect("copy_tree");
        let before_copy = &source[start..copy];
        assert!(
            before_copy.contains("open_install_dir_handle"),
            "hold a non-reparse app_dir handle before copy_tree, not only a path identity check:\n{before_copy}"
        );
        assert!(
            body.contains("open_install_dir_handle") && source.contains("copy_tree_into_pinned"),
            "copy_tree must write through the pinned non-reparse directory, not reopen app_dir by name:\n{body}"
        );
    }

    #[test]
    fn copy_tree_into_pinned_rejects_a_swapped_destination() {
        let temp = TestDir::new();
        let app_dir = temp.0.join("Cindy");
        let extract = temp.0.join("extract");
        fs::create_dir(&app_dir).unwrap();
        fs::create_dir(&extract).unwrap();
        fs::write(extract.join("Cindy.exe"), b"new").unwrap();
        let identity = super::capture_install_dir_identity(&app_dir).expect("capture");
        let handle = super::open_install_dir_handle(&app_dir, &identity).expect("pin");
        fs::remove_dir(&app_dir).unwrap();
        let planted = temp.0.join("planted");
        fs::create_dir(&planted).unwrap();
        std::os::unix::fs::symlink(&planted, &app_dir).unwrap();
        let error = super::copy_tree_into_pinned(&extract, &handle, |_, _| {}).unwrap_err();
        assert!(
            !planted.join("Cindy.exe").exists(),
            "elevated Retry must not copy through a junction swapped after the identity check: {error}"
        );
    }

    #[test]
    fn pinned_join_rejects_a_descendant_junction() {
        let temp = TestDir::new();
        let app_dir = temp.0.join("Cindy");
        fs::create_dir(&app_dir).unwrap();
        let identity = super::capture_install_dir_identity(&app_dir).expect("capture");
        let handle = super::open_install_dir_handle(&app_dir, &identity).expect("pin");
        let planted = temp.0.join("planted");
        fs::create_dir(&planted).unwrap();
        std::os::unix::fs::symlink(&planted, app_dir.join("resources")).unwrap();
        let error = handle.join(Path::new("resources/app.asar")).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(
            !planted.join("app.asar").exists(),
            "join must refuse a descendant junction before create_dir_all/fs::copy: {error}"
        );
    }

    #[test]
    fn successful_rollback_relaunches_when_final_retry_validation_fails() {
        assert!(
            should_relaunch_after_abandoning_retry(false, false, false, true),
            "Close must relaunch Cindy after rollback restored the app even if Retry was later withdrawn"
        );
        assert!(
            !should_relaunch_after_abandoning_retry(false, false, false, false),
            "an inconsistent rollback must still not relaunch Cindy"
        );
        assert!(super::should_relaunch_restored_app_on_abandon(
            false, false, true, true, false, false, true
        ));

        let source = include_str!("installer.rs");
        let start = source
            .find("[installer] rollback succeeded")
            .expect("rollback success path");
        let end = source[start..]
            .find("ROLLBACK ALSO FAILED")
            .expect("failed rollback follows success");
        let inner = &source[start..start + end];
        assert!(
            !inner.contains("should_relaunch_after_rollback"),
            "preliminary isolation must not relaunch before finalize_retry_state:\n{inner}"
        );
        let outer_start = source
            .find("let can_retry = if failure.can_retry")
            .expect("outer finalize");
        let outer_end = source[outer_start..]
            .find("struct InstallerFailure")
            .expect("failure struct follows run_with_lock");
        let outer = &source[outer_start..outer_start + outer_end];
        assert!(
            outer.contains("should_relaunch_after_rollback")
                && outer.contains("install_restored"),
            "relaunch after rollback only once Retry is finally allowed or withdrawn:\n{outer}"
        );
        assert!(
            super::failed_event_install_restored(true, true) == false,
            "Close must not relaunch Cindy after run_with_lock already started the restored app"
        );
        assert!(
            super::failed_event_install_restored(true, false),
            "Close still relaunches when rollback restored the app but Retry remains available until Close"
        );
    }

    #[test]
    fn abandoning_retry_relaunches_the_restored_app() {
        assert!(
            should_relaunch_after_abandoning_retry(true, false, false, false),
            "Close after a retryable rollback must relaunch the restored Cindy"
        );
        assert!(
            !should_relaunch_after_abandoning_retry(true, true, true, true),
            "do not relaunch while an in-process Retry is still replacing files"
        );
        assert!(
            !should_relaunch_after_abandoning_retry(false, false, false, false),
            "an inconsistent rollback must not relaunch Cindy"
        );
        assert!(
            should_relaunch_after_abandoning_retry(false, false, true, false),
            "Close after a terminal pre-install Retry must relaunch the unmodified Cindy"
        );

        let temp = TestDir::new();
        let mut args = test_args();
        args.app_dir = temp.0.join("app");
        args.lock = temp.0.join(".updating");
        fs::create_dir(&args.app_dir).unwrap();
        let exe = args.app_dir.join(&args.exe_name);
        fs::write(&exe, b"cindy").unwrap();
        let held = acquire_update_lock(&args.lock).expect("retain lock while Retry is available");
        retain_update_lock_file(held);

        assert_eq!(super::restored_app_relaunch_path(&args).as_ref(), Some(&exe));
        super::abandon_retry(&args, true, false, false, false, false);
        assert!(
            !args.lock.exists(),
            "abandoning Retry still deletes this process's retained .updating"
        );
        assert!(
            !super::begin_abandon_retry(&args.lock),
            "quit_now plus window destroy must not relaunch Cindy a second time"
        );
    }

    #[test]
    fn abandoning_retry_relaunches_even_without_a_retained_lock() {
        assert!(
            should_relaunch_after_abandoning_retry(true, false, false, false),
            "retryable failures that never acquired .updating still left Cindy closed"
        );
        let temp = TestDir::new();
        let mut args = test_args();
        args.app_dir = temp.0.join("app");
        args.lock = temp.0.join(".updating");
        fs::create_dir(&args.app_dir).unwrap();
        fs::write(args.app_dir.join(&args.exe_name), b"cindy").unwrap();
        assert!(!args.lock.exists());
        assert!(super::should_relaunch_restored_app_on_abandon(
            true, false, false, true, false, false, false
        ));
        assert!(
            !super::should_relaunch_restored_app_on_abandon(
                true, false, false, true, true, true, true
            ),
            "Cindy's 30s wait can drop this window's lock; a later updater's .updating must block relaunch"
        );
        assert!(
            super::should_relaunch_restored_app_on_abandon(
                false, false, true, true, false, true, false
            ),
            "a terminal pre-install Retry left the install unmodified and Cindy stopped"
        );
        assert!(
            !super::should_relaunch_restored_app_on_abandon(
                false, false, true, true, false, false, false
            ),
            "a failed rollback must not relaunch an inconsistent Cindy.exe"
        );
        assert!(super::begin_abandon_retry(&args.lock));
        assert!(
            !super::begin_abandon_retry(&args.lock),
            "Destroyed after quit_now must not start a second restored Cindy"
        );
    }

    #[test]
    fn abandoning_retry_deletes_the_retained_lock_file() {
        let temp = TestDir::new();
        let lock = temp.0.join(".updating");
        let held = acquire_update_lock(&lock).expect("first updater holds the lock");
        retain_update_lock_file(held);
        assert!(lock.exists());
        release_abandoned_update_lock(&lock);
        assert!(
            !lock.exists(),
            "Close must delete .updating so Cindy startup does not wait 30s"
        );
    }

    #[test]
    fn abandoning_retry_does_not_relaunch_when_a_foreign_lock_exists() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.app_dir = temp.0.join("app");
        args.lock = temp.0.join(".updating");
        fs::create_dir(&args.app_dir).unwrap();
        fs::write(args.app_dir.join(&args.exe_name), b"cindy").unwrap();
        let other_pid = if std::process::id() == 1 { 2 } else { 1 };
        fs::write(&args.lock, format!("updating {other_pid}\n")).unwrap();
        assert!(lock_owned_by_foreign_process(&args.lock));
        assert!(
            !super::should_relaunch_restored_app_on_abandon(
                true, false, false, true, true, true, true
            ),
            "stopped_app must not relaunch Cindy into another updater's replace window"
        );
        super::abandon_retry(&args, true, false, true, false, false);
        assert!(
            args.lock.exists(),
            "Close must not delete another updater's .updating"
        );
        assert_eq!(
            fs::read_to_string(&args.lock).unwrap(),
            format!("updating {other_pid}\n")
        );
    }

    #[test]
    fn closing_another_updater_does_not_delete_a_retained_lock() {
        let temp = TestDir::new();
        let lock = temp.0.join(".updating");
        let other_pid = if std::process::id() == 1 { 2 } else { 1 };
        fs::write(&lock, format!("updating {other_pid}\n")).unwrap();
        release_abandoned_update_lock(&lock);
        assert!(
            lock.exists(),
            "a second updater that never retained .updating must not delete the first instance's mutex"
        );

        let owned_path = temp.0.join("owned.updating");
        let owned = acquire_update_lock(&owned_path).expect("own lock");
        retain_update_lock_file(owned);
        release_abandoned_update_lock(&owned_path);
        assert!(
            !owned_path.exists(),
            "the updater that retained .updating must still delete it on Close"
        );
    }

    #[test]
    fn pre_elevation_failures_are_not_retryable_when_uac_is_required() {
        assert!(!pre_elevation_failure_can_retry(true, false));
        assert!(pre_elevation_failure_can_retry(false, false));
        assert!(pre_elevation_failure_can_retry(true, true));
    }

    #[test]
    fn first_attempt_does_not_hold_the_lock_across_uac() {
        let source = include_str!("installer.rs");
        let wrapper = source
            .find("pub(crate) fn run_with_lock")
            .expect("run_with_lock");
        let inner = source.find("fn run_inner").expect("run_inner");
        let wrapper_body = &source[wrapper..inner];
        let bind = wrapper_body
            .find("bind_zip_sha256")
            .expect("bind before inner");
        assert!(
            !wrapper_body[..bind].contains("acquire_update_lock"),
            "the unelevated parent must not create_new the lock before UAC handoff"
        );
        let elevate = source[inner..]
            .find("match self_elevate")
            .expect("self_elevate");
        let acquire = source[inner..]
            .find("acquire_update_lock")
            .expect("lock after elevation");
        assert!(
            acquire > elevate,
            "the elevated child must acquire the lock after the UAC handoff"
        );
        let bind_err = wrapper_body
            .find("bind_zip_sha256")
            .expect("bind_zip_sha256 in run_with_lock");
        let inner_call = wrapper_body
            .find("run_inner(")
            .expect("run_inner follows bind");
        let bind_fail = &wrapper_body[bind_err..inner_call];
        assert!(
            bind_fail.contains("relaunch_unmodified_app_after_early_failure"),
            "Electron already force-quit Cindy; a pre-run_inner digest failure must relaunch the unmodified install:\n{bind_fail}"
        );
        assert!(
            !bind_fail.contains("relaunch_restored_app("),
            "digest-fail relaunch must not inherit a high token before the root is pinned:\n{bind_fail}"
        );
    }

    #[test]
    fn update_lock_rejects_a_second_updater() {
        let temp = TestDir::new();
        let lock = temp.0.join(".updating");
        let first = acquire_update_lock(&lock).expect("first updater holds the lock");
        assert!(matches!(
            acquire_update_lock(&lock),
            Err(error) if error == "updater_busy"
        ));
        release_update_lock(first);
        let second = acquire_update_lock(&lock).expect("released lock can be acquired");
        retain_update_lock_file(second);
        assert!(lock.exists());
        assert!(matches!(
            acquire_update_lock(&lock),
            Err(error) if error == "updater_busy"
        ));
        let reopened = super::reopen_held_update_lock(&lock).expect("retry reopens retained lock");
        release_update_lock(reopened);
        assert!(!lock.exists());
    }

    #[test]
    fn reopen_held_update_lock_rejects_a_lock_owned_by_another_process() {
        let temp = TestDir::new();
        let lock = temp.0.join(".updating");
        let other_pid = if std::process::id() == 1 { 2 } else { 1 };
        fs::write(&lock, format!("updating {other_pid}\n")).unwrap();
        assert!(
            super::reopen_held_update_lock(&lock).is_none(),
            "Retry must not take over a later updater's mutex just because the path still exists"
        );
        assert!(lock.exists());
    }

    #[test]
    fn busy_lock_does_not_delete_the_active_updater_archive() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.app_dir = temp.0.join("app");
        args.workdir = temp.0.join("cindy-update-ts");
        args.lock = temp.0.join(".updating");
        args.log = temp.0.join("update.log");
        args.pid = 0;
        args.elevated = true;
        fs::create_dir(&args.app_dir).unwrap();
        fs::create_dir(&args.workdir).unwrap();
        args.zip = temp.0.join("update.zip");
        fs::write(&args.zip, b"active-archive").unwrap();
        args.zip_sha256 = Some(format!("{:x}", sha2::Sha256::digest(b"active-archive")));
        let held = acquire_update_lock(&args.lock).expect("first updater holds the lock");

        let mut events = Vec::new();
        run(args.clone(), |event| events.push(event));

        assert!(
            args.zip.exists(),
            "the rejected updater must not delete the ZIP still owned by the lock holder"
        );
        assert_eq!(fs::read(&args.zip).unwrap(), b"active-archive");
        assert!(
            events
                .iter()
                .any(|event| {
                    matches!(
                        event,
                        super::InstallerEvent::Failed {
                            can_retry: false,
                            ..
                        }
                    )
                }),
            "lock contention stays non-retryable so this window does not offer Retry"
        );
        release_update_lock(held);
    }

    #[test]
    fn retry_isolation_falls_back_to_copy_when_rename_crosses_devices() {
        let temp = TestDir::new();
        let src = temp.0.join("updates").join("update.zip");
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        let dst = temp.0.join("workdir").join("retry.zip");
        fs::create_dir(dst.parent().unwrap()).unwrap();
        fs::write(&src, b"archive").unwrap();
        let digest = format!("{:x}", sha2::Sha256::digest(b"archive"));

        assert!(super::isolate_archive_with(
            &src,
            &dst,
            Some(&digest),
            |_, _| Err(std::io::Error::from_raw_os_error(super::CROSS_DEVICE_ERRNO)),
        ));
        assert!(
            !src.exists(),
            "source must be removed only after the isolated copy matches the trusted digest"
        );
        assert_eq!(fs::read(&dst).unwrap(), b"archive");
        assert!(archive_matches_digest(&dst, &digest));

        let source = include_str!("installer.rs");
        let start = source
            .find("fn copy_verified_archive")
            .expect("copy_verified_archive");
        let end = source[start..]
            .find("\n/// Retryable failures isolate")
            .expect("finalize_retry_state follows copy");
        let body = &source[start..start + end];
        let drop_at = body.find("drop(source)").expect("close the source handle");
        let remove_at = body
            .find("fs::remove_file(src)")
            .expect("delete the staged source");
        assert!(
            drop_at < remove_at,
            "Windows FILE_SHARE_READ denies delete while the copy handle is still open:\n{body}"
        );
    }

    #[test]
    fn retry_isolation_copy_fallback_keeps_source_when_digest_mismatches() {
        let temp = TestDir::new();
        let src = temp.0.join("update.zip");
        let dst = temp.0.join("retry.zip");
        fs::write(&src, b"tampered").unwrap();

        assert!(!super::isolate_archive_with(
            &src,
            &dst,
            Some(&format!("{:x}", sha2::Sha256::digest(b"trusted"))),
            |_, _| Err(std::io::Error::from_raw_os_error(super::CROSS_DEVICE_ERRNO)),
        ));
        assert!(src.exists(), "untrusted source must stay for diagnosis");
        assert!(!dst.exists(), "failed isolation must not leave a retry.zip");
    }

    #[test]
    fn pre_install_failures_remove_protected_staging_dirs() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.app_dir = temp.0.join("app");
        args.workdir = temp.0.join("cindy-update-ts");
        args.lock = temp.0.join("update.lock");
        args.log = temp.0.join("update.log");
        args.pid = 0;
        args.elevated = true;
        fs::create_dir(&args.app_dir).unwrap();
        fs::create_dir(&args.workdir).unwrap();
        args.zip = super::retry_archive(&args);
        fs::write(&args.zip, b"not-a-zip").unwrap();
        args.zip_sha256 = Some(format!("{:x}", sha2::Sha256::digest(b"not-a-zip")));
        let (extract_dir, backup_dir) = staging_dirs(&args);
        fs::create_dir_all(extract_dir.join("partial")).unwrap();
        fs::write(extract_dir.join("partial").join("Cindy.exe"), b"partial").unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        fs::write(backup_dir.join("Cindy.exe"), b"old").unwrap();

        let mut events = Vec::new();
        run(args.clone(), |event| events.push(event));

        assert!(
            !extract_dir.exists(),
            "extract staging under app_dir must not survive a pre-install failure"
        );
        assert!(
            !backup_dir.exists(),
            "backup staging under app_dir must not survive a pre-install failure"
        );
        assert!(
            events
                .iter()
                .any(|event| {
                    matches!(
                        event,
                        super::InstallerEvent::Failed {
                            can_retry: false,
                            ..
                        }
                    )
                }),
            "terminal ZIP errors stay non-retryable"
        );
    }

    #[test]
    fn zip_io_errors_remain_retryable() {
        let error = anyhow::Error::new(zip::result::ZipError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "temporarily locked",
        )));

        assert!(extract_error_can_retry(&error));
    }

    #[test]
    fn initial_archive_requires_an_externally_trusted_digest() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.workdir = temp.0.join("workdir");
        fs::create_dir(&args.workdir).unwrap();
        args.zip = temp.0.join("update.zip");
        fs::write(&args.zip, b"trusted-archive").unwrap();

        assert_eq!(bind_zip_sha256(&mut args), Err("archive_unavailable".into()));
        assert!(args.zip_sha256.is_none());
    }

    #[test]
    fn initial_archive_must_match_the_externally_trusted_digest() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.workdir = temp.0.join("workdir");
        fs::create_dir(&args.workdir).unwrap();
        args.zip = temp.0.join("update.zip");
        fs::write(&args.zip, b"trusted-archive").unwrap();
        args.zip_sha256 = Some(format!("{:x}", sha2::Sha256::digest(b"trusted-archive")));

        let digest = bind_zip_sha256(&mut args).expect("verify trusted digest");
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
    fn retry_request_uses_the_digest_stored_on_the_same_args() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.zip = temp.0.join("update.zip");
        args.workdir = temp.0.join("workdir");
        fs::create_dir(&args.workdir).unwrap();
        fs::write(&args.zip, b"trusted-archive").unwrap();
        let unbound = args.clone();
        args.zip_sha256 = Some(format!("{:x}", sha2::Sha256::digest(b"trusted-archive")));
        bind_zip_sha256(&mut args).expect("verify trusted digest");
        assert!(prepare_retry_archive(&args));
        let retry_zip = super::retry_archive(&args);
        assert_eq!(
            retry_request_allowed(&unbound, Phase::Failed, true),
            Err("archive_unavailable".into())
        );
        assert!(retry_request_allowed(&args, Phase::Failed, true).is_ok());
        assert!(archive_matches_digest(
            &retry_zip,
            args.zip_sha256.as_deref().unwrap()
        ));
    }

    #[test]
    fn elevated_staging_stays_inside_the_install_directory() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.elevated = true;
        args.app_dir = temp.0.join("Cindy");
        args.workdir = temp.0.join("workdir");
        fs::create_dir(&args.app_dir).unwrap();
        fs::create_dir(&args.workdir).unwrap();
        let (extract_dir, backup_dir) = staging_dirs_for(&args, false, false);
        assert!(extract_dir.starts_with(&args.app_dir));
        assert!(backup_dir.starts_with(&args.app_dir));
        assert!(!extract_dir.starts_with(&args.workdir));
    }

    #[test]
    fn unelevated_staging_stays_in_the_temp_workdir() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.elevated = false;
        args.app_dir = temp.0.join("Cindy");
        args.workdir = temp.0.join("workdir");
        fs::create_dir(&args.app_dir).unwrap();
        fs::create_dir(&args.workdir).unwrap();
        let (extract_dir, backup_dir) = staging_dirs_for(&args, false, false);
        assert!(extract_dir.starts_with(&args.workdir));
        assert!(backup_dir.starts_with(&args.workdir));
    }

    #[test]
    fn inherited_elevation_without_cli_flag_uses_protected_staging() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.elevated = false;
        args.app_dir = temp.0.join("Cindy");
        args.workdir = temp.0.join("workdir");
        fs::create_dir(&args.app_dir).unwrap();
        fs::create_dir(&args.workdir).unwrap();
        assert!(
            uses_protected_staging(false, true, false),
            "a high-integrity updater spawned without --elevated must not stage in TEMP"
        );
        let (extract_dir, backup_dir) = staging_dirs_for(&args, true, false);
        assert!(extract_dir.starts_with(&args.app_dir));
        assert!(backup_dir.starts_with(&args.app_dir));
        assert!(!extract_dir.starts_with(&args.workdir));

        let source = include_str!("installer.rs");
        let start = source
            .find("pub(crate) fn staging_dirs(args: &CliArgs)")
            .expect("staging_dirs");
        let helper = source[start..]
            .find("pub(crate) fn uses_protected_staging")
            .expect("uses_protected_staging");
        let body = &source[start..start + helper];
        assert!(
            body.contains("process_is_elevated()"),
            "staging_dirs must read the process token; --elevated is omitted on inherited elevation"
        );
    }

    #[test]
    fn inherited_elevation_retry_keeps_pinned_private_staging() {
        assert!(
            uses_elevated_private_staging(false, true, true),
            "inherited elevation of a per-user install must stay on High-IL ProgramData"
        );
        let temp = TestDir::new();
        let mut args = test_args();
        args.elevated = false;
        args.install_writable = Some(true);
        args.app_dir = temp.0.join("Cindy");
        args.workdir = temp.0.join("cindy-update-1710000000000");
        fs::create_dir(&args.app_dir).unwrap();
        fs::create_dir(&args.workdir).unwrap();
        let private_root = elevated_private_staging_root(&args);
        let (extract_dir, backup_dir) = staging_dirs_for(&args, true, false);
        assert!(
            extract_dir.starts_with(&private_root),
            "a later Administrators-only DACL must not move Retry staging into plantable app_dir"
        );
        assert!(backup_dir.starts_with(&private_root));
        assert!(!extract_dir.starts_with(&args.app_dir));

        let source = include_str!("installer.rs");
        let start = source
            .find("pub(crate) fn staging_dirs(args: &CliArgs)")
            .expect("staging_dirs");
        let helper = source[start..]
            .find("pub(crate) fn uses_protected_staging")
            .expect("uses_protected_staging");
        let body = &source[start..start + helper];
        assert!(
            body.contains("resolved_install_writable"),
            "Retry must pin the first writable classification instead of re-probing app_dir:\n{body}"
        );
    }

    #[test]
    fn uac_elevated_staging_ignores_a_writable_probe_of_the_install_directory() {
        let temp = TestDir::new();
        let mut args = test_args();
        args.elevated = true;
        args.app_dir = temp.0.join("Cindy");
        args.workdir = temp.0.join("workdir");
        fs::create_dir(&args.app_dir).unwrap();
        fs::create_dir(&args.workdir).unwrap();
        let (extract_dir, backup_dir) = staging_dirs(&args);
        assert!(
            extract_dir.starts_with(&args.app_dir),
            "after UAC, do not reclassify a protected install as writable just because the elevated token can write"
        );
        assert!(backup_dir.starts_with(&args.app_dir));
        assert!(!extract_dir.starts_with(&args.workdir));
    }

    #[test]
    fn elevated_staging_stays_in_temp_when_the_install_directory_is_writable() {
        assert!(
            !uses_protected_staging(false, true, true),
            "a writable per-user install is not a UAC-protected staging root"
        );
        assert!(uses_elevated_private_staging(false, true, true));
        assert!(uses_protected_staging(true, true, false));
        assert!(!uses_elevated_private_staging(true, true, false));
        assert!(
            install_writable_for_staging(false, false, false),
            "inherited elevation must treat a medium-writable per-user install as writable"
        );
        assert!(
            !install_writable_for_staging(true, false, false),
            "--elevated is the pre-UAC protected classification; do not re-probe with the high token"
        );
        assert!(!install_writable_for_staging(false, true, false));
        assert!(
            install_writable_for_staging(false, true, true),
            "a denied write probe on a user-owned root is not proof the install is protected"
        );
        assert!(
            !super::install_is_protected_system_for(
                Path::new(r"C:\Users\u\AppData\Local\Cindy"),
                &[
                    PathBuf::from(r"C:\Program Files"),
                    PathBuf::from(r"C:\Windows"),
                ],
            ),
            "per-user LocalAppData installs stay user-owned across a spoofed PermissionDenied probe"
        );
        assert!(
            super::install_is_protected_system_for(
                Path::new(r"C:\Program Files\Cindy"),
                &[
                    PathBuf::from(r"C:\Program Files"),
                    PathBuf::from(r"C:\Windows"),
                ],
            ),
            "Program Files is a protected system root"
        );
        assert!(
            !super::install_is_protected_system_for(
                Path::new(r"D:\Games\Cindy"),
                &[
                    PathBuf::from(r"C:\Program Files"),
                    PathBuf::from(r"C:\Windows"),
                ],
            ),
            "a custom same-user-writable install outside the profile stays user-owned"
        );
        assert!(
            super::install_is_protected_system_for(
                Path::new(r"C:\Windows\System32\Cindy"),
                &[
                    PathBuf::from(r"C:\Program Files"),
                    PathBuf::from(r"C:\Windows"),
                ],
            ),
            "Windows system directories are protected"
        );
        assert!(
            super::install_is_medium_writable_from_access(Some(true), Some(false)),
            "an Administrators-owned directory that the medium token can modify is not protected"
        );
        assert!(
            !super::install_is_medium_writable_from_access(Some(false), Some(false)),
            "an Administrators-owned directory the medium token cannot modify may use protected staging"
        );
        assert!(
            super::install_is_medium_writable_from_access(None, Some(true)),
            "if AccessCheck cannot be read, fail toward High-IL staging instead of app_dir staging"
        );
        assert!(
            super::install_is_medium_writable_from_access(Some(false), Some(true)),
            "current-user ownership still counts as medium-writable"
        );
        assert!(
            super::install_is_medium_writable_from_file_access(Some(false), Some(true)),
            "a medium-writable Cindy.exe is unprotected even when app_dir denies FILE_ADD_FILE"
        );
        assert!(
            !super::install_is_medium_writable_from_file_access(Some(false), Some(false)),
            "directory and executable both denied remain protected"
        );
        let probe = TestDir::new();
        let app = probe.0.join("Cindy");
        fs::create_dir(&app).unwrap();
        fs::write(app.join("Cindy.exe"), b"exe").unwrap();
        fs::create_dir(app.join("resources")).unwrap();
        fs::write(app.join("resources").join("app.asar"), b"asar").unwrap();
        fs::write(app.join("vcruntime140.dll"), b"dll").unwrap();
        let candidates = super::medium_writable_install_file_candidates(&app, "Cindy.exe");
        assert!(
            candidates.iter().any(|path| path.ends_with("Cindy.exe")),
            "the main executable remains a classification input: {candidates:?}"
        );
        assert!(
            candidates.iter().any(|path| path.ends_with("app.asar")),
            "a writable resources/app.asar must pin the install as unprotected: {candidates:?}"
        );
        assert!(
            candidates
                .iter()
                .any(|path| path.ends_with("vcruntime140.dll")),
            "a writable app-local DLL must pin the install as unprotected: {candidates:?}"
        );
        fs::create_dir_all(
            app.join("resources")
                .join("app.asar.unpacked")
                .join("node_modules")
                .join("better-sqlite3")
                .join("build")
                .join("Release"),
        )
        .unwrap();
        fs::write(
            app.join("resources")
                .join("app.asar.unpacked")
                .join("node_modules")
                .join("better-sqlite3")
                .join("build")
                .join("Release")
                .join("better_sqlite3.node"),
            b"node",
        )
        .unwrap();
        let candidates = super::medium_writable_install_file_candidates(&app, "Cindy.exe");
        assert!(
            candidates
                .iter()
                .any(|path| path.ends_with("better_sqlite3.node")),
            "a writable unpacked native addon must pin the install as unprotected: {candidates:?}"
        );
        fs::create_dir_all(
            app.join("resources")
                .join("app.asar.unpacked")
                .join("node_modules")
                .join("node-pty")
                .join("lib"),
        )
        .unwrap();
        fs::write(
            app.join("resources")
                .join("app.asar.unpacked")
                .join("node_modules")
                .join("node-pty")
                .join("lib")
                .join("index.js"),
            b"module.exports = {}",
        )
        .unwrap();
        let candidates = super::medium_writable_install_file_candidates(&app, "Cindy.exe");
        assert!(
            candidates.iter().any(|path| path.ends_with("index.js")),
            "Forge-unpacked JS such as node-pty must pin the install as unprotected: {candidates:?}"
        );
        fs::create_dir_all(
            app.join("resources")
                .join("tools")
                .join("remote-desktop"),
        )
        .unwrap();
        fs::write(
            app.join("resources")
                .join("tools")
                .join("remote-desktop")
                .join("cindy-windows-desktop-host.node"),
            b"node",
        )
        .unwrap();
        let candidates = super::medium_writable_install_file_candidates(&app, "Cindy.exe");
        assert!(
            candidates
                .iter()
                .any(|path| path.ends_with("cindy-windows-desktop-host.node")),
            "Forge extraResource natives under resources/tools must pin the install as unprotected: {candidates:?}"
        );
        fs::create_dir_all(app.join("resources").join("drizzle").join("scripts")).unwrap();
        fs::write(
            app.join("resources")
                .join("drizzle")
                .join("scripts")
                .join("0031_add_recent_workdirs.ts"),
            b"exports.run = () => {}",
        )
        .unwrap();
        let candidates = super::medium_writable_install_file_candidates(&app, "Cindy.exe");
        assert!(
            candidates
                .iter()
                .any(|path| path.ends_with("0031_add_recent_workdirs.ts")),
            "Forge extraResource drizzle companions required at startup must pin writable: {candidates:?}"
        );
        fs::write(
            app.join("resources")
                .join("windows-installation-version.ps1"),
            b"# sync",
        )
        .unwrap();
        let candidates = super::medium_writable_install_file_candidates(&app, "Cindy.exe");
        assert!(
            candidates
                .iter()
                .any(|path| path.ends_with("windows-installation-version.ps1")),
            "startup PowerShell version script must pin writable: {candidates:?}"
        );
        assert_eq!(
            super::file_write_probe_from_os_error(std::io::ErrorKind::PermissionDenied, Some(5)),
            Some(false),
            "ACL deny is the only CreateFile failure that proves the file is protected"
        );
        assert_eq!(
            super::file_write_probe_from_os_error(std::io::ErrorKind::PermissionDenied, Some(32)),
            Some(true),
            "Windows may map ERROR_SHARING_VIOLATION to PermissionDenied; that is not a protected ACL"
        );
        assert_eq!(
            super::file_write_probe_from_os_error(std::io::ErrorKind::ResourceBusy, Some(32)),
            Some(true),
            "ERROR_SHARING_VIOLATION while Cindy.exe is mapped is not a protected ACL"
        );
        assert_eq!(
            super::file_write_probe_from_os_error(std::io::ErrorKind::Other, Some(33)),
            Some(true),
            "ERROR_LOCK_VIOLATION is also a sharing failure, not PermissionDenied"
        );
        assert_eq!(
            super::file_is_medium_replaceable_from_access(
                Some(false),
                Some(true),
                Some(false),
                Some(false),
                Some(false),
                Some(false),
            ),
            Some(true),
            "DELETE without GENERIC_WRITE still replaces resources/app.asar"
        );
        assert_eq!(
            super::file_is_medium_replaceable_from_access(
                Some(false),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
                Some(false),
            ),
            Some(true),
            "parent FILE_DELETE_CHILD can recreate a protected-looking asar"
        );
        assert_eq!(
            super::file_is_medium_replaceable_from_access(
                Some(false),
                Some(false),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            ),
            Some(true),
            "parent FILE_ADD_FILE after delete also replaces the loadable input"
        );
        assert_eq!(
            super::file_is_medium_replaceable_from_access(
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(false),
            ),
            Some(false),
            "write, delete, and parent replace rights all denied stay protected"
        );
        assert_eq!(
            super::file_is_medium_replaceable_from_access(
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(true),
                Some(false),
            ),
            Some(true),
            "FILE_WRITE_DATA without GENERIC_WRITE still overwrites unpacked JS"
        );
        assert_eq!(
            super::file_is_medium_replaceable_from_access(
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(true),
            ),
            Some(true),
            "FILE_APPEND_DATA without GENERIC_WRITE still edits unpacked JS"
        );
        assert!(
            super::acl_control_pins_install_writable(Some(true), Some(false)),
            "WRITE_DAC after UAC can replace Cindy.exe even when current write/delete is denied"
        );
        assert!(
            super::acl_control_pins_install_writable(Some(false), Some(true)),
            "WRITE_OWNER likewise lets the medium user take the DACL after classification"
        );
        assert!(
            super::acl_control_pins_install_writable(None, Some(false)),
            "unknown ACL-control must de-elevate, not pin the install as protected"
        );
        assert!(
            !super::acl_control_pins_install_writable(Some(false), Some(false)),
            "denied WRITE_DAC and WRITE_OWNER do not by themselves pin writable"
        );
        assert!(
            super::ancestor_control_pins_install_writable(
                Some(true),
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(false),
            ),
            "FILE_DELETE_CHILD on a non-immediate unpacked ancestor can swap a package to a junction"
        );
        assert!(
            super::ancestor_control_pins_install_writable(
                Some(false),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
                Some(false),
            ),
            "WRITE_DAC on a higher ancestor still replaces unpacked code after UAC"
        );
        assert!(
            super::ancestor_control_pins_install_writable(
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(true),
                Some(false),
            ),
            "DELETE on resources/tools lets a medium user junction-swap the tree after UAC"
        );
        assert!(
            super::ancestor_control_pins_install_writable(
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(true),
            ),
            "FILE_ADD_SUBDIRECTORY on a parent of resources/tools recreates the swapped directory"
        );
        assert!(
            !super::ancestor_control_pins_install_writable(
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(false),
            ),
            "denied ancestor replace and ACL-control rights do not pin writable"
        );
        assert!(
            super::install_root_parent_pins_install_writable(
                Some(true),
                Some(true),
                Some(false),
                Some(false),
            ),
            "parent FILE_DELETE_CHILD and FILE_ADD_SUBDIRECTORY can replace a protected-looking app_dir across UAC"
        );
        assert!(
            super::install_root_parent_pins_install_writable(
                Some(false),
                Some(false),
                Some(true),
                Some(false),
            ),
            "WRITE_DAC on the install-root parent still replaces app_dir after classification"
        );
        assert!(
            !super::install_root_parent_pins_install_writable(
                Some(false),
                Some(false),
                Some(false),
                Some(false),
            ),
            "denied parent replace and ACL-control rights do not pin writable"
        );
        {
            let nested = probe.0.join("Games").join("Vendor").join("Cindy");
            fs::create_dir_all(&nested).unwrap();
            let ancestors = super::install_root_ancestors(&nested);
            assert!(
                ancestors.iter().any(|path| path.ends_with("Vendor")),
                "must check the immediate parent of app_dir: {ancestors:?}"
            );
            assert!(
                ancestors.iter().any(|path| path.ends_with("Games")),
                "DELETE on a non-immediate ancestor can replace the whole install path: {ancestors:?}"
            );
            assert!(
                !ancestors.iter().any(|path| path == &nested),
                "app_dir itself is classified separately: {ancestors:?}"
            );
        }
        {
            let nested = app
                .join("resources")
                .join("app.asar.unpacked")
                .join("node_modules")
                .join("node-pty")
                .join("lib")
                .join("index.js");
            let ancestors = super::runtime_path_ancestors(&nested, &app);
            assert!(
                ancestors.iter().any(|path| path.ends_with("node-pty")),
                "must check the package directory, not only lib/: {ancestors:?}"
            );
            assert!(
                ancestors.iter().any(|path| path.ends_with("node_modules")),
                "must check node_modules, not only the immediate parent: {ancestors:?}"
            );
            assert!(
                ancestors
                    .iter()
                    .any(|path| path.ends_with("app.asar.unpacked")),
                "must check the unpacked tree root: {ancestors:?}"
            );
            assert!(
                !ancestors.iter().any(|path| path == &app),
                "app_dir is classified separately: {ancestors:?}"
            );
        }
        assert!(
            super::unpacked_walk_pins_install_writable(super::UnpackedWalk::Unreadable),
            "an unreadable app.asar.unpacked tree must de-elevate, not look protected"
        );
        assert!(!super::unpacked_walk_pins_install_writable(
            super::UnpackedWalk::Complete
        ));
        assert!(
            super::unpacked_walk_pins_install_writable(super::UnpackedWalk::Reparse),
            "a reparse-point unpacked tree must de-elevate, not look protected"
        );
        {
            let not_dir = probe.0.join("not-a-directory");
            fs::write(&not_dir, b"x").unwrap();
            let mut listed = Vec::new();
            assert_eq!(
                super::collect_medium_writable_unpacked_files(&not_dir, &mut listed),
                super::UnpackedWalk::Unreadable,
                "read_dir failure must not become an empty protected subtree: {listed:?}"
            );
            listed.clear();
            assert_eq!(
                super::collect_medium_writable_root_natives(&not_dir, &mut listed),
                super::UnpackedWalk::Unreadable,
                "unlistable install root must not omit ffmpeg.dll and other natives: {listed:?}"
            );
            let missing = probe.0.join("missing-unpacked");
            listed.clear();
            assert_eq!(
                super::collect_medium_writable_unpacked_files(&missing, &mut listed),
                super::UnpackedWalk::Complete,
                "a missing unpacked tree is empty, not unknown"
            );
            listed.clear();
            assert_eq!(
                super::collect_medium_writable_root_natives(&missing, &mut listed),
                super::UnpackedWalk::Complete,
                "a missing install root is empty, not unknown"
            );
        }
        #[cfg(unix)]
        {
            let target = probe.0.join("unpacked-target");
            fs::create_dir_all(&target).unwrap();
            fs::write(target.join("index.js"), b"js").unwrap();
            let link = probe.0.join("unpacked-link");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            let mut listed = Vec::new();
            assert_eq!(
                super::collect_medium_writable_unpacked_files(&link, &mut listed),
                super::UnpackedWalk::Reparse,
                "a junctioned unpacked tree must not look like a complete protected walk: {listed:?}"
            );
            let asar_target = probe.0.join("asar-target");
            fs::write(&asar_target, b"asar").unwrap();
            let asar_link = probe.0.join("app.asar");
            std::os::unix::fs::symlink(&asar_target, &asar_link).unwrap();
            assert!(
                super::loadable_input_is_reparse(&asar_link),
                "a junctioned resources/app.asar must pin writable, not be skipped"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let hidden = probe.0.join("unreadable-unpacked");
            fs::create_dir_all(&hidden).unwrap();
            fs::write(hidden.join("index.js"), b"js").unwrap();
            let original = fs::metadata(&hidden).unwrap().permissions();
            let mut denied = original.clone();
            denied.set_mode(0o000);
            fs::set_permissions(&hidden, denied).unwrap();
            let mut listed = Vec::new();
            let walk = super::collect_medium_writable_unpacked_files(&hidden, &mut listed);
            let _ = fs::set_permissions(&hidden, original);
            assert_eq!(
                walk,
                super::UnpackedWalk::Unreadable,
                "listing failure must not become an empty protected subtree: {listed:?}"
            );
        }
        let source = include_str!("installer.rs");
        let start = source
            .find("fn existing_install_files_medium_writable_windows")
            .expect("windows file probe");
        let body = &source[start..start + 600];
        assert!(
            body.contains("medium_writable_install_file_candidates"),
            "do not classify from Cindy.exe alone:\n{body}"
        );
        let start = source
            .find("fn path_grants_access")
            .expect("file access probe");
        let body = &source[start..start + 900];
        assert!(
            body.contains("file_write_probe_from_os_error"),
            "sharing violations must not collapse to protected:\n{body}"
        );
        let start = source
            .find("fn file_is_medium_replaceable(")
            .expect("replaceable file probe");
        let body = &source[start..start + 900];
        assert!(
            body.contains("DELETE") && body.contains("FILE_DELETE_CHILD") && body.contains("FILE_ADD_FILE"),
            "GENERIC_WRITE alone misses delete/recreate of resources/app.asar:\n{body}"
        );
        let start = source
            .find("fn existing_install_files_medium_writable_windows")
            .expect("windows file classification");
        let body = &source[start..start + 700];
        assert!(
            body.contains("runtime_trees_pin_install_writable"),
            "unlistable install roots and unpacked reparse trees must pin writable under the medium token:\n{body}"
        );
        let start = source
            .find("fn collect_medium_writable_root_natives")
            .expect("root native walk");
        let body = &source[start..start + 700];
        assert!(
            body.contains("Unreadable") && !body.contains("if let Ok(entries)"),
            "install-root listing failure must not omit ffmpeg.dll:\n{body}"
        );
        let start = source
            .find("pub(crate) fn collect_medium_writable_unpacked_files")
            .expect("unpacked walk");
        let body = &source[start..start + 500];
        assert!(
            body.contains("UnpackedWalk::Reparse"),
            "an unpacked reparse point must not look like a complete protected walk:\n{body}"
        );
        let start = source
            .find("fn file_is_medium_replaceable(")
            .expect("replaceable file probe");
        let body = &source[start..start + 1800];
        assert!(
            body.contains("WRITE_DAC") && body.contains("WRITE_OWNER"),
            "ACL-control rights must pin writable before Close relaunch:\n{body}"
        );
        assert!(
            body.contains("runtime_path_ancestors"),
            "a non-immediate unpacked ancestor must be checked, not only path.parent():\n{body}"
        );
        assert!(
            body.contains("FILE_WRITE_DATA") && body.contains("FILE_APPEND_DATA"),
            "GENERIC_WRITE misses a DACL that only grants data/append on unpacked JS:\n{body}"
        );
        assert!(
            body.contains("FILE_ADD_SUBDIRECTORY") && body.contains("DELETE"),
            "ancestor directory DELETE / FILE_ADD_SUBDIRECTORY must pin writable:\n{body}"
        );
        let start = source
            .find("pub(crate) fn install_is_user_owned_for")
            .expect("install classification");
        let body = &source[start..start + 500];
        assert!(
            body.contains("install_root_parent_is_medium_replaceable"),
            "a replaceable parent of app_dir must pin writable across UAC:\n{body}"
        );
        let start = source
            .find("fn directory_medium_token_can_modify_windows")
            .expect("directory medium probe");
        let body = &source[start..start + 900];
        assert!(
            body.contains("WRITE_DAC") && body.contains("WRITE_OWNER"),
            "a directory that only grants WRITE_DAC must not look protected:\n{body}"
        );
        let start = source
            .find("fn existing_install_files_medium_writable_windows")
            .expect("windows file classification");
        let body = &source[start..start + 900];
        assert!(
            body.contains("loadable_input_is_reparse")
                || (body.contains("is_reparse_point") && body.contains("Some(true)")),
            "a reparse-point app.asar must pin writable, not be skipped:\n{body}"
        );
        let start = source
            .find("pub(crate) fn medium_writable_install_file_candidates")
            .expect("candidate list");
        let body = &source[start..start + 900];
        assert!(
            body.contains("tools") || body.contains("extra_resource"),
            "resources/tools extraResource natives must be classification inputs:\n{body}"
        );
        assert!(
            body.contains("drizzle"),
            "resources/drizzle migration companions must be classification inputs:\n{body}"
        );
        assert!(
            body.contains("windows-installation-version.ps1"),
            "startup PowerShell version script must be a classification input:\n{body}"
        );
        let start = source
            .find("fn install_root_parent_is_medium_replaceable_windows")
            .expect("install-root parent probe");
        let body = &source[start..start + 900];
        assert!(
            body.contains("install_root_ancestors"),
            "a non-immediate ancestor of app_dir must be checked, not only parent():\n{body}"
        );
        let temp = TestDir::new();
        let mut args = test_args();
        args.elevated = false;
        args.app_dir = temp.0.join("Cindy");
        args.workdir = temp.0.join("cindy-update-ts");
        fs::create_dir(&args.app_dir).unwrap();
        fs::create_dir(&args.workdir).unwrap();
        let private_root = elevated_private_staging_root(&args);
        let (extract_dir, backup_dir) = staging_dirs_for(&args, true, true);
        assert!(
            extract_dir.starts_with(&private_root),
            "elevated writable installs must not stage in TEMP or app_dir"
        );
        assert!(backup_dir.starts_with(&private_root));
        assert!(!extract_dir.starts_with(&args.workdir));
        assert!(!extract_dir.starts_with(&args.app_dir));

        let source = include_str!("installer.rs");
        let start = source
            .find("pub(crate) fn staging_dirs_for")
            .expect("staging_dirs_for");
        let helper = source[start..]
            .find("/// True when this process already holds an elevated Windows token.")
            .expect("process_is_elevated docs");
        let body = &source[start..start + helper];
        assert!(
            body.contains("uses_elevated_private_staging"),
            "elevated+writable must pick a medium-inaccessible staging root, not workdir:\n{body}"
        );
    }

    #[test]
    fn protected_staging_tree_rejects_a_precreated_directory() {
        let temp = TestDir::new();
        let ancestor = temp.0.join("ProgramData");
        fs::create_dir(&ancestor).unwrap();
        let planted = ancestor.join("cindy-update-planted");
        fs::create_dir(&planted).unwrap();
        let extract = planted.join("cindy-update-extract-ts");
        let error = create_protected_staging_tree(&extract, &ancestor).unwrap_err();
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::AlreadyExists,
            "a medium-integrity plant of the staging root must not be reused: {error}"
        );
        assert!(!extract.exists());
    }

    #[test]
    fn protected_staging_tree_creates_missing_directories() {
        let temp = TestDir::new();
        let ancestor = temp.0.join("ProgramData");
        fs::create_dir(&ancestor).unwrap();
        let extract = ancestor
            .join("cindy-update-nonce")
            .join("cindy-update-extract-ts");
        create_protected_staging_tree(&extract, &ancestor).unwrap();
        assert!(extract.is_dir());
        let backup = ancestor
            .join("cindy-update-nonce")
            .join("cindy-update-rollback-ts");
        create_protected_staging_tree(&backup, &ancestor).unwrap();
        assert!(backup.is_dir());
    }

    #[test]
    fn protected_staging_acl_is_limited_to_the_private_root() {
        let program_data = Path::new(r"C:\ProgramData");
        let private_root = program_data.join("cindy-update-ts");
        let extract = private_root.join("cindy-update-extract-ts");
        assert!(uses_private_staging_acl(&extract, &private_root));
        let app_dir = program_data.join("Cindy");
        let app_extract = app_dir.join("cindy-update-extract-ts");
        assert!(
            !uses_private_staging_acl(&app_extract, &private_root),
            "a Program Files-style install under ProgramData must keep ordinary create_dir_all"
        );

        let source = include_str!("installer.rs");
        let start = source
            .find("fn ensure_staging_directory")
            .expect("ensure_staging_directory");
        let body = &source[start..start + 500];
        assert!(
            body.contains("uses_private_staging_acl"),
            "do not treat every ProgramData descendant as private High-IL staging:\n{body}"
        );
    }

    #[test]
    fn program_data_staging_does_not_trust_the_inherited_environment() {
        let source = include_str!("installer.rs");
        let start = source
            .find("fn known_folder_program_data")
            .expect("known_folder_program_data");
        let body = &source[start..start + 1800];
        assert!(
            !body.contains("var_os(\"ProgramData\")") && !body.contains("var_os(\"PROGRAMDATA\")"),
            "an overridden ProgramData env var must not become the High-IL staging ancestor:\n{body}"
        );
        assert!(
            body.contains("SHGetKnownFolderPath") && body.contains("FOLDERID_ProgramData"),
            "resolve the system ProgramData known folder, not the inherited environment:\n{body}"
        );
        let _ = program_data_dir();
    }

    #[test]
    fn protected_staging_is_created_with_the_security_descriptor() {
        let source = include_str!("installer.rs");
        let start = source
            .find("fn create_directory_with_high_integrity")
            .expect("create_directory_with_high_integrity");
        let windows = source[start..]
            .find("#[cfg(target_os = \"windows\")]\nfn create_directory_with_high_integrity")
            .map(|offset| start + offset)
            .unwrap_or(start);
        let body = &source[windows..windows + 900];
        assert!(
            body.contains("CreateDirectoryW") && body.contains("SECURITY_ATTRIBUTES"),
            "High-IL staging must be born with the DACL, not secured after create_dir:\n{body}"
        );
        let tree = source
            .find("pub(crate) fn create_protected_staging_tree")
            .expect("create_protected_staging_tree");
        let tree_body = &source[tree..tree + 900];
        assert!(
            !tree_body.contains("create_dir_all"),
            "create_dir_all accepts a planted tree before the DACL is applied:\n{tree_body}"
        );
    }

    #[test]
    fn successful_launch_does_not_createprocess_a_writable_install_elevated() {
        let source = include_str!("installer.rs");
        let start = source
            .find("启动新版本")
            .expect("success launch phase");
        let body = &source[start..start + 800];
        assert!(
            body.contains("may_relaunch_with_current_integrity")
                || body.contains("launch_app_exe"),
            "copy_tree then CreateProcess of app_dir/Cindy.exe must not inherit a high token on a writable install:\n{body}"
        );
        assert!(
            body.contains("anyhow::bail!") && body.contains("AppLaunch::Skipped"),
            "a skipped de-elevated launch after replacement is a terminal failure, not Done:\n{body}"
        );
    }

    #[test]
    fn close_is_blocked_until_the_install_worker_reaches_a_terminal_phase() {
        assert!(
            close_should_be_blocked(Phase::Extracting, false),
            "the first install never sets retry_started; closing during extract would relaunch a mixed tree"
        );
        assert!(close_should_be_blocked(Phase::Replacing, false));
        assert!(close_should_be_blocked(Phase::RollingBack, false));
        assert!(close_should_be_blocked(Phase::Waiting, false));
        assert!(close_should_be_blocked(Phase::Launching, false));
        assert!(
            close_should_be_blocked(Phase::Failed, true),
            "in-process Retry must still block Close while the worker is rewriting files"
        );
        assert!(!close_should_be_blocked(Phase::Failed, false));
        assert!(!close_should_be_blocked(Phase::Done, false));
    }

    #[test]
    fn elevated_abandon_does_not_relaunch_a_writable_install_with_the_high_token() {
        assert!(
            !may_relaunch_with_current_integrity(false, true, true),
            "an elevated updater must not CreateProcess a medium-writable Cindy.exe"
        );
        assert!(!may_relaunch_with_current_integrity(true, true, true));
        assert!(
            may_relaunch_with_current_integrity(true, true, false),
            "a UAC-protected install root is not plantable by a medium-integrity process"
        );
        assert!(may_relaunch_with_current_integrity(false, false, true));

        let source = include_str!("installer.rs");
        let start = source
            .find("fn relaunch_restored_app(args: &CliArgs)")
            .expect("relaunch_restored_app");
        let end = source[start..]
            .find("pub(crate) fn should_relaunch_restored_app_on_abandon")
            .expect("should_relaunch follows relaunch");
        let body = &source[start..start + end];
        assert!(
            body.contains("may_relaunch_with_current_integrity"),
            "Close/Destroyed must not launch a writable Cindy.exe from a still-elevated updater:\n{body}"
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

    #[test]
    fn elevation_forwards_pinned_install_writable() {
        let mut args = test_args();
        args.elevated = false;
        args.install_writable = Some(true);
        let cmdline = super::build_elevation_arg_string(&args);
        assert!(
            cmdline.contains("--install-writable true"),
            "UAC child must keep the unelevated parent's writable pin:\n{cmdline}"
        );
        assert!(cmdline.contains("--elevated"));

        args.install_writable = Some(false);
        let cmdline = super::build_elevation_arg_string(&args);
        assert!(
            cmdline.contains("--install-writable false"),
            "a protected install pin must survive UAC:\n{cmdline}"
        );

        let parsed = CliArgs::try_parse_from([
            "cindy-updater",
            "--zip",
            r"C:\Users\Test User\update.zip",
            "--app-dir",
            r"C:\Users\Test User\AppData\Local\Cindy",
            "--exe-name",
            "Cindy.exe",
            "--pid",
            "1",
            "--log",
            r"C:\Users\Test User\update.log",
            "--lock",
            r"C:\Users\Test User\update.lock",
            "--workdir",
            r"C:\Users\Test User\update-workdir",
            "--install-writable",
            "true",
            "--elevated",
        ])
        .expect("elevated child parses the forwarded pin");
        assert_eq!(parsed.install_writable, Some(true));
        assert!(parsed.elevated);
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

/// The first unelevated attempt may `runas` this TEMP-copied updater once.
/// A later Retry must not: the failure window waits long enough for a
/// same-login process to plant `vcruntime140*.dll` beside the executable.
pub(crate) fn may_self_elevate(is_retry: bool) -> bool {
    !is_retry
}

/// Cancelling or failing the UAC prompt leaves a still-valid archive. Offering
/// Retry would `runas` the same TEMP updater; close the window and check for
/// updates again instead.
pub(crate) fn elevation_prompt_can_retry() -> bool {
    false
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
    if let Some(writable) = args.install_writable {
        pairs.push((
            "--install-writable",
            if writable { "true".into() } else { "false".into() },
        ));
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
    // ShellExecute(runas) need not preserve the caller's environment. This is
    // self-reentry into the same binary, so the optional flag is supported.
    if let Some(key) = installation_version_key(args) {
        out.push_str(" --install-key ");
        out.push_str(&quote_cmdline_arg(&key));
    }
    out.push_str(" --elevated");
    out
}

fn installation_version_key(args: &CliArgs) -> Option<String> {
    args.install_key.clone().or_else(|| std::env::var("CINDY_VERSION_SYNC_KEY").ok())
}

#[cfg(test)]
mod version_metadata_args_tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn legacy_launchers_work_and_elevation_preserves_optional_install_key() {
        let mut args = CliArgs::try_parse_from([
            "updater", "--zip", "patch.zip", "--app-dir", "app", "--exe-name",
            "Cindy.exe", "--pid", "123", "--log", "update.log", "--lock", "lock",
            "--workdir", "temp",
        ]).unwrap();
        assert!(args.install_key.is_none());
        args.install_key = Some("5a59f1e9-8f21-5646-8eed-e6da4126bb5c".into());
        assert!(build_elevation_arg_string(&args).ends_with(
            "--install-key 5a59f1e9-8f21-5646-8eed-e6da4126bb5c --elevated"
        ));
    }
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
