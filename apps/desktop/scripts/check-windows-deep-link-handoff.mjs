/**
 * Windows integration: elevated receiver + ordinary sender, using the production
 * native pipe and handoff controller with disposable permission fixtures. No Cindy
 * install/profile/protocol registration is touched. Run from an elevated dev
 * terminal with --addon=<built cindy-windows-taskbar.node or .dll>.
 * Regression: browser deep links disappeared after Program Files updates.
 * Unit tests cannot exercise Windows tokens, ACLs, or cross-process delivery.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Electron restricts queries of an elevated browser-process token. The Node
// matrix alone cannot reproduce that boundary; --electron runs the SAME test
// and production transport with real Electron processes on both sides.
if (process.argv.includes('--electron') && !process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const driver = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-handoff-electron-'));
  try {
    const entry = path.join(driver, 'main.cjs');
    await fs.writeFile(entry, `const {app}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(driver, 'profile'))});
app.whenReady().then(()=>import(${JSON.stringify(import.meta.url)})).catch(error=>{console.error(error);app.exit(1)});`);
    execFileSync(require('electron'), [entry, ...process.argv.slice(2)], {
      env, stdio: 'inherit', windowsHide: true, timeout: 240_000,
    });
  } finally {
    await fs.rm(driver, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
  process.exit(0);
}
const addonArg = process.argv.find((arg) => arg.startsWith('--addon='))?.slice(8);
if (process.platform !== 'win32' || !addonArg) throw new Error('Requires Windows and --addon=<built native addon>');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-deep-link-check-'));
const electronApp = process.versions.electron ? require('electron').app : undefined;
if (electronApp) {
  electronApp.setPath('userData', path.join(fixture, 'receiver-profile'));
  await electronApp.whenReady();
}
let handoff;
try {
  const binary = path.resolve(addonArg);
  const addonModule = { exports: {} };
  process.dlopen(addonModule, binary);
  const native = addonModule.exports;
  assert.equal(native.isProcessElevated(), true, 'Run this integration test from an elevated development terminal');

  const ts = require('typescript');
  const controller = path.join(root, 'apps/desktop/src/main/windowsDeepLinkHandoff.ts');
  const compiled = ts.transpileModule(await fs.readFile(controller, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const controllerFile = path.join(fixture, 'controller.cjs');
  await fs.writeFile(controllerFile, compiled);
  const { createWindowsDeepLinkHandoff } = require(controllerFile);
  const firstId = randomUUID();
  const secondId = randomUUID();
  const deliveries = [];
  const failures = [];
  handoff = createWindowsDeepLinkHandoff({
    lockScopeDir: fixture, native,
    isDeepLink: (url) => url.startsWith('cindy://'),
    dispatch: (url, source) => deliveries.push({ url, source }),
    onFailure: (stage) => failures.push(stage),
  });
  handoff.start();
  assert.deepEqual(failures, []);
  // Simulate Electron arriving first for one launch; the real fallback must not
  // repeat its effect. The next user click still gets delivered independently.
  handoff.dispatch('cindy://focus/integration', { cindyDeepLinkRequest: firstId }, 'second-instance');

  const clientFile = path.join(fixture, 'client.cjs');
  const receipt = path.join(fixture, 'receipt.json');
  const senderStarted = path.join(fixture, 'sender-started.txt');
  const senderExit = path.join(fixture, 'sender-exit.txt');
  // The fixture verifies the sender's user/session against this receiver.
  // Prepare the malformed-frame endpoint before the sender's bounded run;
  // a cold PowerShell startup is not part of the production pipe operation.
  const identityCommand = '[pscustomobject]@{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;session=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json -Compress';
  const identity = JSON.parse(execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(identityCommand, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }));
  const scope = createHash('sha256').update(path.win32.resolve(fixture).toLowerCase()).digest('hex');
  const pipe = String.raw`\\.\pipe\cindy-deep-link-v1-` + identity.sid + '-' + identity.session + '-' + scope;
  await fs.writeFile(clientFile, `
const fs = require('node:fs');
const net = require('node:net');
(async () => {
fs.writeFileSync(${JSON.stringify(senderStarted)}, 'entered');
if (process.versions.electron) require('electron').app.setPath('userData', ${JSON.stringify(path.join(fixture, 'sender-profile'))});
const addonModule = { exports: {} };
process.dlopen(addonModule, ${JSON.stringify(binary)});
const native = addonModule.exports;
const { createWindowsDeepLinkHandoff } = require(${JSON.stringify(controllerFile)});
const failures = [];
const options = { lockScopeDir: ${JSON.stringify(fixture)}, native, isDeepLink: url => url.startsWith('cindy://'), dispatch: () => { throw new Error('sender must not dispatch'); }, onFailure: stage => failures.push(stage) };
const handoff = createWindowsDeepLinkHandoff(options);
const elevated = native.isProcessElevated();
const pipe = ${JSON.stringify(pipe)};
const oversized = Buffer.alloc(4 + 32_769, 32);
oversized.writeUInt32LE(32_769, 0);
for (const frame of [Buffer.from([1]), oversized]) {
  await new Promise((resolve, reject) => {
    let received = false;
    const socket = net.connect(pipe, () => socket.end(frame));
    socket.on('data', () => { received = true; });
    socket.on('error', error => { if (!['ECONNRESET', 'EPIPE'].includes(error.code)) reject(error); });
    socket.on('close', () => received ? reject(new Error('malformed frame received an ACK')) : resolve());
    socket.setTimeout(3_000, () => { socket.destroy(); reject(new Error('malformed client stalled listener')); });
  });
}
const first = handoff.forward('cindy://focus/integration', { cindyDeepLinkRequest: ${JSON.stringify(firstId)} });
const second = handoff.forward('cindy://shared-task/join?invitation=synthetic-test-only', { cindyDeepLinkRequest: ${JSON.stringify(secondId)} });
const otherProfile = createWindowsDeepLinkHandoff({ ...options, lockScopeDir: options.lockScopeDir + '-other' });
const wrongProfile = otherProfile.forward('cindy://focus/integration', { cindyDeepLinkRequest: ${JSON.stringify(randomUUID())} });
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ elevated, first, second, wrongProfile, failures }));
})().catch(error => { fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ error: String(error) })); process.exitCode = 1; }).finally(() => { if (process.versions.electron) require('electron').app.exit(process.exitCode || 0); });
`);

  // Compile a disposable permission fixture for the ordinary sender. Its child
  // starts the same Node executable as the receiver, retaining the original
  // fixture caller's environment/cwd, and uses only synthetic URLs.
  const project = path.join(fixture, 'launcher');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'Cargo.toml'), `[package]
name = "cindy-launch-check"
version = "0.0.0"
edition = "2021"
[dependencies]
windows-sys = { version = "0.59", features = ["Win32_Foundation", "Win32_Security", "Win32_System_Environment", "Win32_System_Threading", "Win32_UI_WindowsAndMessaging"] }
`);
  const launchSource = path.join(root, 'apps/desktop/scripts/fixtures/windows-deep-link-launch.rs');
  await fs.writeFile(path.join(project, 'src/main.rs'), `
#![windows_subsystem = "windows"]
#[path = ${JSON.stringify(launchSource)}] mod windows_launch;
use std::os::windows::process::CommandExt;
fn main() {
  if std::env::args().len() > 1 {
    // Use a normal absolute fixture path. Rust's
    // current_exe can expose libuv's internal verbatim-path launch spelling.
    let exe = std::env::current_exe().unwrap();
    let text = exe.to_string_lossy();
    let text = text.strip_prefix(r"\\\\?\\").unwrap_or(&text);
    let process = windows_launch::spawn_detached(std::path::Path::new(text), |error| panic!("normal desktop parent required: {error}")).unwrap();
    // A fast fixture can finish before this snapshot. Both live and successful
    // exit are valid; the Node driver still verifies the real pipe deliveries.
    assert!(matches!(windows_launch::wait_for_exit(&process, std::time::Duration::ZERO).unwrap(), None | Some(0)));
  } else {
    assert!(windows_launch::launch_via_desktop_shell(std::path::Path::new("missing-test-app.exe")).unwrap().is_none());
    let status = std::process::Command::new(${JSON.stringify(process.execPath)})
      .arg(${JSON.stringify(clientFile)}).creation_flags(0x08000000).status().unwrap();
    std::fs::write(${JSON.stringify(senderExit)}, format!("{status:?}")).unwrap();
    std::process::exit(status.code().unwrap_or(1));
  }
}
`);
  const cargo = path.join(os.homedir(), '.cargo/bin/cargo.exe');
  const env = { ...process.env };
  // Keep this probe independent of shell startup and overlong inherited PATHs.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = [path.dirname(cargo), path.dirname(process.execPath), path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';');
  execFileSync(cargo, ['build', '--manifest-path', path.join(project, 'Cargo.toml')], {
    env, stdio: 'inherit', windowsHide: true, timeout: 180_000,
  });
  execFileSync(path.join(project, 'target/debug/cindy-launch-check.exe'), ['--launch'], {
    env, stdio: 'inherit', windowsHide: true, timeout: 10_000,
  });
  const deadline = Date.now() + 10_000;
  let result;
  while (Date.now() < deadline) {
    try { result = JSON.parse(await fs.readFile(receipt, 'utf8')); break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (result === undefined) {
    const started = await fs.readFile(senderStarted, 'utf8').catch(() => 'not observed');
    const exit = await fs.readFile(senderExit, 'utf8').catch(() => 'not observed');
    assert.fail(`Sender did not produce its receipt within 10 seconds (entry: ${started}; exit: ${exit})`);
  }
  assert.deepEqual(result, { elevated: false, first: true, second: true, wrongProfile: false, failures: [] });
  assert.deepEqual(failures, []);
  assert.deepEqual(deliveries, [
    { url: 'cindy://focus/integration', source: 'second-instance' },
    { url: 'cindy://shared-task/join?invitation=synthetic-test-only', source: 'windows-handoff' },
  ]);
  handoff.close();
  handoff = undefined;
  console.log('PASS: ' + (electronApp ? 'Electron' : 'Node') + ' normal sender → elevated receiver; verified ordinary sender context; launch deduplication; profile isolation; malformed-client recovery');
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  throw error;
} finally {
  handoff?.close();
  // The limited-token probe may still be exiting after writing its receipt.
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  electronApp?.exit(process.exitCode || 0);
}
