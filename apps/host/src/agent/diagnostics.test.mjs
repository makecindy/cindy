/*
 * 测试价值
 * - 生产入口与可观察结果：createHostAgentGraph 组装出的三个引擎上 maker-core 读取的进程登记与
 *   cc-debug 依赖，调用后进程登记表里的记录；Host 退出时调用的 Codex 工具进程回收
 *   （codex-tool-tree-reaper.ts）对本测试自己起的假进程树的实际效果；main.ts 里回收与 cc-debug
 *   开关的调用点。
 * - 规则依据：桌面三个构造点（maker-host/index.ts、pi-host.ts）用同样的拼法登记到
 *   process-monitor/codex-process-registry.ts，Claude 的 cc-debug 落在日志根的 sessions/<id>/；
 *   桌面退出时同步阶段回收登记过的、仍是本进程直接子进程的 Codex app-server 下面的进程树，
 *   app-server 本身留给正常关闭。
 * - 最小失败输入：不登记或登记成别的职责；回收按名字匹配，误伤没登记的同名进程；登记的 pid 已不是
 *   本进程的子进程仍被回收；在账号切换（disposeOwnerRuntime）里也回收。
 * - tier：integration（起本测试自己的假进程树，只按记下的进程号停；不起真实引擎、不调模型）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureHostOwner } from './claude-auth.mjs';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { createHostAgentGraph } from './runtime.ts';
import { listCodexProcessPids, resolveAgentProcessRegistration } from '../../../desktop/src/main/process-monitor/codex-process-registry.ts';
import { resolveSessionCcDebugFile, trackSessionCcDebugFile } from '../../../desktop/src/main/logger.ts';
import { reapCodexToolTreesSync } from '../../../desktop/src/main/codex-tool-tree-reaper.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;


function fixtureHarnessRoot(profile) {
  const root = path.join(profile, 'harnesses');
  const dir = path.join(root, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  return root;
}

function buildGraph(t, ownerId) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-diagnostics-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId });
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  return createHostAgentGraph({
    userDataDir: profile,
    harnessRoot: fixtureHarnessRoot(profile),
    gateway: null,
    // Never spawned: only the constructed agents' dependencies are called.
    binaryPath: path.join(profile, 'claude'),
    codexBinaryPath: path.join(profile, 'codex'),
    piBinaryPath: path.join(profile, 'pi'),
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
}

test('the three engines the Host assembles register their processes as the desktop does, and Claude gets the desktop cc-debug files', { timeout: TEST_TIMEOUT_MS }, t => {
  t = lifoCleanup(t);
  const graph = buildGraph(t, 'diagnostics-registration');
  // PIDs no process holds here: only the in-memory registry is touched.
  const claude = graph.agent.deps.registerLocalAgentProcess({ pid: 999_991, kind: 'claude', role: 'task-host', sessionId: 'claude-task' });
  const pi = graph.pi.deps.registerLocalAgentProcess({ pid: 999_992, kind: 'pi', role: 'task-host', sessionId: 'pi-task' });
  const codex = graph.codex.deps.registerLocalCodexAppServerProcess({ pid: 999_993, role: 'shared-host' });
  const facts = pid => {
    const { instanceId, ...rest } = resolveAgentProcessRegistration(pid) ?? {};
    return rest;
  };
  assert.deepEqual(facts(999_991), { kind: 'claude', role: 'task-host', sessionId: 'claude-task' });
  assert.deepEqual(facts(999_992), { kind: 'pi', role: 'task-host', sessionId: 'pi-task' });
  assert.deepEqual(facts(999_993), { kind: 'codex', role: 'shared-host', sessionId: null });
  assert.deepEqual(listCodexProcessPids(), [999_993]);
  // The disposers the engines call when the process generation ends.
  for (const dispose of [claude, pi, codex]) dispose();
  assert.equal(resolveAgentProcessRegistration(999_991), null);
  assert.deepEqual(listCodexProcessPids(), []);

  // The desktop's own functions: the same path under the logger root (profile logs on the Host).
  assert.equal(graph.agent.deps.resolveCcDebugFile, resolveSessionCcDebugFile);
  assert.equal(graph.agent.deps.trackCcDebugFile, trackSessionCcDebugFile);
});

// A fake app-server: one tool child, which has one grandchild. All three idle until stopped.
const toolScript = `const { spawn } = require('node:child_process');
const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', 'fake-codex-grandchild'], { stdio: 'ignore' });
process.stdout.write(JSON.stringify({ tool: process.pid, grand: grand.pid }) + '\\n');
setInterval(() => {}, 1e9);`;
const appServerScript = `const { spawn } = require('node:child_process');
const tool = spawn(process.execPath, ['-e', process.env.FAKE_TOOL_SCRIPT, 'fake-codex-tool'], { stdio: ['ignore', 'pipe', 'ignore'] });
tool.stdout.pipe(process.stdout);
setInterval(() => {}, 1e9);`;
// Starts the same fake app-server one level down, so it is not this process's child.
const intermediateScript = `const { spawn } = require('node:child_process');
const server = spawn(process.execPath, ['-e', process.env.FAKE_APP_SERVER_SCRIPT, 'fake-codex-app-server'], { stdio: ['ignore', 'pipe', 'ignore'] });
process.stdout.write(JSON.stringify({ server: server.pid }) + '\\n');
server.stdout.pipe(process.stdout);
setInterval(() => {}, 1e9);`;

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

async function until(check, label) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function startFake(t, recorded, script, name) {
  const child = spawn(process.execPath, ['-e', script, name], {
    env: { ...process.env, FAKE_TOOL_SCRIPT: toolScript, FAKE_APP_SERVER_SCRIPT: appServerScript },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  recorded.add(child.pid);
  const facts = {};
  let buffer = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (const line of buffer.split('\n').slice(0, -1)) {
        const fact = JSON.parse(line);
        for (const pid of Object.values(fact)) recorded.add(pid);
        Object.assign(facts, fact);
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
      if (facts.tool && facts.grand) resolve();
    });
    child.once('exit', code => reject(new Error(`${name} exited early (${code})`)));
  });
  return { child, pid: child.pid, facts, ready };
}

// Inspect only the PIDs created by this fixture. No name or synthetic PPID grants ownership.
function scopedFixtureSampler(recorded, fullTimesOut, calls) {
  const ps = process.env.CINDY_TEST_CODEX_REAPER_PS
    ?? (process.platform === 'darwin' || fs.existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps');
  assert.ok(path.isAbsolute(ps));
  return (query, timeout) => {
    calls.push(query.kind);
    if (query.kind === 'all' && fullTimesOut) {
      return { stdout: '', status: null, signal: 'SIGKILL',
        error: Object.assign(new Error('fixture full process scan timed out'), { code: 'ETIMEDOUT' }) };
    }
    const pids = query.kind === 'parents' ? query.pids : [...recorded];
    assert.ok(pids.every(pid => recorded.has(pid)));
    const result = spawnSync(ps, ['-p', pids.join(','), '-o', 'pid=,ppid='], { encoding: 'utf8', timeout });
    if (query.kind !== 'children' || result.status !== 0 || result.error) return result;
    const stdout = result.stdout.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number))
      .filter(([, parent]) => parent === query.parentPid).map(([pid]) => pid).join('\n');
    return { ...result, stdout };
  };
}

for (const [mode, fullTimesOut] of [['scoped fixture', false], ['full scan times out', true], ['native process table', false]]) {
  test('Host exit reaps only tools with a proven app-server owner: ' + mode,
    { skip: process.platform === 'win32', timeout: TEST_TIMEOUT_MS }, async t => {
      t = lifoCleanup(t);
      const graph = buildGraph(t, 'diagnostics-reaper');
      const recorded = new Set();
      t.after(() => {
        for (const pid of recorded) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      });
      const registered = startFake(t, recorded, appServerScript, 'fake-codex-app-server');
      const native = mode === 'native process table';
      const other = native ? [] : [
        startFake(t, recorded, appServerScript, 'fake-codex-app-server'), // unregistered with the same name
        startFake(t, recorded, appServerScript, 'fake-codex-app-server'), // registered by PID only
        startFake(t, recorded, intermediateScript, 'fake-codex-intermediate'), // not a direct child
      ];
      await Promise.all([registered, ...other].map(app => app.ready));
      const register = graph.codex.deps.registerLocalCodexAppServerProcess;
      const disposers = [register({ pid: registered.pid, child: registered.child, role: 'task-host' })];
      if (!native) {
        const [, legacy, notChild] = other;
        disposers.push(register({ pid: legacy.pid, role: 'task-host' }));
        disposers.push(register({ pid: notChild.facts.server, child: notChild.child, role: 'task-host' }));
        assert.ok(listCodexProcessPids().includes(legacy.pid));
        assert.ok(listCodexProcessPids().includes(notChild.facts.server));
      }
      t.after(() => { for (const dispose of disposers) dispose?.(); });

      const calls = [];
      // The native gate requires a process-table-permitted environment, as does the application.
      const result = reapCodexToolTreesSync(native ? undefined : scopedFixtureSampler(recorded, fullTimesOut, calls));
      assert.equal(result.appServers, 1);
      assert.equal(result.killedToolTrees, 1);
      assert.equal(result.scanFailed, fullTimesOut);
      assert.equal(result.fallbackUsed, fullTimesOut);
      assert.equal(result.unreapedAppServers, native ? 0 : 2);
      if (!native) {
        assert.equal(calls[0], 'all');
        assert.equal(calls.includes('children'), fullTimesOut);
        assert.equal(calls.filter(call => call === 'parents').length, 2);
      }
      await until(() => !alive(registered.facts.tool) && !alive(registered.facts.grand), 'registered tools received the real signal');
      recorded.delete(registered.facts.tool);
      recorded.delete(registered.facts.grand);
      assert.equal(alive(registered.pid), true, 'app-server remains eligible for the usual graceful close');
      for (const fixture of other) {
        for (const pid of [fixture.pid, ...Object.values(fixture.facts)]) {
          assert.equal(alive(pid), true, 'the different or unproved tree must be untouched');
        }
      }
    });
}

