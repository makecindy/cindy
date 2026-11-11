use super::*;
use std::io::Write;
use std::path::PathBuf;

/// All replacements use this disposable install tree, never a real Cindy.
struct Fixture {
    root: PathBuf,
    args: CliArgs,
}

impl Fixture {
    fn new() -> Self {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("cindy-retry-test-{}-{unique}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let args = CliArgs {
            zip: root.join("update.zip"),
            app_dir: root.join("app"),
            exe_name: "Cindy.exe".into(),
            install_key: None,
            pid: std::process::id(),
            log: root.join("update.log"),
            lock: root.join(".updating"),
            workdir: root.join("cindy-update-123"),
            theme: ThemeArg::Dark,
            elevated: false,
        };
        fs::create_dir(&args.workdir).unwrap();
        fs::create_dir(&args.app_dir).unwrap();
        fs::write(args.app_dir.join("Cindy.exe"), b"old exe").unwrap();
        fs::create_dir(args.app_dir.join("resources")).unwrap();
        fs::write(args.app_dir.join("resources/app.asar"), b"old app").unwrap();
        let mut zip = zip::ZipWriter::new(File::create(&args.zip).unwrap());
        for (name, data) in [("Cindy.exe", "new exe"), ("resources/app.asar", "new app")] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        Self { root, args }
    }

    fn prepare(&self, args: &CliArgs) -> (PathBuf, PathBuf) {
        let (extract, backup) = staging_dirs(args);
        remove_staging_dir(&extract).unwrap();
        remove_staging_dir(&backup).unwrap();
        fs::create_dir(&extract).unwrap();
        fs::create_dir(&backup).unwrap();
        extract_zip(&args.zip, &extract, |_, _| {}).unwrap();
        snapshot_overwritten_files(&extract, &args.app_dir, &backup, |_, _| {}).unwrap();
        fs::write(&args.lock, b"updating").unwrap();
        (extract, backup)
    }

