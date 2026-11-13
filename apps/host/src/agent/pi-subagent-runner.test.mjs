// Integration: the Host launcher forks its real runner entry (pi-subagent-runner-process.cts) as a
// Node child process, with a fixture runner.cjs in a temporary run directory. No Pi, no model, no
// network; the child gets only the environment given here (HOME is a new empty directory).
// Rule: release table row 19 / P4 (reviewer, step 8 decision): same entry contract as the desktop's
// utilityProcess entry, ready frame once, the IPC channel closed before the runner loads, the child
// stopped through the recorded handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnHostPiSubagentRunner } from './pi-subagent-runner.ts';
import { probeProcessStartTimeSec, startParentWatchdog } from './pi-subagent-parent-watchdog.cts';
import { createHostAgentGraph } from './runtime.ts';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

function fixtureRunnerEnv(root) {
  const env = { PATH: process.env.PATH ?? '', HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') };
  if (process.platform === 'win32') {
    // Production passes Pi's full spawnEnv as durableSpawnEnv. Windows system
    // programs therefore have these directories; isolate them outside HOME here.
    for (const [key, dir] of [['TEMP', 'temp'], ['TMP', 'temp'], ['APPDATA', 'app-data'], ['LOCALAPPDATA', 'local-app-data']]) {
      env[key] = path.join(root, dir);
      fs.mkdirSync(env[key], { recursive: true });
    }
    for (const key of ['SystemRoot', 'windir']) if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function directoryEntries(root, dir = root) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    const stat = fs.lstatSync(file);
    const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
    const row = { path: path.relative(root, file), type, ...(stat.isFile() ? { bytes: stat.size } : {}) };
    return [row, ...(stat.isDirectory() ? directoryEntries(root, file) : [])];
  });
}

function diagnoseRunnerDirectories(t, root) {
  if (process.platform !== 'win32') return;
  for (const dir of ['temp', 'app-data', 'local-app-data']) {
    const directory = path.join(root, dir);
    t.diagnostic(JSON.stringify({ directory, entries: directoryEntries(directory) }));
  }
}

