#!/usr/bin/env node
// Executes the installed artifact, not tsx/source imports. All user state and
// synthetic secrets live in a fresh temporary directory, never the CI account.
import { spawn,execFile } from 'node:child_process';
import {promisify} from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const [runtimeArg, reportArg] = process.argv.slice(2);
if (!runtimeArg || !reportArg) throw new Error('Usage: platform-acceptance.mjs <runtime-directory> <report-directory>');
const runtime = path.resolve(runtimeArg), report = path.resolve(reportArg);
await mkdir(report, { recursive: true });
const realUserManager=process.platform==='linux'&&process.env.CINDY_ACCEPTANCE_SYSTEMD==='1';
const temporary = await mkdtemp(path.join(realUserManager?os.homedir():os.tmpdir(), 'cindy-platform-'));
const home = realUserManager?os.homedir():path.join(temporary, 'home'), profile = path.join(temporary, '终端 profile %name $value');
if(!realUserManager)await mkdir(home);
const node = path.join(runtime, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const cli = path.join(runtime, 'app/dist/cli.js');
const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'CI', 'TERM','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const env = { ...inherited, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state'), LOCALAPPDATA: path.join(home, 'AppData/Local'), APPDATA: path.join(home, 'AppData/Roaming'), CODEX_HOME: path.join(home, '.codex'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), NODE_PATH: '', NODE_OPTIONS: '' };
const results = [];
const record = (name, status, details) => { results.push({ name, status, ...(details ? { details } : {}) }); console.log(`${status}: ${name}${details ? ` (${details})` : ''}`); writeFileSync(path.join(report,'results.json'),JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,results},null,2)); };
async function run(args, { input = '', timeout = 30_000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    // Shared hosted-runner egress can exhaust GitHub's anonymous quota. Only
    // the metadata lookup command receives the ephemeral read-only job token;
    // the daemon, task processes and service installation keep the clean env.
    const commandEnv = args[0] === 'engines' && args[1] === 'update' && process.env.CINDY_GITHUB_API_TOKEN
      ? { ...env, CINDY_GITHUB_API_TOKEN: process.env.CINDY_GITHUB_API_TOKEN } : env;
    const child = spawn(node, [cli, ...args, '--state-dir', profile, '--json'], { env: commandEnv, cwd: home, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timeout: ${args.slice(0, 2).join(' ')}`)); }, timeout);
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject); child.on('close', code => {
      clearTimeout(timer);
      if (raw) { resolve({ code, output, error }); return; }
      if (code !== 0) { reject(new Error(`CLI ${args.slice(0, 2).join(' ')}: ${output}${error?'\n'+error:''}`)); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error(`Non-JSON CLI result: ${args.slice(0, 2).join(' ')}`)); }
    });
    child.stdin.end(input);
  });
}

let server;
let registered = false;
let tuiOutput = '';
let startupOutput = '';
let startupProbeError = '';
try {
  const version = await run(['--version']);
  for (const file of ['runtime-manifest.json', 'app/package.json', 'app/dist/build-info.json']) {
    assert.equal(JSON.parse(await readFile(path.join(runtime, file), 'utf8')).version, version);
  }
  record('bundled Node + CLI version', 'PASS', version);
  const help = await run(['--help']); assert.match(help, /Cindy/); record('bundled CLI help', 'PASS');
  server = spawn(node, [cli, 'serve', '--state-dir', profile], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', chunk => { startupOutput += chunk; }); server.stderr.on('data', chunk => { startupOutput += chunk; });
  let available = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Service exited before ready: ${startupOutput}`);
    // Each probe starts the installed CLI. Hosted Intel Macs took 2.6–3 s
    // even for --help/--version; a 2 s subprocess limit killed every healthy
    // probe before it could reach IPC. Keep the same overall ready deadline.
    try { const state = await run(['status'], { timeout: Math.min(10_000, Math.max(1, deadline - Date.now())) }); if (state.deviceId && state.version) { available = true; break; } }
    catch (error) { startupProbeError = String(error.message); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(available, 'Local IPC service must start'); record('real daemon + authenticated local socket/pipe', 'PASS');
  assert.equal((await run(['status'])).version, version);
  await run(['vault', 'setup', '--passphrase-stdin'], { input: 'test-only-platform-passphrase\n' });
  record('passphrase vault setup', 'PASS');
  const tasks = await run(['tasks', 'list']); assert.ok(tasks); record('daemon command through authenticated IPC', 'PASS');
  const channels = await run(['channels', 'list']);
  assert.deepEqual(channels.items.map(item => item.ref.id).sort(), ['dingtalk', 'discord', 'feishu', 'telegram', 'wechat', 'wecom', 'wecom-group']);
  const wechat = await run(['channels', 'get', 'wechat']);
  assert.equal(wechat.ref.id, 'wechat');
  assert.ok(wechat.actions.some(action => action.id === 'authorize'));
  const telegram = await run(['channels', 'get', 'telegram']);
  assert.equal(telegram.ref.id, 'telegram');
  assert.ok(telegram.actions.some(action => action.id === 'persona'));
  // Reading Telegram's form opens the real fresh group-history database. CLI
  // status alone would miss a background channel initialization failure.
  record('fresh IM history + channel configuration resources', 'PASS');
  const second = await run(['serve'], { raw: true, timeout: 10_000 }); assert.equal(second.code, 0); record('duplicate host does not replace original owner', 'PASS');
  await run(['status']);
  await run(['service', 'stop']);
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); }); server = undefined;
  const wrong = await run(['vault', 'unlock', '--passphrase-stdin'], { input: 'wrong-test-passphrase\n', raw: true });
  assert.notEqual(wrong.code, 0); record('vault rejects wrong passphrase after daemon restart', 'PASS');
  await run(['vault', 'unlock', '--passphrase-stdin'], { input: 'test-only-platform-passphrase\n' }); record('vault survives real process restart', 'PASS');
  // Local follow-up may omit unchanged engine downloads already validated in
  // a preceding artifact run; CI always executes the complete matrix.
  const engineKinds=process.env.CINDY_ACCEPTANCE_SKIP_ENGINES==='1'?[]:['claude-code','codex','pi'];
  if(!engineKinds.length)record('official engine downloads','SKIPPED','Previously validated; this run checks packaging and services');
  for (const kind of engineKinds) {
    const state = await run(['engines', 'install', kind], { timeout: 10 * 60_000 });
    assert.equal(state.source, 'managed'); assert.ok(state.version); record(`official ${kind} download + native --version`, 'PASS', state.version);
    if(kind==='pi'){
      const updated=await run(['engines','update',kind],{timeout:10*60_000});
      assert.equal(updated.source,'managed');assert.ok(updated.version);
      record('current official Pi update + native --version','PASS',updated.version);
    }
  }

  // Native PTY integration also captures an actual TUI frame; no mock streams.
  const require = createRequire(path.join(runtime, 'app/package.json'));
  assert.equal(typeof require('ssh2').Client, 'function'); record('SSH runtime dependency loads', 'PASS');
  const pty = require('node-pty');
  const screen = await new Promise((resolve, reject) => {
    // Exercise a real interactive terminal. Ink intentionally buffers frames
    // until exit under CI=true, even when it receives an actual PTY.
    const terminal = pty.spawn(node, [cli, '--state-dir', profile, '--lang', 'en'], { name: 'xterm-256color', cols: 100, rows: 32, cwd: home, env: { ...env, CI: 'false' } });
    let output = '', closing = false;
    const timeout = setTimeout(() => { terminal.kill(); reject(new Error('Native TUI did not render in PTY')); }, 20_000);
    terminal.onData(data => {
      output += data; tuiOutput = output;
      if (!closing && /Ctrl\+Q/.test(output)) {
        closing = true;
        // Let the first committed frame's input effect put the PTY into raw
        // mode. Before that, the tty driver consumes Ctrl+Q as XON flow control.
        setTimeout(() => terminal.write('\u0011'), 150);
      }
    });
    terminal.onExit(() => { clearTimeout(timeout); if (closing) resolve(output); else reject(new Error('TUI exited before rendering')); });
  });
  await writeFile(path.join(report, 'tui.ansi'), screen);
  record('native PTY + rendered TUI frame', 'PASS');

  // Actual local WebRTC data channel; no TURN/STUN service or account required.
  const { RTCPeerConnection } = require('@roamhq/wrtc');
  const left = new RTCPeerConnection(), right = new RTCPeerConnection();
  const gathering = peer => peer.iceGatheringState === 'complete' ? Promise.resolve() : new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ICE gathering timeout')), 10_000);
    peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); } });
  });
  const sender = left.createDataChannel('acceptance');
  let receiver;
  try {
    let resolveReceived;
    const received = new Promise(resolve => { resolveReceived = resolve; right.ondatachannel = event => { receiver=event.channel; receiver.onmessage = message => resolveReceived(message.data); }; });
    const open = new Promise(resolve => { sender.onopen = resolve; });
    let timeout;
    try { await Promise.race([(async () => {
      await left.setLocalDescription(await left.createOffer()); await gathering(left); await right.setRemoteDescription(left.localDescription);
      await right.setLocalDescription(await right.createAnswer()); await gathering(right); await left.setRemoteDescription(right.localDescription);
      await open; sender.send('cindy-platform-test'); assert.equal(await received, 'cindy-platform-test');
    })(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('RTC data channel timeout')), 25_000); })]); }
    finally { clearTimeout(timeout); }
    record('real local WebRTC data channel', 'PASS');
  } finally { sender.onopen=null;sender.close();if(receiver){receiver.onmessage=null;receiver.close();}right.ondatachannel=null;left.close();right.close(); }

  if(process.platform==='win32')await promisify(execFile)(path.join(process.env.SystemRoot,'System32/wevtutil.exe'),['sl','Microsoft-Windows-TaskScheduler/Operational','/e:true'],{timeout:10_000}).catch(()=>{});
  const install = await run(['service', 'install'], { raw: true });
  if (install.code === 0) {
    registered = true; record('native user-service registration', 'PASS');
    if(realUserManager){const installed=JSON.parse(install.output);assert.equal(installed.starts,'boot');record('systemd linger registers startup without an interactive login','PASS');}
    const activated = await run(['service','activate'],{timeout:90_000});
    console.log('SYNTHETIC_SERVICE_ACTIVATED',JSON.stringify(activated.service));
    assert.equal(activated.service.running,true); assert.ok(activated.status.deviceId);
    record('native user-service activation + real IPC', 'PASS');
    const previousStart=activated.status.startedAt;
    const restarted=await run(['service','restart'],{timeout:90_000});
    assert.ok(restarted.startedAt>previousStart); assert.equal(restarted.deviceId,activated.status.deviceId);
    const running=await run(['service','status']);assert.equal(running.service.running,true);
    record('native user-service restart preserves profile', 'PASS');
    // Crash only the exact synthetic service, then observe the installed service's
    // recovery (the Windows task owns a supervising process). status is passive and cannot create a substitute daemon.
    const endpoint=JSON.parse(await readFile(path.join(profile,'service.json'),'utf8'));
    assert.ok(Number.isSafeInteger(endpoint.pid)&&endpoint.pid>0);
    console.log('SYNTHETIC_SERVICE_CRASH_PID',endpoint.pid);
    process.kill(endpoint.pid,'SIGKILL');
    try{process.kill(endpoint.pid,0);console.log('SYNTHETIC_KILLED_PID_STILL_PRESENT');}catch(error){console.log('SYNTHETIC_KILLED_PID_RESULT',error.code);}
    const recoveryDeadline=Date.now()+100_000;let recovered=false,lastRecoveryState,lastRecoveryError;
    while(Date.now()<recoveryDeadline){
      try{const state=await run(['service','status'],{timeout:25_000});lastRecoveryState={startedAt:state.startedAt,service:state.service};if(state.startedAt>restarted.startedAt&&state.service?.running){assert.equal(state.deviceId,restarted.deviceId);recovered=true;break;}}catch(error){lastRecoveryError=String(error.message);}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!recovered)console.log('SYNTHETIC_RECOVERY_STATE',JSON.stringify({lastRecoveryState,lastRecoveryError}));
    assert.ok(recovered,'Native service manager must recover its crashed host');
    record('Managed host crash recovery without CLI auto-start', 'PASS');
    await run(['service','stop']);
    let stopped=false;
    const stopDeadline=Date.now()+45_000;
    while(Date.now()<stopDeadline){
      const state=await run(['service','status'],{timeout:25_000});
      if(!state.startedAt&&!state.service?.running){stopped=true;break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(stopped,'An intentional stop must finish the managed service');
    record('intentional stop does not trigger crash recovery','PASS');
    await run(['service','start'],{timeout:90_000});
    await run(['service', 'uninstall']); registered = false;
    record('native user-service removal', 'PASS');
  }
  else if (process.platform === 'linux' && !realUserManager && /USER_SERVICE_MANAGER_UNAVAILABLE/.test(install.output)) record('native user-service registration', 'UNAVAILABLE', 'No systemd user manager; not claimed as tested');
  else throw new Error(`Service registration failed: ${install.output || install.error}`);
  await run(['service', 'stop']);
} catch (error) {
  record('platform acceptance', 'FAIL', String(error.message)); process.exitCode = 1;
  // This entire profile contains synthetic acceptance data only.
  if (server) {
    const startup = { output: startupOutput, probeError: startupProbeError, exitCode: server.exitCode, signalCode: server.signalCode };
    await writeFile(path.join(report, 'startup-diagnostic.json'), JSON.stringify(startup, null, 2));
    console.log('SYNTHETIC_STARTUP_DIAGNOSTIC', JSON.stringify(startup));
  }
  console.log('SYNTHETIC_SERVICE_DIAGNOSTIC', await readFile(path.join(profile, 'service.log'), 'utf8').catch(() => 'No service log'));
  if(realUserManager){
    const installation=JSON.parse(await readFile(path.join(profile,'service-installation.json'),'utf8').catch(()=>'null'));
    if(installation?.id){
      console.log('SYNTHETIC_SERVICE_UNIT',await readFile(installation.file,'utf8').catch(()=>''));
      const journal=await promisify(execFile)('journalctl',['--user','--unit',`${installation.id}.service`,'--no-pager','--lines=60'],{env,timeout:15_000}).catch(error=>({stdout:error.stdout??'',stderr:String(error.message)+' '+(error.stderr??'')}));
      console.log('SYNTHETIC_SERVICE_JOURNAL',journal.stdout,journal.stderr);
    }
  }
  if(process.platform==='win32'){
    const installation=JSON.parse(await readFile(path.join(profile,'service-installation.json'),'utf8').catch(()=>'null'));
    if(installation?.id){
      const script=`$ErrorActionPreference='Stop';[Console]::WriteLine('PS_START');$s=[Activator]::CreateInstance([type]::GetTypeFromProgID('Schedule.Service'));[Console]::WriteLine('PS_COM');$s.Connect();[Console]::WriteLine('PS_CONNECTED');$t=$s.GetFolder('\\').GetTask('${installation.id}');[Console]::WriteLine('State='+[int]$t.State);[Console]::WriteLine('LastResult='+$t.LastTaskResult);[Console]::WriteLine('LastRun='+$t.LastRunTime);[Console]::WriteLine($t.Xml)`;
      const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
      const diagnostic=await promisify(execFile)(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:process.env,timeout:15_000}).catch(error=>({stdout:error.stdout??'',stderr:String(error.message)+' '+(error.stderr??'')}));
      console.log('SYNTHETIC_SCHEDULER_STATE',diagnostic.stdout,diagnostic.stderr);
      const events=await promisify(execFile)(path.join(process.env.SystemRoot,'System32/wevtutil.exe'),['qe','Microsoft-Windows-TaskScheduler/Operational',`/q:*[EventData[Data[@Name='TaskName']='\\${installation.id}']]`,'/f:text','/c:40','/rd:true'],{timeout:10_000}).catch(error=>({stdout:error.stdout??'',stderr:String(error.message)}));
      console.log('SYNTHETIC_SCHEDULER_EVENTS',events.stdout,events.stderr);
      console.log('SYNTHETIC_SERVICE_ENDPOINT',await readFile(path.join(profile,'service.json'),'utf8').then(text=>{const {pid}=JSON.parse(text);return {pid};}).catch(()=>null));
    }
  }
} finally {
  if (tuiOutput) await writeFile(path.join(report, 'tui.ansi'), tuiOutput);
  if (registered) await run(['service', 'uninstall'], { raw: true }).catch(() => {});
  await run(['service', 'stop'], { raw: true, timeout: 5000 }).catch(() => {});
  server?.kill();
  await writeFile(path.join(report, 'results.json'), JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, results }, null, 2));
  await writeFile(path.join(report, 'runtime-manifest.json'), await readFile(path.join(runtime, 'runtime-manifest.json')));
  await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  console.log('NATIVE_ACCEPTANCE_CLEANUP_COMPLETE',JSON.stringify(process.getActiveResourcesInfo()));
}