    fn assert_old_app(&self) {
        assert_eq!(
            fs::read(self.args.app_dir.join("Cindy.exe")).unwrap(),
            b"old exe"
        );
        assert_eq!(
            fs::read(self.args.app_dir.join("resources/app.asar")).unwrap(),
            b"old app"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct TestProcess(std::process::Child);
impl Drop for TestProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start_install_process(fixture: &Fixture) -> TestProcess {
    let executable = fixture.args.app_dir.join("retry-process-fixture.exe");
    fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
    TestProcess(
        std::process::Command::new(executable)
            .args([
                "--exact",
                "installer::retry_tests::retry_process_fixture",
                "--ignored",
            ])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    )
}

// Production transaction regression: an exited/missed main process can leave
// an install-dir child alive. Earlier tests only covered a definitely failed
// launch, so they allowed overwriting its files during rollback. The minimum
// input is a launch error with one live install-dir process (Rust integration
// fixture); assert file contents and recovery choices, not implementation text.
#[test]
fn surviving_install_process_prevents_overwrite_rollback() {
    let fixture = Fixture::new();
    let args = &fixture.args;
    let (extract, backup) = fixture.prepare(args);
    let mut child = start_install_process(&fixture);
    let mut attempt = AttemptState::default();
    let error = replace_and_launch(args, &extract, &backup, &mut attempt, &mut |_| {}, |_| {
        anyhow::bail!("main process exited but child is still alive")
    })
    .unwrap_err();
    assert!(error.to_string().contains("未执行覆盖回滚"));
    assert_eq!(
        fs::read(args.app_dir.join("Cindy.exe")).unwrap(),
        b"new exe"
    );
    assert_eq!(
        fs::read(args.app_dir.join("resources/app.asar")).unwrap(),
        b"new app"
    );
    assert_eq!(fs::read(backup.join("Cindy.exe")).unwrap(), b"old exe");
    assert!(!finish_failed_attempt(args, &attempt));
    assert!(backup.exists());
    assert!(child.0.try_wait().unwrap().is_none());
}

// A failed handle query is not proof of exit. Exercise real replacement and
// cleanup without fabricating a Windows handle or launching the installed app.
#[test]
fn unknown_created_process_preserves_new_tree_and_recovery_backup() {
    let fixture = Fixture::new();
    let args = &fixture.args;
    let (extract, backup) = fixture.prepare(args);
    let mut attempt = AttemptState::default();
    let error = replace_and_launch(args, &extract, &backup, &mut attempt, &mut |_| {}, |_| {
        Err(LaunchStateUnknown(io::Error::other("simulated handle query failure")).into())
    })
    .unwrap_err();
    assert!(error.to_string().contains("未执行覆盖回滚"));
    assert_eq!(
        fs::read(args.app_dir.join("Cindy.exe")).unwrap(),
        b"new exe"
    );
    assert_eq!(fs::read(backup.join("Cindy.exe")).unwrap(), b"old exe");
    assert!(!finish_failed_attempt(args, &attempt));
    assert!(backup.exists());
}

// Integration tier, explicitly invoked by check-windows-updater-launch.mjs.
// The launcher-only matrix cannot observe replacement, rollback, retained ZIP
// or Close. Use the real installer entry and an isolated executable that waits
// for our release file. Never call the updater's global stale-temp sweep or use
// an installed Cindy. The driver removes CINDY_VERSION_SYNC_KEY from its env.
#[cfg(target_os = "windows")]
#[test]
#[ignore = "requires the isolated Windows launcher integration driver"]
fn real_launcher_transactions_rollback_retry_and_close() {
    let executable =
        std::env::var_os("CINDY_UPDATER_TEST_EXE").expect("integration driver required");
    assert!(std::env::var_os("CINDY_VERSION_SYNC_KEY").is_none());
    let fixture = Fixture::new();
    let mut args = fixture.args.clone();
    use std::os::windows::process::CommandExt;
    // PID 0 is Windows' real Idle process. Retain a handle to our known-exited
    // fixture parent so this test neither waits on a system PID nor reuses one.
    let mut parent = std::process::Command::new(std::env::var("ComSpec").unwrap())
        .args(["/d", "/c", "exit", "0"])
        .creation_flags(0x08000000)
        .spawn()
        .unwrap();
    args.pid = parent.id();
    assert!(parent.wait().unwrap().success());
    let image = fs::read(executable).unwrap();
    let receipt = fixture.root.join("receipt.txt");
    let release = fixture.root.join("release");
    std::env::set_var("CINDY_LAUNCH_TEST_RECEIPT", &receipt);
    std::env::set_var("CINDY_LAUNCH_TEST_RELEASE", &release);
    std::env::set_var("CINDY_LAUNCH_TEST_CONTEXT", "transaction-only");
    let write_package = |image: &[u8], version: &[u8]| {
        let mut zip = zip::ZipWriter::new(File::create(&args.zip).unwrap());
        for (name, bytes) in [("Cindy.exe", image), ("resources/app.asar", version)] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    };
    let release_child = || {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !receipt.exists() {
            assert!(
                Instant::now() < deadline,
                "new process did not write its receipt"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(fs::read_to_string(&receipt).unwrap().starts_with("0|"));
        fs::write(&release, b"done").unwrap();
        let mut sys = System::new();
        while !collect_appdir_processes(&mut sys, &args.app_dir, std::process::id()).is_empty() {
            assert!(Instant::now() < deadline, "fixture child did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
        fs::remove_file(&receipt).unwrap();
        fs::remove_file(&release).unwrap();
    };
    for version in [b"version-one".as_slice(), b"version-two".as_slice()] {
        write_package(&image, version);
        let mut done = false;
        run(args.clone(), |event| match event {
            InstallerEvent::Done => done = true,
            InstallerEvent::Failed { error, .. } => panic!("{error}"),
            _ => {}
        });
        assert!(done);
        assert_eq!(
            fs::read(args.app_dir.join("resources/app.asar")).unwrap(),
            version
        );
        assert!(!args.zip.exists());
        assert!(!args.lock.exists());
        release_child();
    }
    write_package(b"invalid executable image", b"broken version");
    for attempt in [args.clone(), retry_args(&args)] {
        let mut failed = false;
        run(attempt, |event| {
            if let InstallerEvent::Failed {
                can_retry,
                relaunch_on_close,
                ..
            } = event
            {
                assert!(can_retry && relaunch_on_close);
                failed = true;
            }
        });
        assert!(failed);
        assert_eq!(fs::read(args.app_dir.join("Cindy.exe")).unwrap(), image);
        assert_eq!(
            fs::read(args.app_dir.join("resources/app.asar")).unwrap(),
            b"version-two"
        );
        assert!(retry_available(&retry_archive(&args)));
    }
    abandon_retry(&args, true);
    assert!(!retry_archive(&args).exists());
    release_child();
}

#[test]
fn launch_failure_rolls_back_and_same_package_succeeds_on_manual_retry() {
    let fixture = Fixture::new();
    let args = &fixture.args;
    let original_zip = fs::read(&args.zip).unwrap();
    let (extract, backup) = fixture.prepare(args);
    let mut attempt = AttemptState {
        app_stopped: true,
        ..Default::default()
    };
    let error = replace_and_launch(args, &extract, &backup, &mut attempt, &mut |_| {}, |exe| {
        assert_eq!(fs::read(exe).unwrap(), b"new exe");
        assert!(!args.lock.exists());
        anyhow::bail!("simulated launch failure")
    })
    .unwrap_err();
    assert!(error.to_string().contains("已回滚到旧版本"));
    fixture.assert_old_app();
    assert!(finish_failed_attempt(args, &attempt));
    assert!(!args.zip.exists());
    assert!(!extract.exists());
    assert!(!backup.exists());
    assert_eq!(fs::read(retry_archive(args)).unwrap(), original_zip);

    let retry = retry_args(args);
    let (extract, backup) = fixture.prepare(&retry);
    replace_and_launch(
        &retry,
        &extract,
        &backup,
        &mut attempt,
        &mut |_| {},
        |exe| {
            assert_eq!(fs::read(exe).unwrap(), b"new exe");
            assert_eq!(
                fs::read(args.app_dir.join("resources/app.asar")).unwrap(),
                b"new app"
            );
            assert!(!args.lock.exists());
            Ok(())
        },
    )
    .unwrap();
    assert!(!retry.zip.exists());
    assert!(!extract.exists());
    assert!(!backup.exists());
}

#[test]
fn rollback_failure_disables_retry_and_keeps_original_backup() {
    let fixture = Fixture::new();
    let args = &fixture.args;
    let (extract, backup) = fixture.prepare(args);
    let mut attempt = AttemptState {
        app_stopped: true,
        ..Default::default()
    };
    let error = replace_and_launch(args, &extract, &backup, &mut attempt, &mut |_| {}, |exe| {
        // A directory at the destination forces the real rollback copy to fail
        // on Windows and Unix without changing ACLs or needing elevation.
        fs::remove_file(exe).unwrap();
        fs::create_dir(exe).unwrap();
        anyhow::bail!("simulated failed launch and blocked restore")
    })
    .unwrap_err();
    assert!(error.to_string().contains("回滚也失败"));
    assert!(attempt.recovery_required);
    assert!(!finish_failed_attempt(args, &attempt));
    assert_eq!(fs::read(backup.join("Cindy.exe")).unwrap(), b"old exe");
    assert!(!args.zip.exists());
    assert!(!retry_archive(args).exists());
    assert!(!extract.exists());
}

#[test]
fn missing_backup_is_not_reported_as_a_successful_rollback() {
    let fixture = Fixture::new();
    let args = &fixture.args;
    let (extract, backup) = fixture.prepare(args);
    let moved_backup = backup.with_extension("preserved");
    let mut attempt = AttemptState {
        app_stopped: true,
        ..Default::default()
    };
    let error = replace_and_launch(args, &extract, &backup, &mut attempt, &mut |_| {}, |_| {
        // The backup becomes unavailable after replacement. A failed walk
        // must not look like an empty, successfully restored snapshot.
        fs::rename(&backup, &moved_backup).unwrap();
        anyhow::bail!("simulated failed launch and missing backup")
    })
    .unwrap_err();
    assert!(error.to_string().contains("回滚也失败"));
    assert!(attempt.recovery_required);
    assert!(!finish_failed_attempt(args, &attempt));
    assert_eq!(
        fs::read(moved_backup.join("Cindy.exe")).unwrap(),
        b"old exe"
    );
}

#[test]
fn retry_rejects_running_processes_without_terminating_them() {
    let fixture = Fixture::new();
    let mut child = start_install_process(&fixture);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while ensure_retry_processes_closed(&fixture.args).is_ok() {
        assert!(
            std::time::Instant::now() < deadline,
            "fixture did not appear"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        ensure_retry_processes_closed(&fixture.args),
        Err("processes_running".into())
    );
    assert!(
        child.0.try_wait().unwrap().is_none(),
        "retry must not kill the process"
    );
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert!(ensure_retry_processes_closed(&fixture.args).is_ok());
}

#[test]
fn updater_detection_includes_temp_processes_and_the_uac_handoff() {
    let fixture = Fixture::new();
    let updater = fixture.args.workdir.join("cindy-updater-999.exe");
    assert!(!fixture.args.lock.exists());
    let current = fixture.args.workdir.join("cindy-updater-123.exe");
    assert!(is_other_updater(
        "cindy-updater-999.exe",
        Some(&updater),
        Some(&current)
    ));
    assert!(is_other_updater("Cindy-Updater.exe", None, Some(&current)));
    assert!(is_other_updater(
        "xdt-updater-999.exe",
        Some(&updater),
        Some(&current)
    ));
    assert!(!is_other_updater(
        "cindy-updater-123.exe",
        Some(&current),
        Some(&current)
    ));
    assert!(!is_other_updater("Cindy.exe", None, Some(&current)));
    assert!(!is_other_updater(
        "cindy-updater-helper.exe",
        None,
        Some(&current)
    ));
}

#[test]
fn active_update_blocks_retry_and_close_without_deleting_its_lock() {
    let fixture = Fixture::new();
    let args = &fixture.args;
    prepare_retry_archive(args).unwrap();
    fs::write(&args.lock, b"other updater owns this").unwrap();
    assert_eq!(
        ensure_retry_processes_closed(args),
        Err("updater_busy".into())
    );
    let mut failure = None;
    run(retry_args(args), |event| {
        if let InstallerEvent::Failed {
            error,
            can_retry,
            relaunch_on_close,
        } = event
        {
            failure = Some((error, can_retry, relaunch_on_close));
        }
    });
    assert_eq!(failure, Some(("updater_busy".into(), true, false)));
    assert_eq!(fs::read(&args.lock).unwrap(), b"other updater owns this");
    assert!(retry_available(&retry_archive(args)));
    abandon_retry_with(args, true, |_| {
        panic!("Close must not launch during another update")
    })
    .unwrap();
    assert_eq!(fs::read(&args.lock).unwrap(), b"other updater owns this");
    assert!(!retry_archive(args).exists());
    fixture.assert_old_app();
}

#[test]
#[ignore = "child process fixture, invoked only by the retry process test"]
fn retry_process_fixture() {
    std::thread::sleep(Duration::from_secs(30));
}

#[test]
fn retry_skips_original_pid_and_rejects_malformed_zip_without_touching_app() {
    let fixture = Fixture::new();
    prepare_retry_archive(&fixture.args).unwrap();
    let mut retry = retry_args(&fixture.args);
    // Still alive: waiting on this PID would take 60s instead of reaching ZIP.
    retry.pid = std::process::id();
    fs::write(&retry.zip, b"not a zip").unwrap();
    let mut failure = None;
    run(retry.clone(), |event| {
        if let InstallerEvent::Failed {
            can_retry,
            relaunch_on_close,
            ..
        } = event
        {
            failure = Some((can_retry, relaunch_on_close));
        }
    });
    assert_eq!(failure, Some((false, true)));
    fixture.assert_old_app();
    assert!(!retry.zip.exists());
    assert!(!retry.lock.exists());
}

#[test]
fn close_discards_only_its_retry_package_and_keeps_failed_rollback_backup() {
    let fixture = Fixture::new();
    let args = &fixture.args;
    prepare_retry_archive(args).unwrap();
    // Another download can appear at the original path while the error is open.
    fs::write(&args.zip, b"later update").unwrap();
    let (_, backup) = staging_dirs(args);
    fs::create_dir(&backup).unwrap();
    fs::write(backup.join("Cindy.exe"), b"recovery").unwrap();
    abandon_retry(args, false);
    abandon_retry(args, false);
    assert!(!retry_archive(args).exists());
    assert_eq!(fs::read(&args.zip).unwrap(), b"later update");
    assert_eq!(fs::read(backup.join("Cindy.exe")).unwrap(), b"recovery");
}

#[test]
fn close_starts_the_restored_app_after_removing_the_retry_package() {
    let fixture = Fixture::new();
    let args = &fixture.args;
    prepare_retry_archive(args).unwrap();
    let mut launched = false;
    abandon_retry_with(args, true, |exe| {
        assert_eq!(exe, args.app_dir.join(&args.exe_name));
        assert_eq!(fs::read(exe).unwrap(), b"old exe");
        assert!(!retry_archive(args).exists());
        launched = true;
        Ok(())
    })
    .unwrap();
    assert!(launched);
}

#[test]
fn pre_install_failure_retains_package_and_discards_partial_snapshots() {
    let fixture = Fixture::new();
    let (extract, backup) = fixture.prepare(&fixture.args);
    assert!(finish_failed_attempt(
        &fixture.args,
        &AttemptState::default()
    ));
    assert!(!extract.exists());
    assert!(!backup.exists());
    fixture.assert_old_app();
    assert!(retry_available(&retry_archive(&fixture.args)));
}

#[test]
fn retry_preserves_install_arguments_for_both_elevation_states() {
    let fixture = Fixture::new();
    let mut args = fixture.args.clone();
    args.install_key = Some("installation-key".into());
    for elevated in [false, true] {
        args.elevated = elevated;
        let retry = retry_args(&args);
        assert_eq!(retry.zip, retry_archive(&args));
        assert_eq!(retry.pid, 0);
        assert_eq!(retry.app_dir, args.app_dir);
        assert_eq!(retry.exe_name, args.exe_name);
        assert_eq!(retry.workdir, args.workdir);
        assert_eq!(retry.log, args.log);
        assert_eq!(retry.lock, args.lock);
        assert_eq!(retry.install_key, args.install_key);
        assert_eq!(retry.elevated, elevated);
        assert!(matches!(retry.theme, ThemeArg::Dark));
    }
}

#[test]
fn missing_archive_and_existing_retry_are_not_silently_reused() {
    let fixture = Fixture::new();
    let args = &fixture.args;
    let retry = retry_archive(args);
    fs::write(&retry, b"existing retry").unwrap();
    assert!(prepare_retry_archive(args).is_err());
    assert_eq!(fs::read(&retry).unwrap(), b"existing retry");
    fs::remove_file(&args.zip).unwrap();
    fs::remove_file(&retry).unwrap();
    assert!(!retry_available(&retry));
    assert!(!finish_failed_attempt(args, &AttemptState::default()));
    fs::create_dir(&retry).unwrap();
    assert!(!retry_available(&retry));
}
