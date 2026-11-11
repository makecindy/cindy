/**
 * Integration tier: compile the production Windows updater launcher and run
 * only disposable fixture executables. Regression: asynchronous Shell launch
 * could arrive after rollback, and admin-only targets must retain their policy.
 * Unit fakes cannot verify Windows tokens, process handles, IPC or AppCompat.
 * Requires an elevated dev terminal and --mt=<Windows SDK x64 mt.exe>.
 * No installed Cindy, profile, registry or protocol association is changed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const mt = process.argv.find(arg => arg.startsWith('--mt='))?.slice(5);
if (process.platform !== 'win32' || !mt) throw new Error('Requires Windows and --mt=<Windows SDK mt.exe>');
const fixture = path.join(root, '.artifacts', `updater-launch-check-${randomUUID()}`);
const project = path.join(fixture, 'launcher');
const cargo = path.join(os.homedir(), '.cargo/bin/cargo.exe');
const launchSource = path.join(root, 'apps/desktop/cindy-updater/src-tauri/src/windows_launch.rs');
await fs.mkdir(path.join(project, 'src'), { recursive: true });
try {
  await fs.writeFile(path.join(project, 'Cargo.toml'), `[package]
name = "updater-launch-check"
version = "0.0.0"
edition = "2021"
[dependencies]
windows-sys = { version = "0.59", features = ["Win32_Foundation", "Win32_Security", "Win32_System_Threading", "Win32_UI_WindowsAndMessaging"] }
`);
  await fs.writeFile(path.join(project, 'src/main.rs'), `
#[path = ${JSON.stringify(launchSource)}] mod windows_launch;
use std::{mem, ptr, os::windows::{io::AsRawHandle, process::CommandExt}};
use windows_sys::Win32::{Foundation::{CloseHandle, WAIT_OBJECT_0}, Security::{TOKEN_QUERY, TOKEN_ELEVATION, TokenElevation, GetTokenInformation}, System::Threading::{OpenProcessToken, GetCurrentProcess, GetExitCodeProcess, WaitForSingleObject, CreateEventW, SetEvent}};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 1 {
        let mut token = ptr::null_mut();
        assert_ne!(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }, 0);
        let mut elevation: TOKEN_ELEVATION = unsafe { mem::zeroed() };
        let mut size = 0;
        assert_ne!(unsafe { GetTokenInformation(token, TokenElevation, (&mut elevation as *mut TOKEN_ELEVATION).cast(), mem::size_of_val(&elevation) as u32, &mut size) }, 0);
        unsafe { CloseHandle(token) };
        let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
        assert!(!event.is_null());
        assert_ne!(unsafe { SetEvent(event) }, 0);
        assert_eq!(unsafe { WaitForSingleObject(event, 0) }, WAIT_OBJECT_0);
        unsafe { CloseHandle(event) };
        assert!(std::process::Command::new(std::env::var("ComSpec").unwrap()).args(["/d", "/c", "exit", "0"]).creation_flags(0x08000000).status().unwrap().success());
        std::fs::write(std::env::var("CINDY_LAUNCH_TEST_RECEIPT").unwrap(), format!("{}|{}|{}", elevation.TokenIsElevated, std::env::current_dir().unwrap().display(), std::env::var("CINDY_LAUNCH_TEST_CONTEXT").unwrap())).unwrap();
        if let Some(release) = std::env::var_os("CINDY_LAUNCH_TEST_RELEASE") {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !std::path::Path::new(&release).exists() {
                assert!(std::time::Instant::now() < deadline, "fixture release timed out");
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        // The ordinary caller must keep its existing route and token-query access.
        if elevation.TokenIsElevated == 0 {
            assert!(windows_launch::launch_via_desktop_shell(std::path::Path::new("missing.exe")).unwrap().is_none());
        }
        return;
    }
    match windows_launch::spawn_detached(std::path::Path::new(&args[1]), |error| println!("fallback: {error}")) {
        Ok(process) => {
            assert_eq!(unsafe { WaitForSingleObject(process.as_raw_handle(), 10_000) }, WAIT_OBJECT_0);
            let mut exit_code = 0;
            assert_ne!(unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut exit_code) }, 0);
            assert_eq!(exit_code, 0);
            assert!(!windows_launch::is_running(&process).unwrap());
        }
        Err(error) if args.get(2).map(|arg| arg == "missing").unwrap_or(false) => println!("creation-failed: {error}"),
        Err(error) => panic!("{error}"),
    }
}
`);
  execFileSync(cargo, ['build', '--offline', '--manifest-path', path.join(project, 'Cargo.toml')], {
    stdio: 'inherit', windowsHide: true, timeout: 180_000,
  });
  const exe = path.join(project, 'target/debug/updater-launch-check.exe');
  const manifest = path.join(fixture, 'admin.manifest');
  await fs.writeFile(manifest, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="requireAdministrator" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>');
  const targets = path.join(fixture, '发行 空格');
  await fs.mkdir(targets);
  for (const mode of ['ordinary', 'manifest-admin', 'compat-admin']) {
    const target = path.join(targets, `${mode}.exe`);
    const receipt = path.join(targets, `${mode}.txt`);
    await fs.copyFile(exe, target);
    if (mode === 'manifest-admin') {
      execFileSync(mt, ['-nologo', '-manifest', manifest, `-outputresource:${target};#1`], { stdio: 'inherit', windowsHide: true });
    }
    const env = { ...process.env, CINDY_LAUNCH_TEST_RECEIPT: receipt, CINDY_LAUNCH_TEST_CONTEXT: 'synthetic-only' };
    delete env.__COMPAT_LAYER;
    delete env.CINDY_LAUNCH_TEST_RELEASE;
    if (mode === 'compat-admin') env.__COMPAT_LAYER = 'RUNASADMIN';
    const output = execFileSync(exe, [target], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    const [elevated, cwd, context] = (await fs.readFile(receipt, 'utf8')).split('|');
    assert.equal(cwd.toLowerCase(), root.toLowerCase());
    assert.equal(context, 'synthetic-only');
    assert.equal(elevated, mode === 'ordinary' ? '0' : '1');
    if (mode === 'ordinary') assert.equal(output, '');
    else assert.match(output, /fallback:.*740/);
    console.log(`PASS: ${mode}; child token query, event IPC, descendants, context and exit handle`);
  }
  const output = execFileSync(exe, [path.join(targets, 'missing.exe'), 'missing'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.match(output, /fallback:.*Some\(2\)/);
  assert.match(output, /creation-failed:/);
  console.log('PASS: missing target returns a definite creation failure');
  if (process.argv.includes('--transaction')) {
    const env = { ...process.env, CINDY_UPDATER_TEST_EXE: exe };
    delete env.CINDY_VERSION_SYNC_KEY;
    delete env.__COMPAT_LAYER;
    execFileSync(cargo, ['test', '--locked', '--manifest-path', path.join(root, 'apps/desktop/cindy-updater/src-tauri/Cargo.toml'), 'real_launcher_transactions_rollback_retry_and_close', '--', '--ignored', '--nocapture'], {
      env, stdio: 'inherit', windowsHide: true, timeout: 180_000,
    });
    console.log('PASS: isolated installer replacement, sequential upgrades, rollback, Retry and Close through the production launcher');
  }
} finally {
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
