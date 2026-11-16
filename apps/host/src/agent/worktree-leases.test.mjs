/*
 * 测试价值
 * - 生产入口与可观察结果：Host 的启动钩子（start-options.ts 的 prepareStartOptions、onStartFailed、
 *   onStartCleanupSucceeded、onClose，经 runtime.ts 交给 Maker）在 profile 里写下和删掉的租约文件，
 *   以及桌面用同一份代码（runtimeLeases 的 readWorktreeRuntimePaths，两端在启动时配置相同的 profile 和 app-data 路径）读到的受保护目录。
 * - 规则依据：桌面 maker-host/index.ts 对每个本机任务在共享 Skill 链接之前取租约、取后复查已取消的
 *   预建，并在启动失败（运行时确定没起来）、启动清理成功和关闭时释放；同一 profile 的窗口回收
 *   worktree 前读这些租约。Host 不在桌面的实例登记表里，它的租约靠写入进程的进程号和进程身份受保护。
 * - 最小失败输入：不取租约或不记下；关闭、清理成功不释放；运行时可能还活着时也释放；复查放到取租约
 *   之前或去掉；userData 与 appData 接反。
 * - tier：integration（起本测试自己的 Node 子进程充当 Host，按记下的子进程句柄停它；临时 profile，
 *   不登录、不调模型）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { configureHostOwner } from './claude-auth.mjs';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { createHostModelContext } from './model-context.ts';
import { createHostAgentGraph } from './runtime.ts';
import { createHostStartOptions } from './start-options.ts';
import { configureAppDataDir, configureUserDataDir } from '../../../desktop/src/main/userDataPath.ts';
import * as desktopRuntimeLeases from '../../../desktop/src/main/worktree/runtimeLeases.ts';
import { createPrecreatedCancellation } from '../../../desktop/src/main/worktree/precreatedCancellationCore.ts';
import { physicalWorktreeKey } from '../../../desktop/src/main/worktree/resourceLock.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

const agentDir = path.dirname(fileURLToPath(import.meta.url));
const hostDir = path.dirname(path.dirname(agentDir));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-leases-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  const appData = path.join(root, 'app-data');
  const worktree = path.join(root, 'repo', '.cindy-worktrees', 'task-1');
  const plain = path.join(root, 'plain');
  for (const dir of [profile, appData, worktree, plain]) fs.mkdirSync(dir, { recursive: true });
  // The desktop window sharing this profile: its instance registry exists from its startup.
  fs.mkdirSync(path.join(profile, '.dev-instances'), { recursive: true });
  configureUserDataDir(profile);
  configureAppDataDir(appData);
  const app = { getPath: name => (name === 'appData' ? appData : profile) };
  return {
    root, profile, appData, worktree, plain,
    leaseDir: path.join(profile, 'worktree-runtime-leases'),
    desktop: desktopRuntimeLeases,
    desktopCancellation: createPrecreatedCancellation({ app }),
  };
}

const leaseFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')) : []);

function age(file, ms) {
  const then = new Date(Date.now() - ms);
  fs.utimesSync(file, then, then);
}

// runtimeLeases counts evidence older than the boot (minus a 10-minute margin) as abandoned
// before it looks at the heartbeat grace. Fix the uptime so an aged lease is judged by the grace
// alone, whatever this machine's real uptime is.
function upFor(t, seconds) {
  t.mock.method(os, 'uptime', () => seconds);
}
const LONG_UPTIME_S = 30 * 24 * 3600;

// The Host side, in its own process: the Host's own start hooks, its own profile and app data.
const hostProbe = `
  const { configureHostOwner } = await import('./src/agent/claude-auth.mjs');
  const { configureAppDataDir } = await import('../desktop/src/main/userDataPath.ts');
  const { createHostModelContext } = await import('./src/agent/model-context.ts');
  const { createHostStartOptions } = await import('./src/agent/start-options.ts');
  const env = process.env;
  configureHostOwner({ userDataDir: env.LEASE_PROFILE, ownerId: 'lease-host' });
  configureAppDataDir(env.LEASE_APPDATA);
  const modelContext = createHostModelContext({ readGatewayKey: () => null, hasCodexOAuthLogin: () => false,
    codexAccountState: () => ({ authenticated: false }) });
  const start = createHostStartOptions({ modelContext, fastPolicies: null, logger: { warn() {} } });
  const opts = { agentKind: 'claude-code', providerId: 'fixture-provider', model: 'fixture-model', workingDir: env.LEASE_WORKTREE };
  await start.prepareStartOptions('host-task', opts);
  process.stdout.write('ready\\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async chunk => {
    if (chunk.trim() !== 'close') return;
    await start.onClose('host-task', opts);
    process.stdout.write('closed\\n');
  });`;

function startHost(t, f) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs',
    '--input-type=module', '-e', hostProbe], {
    cwd: hostDir,
    env: { ...process.env, LEASE_PROFILE: f.profile, LEASE_APPDATA: f.appData, LEASE_WORKTREE: f.worktree },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  // Stopped only through this handle, i.e. the process this test started.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  });
  let out = '';
  let err = '';
  child.stderr.on('data', chunk => { err += chunk; });
  // Bounded by the test timeout; a child that exits first rejects with its stderr.
  const waitFor = line => new Promise((resolve, reject) => {
    const check = () => {
      if (!out.split(/\r?\n/).includes(line)) return;
      child.stdout.off('data', onData);
      resolve();
    };
    const onData = chunk => { out += chunk; check(); };
    child.stdout.on('data', onData);
    child.once('exit', code => reject(new Error(`Host child exited (${code}): ${err}`)));
    check();
  });
  return {
    child,
    ready: waitFor('ready'),
    close: async () => { const done = waitFor('closed'); child.stdin.write('close\n'); await done; child.stdin.end(); await exited; },
    crash: async () => { child.kill('SIGKILL'); await exited; },
  };
}

test('a lease the Host process holds is protected in the desktop view, and the Host close releases it', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = fixture(t);
  const host = startHost(t, f);
  await host.ready;
  const readyAt = performance.now();
  const [name] = leaseFiles(f.leaseDir);
  assert.equal(leaseFiles(f.leaseDir).length, 1);
  assert.match(name, new RegExp(`^${host.child.pid}-[a-f0-9]{64}\\.json$`));
  const lease = JSON.parse(fs.readFileSync(path.join(f.leaseDir, name), 'utf8'));
  t.diagnostic(JSON.stringify({
    processIdentityPresent: lease.processIdentity !== undefined,
    readyToLeaseReadMs: performance.now() - readyAt,
  }));
  const physical = await physicalWorktreeKey(f.worktree);
  assert.equal(lease.pid, host.child.pid);
  assert.equal(lease.path, physical);
  if (lease.processIdentity !== undefined) {
    assert.ok(Number.isFinite(lease.processIdentity.startedAtMs));
    assert.ok(lease.processIdentity.startedAtMs > 0);
    assert.equal(typeof lease.processIdentity.executablePath, 'string');
    assert.ok(path.isAbsolute(lease.processIdentity.executablePath));
  } else {
    // Windows' OS probe may exceed the production acquisition bound. Even then,
    // the assertions below must prove the lease protects the worktree until close.
    assert.equal(process.platform, 'win32', 'the Host records its OS identity on POSIX');
  }
  // No desktop registration: identity or the PID/heartbeat fallback must protect it.
  assert.deepEqual(fs.readdirSync(path.join(f.profile, '.dev-instances')), []);
  assert.deepEqual([...await f.desktop.readWorktreeRuntimePaths()], [physical]);

  await host.close();
  assert.deepEqual(leaseFiles(f.leaseDir), []);
  assert.deepEqual([...await f.desktop.readWorktreeRuntimePaths()], []);
});

test('a lease left by a Host that is gone stays protective through the heartbeat grace, then counts as abandoned', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = fixture(t);
  const host = startHost(t, f);
  await host.ready;
  const physical = await physicalWorktreeKey(f.worktree);
  await host.crash();
  upFor(t, LONG_UPTIME_S);
  const [name] = leaseFiles(f.leaseDir);
  const file = path.join(f.leaseDir, name);
  assert.ok(name, 'a crashed Host leaves its lease file');
  // As the desktop's own leases after a crash: a detached child may still use the directory
  // until the last heartbeat is older than the grace (one hour) or the machine has rebooted.
  assert.deepEqual([...await f.desktop.readWorktreeRuntimePaths()], [physical]);
  age(file, 59 * 60_000);
  assert.deepEqual([...await f.desktop.readWorktreeRuntimePaths()], [physical]);
  age(file, 61 * 60_000);
  assert.deepEqual([...await f.desktop.readWorktreeRuntimePaths()], []);
  // Abandoned leases are ignored, not deleted (the desktop's explicit reclaim path deletes).
  assert.deepEqual(leaseFiles(f.leaseDir), [name]);
});

test('after a Host restart one lease file remains when it closed; a crashed one stays beside the new one until its grace passes', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = fixture(t);
  const physical = await physicalWorktreeKey(f.worktree);
  const first = startHost(t, f);
  await first.ready;
  await first.close();
  const second = startHost(t, f);
  await second.ready;
  assert.deepEqual(leaseFiles(f.leaseDir).map(name => Number(name.split('-')[0])), [second.child.pid]);
  await second.crash();

  const third = startHost(t, f);
  await third.ready;
  const files = leaseFiles(f.leaseDir);
  assert.deepEqual(files.map(name => Number(name.split('-')[0])).sort(), [second.child.pid, third.child.pid].sort());
  await third.close();
  const [left] = leaseFiles(f.leaseDir);
  assert.equal(Number(left.split('-')[0]), second.child.pid);
  assert.deepEqual([...await f.desktop.readWorktreeRuntimePaths()], [physical]);
  upFor(t, LONG_UPTIME_S);
  age(path.join(f.leaseDir, left), 61 * 60_000);
  assert.deepEqual([...await f.desktop.readWorktreeRuntimePaths()], []);
});

test('a lease left from before the machine booted counts as abandoned at once, inside the heartbeat grace', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = fixture(t);
  const host = startHost(t, f);
  await host.ready;
  const physical = await physicalWorktreeKey(f.worktree);
  await host.crash();
  const [name] = leaseFiles(f.leaseDir);
  const file = path.join(f.leaseDir, name);
  // Up for five minutes: anything older than 15 minutes (boot plus the 10-minute margin) predates it.
  upFor(t, 5 * 60);
  age(file, 14 * 60_000);
  assert.deepEqual([...await f.desktop.readWorktreeRuntimePaths()], [physical]);
  age(file, 16 * 60_000);
  assert.deepEqual([...await f.desktop.readWorktreeRuntimePaths()], []);
  assert.deepEqual(leaseFiles(f.leaseDir), [name]);
});

function fixtureHarnessRoot(profile) {
  const root = path.join(profile, 'harnesses');
  const dir = path.join(root, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  return root;
}

test('the Maker the Host assembles releases the lease on a dead start failure, a successful cleanup and close', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = fixture(t);
  configureHostOwner({ userDataDir: f.profile, ownerId: 'lease-graph' });
  configureAppDataDir(f.appData);
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  const graph = createHostAgentGraph({
    userDataDir: f.profile,
    harnessRoot: fixtureHarnessRoot(f.profile),
    gateway: null,
    // Never spawned: only the Maker's start hooks run.
    binaryPath: path.join(f.profile, 'claude'),
    piBinaryPath: path.join(f.profile, 'pi'),
    mcpRuntime: mcp,
    mcpProviders: [],
    storage: {},
    providerConfig: {
      grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
      list: async () => [],
      readKey: () => null,
      oauth: { readCachedGenericOAuthAccessToken: () => null },
      codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false },
    },
  });
  const hooks = graph.maker.lifecycleHooks;
  const begin = async (id) => {
    const opts = { agentKind: 'claude-code', providerId: 'fixture-provider', model: 'fixture-model', workingDir: f.worktree };
    await hooks.prepareStartOptions(id, opts);
    assert.equal(leaseFiles(f.leaseDir).length, 1, `${id} holds a lease`);
    return opts;
  };

  // A failure whose runtime may still be alive keeps the lease until its cleanup succeeds.
  let opts = await begin('maybe-alive');
  await hooks.onStartFailed({ sessionId: 'maybe-alive', options: opts, stage: 'start', error: new Error('x'), runtimeMayBeAlive: true });
  assert.equal(leaseFiles(f.leaseDir).length, 1);
  await hooks.onStartCleanupSucceeded('maybe-alive', opts);
  assert.deepEqual(leaseFiles(f.leaseDir), []);

  opts = await begin('dead-start');
  await hooks.onStartFailed({ sessionId: 'dead-start', options: opts, stage: 'start', error: new Error('x'), runtimeMayBeAlive: false });
  assert.deepEqual(leaseFiles(f.leaseDir), []);

  opts = await begin('closed');
  await hooks.onClose('closed', opts, { reason: 'requested', transient: false });
  assert.deepEqual(leaseFiles(f.leaseDir), []);
});

function startOptionsFor(t, f, ownerId) {
  configureHostOwner({ userDataDir: f.profile, ownerId });
  configureAppDataDir(f.appData);
  const modelContext = createHostModelContext({ readGatewayKey: () => null, hasCodexOAuthLogin: () => false,
    codexAccountState: () => ({ authenticated: false }) });
  return createHostStartOptions({ modelContext, fastPolicies: null, logger: { warn() {} } });
}

test('a creation cancelled by another local instance is caught after the lease is taken, and the failed start releases it', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = fixture(t);
  const start = startOptionsFor(t, f, 'lease-cancel');
  // The desktop window seals the cancellation in the shared profile.
  f.desktopCancellation.sealPrecreatedSessionCancellation('cancelled-task');
  const opts = { agentKind: 'claude-code', providerId: 'fixture-provider', model: 'fixture-model', workingDir: f.worktree };
  await assert.rejects(start.prepareStartOptions('cancelled-task', opts),
    /^Error: PRECONDITION_FAILED: Worktree creation was cancelled; create a new task$/);
  // The recheck runs after the lease is taken, as on the desktop; Maker then reports the failure.
  assert.equal(leaseFiles(f.leaseDir).length, 1);
  await start.onStartFailed({ sessionId: 'cancelled-task', options: opts, stage: 'prepare', error: new Error('x'), runtimeMayBeAlive: false });
  assert.deepEqual(leaseFiles(f.leaseDir), []);
});

test('no lease is taken outside a managed worktree or for a remote task', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = fixture(t);
  const start = startOptionsFor(t, f, 'lease-none');
  await start.prepareStartOptions('plain-task', { agentKind: 'claude-code', providerId: 'fixture-provider', model: 'fixture-model', workingDir: f.plain });
  await start.prepareStartOptions('remote-task', { agentKind: 'claude-code', providerId: 'fixture-provider', model: 'fixture-model', workingDir: f.worktree, remoteHostId: 'other-device' });
  assert.deepEqual(leaseFiles(f.leaseDir), []);
});

