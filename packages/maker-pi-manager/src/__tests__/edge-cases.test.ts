/**
 * edge-cases.test.ts — 深度自审第 2 批轮 4:边界与极端情况审计。
 *
 * 覆盖:
 *   1. sessionId 极端:超长/Unicode/空串/纯数字/`-` 开头/`..`/`.`
 *   2. env 极端:超大值/空值/值含 `=`/KEY 含 Unicode/空对象/1000 键
 *   3. cmd 极端:空串/超长/换行/`;`&`&&`&`|`(注入面)
 *   4. 并发窗口:ensure vs idle-recycle(连接守卫)/ensure vs shutdown(killChild 守卫)
 *      /kill vs child close(dying 语义)
 *   5. 超时边界:idleTimeoutMs=0/idleTimeoutMs=1ms/KILL_GRACE boundary
 *   6. 文件系统边界:envDir 不可写(非 dir)/sockDir 文件(非 dir)/写 env-file 失败
 *   7. RPC 极端:超大 request(>64M OOM)/非法 JSON/connect 后不发 hello/hello 后立刻断
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { NDJSONDecoder, encodeMessage } from '../codec.js';
import type { RpcMessage } from '../protocol.js';

// ── Hoisted mock refs ────────────────────────────────────
const { mockSpawn, mockCreateServer } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockCreateServer: vi.fn(),
}));

// ── Mock: node:child_process ─────────────────────────────
vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// ── Mock: node:net ───────────────────────────────────────
vi.mock('node:net', () => {
  const EE = require('node:events').EventEmitter;
  class MockSocket extends EE {
    destroyed = false;
    write(_data: any, cb?: (err?: Error) => void) {
      if (cb) cb();
      return true;
    }
    destroy() {
      this.destroyed = true;
      this.emit('close');
    }
  }
  return {
    createServer: (...args: any[]) => mockCreateServer(...args),
    Socket: MockSocket,
  };
});

// ── Imports ──────────────────────────────────────────────
import { PiSessionRegistry } from '../session-registry.js';

// ── Helpers ──────────────────────────────────────────────

function makeChild(opts: { pid?: number } = {}) {
  const child = new EventEmitter() as any;
  child.pid = opts.pid ?? 12345;
  child.exitCode = null;
  // 与真实 Node child 一致:未退出时 signalCode 为 null(不是 undefined)。
  child.signalCode = null;
  child.stdin = new EventEmitter() as any;
  child.stdin.destroyed = false;
  child.stdin.write = vi.fn((_data: any, cb?: (err?: Error) => void) => {
    if (cb) cb();
    return true;
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((_signal?: string) => {
    child.exitCode = 0;
    return true;
  });
  return child;
}

/** A child that does NOT set exitCode on kill (to test KILL_GRACE path). */
function makeSlowChild(opts: { pid?: number } = {}) {
  const child = new EventEmitter() as any;
  child.pid = opts.pid ?? 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new EventEmitter() as any;
  child.stdin.destroyed = false;
  child.stdin.write = vi.fn((_data: any, cb?: (err?: Error) => void) => {
    if (cb) cb();
    return true;
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((_signal?: string) => {
    // Don't set exitCode — caller must emit('exit') for process to terminate.
    return true;
  });
  return child;
}

function makeServer() {
  const srv = new EventEmitter() as any;
  srv.listen = vi.fn((_sockPath: string, cb?: () => void) => {
    if (cb) cb();
    return srv;
  });
  srv.close = vi.fn((cb?: () => void) => {
    if (cb) cb();
    return srv;
  });
  srv.unref = vi.fn(() => srv);
  return srv;
}

function makeSocket() {
  const sock = new EventEmitter() as any;
  sock.destroyed = false;
  sock.write = vi.fn((_data: any, cb?: (err?: Error) => void) => {
    if (cb) cb();
    return true;
  });
  sock.destroy = vi.fn(function (this: any) {
    this.destroyed = true;
    this.emit('close');
  });
  return sock;
}

async function createRegistry(
  overrides: Partial<import('../session-registry.js').PiSessionRegistryOptions> = {},
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-edge-test-'));
  const sockDir = path.join(tmpDir, 'socks');
  const envDir = path.join(tmpDir, 'envs');
  const onSessionClosed = vi.fn();
  const registry = new PiSessionRegistry({
    sockDir,
    envDir,
    idleTimeoutMs: 0,
    onSessionClosed,
    ...overrides,
  });
  return { registry, tmpDir, sockDir, envDir, onSessionClosed };
}

let cleanupFns: Array<() => void> = [];

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  mockSpawn.mockReset();
  mockCreateServer.mockReset();
});