function stageRun(root, runId) {
  const runDir = path.join(root, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const status = path.join(root, 'status.json');
  // The fixture runner records what it sees, then stays alive until stopped.
  fs.writeFileSync(path.join(runDir, 'runner.cjs'), `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(status)}, JSON.stringify({
  connected: process.connected, send: typeof process.send, argv: process.argv.slice(1),
  home: process.env.HOME, parentOnly: process.env.CINDY_TEST_PARENT_ONLY ?? null,
}));
setInterval(() => {}, 1000);
`);
  fs.writeFileSync(path.join(runDir, 'config.json'), '{}');
  return { runDir, status, request: {
    runId, runDir, runnerFile: path.join(runDir, 'runner.cjs'), configFile: path.join(runDir, 'config.json'),
    cwd: root, env: fixtureRunnerEnv(root),
  } };
}

const waitFor = async (predicate, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('the runner is ready once, loses its IPC channel before loading, and stops through its handle', async t => {
  let runner;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-pi-runner-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const controlRoot = process.platform === 'win32' ? path.join(root, 'powershell-control') : null;
  const controlHome = controlRoot ? path.join(controlRoot, 'home') : null;
  let controlRun;
  try {
    if (controlRoot) {
      fs.mkdirSync(controlHome, { recursive: true });
      // Measure Windows known-folder creation with the same isolated environment,
      // without running Node, tsx, or our runner in the control home.
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$null'], {
        cwd: controlRoot, env: fixtureRunnerEnv(controlRoot), windowsHide: true, encoding: 'utf8', timeout: 5_000,
      });
      controlRun = { status: result.status, signal: result.signal,
        error: result.error ? { code: result.error.code, message: result.error.message } : null,
        stdout: result.stdout, stderr: result.stderr };
      const detail = JSON.stringify({ home, entries: directoryEntries(home),
        controlHome, controlEntries: directoryEntries(controlHome), controlRun });
      assert.equal(result.error, undefined, detail);
      assert.equal(result.status, 0, detail);
    }
    const { status, request } = stageRun(root, 'run-1');
    // A variable only the parent has must not reach the child.
    process.env.CINDY_TEST_PARENT_ONLY = 'parent-only';
    runner = spawnHostPiSubagentRunner(request);
    const spawned = new Promise((resolve, reject) => {
      runner.once('spawn', resolve);
      runner.once('error', reject);
      runner.once('exit', code => reject(new Error(`exited before ready (${code})`)));
    });
    await spawned;
    await waitFor(() => fs.existsSync(status));
    const seen = JSON.parse(fs.readFileSync(status, 'utf8'));
    // The desktop entry clears parentPort; here the channel is closed before the runner loads.
    assert.equal(seen.connected, false);
    assert.deepEqual(seen.argv, [request.runnerFile, request.configFile]);
    // Only the request's environment reaches the child.
    assert.equal(seen.home, request.env.HOME);
    assert.equal(seen.parentOnly, null);
    const pid = runner.pid;
    assert.ok(pid && alive(pid));
    const exited = new Promise(resolve => runner.once('exit', (code, signal) => resolve({ code, signal })));
    assert.equal(runner.kill('SIGTERM'), true);
    // Node reports TerminateProcess on Windows as exit code 1, without a signal.
    // PiAgent confirms a requested exit from the exit/close event, not this shape.
    assert.deepEqual(await exited, process.platform === 'win32'
      ? { code: 1, signal: null } : { code: null, signal: 'SIGTERM' });
    assert.equal(runner.killed, true);
    assert.equal(alive(pid), false);
    const entries = directoryEntries(home);
    const controlEntries = controlHome ? directoryEntries(controlHome) : [];
    const detail = JSON.stringify({ home, entries, controlHome, controlEntries });
    // Files, links, and other entry kinds are forbidden on every platform and
    // in both homes. Windows directory names come from this run's control only.
    assert.deepEqual(entries.filter(entry => entry.type !== 'directory'), [], detail);
    assert.deepEqual(controlEntries.filter(entry => entry.type !== 'directory'), [], detail);
    assert.deepEqual(entries.map(entry => entry.path).sort(), controlEntries.map(entry => entry.path).sort(), detail);
  } finally {
    // A failed assertion above must not leave the fixture runner behind: stop it through its handle.
    if (runner && !runner.killed) runner.kill('SIGKILL');
    delete process.env.CINDY_TEST_PARENT_ONLY;
    t.diagnostic(JSON.stringify({ home, entries: directoryEntries(home) }));
    diagnoseRunnerDirectories(t, root);
    if (controlRoot) {
      t.diagnostic(JSON.stringify({ home: controlHome, entries: directoryEntries(controlHome), controlRun }));
      diagnoseRunnerDirectories(t, controlRoot);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('paths outside the declared run directory are refused before any process starts', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-pi-runner-')));
  try {
    const { request } = stageRun(root, 'run-2');
    let forks = 0;
    const forkStub = () => { forks += 1; throw new Error('must not fork'); };
    assert.throws(() => spawnHostPiSubagentRunner({ ...request, runId: 'other' }, forkStub), /paths are invalid/);
    assert.throws(() => spawnHostPiSubagentRunner({ ...request, configFile: path.join(root, 'config.json') }, forkStub), /paths are invalid/);
    assert.equal(forks, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


// maker-core's runner source as a release build produces it. Under tsx (this test, any Host source
// run) the embedded createPiCacheInputTracker.toString() carries tsx's __name helper, which the
// runner process does not define; esbuild without keepNames, as the Host release build, does not.
const { outputFiles: [runnerModule] } = await build({
  entryPoints: [path.join(here, '../../../../packages/maker-core/src/agents/pi/cindy-subagent-runner-source.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false,
});
const { CINDY_SUBAGENT_RUNNER_SOURCE } = await import(`data:text/javascript;base64,${Buffer.from(runnerModule.text).toString('base64')}`);

// The real runner (maker-core's runner source) with a fake Pi binary: a Node script that records its
// pid and waits. The runner starts it in its own process group, as it starts Pi.
function stageRealRun(root, runId, { ignoreTerm = false } = {}) {
  const runDir = path.join(root, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const piPids = path.join(root, `${runId}-pi.pids`);
  const fakePi = path.join(root, `${runId}-fake-pi.cjs`);
  fs.writeFileSync(fakePi, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(piPids)}, process.pid + '\\n');
process.stdin.resume();
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const runner = ignoreTerm
    // A runner that ignores SIGTERM, for the SIGKILL fallback; it starts the same detached child.
    ? `process.on('SIGTERM', () => {});
require('node:child_process').spawn(${JSON.stringify(fakePi)}, [], { stdio: 'ignore', detached: true }).unref();
setInterval(() => {}, 1000);
`
    : CINDY_SUBAGENT_RUNNER_SOURCE;
  fs.writeFileSync(path.join(runDir, 'runner.cjs'), runner);
  fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify({
    version: 1, runId, runDir, cwd: root, binary: fakePi, timeoutMs: 60_000, interactiveOwner: 'host',
    bridgeExtension: path.join(runDir, 'bridge.js'), childConfigHome: path.join(runDir, 'child-home'),
    tasks: [{ childId: 'child-1', agent: 'worker', task: 'fixture', tools: 'read', profilePrompt: 'fixture',
      provider: 'fixture', sessionId: 'child-session', sessionDir: path.join(runDir, 'sessions', 'child') }],
  }));
  return { piPids, request: {
    runId, runDir, runnerFile: path.join(runDir, 'runner.cjs'), configFile: path.join(runDir, 'config.json'),
    cwd: root, env: fixtureRunnerEnv(root),
  } };
}
const readPids = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : []);

function hostPiGraph(root) {
  configureHostOwner({ userDataDir: root, ownerId: 'pi-runner-owner' });
  const harnessRoot = path.join(root, 'harnesses');
  const rgDir = path.join(harnessRoot, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(rgDir, { recursive: true });
  fs.writeFileSync(path.join(rgDir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  const graph = createHostAgentGraph({
    userDataDir: root, harnessRoot, gateway: null, piBinaryPath: path.join(root, 'pi'), mcpRuntime: mcp, mcpProviders: [],
    storage: {},
    providerConfig: {
      grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
      list: async () => [], readKey: () => null, oauth: { readCachedGenericOAuthAccessToken: () => null },
      codexAccounts: { setCodexAccountRetirement: () => {}, isOpenAiSubscriptionProviderId: id => id === 'openai' },
    },
  });
  return { graph, mcp };
}

// Integration through maker-core's own handles (reviewer, P4 decision A): the PiAgent the Host
// assembles launches the runner with the Host launcher; ending it through the account-boundary /
// terminate path (terminateSubagentRunner) and through Host shutdown (Maker.shutdown -> PiAgent.dispose)
// leaves neither the runner nor its Pi child. A runner that ignores SIGTERM is killed by the fallback.
// The launch and terminate methods are private in PiAgent; the test calls them as the Subagent tool does.
// The fake Pi below is a script the runner starts without a shell, and Windows ends a process on
// SIGTERM instead of delivering it; the tests that need either are POSIX only. The watchdog's
// Windows probe is covered without a script by 'the start-time probe reads this process'.
const posixOnly = process.platform === 'win32'
  && 'the fake Pi is a script started without a shell, and Windows cannot deliver an ignorable SIGTERM';

for (const ending of ['terminate (account boundary, terminate action)', 'Host shutdown (Maker.shutdown)']) {
  test(`a real runner and its Pi child end through ${ending}`, { timeout: 60_000, skip: posixOnly }, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-pi-runner-')));
    fs.mkdirSync(path.join(root, 'home'));
    const { graph, mcp } = hostPiGraph(root);
    const { piPids, request } = stageRealRun(root, 'run-real');
    try {
      await graph.pi.launchSubagentRunner(request);
      const runner = graph.pi.subagentRunners.get('run-real');
      assert.ok(runner?.pid && alive(runner.pid));
      await waitFor(() => readPids(piPids).length === 1);
      const [piPid] = readPids(piPids);
      assert.ok(alive(piPid));
      if (ending.startsWith('terminate')) {
        assert.equal(await graph.pi.terminateSubagentRunner('run-real', request.runDir), true);
      } else {
        await graph.maker.shutdown();
      }
      await waitFor(() => !alive(runner.pid) && !alive(piPid));
      assert.equal(graph.pi.subagentRunners.has('run-real'), false);
    } finally {
      for (const pid of readPids(piPids)) if (alive(pid)) process.kill(pid, 'SIGKILL');
      await graph.maker.shutdown().catch(() => {});
      await mcp.close();
      configureHostOwner({ userDataDir: root, ownerId: null });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a runner that ignores SIGTERM is killed after the grace period; its detached child is not reaped', { timeout: 60_000, skip: posixOnly }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-pi-runner-')));
  fs.mkdirSync(path.join(root, 'home'));
  const { graph, mcp } = hostPiGraph(root);
  const { piPids, request } = stageRealRun(root, 'run-stubborn', { ignoreTerm: true });
  try {
    await graph.pi.launchSubagentRunner(request);
    const runner = graph.pi.subagentRunners.get('run-stubborn');
    await waitFor(() => readPids(piPids).length === 1);
    const started = Date.now();
    assert.equal(await graph.pi.terminateSubagentRunner('run-stubborn', request.runDir), true);
    assert.ok(Date.now() - started >= 1_400, 'SIGKILL only after the SIGTERM grace period');
    assert.equal(alive(runner.pid), false);
    // Same code on the desktop: a SIGKILLed runner cannot stop the child it started in its own
    // process group. Recorded here so a change is noticed; the test stops it by its recorded pid.
    assert.equal(alive(readPids(piPids)[0]), true);
  } finally {
    for (const pid of readPids(piPids)) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await graph.maker.shutdown().catch(() => {});
    await mcp.close();
    configureHostOwner({ userDataDir: root, ownerId: null });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Unit: the parent watchdog's decision with injected process facts and a short interval. A live
// parent with its start time is never reported; re-parenting, a vanished pid, or the same pid with
// another start time (pid reuse) is reported once.
test('the parent watchdog reports a gone parent once and never a live one', async () => {
  const run = (facts, ticks) => new Promise(resolve => {
    let gone = 0;
    let n = 0;
    const stop = startParentWatchdog({
      parentPid: 4242, intervalMs: 2, probeEveryTicks: 3,
      readStartTimeSec: () => facts.start(n), isPidAlive: () => facts.alive(n), currentParentPid: () => facts.ppid(n),
      onParentGone: () => { gone += 1; },
    });
    const tick = setInterval(() => { n += 1; if (n >= ticks) { clearInterval(tick); stop(); resolve(gone); } }, 2);
  });
  const live = { start: () => 1_000, alive: () => true, ppid: () => 4242 };
  assert.equal(await run(live, 40), 0);
  assert.equal(await run({ ...live, ppid: n => (n > 5 ? 1 : 4242) }, 40), 1);
  assert.equal(await run({ ...live, alive: n => n <= 5 }, 40), 1);
  // Same pid, alive, still our parent by pid, but started at another time.
  assert.equal(await run({ ...live, start: n => (n > 5 ? 2_000 : 1_000) }, 40), 1);
  // An unreadable start time counts as the same process, as in the runner.
  assert.equal(await run({ ...live, start: n => (n === 0 ? 1_000 : null) }, 40), 0);
});

// Integration: a separate parent process (as the Host) launches a real runner with a fake Pi child,
// then is killed with SIGKILL (a crash). Both the runner and its Pi child end within a few seconds.
async function killHostThenWait(ignoreTerm) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-pi-runner-')));
  fs.mkdirSync(path.join(root, 'home'));
  const { piPids, request } = stageRealRun(root, 'run-orphan', { ignoreTerm });
  const runnerPidFile = path.join(root, 'runner.pid');
  const parentScript = path.join(root, 'host.mjs');
  fs.writeFileSync(parentScript, `
import { spawnHostPiSubagentRunner } from ${JSON.stringify(path.join(here, 'pi-subagent-runner.ts'))};
import fs from 'node:fs';
const runner = spawnHostPiSubagentRunner(JSON.parse(process.argv[2]));
runner.once('spawn', () => fs.writeFileSync(${JSON.stringify(runnerPidFile)}, String(runner.pid)));
setInterval(() => {}, 1000);
`);
  const { spawn } = await import('node:child_process');
  const host = spawn(process.execPath, ['--import', 'tsx', parentScript, JSON.stringify(request)], { stdio: 'ignore', cwd: here });
  let runnerPid;
  try {
    await waitFor(() => fs.existsSync(runnerPidFile) && readPids(piPids).length === 1, 20_000);
    runnerPid = Number(fs.readFileSync(runnerPidFile, 'utf8'));
    const [piPid] = readPids(piPids);
    assert.ok(alive(runnerPid) && alive(piPid));
    host.kill('SIGKILL');
    const killedAt = Date.now();
    if (ignoreTerm) {
      // The runner ignores SIGTERM: the 5-second forced exit ends it. Its detached child is not its
      // to reap without the runner's cleanup, as after the SIGKILL fallback.
      await waitFor(() => !alive(runnerPid), 15_000);
      assert.ok(Date.now() - killedAt >= 4_000, 'the forced exit waits for the cleanup bound');
    } else {
      await waitFor(() => !alive(runnerPid) && !alive(piPid), 15_000);
    }
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    for (const pid of [runnerPid, ...readPids(piPids)]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a real runner and its Pi child end after the Host is killed', { timeout: 60_000, skip: posixOnly }, () => killHostThenWait(false));
test('a runner whose SIGTERM cleanup hangs still ends after the Host is killed', { timeout: 60_000, skip: posixOnly }, () => killHostThenWait(true));

// The real start-time probe on this platform (ps on POSIX, PowerShell on Windows), against this
// process: its answer is the moment this process started, to the second the probe reports.
test('the start-time probe reads this process', { timeout: 60_000 }, () => {
  const started = (Date.now() - process.uptime() * 1000) / 1000;
  const probed = probeProcessStartTimeSec(process.pid);
  assert.equal(typeof probed, 'number');
  assert.ok(Math.abs(probed - started) <= 3, `probed ${probed}, started ${started}`);
});
