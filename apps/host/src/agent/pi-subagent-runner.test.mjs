// Integration: the Host launcher forks its real runner entry (pi-subagent-runner-process.cts) as a
// Node child process, with a fixture runner.cjs in a temporary run directory. No Pi, no model, no
// network; the child gets only the environment given here (HOME is a new empty directory).
// Rule: release table row 19 / P4 (reviewer, step 8 decision): same entry contract as the desktop's
// utilityProcess entry, ready frame once, the IPC channel closed before the runner loads, the child
// stopped through the recorded handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnHostPiSubagentRunner } from './pi-subagent-runner.ts';
import { createHostAgentGraph } from './runtime.ts';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

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
    cwd: root, env: { PATH: process.env.PATH ?? '', HOME: path.join(root, 'home') },
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

test('the runner is ready once, loses its IPC channel before loading, and stops through its handle', async () => {
  let runner;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-pi-runner-')));
  fs.mkdirSync(path.join(root, 'home'));
  try {
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
    assert.deepEqual(await exited, { code: null, signal: 'SIGTERM' });
    assert.equal(runner.killed, true);
    assert.equal(alive(pid), false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'home')), []);
  } finally {
    // A failed assertion above must not leave the fixture runner behind: stop it through its handle.
    if (runner && !runner.killed) runner.kill('SIGKILL');
    delete process.env.CINDY_TEST_PARENT_ONLY;
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

// Source shape: the Host entry is the desktop entry except how the ready frame is sent and how the
// channel is dropped (reviewer, P4).
test('the Host runner entry matches the desktop entry except the ready frame and the channel', () => {
  // Bracket-only lines appear in both files and are not compared.
  const lines = file => fs.readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'));
  const desktop = lines(path.join(here, '../../../desktop/src/main/cindy-brain/piSubagentRunnerProcess.ts'));
  const host = lines(path.join(here, 'pi-subagent-runner-process.cts'));
  assert.deepEqual(desktop.filter(line => !host.includes(line)), [
    'interface ParentPortLike {',
    'postMessage(message: unknown): void;',
    'const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;',
    "if (!parentPort) throw new Error('PI Subagent runner process is missing parentPort');",
    "parentPort.postMessage({ type: 'ready' });",
    'try {',
    "Object.defineProperty(process, 'parentPort', {",
    'configurable: true,',
    'value: undefined,',
    '} catch {',
  ]);
  assert.deepEqual(host.filter(line => !desktop.includes(line)), [
    'const send = process.send?.bind(process);',
    "if (!send) throw new Error('PI Subagent runner process is missing its IPC channel');",
    "send({ type: 'ready' }, (error: Error | null) => {",
    'if (error) throw error;',
    'process.disconnect?.();',
  ]);
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
    cwd: root, env: { PATH: process.env.PATH ?? '', HOME: path.join(root, 'home') },
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
for (const ending of ['terminate (account boundary, terminate action)', 'Host shutdown (Maker.shutdown)']) {
  test(`a real runner and its Pi child end through ${ending}`, { timeout: 60_000 }, async () => {
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

test('a runner that ignores SIGTERM is killed after the grace period; its detached child is not reaped', { timeout: 60_000 }, async () => {
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