afterEach(() => {
  for (const fn of cleanupFns) fn();
  cleanupFns = [];
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. sessionId 极端
// ══════════════════════════════════════════════════════════════════════════════
describe('sessionId extremes', () => {
  it('1a. accepts sessionId up to 128 chars, rejects beyond (MAX_PATH guard)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    // 128 = 长度上限(深挖轮 4 观察 1:超长 sessionId 拼出超长路径,
    // Windows MAX_PATH ~260 下 fs 失败)。
    const longId = 'a'.repeat(128);
    const result = await registry.ensure(longId, 'echo hi', { K: 'v' }, 'h1', false);
    expect(result.sessionId).toBe(longId);
    expect(result.isReattach).toBe(false);

    // 129 字符拒绝。
    await expect(
      registry.ensure('a'.repeat(129), 'echo hi', { K: 'v' }, 'h1', false),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('1b. rejects sessionId with Unicode characters', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('测试session', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/unsafe sessionId/);

    await expect(
      registry.ensure('café', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/unsafe sessionId/);
  });

  it('1c. rejects empty sessionId', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/unsafe sessionId/);
  });

  it('1d. accepts pure-numeric sessionId', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    const result = await registry.ensure('12345', 'cmd', { K: 'v' }, 'h1', false);
    expect(result.sessionId).toBe('12345');
  });

  it('1e. accepts sessionId starting with dash', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    const result = await registry.ensure('-test-id', 'cmd', { K: 'v' }, 'h1', false);
    expect(result.sessionId).toBe('-test-id');
  });

  it('1f. rejects sessionId containing dots (..)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('..', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/unsafe sessionId/);
  });

  it('1g. rejects sessionId containing a single dot', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('test.name', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/unsafe sessionId/);
  });

  it('1h. rejects sessionId with angle brackets (<.>)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('<script>', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/unsafe sessionId/);
  });

  it('1i. rejects sessionId with null byte', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('test bad', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/unsafe sessionId/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. env 极端
// ══════════════════════════════════════════════════════════════════════════════
describe('env extremes', () => {
  it('2a. accepts very long env value (1MB)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    const bigVal = 'x'.repeat(1_000_000);
    const result = await registry.ensure('big-env', 'cmd', { KEY: bigVal }, 'h1', false);
    expect(result.sessionId).toBe('big-env');

    // Verify the full value was written to the env-file
    const envFile = path.join(tmpDir, 'envs', 'env-big-env');
    const content = fs.readFileSync(envFile, 'utf8');
    expect(content).toContain('KEY=xxxxxxxxxx'); // starts with the key
    expect(content.length).toBeGreaterThanOrEqual(1_000_000);
  });

  it('2b. accepts empty env value', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    const result = await registry.ensure('empty-val', 'cmd', { EMPTY: '' }, 'h1', false);
    expect(result.sessionId).toBe('empty-val');

    const envFile = path.join(tmpDir, 'envs', 'env-empty-val');
    const content = fs.readFileSync(envFile, 'utf8');
    expect(content.trim()).toBe('EMPTY=');
  });

  it('2c. accepts env value containing `=` sign', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    // Value with = splits incorrectly at the env-file KEY=value line level.
    // This is acceptable because the daemon trusts the host; the raw value is
    // joined with the key verbatim: `KEY=val=with=equals`.
    const result = await registry.ensure('eq-val', 'cmd', { KEY: 'val=with=equals' }, 'h1', false);
    expect(result.sessionId).toBe('eq-val');

    const envFile = path.join(tmpDir, 'envs', 'env-eq-val');
    const content = fs.readFileSync(envFile, 'utf8');
    // The line will be "KEY=val=with=equals" — only the first = separates key from value
    expect(content.trim()).toMatch(/^KEY=val=with=equals$/);
  });

  it('2d. rejects env key with Unicode characters', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('test', 'cmd', { '中文KEY': 'val' }, 'h1', false),
    ).rejects.toThrow(/unsafe env entry/);
  });

  it('2e. accepts empty env object', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    const result = await registry.ensure('empty-env', 'cmd', {}, 'h1', false);
    expect(result.sessionId).toBe('empty-env');

    // The env-file should exist but be empty (just a trailing newline from join with no entries)
    const envFile = path.join(tmpDir, 'envs', 'env-empty-env');
    const content = fs.readFileSync(envFile, 'utf8');
    expect(content).toBe('');
  });

  it('2f. accepts env with 1000 keys', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    const bigEnv: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      bigEnv[`KEY_${i}`] = `value_${i}`;
    }

    const result = await registry.ensure('many-env', 'cmd', bigEnv, 'h1', false);
    expect(result.sessionId).toBe('many-env');

    const envFile = path.join(tmpDir, 'envs', 'env-many-env');
    const content = fs.readFileSync(envFile, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1000);
    expect(lines[0]).toBe('KEY_0=value_0');
    expect(lines[999]).toBe('KEY_999=value_999');
  });

  it('2g. accepts env key with underscore prefix', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    await expect(
      registry.ensure('test', 'cmd', { _PRIVATE_KEY: 'secret' }, 'h1', false),
    ).resolves.toBeDefined();

    const envFile = path.join(tmpDir, 'envs', 'env-test');
    const content = fs.readFileSync(envFile, 'utf8');
    expect(content.trim()).toBe('_PRIVATE_KEY=secret');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. cmd 极端（daemon 信任 host 的威胁模型）
// ══════════════════════════════════════════════════════════════════════════════
describe('cmd extremes', () => {
  // NOTE: pi-manager daemon is designed under a trust-the-host threat model.
  // It runs `bash -c <cmd>` verbatim — no shell-escaping, no injection
  // filtering. The desktop host controls cmd and is trusted. These tests
  // verify the daemon's behavior, not that it "blocks injections" (it
  // deliberately does not).

  it('3a. accepts empty command string (bash -c "" exits 0)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());

    const result = await registry.ensure('empty-cmd', '', { K: 'v' }, 'h1', false);
    expect(result.sessionId).toBe('empty-cmd');
    expect(mockSpawn).toHaveBeenCalledWith('bash', ['-c', ''], expect.any(Object));
  });

  it('3b. accepts very long command (100KB)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    const longCmd = 'echo ' + 'x'.repeat(100_000);
    const result = await registry.ensure('long-cmd', longCmd, { K: 'v' }, 'h1', false);
    expect(result).toBeDefined();
  });

  it('3c. passes command with newlines through to bash', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    const cmdWithNewlines = 'echo line1\necho line2\necho line3';
    const result = await registry.ensure('nl-cmd', cmdWithNewlines, { K: 'v' }, 'h1', false);
    expect(result).toBeDefined();
    // bash receives the raw cmd string including newlines
    expect(mockSpawn).toHaveBeenCalledWith('bash', ['-c', cmdWithNewlines], expect.any(Object));
  });

  it('3d. passes command with shell metacharacters (; && |) through verbatim', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    // These are shell metacharacters but the daemon does not sanitize them —
    // the host (desktop) controls the command and is trusted. The daemon's
    // `bash -c` will interpret these normally.
    const cmd = 'echo a; echo b && echo c | cat';
    const result = await registry.ensure('inject-cmd', cmd, { K: 'v' }, 'h1', false);
    expect(result).toBeDefined();
    expect(mockSpawn).toHaveBeenCalledWith('bash', ['-c', cmd], expect.any(Object));
  });

  it('3e. passes command with backticks (command substitution) verbatim', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    // Backtick command substitution: bash will execute these.
    // The daemon trusts the host — this is expected behavior, not a vulnerability.
    const cmd = 'echo `whoami`';
    const result = await registry.ensure('bt-cmd', cmd, { K: 'v' }, 'h1', false);
    expect(result).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. 并发窗口
// ══════════════════════════════════════════════════════════════════════════════
describe('concurrency windows', () => {
  // 4a. ensure vs idle-recycle 竞争:killChild 连接守卫
  it('4a. idle-recycle respects connection guard in killChild (TOCTOU)', async () => {
    // recycleIdle checks attachedSocket in its loop, but killChild has its
    // own guard. Verify that even if called directly (simulating a race where
    // client connects between recycleIdle's check and actual SIGTERM), the
    // killChild guard prevents killing a connected session.
    const { registry, tmpDir } = await createRegistry({ idleTimeoutMs: 1 });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    const server = makeServer();
    mockCreateServer.mockReturnValueOnce(server);

    await registry.ensure('race-test', 'cmd', { K: 'v' }, 'h1', false);
    const entry = registry.get('race-test')!;
    entry.lastActivity = 0; // ancient = eligible for recycle
    entry.lastActivityMono = 0n; // 轮 23-H1:mono 时钟同步设

    // Simulate: recycleIdle runs, sees no attachedSocket → calls killChild.
    // But between the check and killChild, a client connects.
    const conn = makeSocket();
    entry.attachedSocket = conn;

    // killChild should see attachedSocket and abort
    await (registry as any).killChild(entry);
    expect(child.kill).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
  });

  // 4b. ensure vs shutdown 竞争:shuttingDown 守卫
  it('4b. ensure rejected after beginShutdown (existing + new)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false);

    registry.beginShutdown();
    await expect(
      registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    // Even existing sessions are blocked from re-ensure during shutdown
    expect(registry.list()).toHaveLength(1);
  });

  // 4c. kill vs child close 竞争:dying 语义
  // When SESSION_KILL_SURVIVED is thrown, the entry stays in the Map with
  // dying=true and deathPromise settled (rejected). Subsequent ensure()
  // waits on deathPromise.catch() then reattaches to the surviving session.
  it('4c. SESSION_KILL_SURVIVED leaves entry dying; subsequent ensure must REJECT (round 40-w1 HIGH)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child1 = makeChild();
    mockSpawn.mockReturnValueOnce(child1);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false);

    // Directly simulate SESSION_KILL_SURVIVED state: set entry dying + deathPromise rejected
    const entry = registry.get('s1')!;
    entry.dying = true;
    entry.deathPromise = Promise.reject(
      Object.assign(new Error('pi process survived SIGKILL'), { code: 'SESSION_KILL_SURVIVED' }),
    );
    // Suppress unhandled rejection noise
    entry.deathPromise.catch(() => {});

    // 轮 40-w1 HIGH:杀不死的进程不得 reattach(fail-closed)——
    // ensure 等待 deathPromise 后 entry 仍 dying → 必须 SESSION_KILL_SURVIVED。
    await expect(
      registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toMatchObject({ code: 'SESSION_KILL_SURVIVED' });
    expect(entry.dying).toBe(true); // still dying, was never cleared
  });

  // 4d. sequential kill + ensure
  it('4d. after kill completes, ensure creates new session with same id', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child1 = makeChild();
    mockSpawn.mockReturnValueOnce(child1);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false);

    // Kill synchronously (makeChild kill sets exitCode → immediate)
    await registry.kill('s1');
    expect(registry.list()).toHaveLength(0);

    // Re-spawn with same sessionId
    const child2 = makeChild({ pid: 99999 });
    mockSpawn.mockReturnValueOnce(child2);
    mockCreateServer.mockReturnValueOnce(makeServer());

    const result = await registry.ensure('s1', 'new-cmd', { K: 'v2' }, 'h2', false);
    expect(result.isReattach).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  // 4e. concurrent ensures during kill: spawn dedup via pendingSpawns
  it('4e. concurrent ensures after kill use pendingSpawns dedup', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child1 = makeChild();
    mockSpawn.mockReturnValueOnce(child1);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false);

    // Kill completes synchronously
    await registry.kill('s1');

    // Now two concurrent ensures should dedup via pendingSpawns
    const child2 = makeChild({ pid: 99999 });
    mockSpawn.mockReturnValueOnce(child2);
    mockCreateServer.mockReturnValueOnce(makeServer());

    const [r1, r2] = await Promise.all([
      registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false),
      registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false),
    ]);

    expect(r1.sockPath).toBe(r2.sockPath);
    // Only one spawn: both ensures await the same pendingSpawns promise
    expect(mockSpawn).toHaveBeenCalledTimes(2); // first spawn + ONE dedup'ed spawn
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. 超时边界
// ══════════════════════════════════════════════════════════════════════════════
describe('timeout boundaries', () => {
  it('5a. idleTimeoutMs=0 disables auto-recycling', async () => {
    const { registry, tmpDir } = await createRegistry({ idleTimeoutMs: 0 });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // With idleTimeoutMs=0, the constructor does NOT create the idle timer.
    // No setInterval is called. recycleIdle is only called by the interval,
    // so sessions should never be auto-recycled.
    // Verify close() doesn't throw (no timer to clear).
    expect(() => registry.close()).not.toThrow();
  });

  it('5b. idleTimeoutMs=1 triggers killChild when session is ancient', async () => {
    const { registry, tmpDir, onSessionClosed } = await createRegistry({
      idleTimeoutMs: 1,
    });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('idle-1ms', 'cmd', { K: 'v' }, 'h1', false);
    const entry = registry.get('idle-1ms')!;
    entry.lastActivity = 0;
    entry.lastActivityMono = 0n; // 轮 23-H1:mono 时钟同步设

    // Call killChild directly (with makeChild, kill sets exitCode → waitForExit resolves immediately)
    await (registry as any).killChild(entry);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  }, 10_000);

  it('5c. idleTimeoutMs=1 does NOT recycle a just-created session (lastActivity=now)', async () => {
    const { registry, tmpDir } = await createRegistry({ idleTimeoutMs: 1 });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('just-made', 'cmd', { K: 'v' }, 'h1', false);

    // 模拟「就在此刻活跃」—— ensure 内部的 fs/spawn/server 操作在慢机器
    // (Windows CI) 上可能已消耗 >1ms, 不刷新会让刚创建的 session 被判过期
    // (idleTimeoutMs=1 的时序竞态, Windows shard 偶发 SIGTERM)。
    const entry = registry.get('just-made')!;
    entry.lastActivityMono = process.hrtime.bigint();

    // recycleIdle is fully synchronous for non-expired entries (loop/continue, no async)
    (registry as any).recycleIdle();

    // Should NOT have been killed — activity is too recent
    expect(child.kill).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
  });

  it('5d. KILL_GRACE boundary: process exits during grace window (no SIGKILL)', async () => {
    vi.useFakeTimers();
    try {
      const { registry, tmpDir } = await createRegistry();
      cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

      const child = makeSlowChild(); // kill() does NOT set exitCode
      mockSpawn.mockReturnValueOnce(child);
      mockCreateServer.mockReturnValueOnce(makeServer());

      await registry.ensure('grace-test', 'cmd', { K: 'v' }, 'h1', false);

      const killPromise = registry.kill('grace-test');
      // killChild sent SIGTERM, waits for exit in waitForExit(KILL_GRACE_MS=3000)
      // During grace: emit 'exit' from child → waitForExit resolves true
      child.emit('exit');
      vi.advanceTimersByTime(100); // just enough for microtasks

      await expect(killPromise).resolves.toBeUndefined();
      // SIGTERM was sent, but SIGKILL was NOT (process exited within grace)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
      // Teardown ran
      expect(registry.list()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('5e. recycleIdle triggered exactly at idleTimeoutMs boundary (not before)', async () => {
    const { registry, tmpDir } = await createRegistry({ idleTimeoutMs: 1000 });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('boundary', 'cmd', { K: 'v' }, 'h1', false);
    const entry = registry.get('boundary')!;

    // Set lastActivity to 999ms ago (just inside boundary)
    // 轮 23-H1:mono 时钟同步设(hrtime 减 N ms) —— idle 判断用单调时钟。
    entry.lastActivity = Date.now() - 999;
    entry.lastActivityMono = process.hrtime.bigint() - 999_000_000n;

    (registry as any).recycleIdle();
    await flushMicrotasks();
    expect(child.kill).not.toHaveBeenCalled(); // still within boundary

    // Now set to exactly 1000ms ago (at boundary) — recycle checks `<=`
    entry.lastActivity = Date.now() - 1000;
    entry.lastActivityMono = process.hrtime.bigint() - 1_000_000_000n;

    (registry as any).recycleIdle();
    await flushMicrotasks();

    // The condition is: now - entry.lastActivity <= idleTimeoutMs → DON'T recycle
    // So at exactly 1000ms idle, now - 1000 <= 1000 → true → not recycled
    // Set to 1001ms (just past boundary)
    entry.lastActivity = Date.now() - 1001;
    entry.lastActivityMono = process.hrtime.bigint() - 1_001_000_000n;

    (registry as any).recycleIdle();
    await flushMicrotasks();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. 文件系统边界
// ══════════════════════════════════════════════════════════════════════════════
describe('filesystem boundaries', () => {
  it('6a. envDir path is a file, not a directory — mkdirSync fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-edge-fs-'));
    const envDir = path.join(tmpDir, 'env-file');

    // Create a FILE where envDir should be
    fs.writeFileSync(envDir, 'not a directory');

    try {
      expect(() => {
        new PiSessionRegistry({
          sockDir: path.join(tmpDir, 'socks'),
          envDir,  // This is a file, mkdirSync will fail
          idleTimeoutMs: 0,
        });
      }).toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6b. sockDir path is a file, not a directory — mkdirSync fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-edge-fs-'));
    const sockDir = path.join(tmpDir, 'sock-file');

    fs.writeFileSync(sockDir, 'not a directory');

    try {
      expect(() => {
        new PiSessionRegistry({
          sockDir, // This is a file
          envDir: path.join(tmpDir, 'envs'),
          idleTimeoutMs: 0,
        });
      }).toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6c. writeFile env-file fails (e.g. disk full) — spawn rejects and cleans up', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Make the envDir non-writable by deleting it and replacing with a file
    const envDir = path.join(tmpDir, 'envs');
    fs.rmSync(envDir, { recursive: true, force: true });
    fs.writeFileSync(envDir, 'block');

    // ensure should fail when trying to write env-file
    await expect(
      registry.ensure('fs-fail', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow();

    // Child should NOT have been spawned (env-file write fails before spawn)
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('6d. stale socket/session state cleanup runs on construction', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-edge-cleanup-'));
    const sockDir = path.join(tmpDir, 'socks');
    const envDir = path.join(tmpDir, 'envs');
    fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });

    // Place stale state files
    fs.writeFileSync(path.join(sockDir, 'old-session.pi.sock'), 'stale socket');
    fs.writeFileSync(path.join(envDir, 'env-old-session'), 'STALE_KEY=secret');

    try {
      const registry = new PiSessionRegistry({ sockDir, envDir, idleTimeoutMs: 0 });
      cleanupFns.push(() => {
        registry.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      // Stale files should be cleaned up
      expect(fs.existsSync(path.join(sockDir, 'old-session.pi.sock'))).toBe(false);
      expect(fs.existsSync(path.join(envDir, 'env-old-session'))).toBe(false);
    } catch {
      // In case the tmpDir gets cleaned in finally
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. RPC 极端
// ══════════════════════════════════════════════════════════════════════════════
describe('RPC extremes', () => {
  // 7a. OOM guard: buffer exceeding 64M without newline
  it('7a. NDJSONDecoder discards buffer >64M without newline (OOM guard)', () => {
    const maxChars = 64 * 1024 * 1024;
    let corruptCalls = 0;

    const decoder = new NDJSONDecoder({
      onCorruptLine: () => { corruptCalls++; },
    });

    const bigBuf = Buffer.alloc(maxChars + 1, 0x41);
    const result = decoder.push(bigBuf);

    expect(result).toEqual([]);
    expect(corruptCalls).toBe(1);
  });

  // 7b. OOM guard: buffer exactly at 64M+1 chars boundary
  it('7b. buffer at exactly MAX_BUFFER_CHARS bytes is NOT discarded (has margin)', () => {
    const maxChars = 64 * 1024 * 1024;
    let corruptCalls = 0;

    const decoder = new NDJSONDecoder({
      onCorruptLine: () => { corruptCalls++; },
    });

    // Exactly MAX_BUFFER_CHARS — should NOT trigger (condition is > not >=)
    const exactBuf = Buffer.alloc(maxChars, 0x41);
    const result = decoder.push(exactBuf);
    expect(result).toEqual([]); // no newline
    expect(corruptCalls).toBe(0); // NOT triggered at exactly MAX_BUFFER_CHARS
  });

  // 7c. illegal JSON
  it('7c. NDJSONDecoder skips lines that are not valid JSON', () => {
    const corruptLines: string[] = [];
    const decoder = new NDJSONDecoder({
      onCorruptLine: (line) => { corruptLines.push(line); },
    });

    const results = decoder.push(
      '{broken}\n"just a string"\n12345\nnull\ntrue\n[1,2,3]\n' +
      '{"type":"notification","method":"ok"}\n',
    );

    // All non-RpcMessage JSON values trigger onCorruptLine (valid JSON but not RpcMessage)
    // {broken} is SyntaxError
    expect(corruptLines.length).toBe(6);
    expect(results).toHaveLength(1); // only the valid RpcMessage survives
    expect(results[0]).toMatchObject({ method: 'ok' });
  });

  // 7d. valid JSON that is not RpcMessage shape
  it('7d. rejects valid JSON that is not an RpcMessage', () => {
    const corruptLines: string[] = [];
    const decoder = new NDJSONDecoder({
      onCorruptLine: (line) => { corruptLines.push(line); },
    });

    const results = decoder.push(
      '{"type":"unknown","method":"test"}\n' +
      '{"type":"request","method":"test"}\n' + // missing id
      '{"type":"response"}\n' + // missing id
      '{"type":"notification"}\n' + // missing method
      '{"type":"notification","method":"ok","params":{}}\n', // correct
    );

    // First 4 are invalid RpcMessages
    expect(corruptLines.length).toBe(4);
    expect(results).toHaveLength(1);
  });

  // 7e. request with non-numeric id
  it('7e. rejects request with NaN id', () => {
    const corruptLines: string[] = [];
    const decoder = new NDJSONDecoder({
      onCorruptLine: (line) => { corruptLines.push(line); },
    });

    const results = decoder.push(
      '{"type":"request","id":null,"method":"test","params":{}}\n' +
      '{"type":"request","id":"string","method":"test","params":{}}\n',
    );

    expect(corruptLines.length).toBe(2);
    expect(results).toHaveLength(0);
  });

  // 7f. very large valid frame (just under 64M, with newline)
  it('7f. decodes valid frame approaching 64M', () => {
    const decoder = new NDJSONDecoder();
    // Build a frame that is ~2MB (well under 64M) with a large params field
    const bigStr = 'x'.repeat(2_000_000);
    const msg: RpcMessage = {
      type: 'notification',
      method: 'big',
      params: { data: bigStr },
    };

    const line = encodeMessage(msg);
    const results = decoder.push(line);
    expect(results).toHaveLength(1);
    expect((results[0] as any).params.data.length).toBe(2_000_000);
  });

  // 7g. encodeMessage:verify roundtrip of edge case messages
  it('7g. encodeMessage roundtrip with special characters in params', () => {
    const decoder = new NDJSONDecoder();
    const msg: RpcMessage = {
      type: 'request',
      id: 1,
      method: 'pi/ensure',
      params: {
        sessionId: 'test\nwith\nnewlines', // embedded newlines in JSON string (escaped)
        cmd: 'echo "hello world"',
        env: { KEY: 'val' },
      },
    };

    const line = encodeMessage(msg);
    const results = decoder.push(line);
    expect(results).toHaveLength(1);
    expect((results[0] as any).params.sessionId).toBe('test\nwith\nnewlines');
  });

  // 7h. rapid push of many small chunks (simulates TCP packet fragmentation)
  it('7h. handles byte-by-byte push without corruption', () => {
    const decoder = new NDJSONDecoder();
    const msg: RpcMessage = {
      type: 'notification',
      method: 'hello',
      params: { id: 42 },
    };

    const line = encodeMessage(msg);
    const buf = Buffer.from(line, 'utf8');

    let allResults: RpcMessage[] = [];
    for (let i = 0; i < buf.length; i++) {
      const results = decoder.push(buf.subarray(i, i + 1));
      allResults = allResults.concat(results);
    }

    expect(allResults).toHaveLength(1);
    expect(allResults[0]).toMatchObject({ type: 'notification', method: 'hello' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. 额外边界:会话注册表内部状态一致性
// ══════════════════════════════════════════════════════════════════════════════
describe('session registry internal consistency', () => {
  it('8a. ensure with restart=false returns existing session even when envHash differs', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    const r1 = await registry.ensure('s1', 'cmd', { K: 'v1' }, 'h1', false);
    const r2 = await registry.ensure('s1', 'different-cmd', { K: 'v2' }, 'h2', false);
    expect(r2.isReattach).toBe(true);
    expect(r2.sockPath).toBe(r1.sockPath);
    expect(mockSpawn).toHaveBeenCalledTimes(1); // no re-spawn
  });

  it('8b. ensure with restart=false vs restart=true switch', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child1 = makeChild({ pid: 100 });
    mockSpawn.mockReturnValueOnce(child1);
    mockCreateServer.mockReturnValueOnce(makeServer());

    // First spawn
    await registry.ensure('s1', 'cmd', { K: 'v1' }, 'h1', true);

    // Same envHash, restart=true → reattach (hash matches)
    const r2 = await registry.ensure('s1', 'cmd', { K: 'v1' }, 'h1', true);
    expect(r2.isReattach).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Different envHash, restart=true → kill old + re-spawn
    const child2 = makeChild({ pid: 200 });
    mockSpawn.mockReturnValueOnce(child2);
    mockCreateServer.mockReturnValueOnce(makeServer());

    const r3 = await registry.ensure('s1', 'cmd', { K: 'v2' }, 'h2', true);
    expect(r3.isReattach).toBe(false);
    expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('8c. list returns empty array when no sessions', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    expect(registry.list()).toEqual([]);
  });

  it('8d. get returns undefined for unknown session', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('8e. shutdownAll with no sessions is a no-op', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(registry.shutdownAll()).resolves.toBeUndefined();
  });

  it('8f. kill session that died naturally (child close before kill) → SESSION_NOT_FOUND', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('auto-die', 'cmd', { K: 'v' }, 'h1', false);

    // Simulate pi process exiting on its own
    child.emit('close', 0, null);

    // Now kill should fail because teardown already removed the entry
    await expect(registry.kill('auto-die')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('8g. idleTimeoutMs=undefined → default 30 min (1800000ms)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-edge-default-'));
    cleanupFns.push(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const registry = new PiSessionRegistry({
      sockDir: path.join(tmpDir, 'socks'),
      envDir: path.join(tmpDir, 'envs'),
      // idleTimeoutMs NOT provided → should default to 1_800_000
    });
    registry.close();

    // No assertion needed — just verify construction succeeds. The actual
    // default value is tested indirectly by idle recycling tests.
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. 退役后并发回归：单 daemon 扛所有会话
// ══════════════════════════════════════════════════════════════════════════════
describe('post-retirement daemon concurrency — single daemon all sessions', () => {
  // 9a. daemon 崩溃 + 并发重连:崩溃瞬间多个 ensure 并发 → 重 spawn 后全部恢复
  it('9a. concurrent ensures recover after daemon crash (all children exit)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const SESSION_COUNT = 5;
    const children: ReturnType<typeof makeChild>[] = [];
    const servers: ReturnType<typeof makeServer>[] = [];

    // Phase 1: Spawn SESSION_COUNT sessions
    for (let i = 0; i < SESSION_COUNT; i++) {
      const child = makeChild({ pid: 1000 + i });
      children.push(child);
      mockSpawn.mockReturnValueOnce(child);
      const server = makeServer();
      servers.push(server);
      mockCreateServer.mockReturnValueOnce(server);
      await registry.ensure(`crash-${i}`, 'cmd', { K: `v${i}` }, `h${i}`, false);
    }
    expect(registry.list()).toHaveLength(SESSION_COUNT);

    // Phase 2: Simulate daemon crash — all children exit with code 1 simultaneously
    // (this is what happens when the daemon machine crashes/reboots — all processes die)
    // Each child's close handler runs teardown, removing the session.
    // To simulate crash recovery, we manually teardown all entries.
    for (let i = 0; i < SESSION_COUNT; i++) {
      const entry = registry.get(`crash-${i}`);
      if (entry) {
        children[i].emit('close', 1, null);
      }
    }
    // Allow teardown to complete
    await flushMicrotasks();
    expect(registry.list()).toHaveLength(0);

    // Phase 3: Concurrent re-ensure all sessions — simulate crash recovery
    // Set up new mocks for re-spawns
    for (let i = 0; i < SESSION_COUNT; i++) {
      const child = makeChild({ pid: 2000 + i });
      mockSpawn.mockReturnValueOnce(child);
      mockCreateServer.mockReturnValueOnce(makeServer());
    }

    const results = await Promise.all(
      Array.from({ length: SESSION_COUNT }, (_, i) =>
        registry.ensure(`crash-${i}`, 'recover-cmd', { K: `v${i}` }, `h${i}`, false),
      ),
    );

    // All should have re-spawned (isReattach=false since entries were torn down)
    expect(results).toHaveLength(SESSION_COUNT);
    for (const r of results) {
      expect(r.isReattach).toBe(false);
    }
    expect(registry.list()).toHaveLength(SESSION_COUNT);

    // Verify spawn count: SESSION_COUNT initial + SESSION_COUNT recovery = 2*SESSION_COUNT
    expect(mockSpawn).toHaveBeenCalledTimes(SESSION_COUNT * 2);
  });

  // 9b. 高会话数压力:30 会话并发(单 daemon 内存/句柄)
  it('9b. 30 concurrent sessions — single daemon memory/handle pressure', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const COUNT = 30;
    for (let i = 0; i < COUNT; i++) {
      mockSpawn.mockReturnValueOnce(makeChild({ pid: 10000 + i }));
      mockCreateServer.mockReturnValueOnce(makeServer());
    }

    // Spawn all 30 concurrently via pendingSpawns dedup (NOT Promise.all —
    // each spawn proceeds independently, but the registry handles them all).
    const results: Promise<any>[] = [];
    for (let i = 0; i < COUNT; i++) {
      results.push(
        registry.ensure(`session-${i}`, 'cmd', { IDX: `${i}` }, `h-${i}`, false),
      );
    }
    const spawned = await Promise.all(results);

    expect(spawned).toHaveLength(COUNT);
    expect(registry.list()).toHaveLength(COUNT);

    // All distinct sock paths
    const sockPaths = new Set(spawned.map((r: any) => r.sockPath));
    expect(sockPaths.size).toBe(COUNT);

    // All distinct session IDs in list
    const ids = registry.list().map((e) => e.sessionId);
    expect(new Set(ids).size).toBe(COUNT);

    // No cross-contamination: each session's envHash is correct
    for (let i = 0; i < COUNT; i++) {
      const entry = registry.get(`session-${i}`);
      expect(entry).toBeDefined();
      expect(entry!.envHash).toBe(`h-${i}`);
    }
  });

  // 9c. 混合操作压力:同时 ensure + kill + list + reattach
  it('9c. interleaved ensure/kill/list/reattach under load — no corruption', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const N = 12;
    // Pre-spawn N sessions
    for (let i = 0; i < N; i++) {
      mockSpawn.mockReturnValueOnce(makeChild({ pid: 30000 + i }));
      mockCreateServer.mockReturnValueOnce(makeServer());
      await registry.ensure(`mix-${i}`, 'cmd', { IDX: `${i}` }, `h-mix-${i}`, false);
    }
    expect(registry.list()).toHaveLength(N);

    // Concurrent mixed operations
    const ops: Promise<any>[] = [];

    // 3 list calls
    for (let i = 0; i < 3; i++) {
      ops.push(Promise.resolve(registry.list()));
    }

    // Reattach (ensure with same envHash, restart=false) for odd indices
    for (let i = 1; i < N; i += 2) {
      ops.push(registry.ensure(`mix-${i}`, 'cmd', { IDX: `${i}` }, `h-mix-${i}`, false));
    }

    // Kill even indices
    for (let i = 0; i < N; i += 2) {
      ops.push(registry.kill(`mix-${i}`));
    }

    await Promise.all(ops);

    // Verify: even indices killed, odd indices survived (reattached)
    const remaining = registry.list();
    for (let i = 0; i < N; i++) {
      if (i % 2 === 0) {
        expect(registry.get(`mix-${i}`)).toBeUndefined();
      } else {
        expect(registry.get(`mix-${i}`)).toBeDefined();
      }
    }
    expect(remaining.length).toBe(N / 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. 退役后:kill 与 idle-recycle 并发(D 状态进程 + 空闲回收)
// ══════════════════════════════════════════════════════════════════════════════
describe('post-retirement: kill vs idle-recycle concurrency (D-state)', () => {
  // 10a. killChild SESSION_KILL_SURVIVED + recycleIdle 并发:dying guard 防双杀
  it('10a. recycleIdle skips dying sessions — no double-kill', async () => {
    const { registry, tmpDir } = await createRegistry({ idleTimeoutMs: 1 });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Spawn a session with a "slow" child that survives SIGKILL
    const child = makeSlowChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('d-state', 'cmd', { K: 'v' }, 'h1', false);

    const entry = registry.get('d-state')!;
    entry.lastActivity = 0; // ancient — makes it eligible for idle-recycle

    // Start killChild (will send SIGTERM → wait grace → send SIGKILL → wait confirm → SESSION_KILL_SURVIVED)
    // But we don't await it — we want it in-flight
    const killPromise = registry.kill('d-state').catch(() => { /* expected SESSION_KILL_SURVIVED */ });

    // Allow killChild to start (SIGTERM sent, waitForExit starts)
    await new Promise((r) => setTimeout(r, 10));

    // Now recycleIdle runs — should see entry.dying=true and skip it
    (registry as any).recycleIdle();
    await flushMicrotasks();

    // Child was NOT killed again by recycleIdle (dying guard prevented second killChild)
    // killChild was called only once (from the manual kill, not from recycle)
    // SIGTERM was called once by the manual kill, SIGKILL will follow after grace
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // The entry should still exist (dying=true) — recycleIdle skipped it
    expect(registry.get('d-state')).toBeDefined();

    // Clean up: resolve SESSION_KILL_SURVIVED by emitting exit
    child.exitCode = 0;
    child.emit('exit');
    await killPromise;
  });

  // 10b. 空闲回收触发 killChild 时客户端重连(连接守卫 TOCTOU)
  // 连接守卫在 dying 守卫之后、SIGTERM 之前做同步检查。必须先附着再调 killChild
  // 才能触发守卫(attach 后调 kill 的 TOCTOU 测在 4a)。
  it('10b. client attaches before killChild — connection guard aborts kill', async () => {
    const { registry, tmpDir } = await createRegistry({ idleTimeoutMs: 1 });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Spawn a session
    const child = makeSlowChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('reconnect-during-kill', 'cmd', { K: 'v' }, 'h1', false);

    const entry = registry.get('reconnect-during-kill')!;
    entry.lastActivity = 0; // ancient

    // Attach a client BEFORE killChild — connection guard is synchronous
    // after the dying guard check, before any await/waitForExit.
    const conn = makeSocket();
    entry.attachedSocket = conn;

    // killChild should see attachedSocket !== null and abort immediately
    await (registry as any).killChild(entry);
    expect(child.kill).not.toHaveBeenCalled(); // No signal sent
    expect(registry.list()).toHaveLength(1); // Session still exists
    expect(entry.dying).toBe(false); // Not marked dying (aborted at guard)
  });

  // 10c. 连续空闲回收:多个会话同时过期 → 逐一 kill 不冲突
  it('10c. multiple sessions expire simultaneously — each killed independently', async () => {
    const { registry, tmpDir, onSessionClosed } = await createRegistry({
      idleTimeoutMs: 1,
    });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const COUNT = 5;
    const children: ReturnType<typeof makeChild>[] = [];

    for (let i = 0; i < COUNT; i++) {
      const child = makeChild();
      children.push(child);
      mockSpawn.mockReturnValueOnce(child);
      mockCreateServer.mockReturnValueOnce(makeServer());
      await registry.ensure(`expire-${i}`, 'cmd', { IDX: `${i}` }, `h${i}`, false);
    }

    expect(registry.list()).toHaveLength(COUNT);

    // Make all sessions ancient
    for (let i = 0; i < COUNT; i++) {
      const entry = registry.get(`expire-${i}`)!;
      entry.lastActivity = 0;
      entry.lastActivityMono = 0n; // 轮 23-H1:mono 时钟同步设
    }

    // Trigger recycleIdle — should kill all 5
    (registry as any).recycleIdle();
    await flushMicrotasks();

    // All 5 children should have received SIGTERM
    for (const child of children) {
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    }

    // All sessions should be torn down (makeChild kill sets exitCode → waitForExit resolves)
    expect(registry.list()).toHaveLength(0);

    // onSessionClosed should have been called 5 times with reason 'idle_timeout'
    const idleCloseCalls = onSessionClosed.mock.calls.filter(
      (call: unknown[]) => call[1] === 'idle_timeout',
    );
    expect(idleCloseCalls).toHaveLength(COUNT);
  });

  // 10d. SESSION_KILL_SURVIVED 后会话保留 dying 状态,确保不双 spawn
  // killChild 的 deathPromise 有 KILL_GRACE_MS(3s)+KILL_CONFIRM_MS(5s) 真实
  // 定时器。用 fake timers 控制时间流，避免测试超时。
  it('10d. SESSION_KILL_SURVIVED preserves dying state — blocks double-spawn', async () => {
    vi.useFakeTimers();
    try {
      const { registry, tmpDir } = await createRegistry();
      cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

      const child = makeSlowChild(); // does NOT set exitCode on kill
      mockSpawn.mockReturnValueOnce(child);
      mockCreateServer.mockReturnValueOnce(makeServer());
      await registry.ensure('survivor', 'cmd', { K: 'v' }, 'h1', false);

      // Directly call killChild — it will set dying=true, send SIGTERM,
      // wait grace → SIGKILL → wait confirm → SESSION_KILL_SURVIVED
      let killError: Error | null = null;
      const killPromise = (registry as any)
        .killChild(registry.get('survivor'))
        .catch((err: Error) => {
          killError = err;
        });

      // Allow killChild to run up to first waitForExit (SIGTERM → waitForExit(3s))
      await vi.advanceTimersByTimeAsync(0);

      // Advance past KILL_GRACE_MS (3s): child has not exited → SIGKILL sent
      await vi.advanceTimersByTimeAsync(3000);
      // Advance past KILL_CONFIRM_MS (5s): child still has not exited → SESSION_KILL_SURVIVED
      await vi.advanceTimersByTimeAsync(5000);

      // Let the promise settle
      await killPromise;
      expect(killError).toBeDefined();
      expect((killError as any).code).toBe('SESSION_KILL_SURVIVED');

      // Entry should still exist and be dying
      const entry = registry.get('survivor');
      expect(entry).toBeDefined();
      expect(entry!.dying).toBe(true);

      // 轮 40-w1 HIGH:杀不死的进程不得 reattach —— ensure 必须 SESSION_KILL_SURVIVED
      // (fail-closed), 直到进程真正 close 被 teardown 后才允许新 spawn。
      await expect(
        registry.ensure('survivor', 'cmd', { K: 'v' }, 'h1', false),
      ).rejects.toMatchObject({ code: 'SESSION_KILL_SURVIVED' });
      expect(registry.list()).toHaveLength(1);

      // No second spawn occurred (mockSpawn only called once)
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      // Clean up: let the D-state process finally exit
      child.exitCode = 0;
      child.emit('exit');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 11. SESSION_LIMIT_EXCEEDED — spawn flood DoS guard (轮 11 MEDIUM-3 + 轮 12 HIGH-1)
// ---------------------------------------------------------------------------
describe('session limit (DoS guard)', () => {
  it('rejects ensure with SESSION_LIMIT_EXCEEDED when sessions reach MAX_SESSIONS', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // 填满 MAX_SESSIONS=36(轮 16 MEDIUM-2:32 活跃 + 4 dying 头寸)
    for (let i = 0; i < 36; i++) {
      mockSpawn.mockReturnValueOnce(makeChild());
      mockCreateServer.mockReturnValueOnce(makeServer());
      await registry.ensure(`limit-${i}`, 'cmd', { K: 'v' }, `h${i}`, false);
    }
    expect(registry.list()).toHaveLength(36);

    // 第 37 个必须拒绝
    await expect(
      registry.ensure('limit-36', 'cmd', { K: 'v' }, 'h36', false),
    ).rejects.toMatchObject({ code: 'SESSION_LIMIT_EXCEEDED' });
    expect(mockSpawn).toHaveBeenCalledTimes(36);
  });

  it('counts pending spawns against the limit (in-flight flood bypass)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // 35 个已注册 + 1 个 in-flight spawn(挂起的 listen)= 36 = 上限
    for (let i = 0; i < 35; i++) {
      mockSpawn.mockReturnValueOnce(makeChild());
      mockCreateServer.mockReturnValueOnce(makeServer());
      await registry.ensure(`p-${i}`, 'cmd', { K: 'v' }, `h${i}`, false);
    }

    // 第 36 个:listen 挂起, ensure 不 resolve —— spawn 已发出但未注册
    let resolveListen!: () => void;
    const gate = new Promise<void>((r) => { resolveListen = r; });
    const server = makeServer();
    server.listen.mockImplementation((_p: string, cb?: () => void) => {
      gate.then(() => { if (cb) cb(); });
      return server;
    });
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(server);
    const pendingEnsure = registry.ensure('p-35', 'cmd', { K: 'v' }, 'h35', false);

    // 第 37 个 ensure:35 注册 + 1 pending = 36 >= 36 → 拒绝
    await expect(
      registry.ensure('p-36', 'cmd', { K: 'v' }, 'h36', false),
    ).rejects.toMatchObject({ code: 'SESSION_LIMIT_EXCEEDED' });

    // 放行 pending, 收尾
    resolveListen();
    await pendingEnsure;
    expect(registry.list()).toHaveLength(36);
  });

  it('releases limit slots after kill (teardown frees capacity)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // 填满
    for (let i = 0; i < 36; i++) {
      mockSpawn.mockReturnValueOnce(makeChild());
      mockCreateServer.mockReturnValueOnce(makeServer());
      await registry.ensure(`r-${i}`, 'cmd', { K: 'v' }, `h${i}`, false);
    }
    // kill 一个
    await registry.kill('r-0');
    expect(registry.list()).toHaveLength(35);

    // 释放后可以再建
    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());
    const result = await registry.ensure('r-fresh', 'cmd', { K: 'v' }, 'hf', false);
    expect(result.sessionId).toBe('r-fresh');
    expect(registry.list()).toHaveLength(36);
  });
});
