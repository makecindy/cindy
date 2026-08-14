/**
 * session-registry.test.ts — PiSessionRegistry vitest 完整测试套件
 *
 * 覆盖清单 (自审轮 9):
 *   1. ensure 语义:新建 spawn(isReattach=false)、已存在同 envHash(isReattach=true
 *      不杀)、不同 envHash+restart=true(SIGTERM 旧+新 spawn)、不同 envHash+
 *      restart=false(纯 attach)、in-flight spawn dedup(并发 ensure 同 id 只 spawn 一次)
 *   2. kill:正常 kill(SIGTERM→退出)、SESSION_KILL_SURVIVED(mock 杀不死)、
 *      双 kill 幂等、kill in-flight spawn、SESSION_NOT_FOUND
 *   3. list/shutdownAll/teardown 身份校验:list 返回正确、shutdownAll 排空 pending+
 *      双轮扫描、stale entry teardown 不删新会话
 *   4. 空闲回收:过期触发(reason=idle_timeout)、边界内不触发、有连接豁免、
 *      连接守卫(attachedSocket 检查)
 *   5. env-file:内容格式(KEY=val\n)、spawn 失败清理、stale socket 清理
 *   6. shuttingDown:beginShutdown 后 ensure 拒绝(INTERNAL)
 *   7. sessionId/env 校验:路径遍历 sessionId 拒绝、env 换行/坏 KEY 拒绝
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

// ── Hoisted mock refs ────────────────────────────────────
const { mockSpawn, mockCreateServer, mockFsWriteFile } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockCreateServer: vi.fn(),
  // 轮 40-w4-t5 MEDIUM-5:env-file 原子写失败注入 —— node:fs/promises 的
  // ESM namespace 不可 spyOn, 用模块级 mock 替换。
  mockFsWriteFile: vi.fn(),
}));

// ── Mock: node:fs/promises(仅 writeFile 可注入失败) ──────
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  // 捕获原始 writeFile 供 beforeEach 默认透传(避免 mock 内递归)。
  (globalThis as Record<string, unknown>).__realFsWriteFile = actual.writeFile;
  return {
    ...actual,
    writeFile: (...args: any[]) => mockFsWriteFile(...args),
  };
});

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
import { PiSessionRegistry, scrubCredentialText } from '../session-registry.js';

// ── Helpers ──────────────────────────────────────────────

function makeChild(opts: { pid?: number } = {}) {
  const child = new EventEmitter() as any;
  child.pid = opts.pid ?? 12345;
  child.exitCode = null;
  // 与真实 Node child 一致:未退出时 signalCode 为 null(不是 undefined)——
  // 实现按 != null 判定「已退出」, mock 必须显式 null 否则被误判。
  child.signalCode = null;
  child.stdin = new EventEmitter() as any;
  child.stdin.destroyed = false;
  child.stdin.write = vi.fn((_data: any, cb?: (err?: Error) => void) => {
    if (cb) cb();
    return true;
  });
  // stdout 带 paused 追踪(轮 16 背压测试需要):真实 Readable 有 pause/resume。
  child.stdout = Object.assign(new EventEmitter(), {
    paused: false,
    pause: () => { child.stdout.paused = true; },
    resume: () => { child.stdout.paused = false; },
    destroy: vi.fn(),
    destroyed: false,
  });
  child.stderr = new EventEmitter();
  // Default kill: only sets exitCode. Real kill() sends a signal;
  // process exits asynchronously. waitForExit checks exitCode first
  // and resolves immediately without needing 'exit' event.
  // NOT emitting 'close' synchronously prevents premature teardown
  // via the spawnSession close handler during kill() flow.
  child.kill = vi.fn((_signal?: string) => {
    child.exitCode = 0;
    return true;
  });
  return child;
}

/** A child that survives all kill attempts (D-state simulation). */
function makeSurviveChild(opts: { pid?: number } = {}) {
  const child = makeChild(opts);
  child.kill = vi.fn(); // no-op: never sets exitCode, never emits exit/close
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reg-test-'));
  const sockDir = path.join(tmpDir, 'socks');
  const envDir = path.join(tmpDir, 'envs');
  const onSessionClosed = vi.fn();
  const registry = new PiSessionRegistry({
    sockDir,
    envDir,
    idleTimeoutMs: 0, // disabled by default
    onSessionClosed,
    ...overrides,
  });
  return { registry, tmpDir, sockDir, envDir, onSessionClosed };
}

let cleanupFns: Array<() => void> = [];

/** Flush pending microtasks so async kill chains complete. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  // 关键:mock 状态跨测试泄漏会让 mockReturnValueOnce 队列错乱、调用计数翻倍
  // (spy 计数异常 —— 深度自审发现的测试基础设施 bug)。
  mockSpawn.mockReset();
  mockCreateServer.mockReset();
  // writeFile 默认透传真实实现(importOriginal 捕获的原始 writeFile)。
  const realWriteFile = (globalThis as Record<string, unknown>).__realFsWriteFile as typeof fsPromises.writeFile;
  mockFsWriteFile.mockImplementation((...args: any[]) => (realWriteFile as any).apply(null, args));
});

afterEach(() => {
  for (const fn of cleanupFns) fn();
  cleanupFns = [];
});

// ── 1. ensure 语义 ───────────────────────────────────────
describe('ensure', () => {
  // 1a. 新建 spawn
  it('should spawn a new session (isReattach=false)', async () => {
    const { registry, tmpDir, onSessionClosed } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    const server = makeServer();
    mockCreateServer.mockReturnValueOnce(server);

    const result = await registry.ensure('test', 'echo hi', { KEY: 'val' }, 'hash1', false);

    // 轮 21-W4 HIGH:socket 文件名用 sha256 截断(防 macOS sun_path 超限),
    // 不再含完整 sessionId —— 断言保持 .pi.sock 后缀 + socks 目录内即可。
    expect(result.sessionId).toBe('test');
    expect(result.sockPath).toContain('.pi.sock');
    expect(result.sockPath).not.toContain('test.pi.sock');
    expect(result.isReattach).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith('bash', ['-c', 'echo hi'], expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }));

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: 'test', pid: child.pid, envHash: 'hash1', isAttached: false });

    // Cleanup
    child.emit('close', 0, null);
    expect(onSessionClosed).toHaveBeenCalledWith('test', 'completed', expect.stringContaining('exited'));
  });

  // 1b. 已存在 + 同 envHash + restart=false → isReattach=true（不杀）
  it('should reattach when same envHash and restart=false', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child1 = makeChild();
    mockSpawn.mockReturnValueOnce(child1);
    mockCreateServer.mockReturnValueOnce(makeServer());

    const r1 = await registry.ensure('s1', 'cmd', { K: 'v' }, 'hash-abc', false);
    expect(r1.isReattach).toBe(false);

    const r2 = await registry.ensure('s1', 'cmd', { K: 'v' }, 'hash-abc', false);
    expect(r2.isReattach).toBe(true);
    expect(r2.sockPath).toBe(r1.sockPath);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(child1.kill).not.toHaveBeenCalled();

    child1.emit('close', 0, null);
  });

  // 1c. 不同 envHash + restart=true → SIGTERM 旧 + 新 spawn
  it('should kill old and spawn new when different envHash and restart=true', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child1 = makeChild();
    mockSpawn.mockReturnValueOnce(child1);
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('s1', 'cmd', { K: 'v1' }, 'hash-1', true);

    const child2 = makeChild({ pid: 99999 });
    mockSpawn.mockReturnValueOnce(child2);
    mockCreateServer.mockReturnValueOnce(makeServer());

    const r2 = await registry.ensure('s1', 'cmd', { K: 'v2' }, 'hash-2', true);
    expect(r2.isReattach).toBe(false);
    expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    child2.emit('close', 0, null);
  });

  // 1d. 不同 envHash + restart=false → 纯 attach（不杀旧）
  it('should pure attach when different envHash and restart=false', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    const r1 = await registry.ensure('s1', 'cmd', { K: 'v1' }, 'hash-1', false);

    const r2 = await registry.ensure('s1', 'cmd', { K: 'v2' }, 'hash-2', false);
    expect(r2.isReattach).toBe(true);
    expect(r2.sockPath).toBe(r1.sockPath);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  // 1e. In-flight spawn dedup:并发 ensure 同一 id 只 spawn 一次
  it('should deduplicate concurrent ensure for same sessionId', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Delay spawn resolution so both ensures hit pendingSpawns
    let resolveSpawn: (child: any) => void;
    const spawnGate = new Promise<any>((r) => { resolveSpawn = r; });

    mockSpawn.mockImplementationOnce(() => {
      const child = makeChild();
      resolveSpawn(child);
      return child;
    });
    mockCreateServer.mockReturnValueOnce(makeServer());

    // Launch two concurrent ensures
    const [r1, r2] = await Promise.all([
      registry.ensure('dedup', 'cmd', { K: 'v' }, 'h1', false),
      registry.ensure('dedup', 'cmd', { K: 'v' }, 'h1', false),
    ]);

    expect(r1.sockPath).toBe(r2.sockPath);
    expect(r1.isReattach).toBe(false);
    // 第二个应该也返回 isReattach=false（两个都 await 了同一个 spawn promise）
    expect(r2.isReattach).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  // 1f: 已存在 + 同 envHash + restart=true → 不杀(同 hash)
  it('should reattach when same envHash even with restart=true', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', true);

    const r2 = await registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', true);
    expect(r2.isReattach).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

// ── 2. kill ──────────────────────────────────────────────
describe('kill', () => {
  // 2a. 正常 kill:SIGTERM → 进程退出
  it('should kill an active session (SIGTERM → exit)', async () => {
    const { registry, tmpDir, onSessionClosed } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('test', 'cmd', { K: 'v' }, 'h1', false);

    await registry.kill('test');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // waitForExit:exitCode 已在 kill 中设为 0,立即 resolve → 不发 SIGKILL
    expect(child.kill).toHaveBeenCalledTimes(1);
    // makeChild 的 kill 不 emit close → teardown 由 kill() 调用(detail=undefined)。
    // reason='killed'(dying 语义)。
    expect(onSessionClosed).toHaveBeenCalledWith('test', 'killed', undefined);
    expect(registry.list()).toHaveLength(0);
  });

  // 2b. SESSION_KILL_SURVIVED:mock 杀不死
  it('should throw SESSION_KILL_SURVIVED when process survives SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const { registry, tmpDir } = await createRegistry();
      cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

      const child = makeSurviveChild();
      mockSpawn.mockReturnValueOnce(child);
      mockCreateServer.mockReturnValueOnce(makeServer());

      await registry.ensure('survive', 'cmd', { K: 'v' }, 'h1', false);

      const killPromise = registry.kill('survive');

      // Advance through KILL_GRACE_MS (3000) → timeout first waitForExit
      vi.advanceTimersByTime(3000);
      await Promise.resolve(); // flush microtasks so IIFE continues
      // Advance through KILL_CONFIRM_MS (5000) → timeout second waitForExit
      vi.advanceTimersByTime(5000);
      await Promise.resolve(); // flush microtasks so IIFE throws

      // 错误码在 err.code(makeServerError), 不在 message —— 断言 code。
      await expect(killPromise).rejects.toMatchObject({ code: 'SESSION_KILL_SURVIVED' });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      // 进程还活着(D 状态)不该 teardown(会删 env-file 但进程仍在)——
      // entry 保留 dying 状态, 等进程自然退出(源码语义, 非测试错误)。
      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0]).toMatchObject({ sessionId: 'survive' });
    } finally {
      vi.useRealTimers();
    }
  });

  // 2c. 双 kill 幂等
  it('should be idempotent on double kill', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('test', 'cmd', { K: 'v' }, 'h1', false);

    const k1 = registry.kill('test');
    await expect(k1).resolves.toBeUndefined();
    // mock kill 同步完成 → k1 已删 entry → k2 找不到会话。
    // 幂等语义 = 不重复杀(第二次无会话可杀, SESSION_NOT_FOUND 是正确行为)。
    await expect(registry.kill('test')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(child.kill).toHaveBeenCalledTimes(1); // only one SIGTERM
  });

  // 2d. kill in-flight spawn
  it('should kill an in-flight spawn (wait for spawn then kill)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Make spawn slow: server.listen delayed
    let resolveListen: () => void;
    const listenGate = new Promise<void>((r) => { resolveListen = r; });

    const server = makeServer();
    server.listen.mockImplementation((_path: string, cb?: () => void) => {
      setImmediate(() => {
        // Don't call cb yet; gate keeps listen pending
      });
      // We need to call cb eventually for spawn to complete
      listenGate.then(() => { if (cb) cb(); });
      return server;
    });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(server);

    // Start ensure (spawn will hang on listen)
    const ensurePromise = registry.ensure('test', 'cmd', { K: 'v' }, 'h1', false);

    // Kill while pending
    const killPromise = registry.kill('test');

    // Now let spawn complete
    resolveListen!();

    // Ensure should succeed, and kill should follow
    await ensurePromise;
    await killPromise;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(registry.list()).toHaveLength(0);
  });

  // 2e. SESSION_NOT_FOUND
  it('should throw SESSION_NOT_FOUND for unknown session', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(registry.kill('no-such-session')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  // 2f: kill in-flight spawn where spawn fails → kill succeeds (幂等)
  it('should treat kill as success when in-flight spawn fails', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // Make spawn fail immediately
    mockSpawn.mockImplementationOnce(() => { throw new Error('spawn ENOENT'); });

    const ensurePromise = registry.ensure('test', 'cmd', { K: 'v' }, 'h1', false);
    const killPromise = registry.kill('test');

    await expect(ensurePromise).rejects.toThrow();
    await expect(killPromise).resolves.toBeUndefined(); // spawn failed = no live process
  });
});

// ── 3. list / shutdownAll / teardown 身份校验 ────────────
describe('list / shutdownAll / teardown identity', () => {
  // 3a. list 返回正确
  it('should list all sessions with correct fields', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild({ pid: 100 }));
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('a', 'cmd', { K: 'v' }, 'h-a', false);

    mockSpawn.mockReturnValueOnce(makeChild({ pid: 200 }));
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('b', 'cmd', { X: 'y' }, 'h-b', false);

    const list = registry.list();
    expect(list).toHaveLength(2);
    const sessions = list.map((e) => e.sessionId).sort();
    expect(sessions).toEqual(['a', 'b']);
    for (const entry of list) {
      expect(entry).toMatchObject({
        pid: expect.any(Number),
        sockPath: expect.stringContaining('.pi.sock'),
        envHash: expect.any(String),
        lastActivity: expect.any(Number),
        isAttached: false,
      });
    }
  });

  // 3b. shutdownAll 排空 pending + 双轮扫描
  it('should drain pending spawns and kill all sessions during shutdownAll', async () => {
    const { registry, tmpDir, onSessionClosed } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // First spawn: normal
    const child1 = makeChild();
    mockSpawn.mockReturnValueOnce(child1);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false);

    // Second spawn: start but don't complete yet (slow listen)
    let resolveListen2: () => void;
    const gate2 = new Promise<void>((r) => { resolveListen2 = r; });
    const server2 = makeServer();
    server2.listen.mockImplementation((_p: string, cb?: () => void) => {
      gate2.then(() => { if (cb) cb(); });
    });
    const child2 = makeChild();
    mockSpawn.mockReturnValueOnce(child2);
    mockCreateServer.mockReturnValueOnce(server2);
    const ensure2 = registry.ensure('s2', 'cmd', { K: 'v' }, 'h2', false);

    // Start shutdown (will wait for pending spawns)
    const shutdownPromise = registry.shutdownAll();

    // Let second spawn complete — its spawnSession guard checks shuttingDown
    // and throws, so s2 never registers. shutdownAll drains the pending spawn
    // (it rejects) then kills s1 in the double pass.
    resolveListen2!();
    await expect(ensure2).rejects.toThrow(/shutting down/);

    // Now shutdownAll should kill s1 and finish
    await shutdownPromise;

    expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
    // s2 was never registered (shuttingDown guard), so only s1 is killed
    expect(registry.list()).toHaveLength(0);
  });

  it('awaits close-handler teardown cleanup during shutdownAll', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('close-race', 'cmd', { CINDY_PI_API_KEY: 'gateway-secret' }, 'h1', false);
    const envFile = path.join(tmpDir, 'envs', 'env-close-race');
    expect(fs.existsSync(envFile)).toBe(true);

    child.kill = vi.fn((_signal?: string) => {
      child.exitCode = 0;
      child.emit('close', 0, null);
      return true;
    });

    await registry.shutdownAll();
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it('collects natural-exit teardown while shutdownAll drains pending spawns', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const live = makeChild();
    mockSpawn.mockReturnValueOnce(live);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('live-exit', 'cmd', { CINDY_PI_API_KEY: 'gateway-secret' }, 'h1', false);
    const envFile = path.join(tmpDir, 'envs', 'env-live-exit');
    expect(fs.existsSync(envFile)).toBe(true);

    let resolveListen: () => void;
    const gate = new Promise<void>((r) => { resolveListen = r; });
    const pendingServer = makeServer();
    pendingServer.listen.mockImplementation((_p: string, cb?: () => void) => {
      gate.then(() => { if (cb) cb(); });
    });
    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(pendingServer);
    const pending = registry.ensure('pending', 'cmd', { K: 'v' }, 'h2', false);

    const shutdownPromise = registry.shutdownAll();
    live.emit('close', 0, null);
    resolveListen!();
    await expect(pending).rejects.toThrow(/shutting down/);
    await shutdownPromise;
    expect(fs.existsSync(envFile)).toBe(false);
  });

  // 轮 40-w4-t3 CRITICAL:shutdownAll 遇杀不死的 session 不得 teardown ——
  // 保留 entry(防凭证进程残留不受管理)并聚合抛出 SESSION_KILL_SURVIVED。
  it('shutdownAll keeps survivor entry and rejects (round 40-w4-t3 CRITICAL)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { registry, tmpDir, onSessionClosed } = await createRegistry();
      cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

      // survivor:杀不死(D-state)
      const survivor = makeSurviveChild();
      mockSpawn.mockReturnValueOnce(survivor);
      mockCreateServer.mockReturnValueOnce(makeServer());
      await registry.ensure('surv', 'cmd', { K: 'v' }, 'h1', false);

      const shutdownPromise = registry.shutdownAll('killed');
      // 预挂 no-op handler:advanceTimersByTimeAsync 异步推进跨 macrotask,
      // shutdownPromise 在推进中途 reject, 若等到 advance 返回后才挂
      // expect().rejects, Node 已把该 rejection 判为 unhandled(vitest
      // fake timers 时序 —— 轮 18-T1 修复前此测试报 unhandled rejection)。
      shutdownPromise.catch(() => {});
      // KILL_GRACE_MS (3000) → SIGKILL
      await vi.advanceTimersByTimeAsync(3_000);
      // KILL_CONFIRM_MS (5000) → SESSION_KILL_SURVIVED
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(shutdownPromise).rejects.toMatchObject({ code: 'SESSION_KILL_SURVIVED' });
      // entry 保留(不 teardown)—— 防残留进程 + 防新 daemon 双 spawn
      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0].sessionId).toBe('surv');
      // 不 teardown → 不触发 onSessionClosed
      expect(onSessionClosed).not.toHaveBeenCalled();
      // env-file 保留(凭证仍被进程持有, 删了反而无法追踪)
      const envFile = path.join(tmpDir, 'envs', 'env-surv');
      expect(fs.existsSync(envFile)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // 3c. stale entry teardown 不删新会话（身份校验）
  it('should not remove a newer session with same id during stale teardown', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child1 = makeChild();
    mockSpawn.mockReturnValueOnce(child1);
    const server1 = makeServer();
    mockCreateServer.mockReturnValueOnce(server1);
    await registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false);

    // Grab the entry reference
    const oldEntry = registry.get('s1')!;

    // Kill and re-spawn (old entry teardown + new spawn)
    const child2 = makeChild({ pid: 99999 });
    mockSpawn.mockReturnValueOnce(child2);
    const server2 = makeServer();
    mockCreateServer.mockReturnValueOnce(server2);

    // Force a direct teardown on the old entry — should be a no-op because
    // the Map now holds the new entry.
    // Simulate by calling internal teardown via child close on OLD child.
    // But the close handler on old child references old entry...
    // Let's just call kill which tears down the old entry then spawn a new one.
    await registry.kill('s1');
    await registry.ensure('s1', 'cmd', { K: 'v' }, 'h2', false);
    const newEntry = registry.get('s1')!;

    // Manually call teardown on old entry via internal access — should no-op
    (registry as any).teardown(oldEntry, 'killed');
    // New session should still be in the list (identity check passed)
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('s1')).toBe(newEntry);
  });
});

// ── 4. 空闲回收 ──────────────────────────────────────────
describe('idle recycling', () => {
  it('should recycle session that exceeds idle timeout', async () => {
    const { registry, tmpDir, onSessionClosed } = await createRegistry({
      idleTimeoutMs: 1, // very short timeout
    });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('idle-test', 'cmd', { K: 'v' }, 'h1', false);

    // Set lastActivity to ancient(轮 23-H1:单调时钟也要设 —— idle 判断用 mono)
    const entry = registry.get('idle-test')!;
    entry.lastActivity = 0;
    entry.lastActivityMono = 0n;

    // Manually trigger recycle; killChild runs async — wait for chain
    (registry as any).recycleIdle();
    await flushMicrotasks();

    // killChild should have been called with SIGTERM
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(onSessionClosed).toHaveBeenCalledWith('idle-test', 'idle_timeout', expect.stringContaining('no client'));
    expect(registry.list()).toHaveLength(0);
  });

  it('should not recycle session within idle boundary', async () => {
    const { registry, tmpDir, onSessionClosed } = await createRegistry({
      idleTimeoutMs: 60_000, // 60 seconds
    });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('idle-test', 'cmd', { K: 'v' }, 'h1', false);

    // lastActivity is recent (just set in spawnSession)
    (registry as any).recycleIdle();
    await flushMicrotasks();

    // Should NOT have been killed
    expect(child.kill).not.toHaveBeenCalled();
    expect(onSessionClosed).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
  });

  it('should not recycle session with attached socket', async () => {
    const { registry, tmpDir } = await createRegistry({
      idleTimeoutMs: 1,
    });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('idle-test', 'cmd', { K: 'v' }, 'h1', false);

    // Directly set attachedSocket to simulate connected client
    const conn = makeSocket();
    const entry = registry.get('idle-test')!;
    entry.attachedSocket = conn;
    entry.lastActivity = 0; // ancient activity

    expect(registry.list()[0].isAttached).toBe(true);

    (registry as any).recycleIdle();
    await flushMicrotasks();

    // Should NOT kill (attached socket check in recycleIdle loop)
    expect(child.kill).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
  });

  it('should guard against connected client in killChild (TOCTOU)', async () => {
    const { registry, tmpDir } = await createRegistry({ idleTimeoutMs: 1 });
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    const server = makeServer();
    mockCreateServer.mockReturnValueOnce(server);

    await registry.ensure('guard-test', 'cmd', { K: 'v' }, 'h1', false);

    // Simulate client connecting between recycleIdle check and killChild execution
    const entry = registry.get('guard-test')!;
    entry.lastActivity = 0;

    // Attach socket AFTER lastActivity is ancient but before killChild does its check
    const conn = makeSocket();
    entry.attachedSocket = conn;

    // Directly call killChild (recycleIdle would call this)
    await (registry as any).killChild(entry);

    // killChild checks attachedSocket and aborts
    expect(child.kill).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
  });

  it('explicit kill ignores attached socket — must terminate the process (round 40-w3 CRITICAL)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('kill-attached', 'cmd', { K: 'v' }, 'h1', false);

    // 模拟 bridge RPC 通道仍 attached(用户关会话时常见)
    const conn = makeSocket();
    const entry = registry.get('kill-attached')!;
    entry.attachedSocket = conn;

    // 显式 kill:allowAttached=true 必须无视 attached 杀进程
    await registry.kill('kill-attached');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // teardown 已删 entry + env-file
    expect(registry.list()).toHaveLength(0);
  });
});

// ── 5. env-file ──────────────────────────────────────────
describe('env-file', () => {
  it('should write env-file with KEY=val format', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('env-fmt', 'cmd', { FOO: 'bar', BAZ: 'qux' }, 'h1', false);

    const envFile = path.join(tmpDir, 'envs', 'env-env-fmt');
    const content = fs.readFileSync(envFile, 'utf8');
    expect(content.trim()).toMatch(/^FOO=bar$/m);
    expect(content.trim()).toMatch(/^BAZ=qux$/m);
  });

  it('should create env-file with restrictive permissions', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    await registry.ensure('env-perm', 'cmd', { KEY: 'val' }, 'h1', false);

    const envFile = path.join(tmpDir, 'envs', 'env-env-perm');
    const stat = fs.statSync(envFile);
    // 0600 = owner rw only; platform-dependent — on Windows mode bits differ
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    } else {
      // On Windows, at minimum the file should exist and be readable
      expect(stat.isFile()).toBe(true);
    }
  });

  it('should clean up env-file and child on spawn failure', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);

    // Throw synchronously in listen() → Promise executor catches → rejects
    const server = makeServer();
    server.listen.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    mockCreateServer.mockReturnValueOnce(server);

    await expect(
      registry.ensure('fail-spawn', 'cmd', { KEY: 'val' }, 'h1', false),
    ).rejects.toThrow(/EACCES/);

    // Child should have been killed with SIGKILL
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    // Env-file should have been removed
    const envFile = path.join(tmpDir, 'envs', 'env-fail-spawn');
    expect(fs.existsSync(envFile)).toBe(false);
  });

  // 轮 40-w4-t5 MEDIUM-5:env-file 写入自身失败(原子写 tmp 失败)时 —— ensure
  // reject、无 env-file 残留、不 spawn child、不 listen socket。
  it('should reject cleanly when env-file write fails (no residue, no spawn)', async () => {
    const { registry, tmpDir, envDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // 诱发 atomic write 的 writeFile(envTmp) 抛错:mockFsWriteFile 对 .tmp-
    // 路径抛 ENOSPC(其余路径透传真实实现)。
    const realWriteFile = (globalThis as Record<string, unknown>).__realFsWriteFile as typeof fsPromises.writeFile;
    mockFsWriteFile.mockImplementation(async (p: any, ...rest: any[]) => {
      if (String(p).includes('.tmp-')) throw new Error('ENOSPC: no space left on device');
      return (realWriteFile as any)(p, ...rest);
    });

    await expect(
      registry.ensure('envfail', 'cmd', { KEY: 'val' }, 'h1', false),
    ).rejects.toThrow(/env-file write failed/);

    // 无残留(最终 env-file 与 tmp 都不存在)
    expect(fs.readdirSync(envDir)).toHaveLength(0);
    // 未 spawn(写失败发生在 spawn 前)
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  // 轮 40-w4-t6 CRITICAL:daemon 子进程不得继承宿主污染 env —— allowlist 最小
  // 环境 + session env, BASH_ENV/ENV/代理变量等不得透传。
  it('spawns child with allowlisted env, not host process.env (round 40-w4-t6 CRITICAL)', async () => {
    // 注入宿主污染变量
    const origEnv = { ...process.env };
    process.env.BASH_ENV = '/etc/evil.sh';
    process.env.HTTP_PROXY = 'http://proxy.example:8080';
    process.env.MY_CUSTOM_VAR = 'should-not-leak';
    try {
      const { registry, tmpDir } = await createRegistry();
      cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

      const child = makeChild();
      mockSpawn.mockReturnValueOnce(child);
      mockCreateServer.mockReturnValueOnce(makeServer());
      await registry.ensure('enviso', 'cmd', { SESSION_KEY: 'session-value' }, 'h1', false);

      const spawnOpts = mockSpawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      // session env 注入
      expect(spawnOpts.env.SESSION_KEY).toBe('session-value');
      // 宿主污染变量不泄漏
      expect(spawnOpts.env.BASH_ENV).toBeUndefined();
      expect(spawnOpts.env.HTTP_PROXY).toBeUndefined();
      expect(spawnOpts.env.MY_CUSTOM_VAR).toBeUndefined();
      // allowlist 有稳定 PATH
      expect(spawnOpts.env.PATH).toContain('/usr/bin');
    } finally {
      process.env = origEnv;
    }
  });

  // 轮 40-w2 MEDIUM:spawn 后 listen 失败 + SIGKILL 杀不死 → 必须抛
  // SESSION_KILL_SURVIVED(而非静默返回), 否则调用方 retry 会双 spawn。
  it('spawn failure with survivor → SESSION_KILL_SURVIVED, env-file cleaned', async () => {
    // 只 fake setTimeout(4c 同款), 保留 setImmediate 供 flushMicrotasks 驱动
    // 真实 fs I/O 到达 catch 段。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { registry, tmpDir } = await createRegistry();
      cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

      const child = makeSurviveChild();
      mockSpawn.mockReturnValueOnce(child);
      const server = makeServer();
      server.listen.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      mockCreateServer.mockReturnValueOnce(server);

      const ensurePromise = registry.ensure('fail-survive', 'cmd', { KEY: 'val' }, 'h1', false);
      // spawnSession 前置有真实 fs I/O await(rm env-file + atomic writeFile tmp +
      // rename + rm sock), 先把它们 flush 到 catch 段(waitForExit 的 setTimeout
      // 注册)再 advance。spawn 失败 catch 是**直接 SIGKILL**(同步), 轮询条件
      // 等 child.kill 被调即到达 catch。轮 42 CI 修复:上限 500 → 5000 —— 慢
      // CI 上真实 fs 链(4 个 await)可能排得更久, 500 次 setImmediate 不够,
      // 提前失败后 afterEach 删 tmpDir 会让迟到的 rename 变成 unhandled ENOENT。
      for (let i = 0; i < 5000 && child.kill.mock.calls.length === 0; i += 1) {
        await flushMicrotasks();
      }
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      // KILL_CONFIRM_MS (5000):waitForExit times out → SESSION_KILL_SURVIVED
      vi.advanceTimersByTime(5000);
      await Promise.resolve();

      await expect(ensurePromise).rejects.toMatchObject({ code: 'SESSION_KILL_SURVIVED' });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      const envFile = path.join(tmpDir, 'envs', 'env-fail-survive');
      expect(fs.existsSync(envFile)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('5d. should clean stale socket file before listen', async () => {
    const { registry, tmpDir, sockDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // 轮 21-W4 HIGH:socket 文件名是 sha256(sessionId) 截断 —— stale 文件必须
    // 用 ensure 实际生成的 sockPath(registry 的 list 可查)才验证到清理逻辑。
    const sessionId = 'stale';
    const stubChild = makeChild();
    mockSpawn.mockReturnValueOnce(stubChild);
    mockCreateServer.mockReturnValueOnce(makeServer());
    const first = await registry.ensure(sessionId, 'cmd', { K: 'v' }, 'h1', false);
    const sockPath = first.sockPath;

    // 模拟上一次生命周期残留:在 ensure 生成的真实 sockPath 上写 stale 文件,
    // 然后 kill + 重新 ensure —— spawnSession 的 rm(sockPath) 应清掉它。
    await registry.kill(sessionId);
    fs.writeFileSync(sockPath, 'stale data');

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());
    const second = await registry.ensure(sessionId, 'cmd', { K: 'v' }, 'h1', false);

    // After re-ensure, the stale file at this sockPath should be gone
    expect(fs.existsSync(sockPath)).toBe(false);
    expect(second.sockPath).toBe(sockPath);
    expect(registry.list()).toHaveLength(1);
  });
});

// ── 6. shuttingDown ──────────────────────────────────────
describe('shuttingDown', () => {
  it('should reject ensure with INTERNAL after beginShutdown', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    registry.beginShutdown();

    await expect(
      registry.ensure('test', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/pi-manager is shutting down/);

    // Verify error code is INTERNAL
    try {
      await registry.ensure('test', 'cmd', { K: 'v' }, 'h1', false);
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('INTERNAL');
    }
  });

  it('should reject ensure during shutdownAll', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false);

    // Start shutdown — it sets shuttingDown=true
    const shutdownPromise = registry.shutdownAll();

    // Any new ensure should be rejected
    await expect(
      registry.ensure('s2', 'cmd2', { K: 'v' }, 'h2', false),
    ).rejects.toThrow(/shutting down/);

    await shutdownPromise;
  });

  it('should reject new spawn during shutdown (guard in spawnSession before spawn)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // 守卫在 spawnSession 的 env-file 写后、spawn 前 —— 直接置 shuttingDown
    // 再 ensure 即可触发(自审轮 6 L-3 把守卫提前后的语义)。
    registry.beginShutdown();

    await expect(
      registry.ensure('s1', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    // Env-file 不应残留
    const envFile = path.join(tmpDir, 'envs', 'env-s1');
    expect(fs.existsSync(envFile)).toBe(false);

    // Child 不应被 spawn
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(0);
  });

  it('awaits env-file removal when shutdown races after the credential file is written', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const envFile = path.join(tmpDir, 'envs', 'env-race-shutdown');
    const origRename = fsPromises.rename.bind(fsPromises);
    const renameSpy = vi.spyOn(fsPromises, 'rename').mockImplementation(async (src, dest, ...rest) => {
      const result = await origRename(src, dest, ...rest);
      if (String(dest) === envFile) registry.beginShutdown();
      return result;
    });

    await expect(
      registry.ensure('race-shutdown', 'cmd', { CINDY_PI_API_KEY: 'gateway-secret' }, 'h1', false),
    ).rejects.toThrow(/pi-manager is shutting down/);

    expect(fs.existsSync(envFile)).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    renameSpy.mockRestore();
  });
});

// ── 7. sessionId / env 校验 ──────────────────────────────
describe('sessionId / env validation', () => {
  it('should reject sessionId with path traversal (/)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('../escape', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/unsafe sessionId/);
  });

  it('should reject sessionId with backslash (path traversal)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('..\\escape', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/unsafe sessionId/);
  });

  it('should reject sessionId with spaces', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('has space', 'cmd', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/unsafe sessionId/);
  });

  it('should accept sessionId with alphanumeric, dash, underscore', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    mockSpawn.mockReturnValueOnce(makeChild());
    mockCreateServer.mockReturnValueOnce(makeServer());

    const result = await registry.ensure(
      'my-session_42',
      'cmd',
      { K: 'v' },
      'h1',
      false,
    );
    expect(result.sessionId).toBe('my-session_42');
  });

  it('should reject env key with leading digit', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('test', 'cmd', { '1BAD': 'val' }, 'h1', false),
    ).rejects.toThrow(/unsafe env entry/);
  });

  it('should reject env key with special characters', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('test', 'cmd', { 'KEY-INJECT=evil': 'val' }, 'h1', false),
    ).rejects.toThrow(/unsafe env entry/);
  });

  it('should reject env value with newline injection', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('test', 'cmd', { KEY: 'val\nINJECT=evil' }, 'h1', false),
    ).rejects.toThrow(/unsafe env entry/);
  });

  it('should reject env value with carriage return', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('test', 'cmd', { KEY: 'val\rINJECT=evil' }, 'h1', false),
    ).rejects.toThrow(/unsafe env entry/);
  });

  // 轮 40-w5 MEDIUM:env value 含 NUL → Node spawn 同步抛 ERR_INVALID_ARG_VALUE,
  // 发生在 env-file 写入之后会残留凭证文件。ensure 必须在写入前拒绝。
  it('should reject env value with NUL byte (spawn would throw synchronously)', async () => {
    const { registry, tmpDir, envDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('test', 'cmd', { KEY: 'val\0INJECT' }, 'h1', false),
    ).rejects.toThrow(/unsafe env entry/);
    // fail-fast: 任何 env-file 都不得写入
    expect(fs.readdirSync(envDir)).toHaveLength(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  // 轮 40-w5 MEDIUM:cmd 含 NUL 同理会同步抛 ERR_INVALID_ARG_VALUE。
  it('should reject cmd with NUL byte', async () => {
    const { registry, tmpDir, envDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    await expect(
      registry.ensure('test', 'echo a\0rm -rf /', { K: 'v' }, 'h1', false),
    ).rejects.toThrow(/unsafe cmd/);
    expect(fs.readdirSync(envDir)).toHaveLength(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// ── 8. child stdout / stderr forwarding ─────────────────
// Tests verify the stdio-forwarding logic by setting attachedSocket directly
// on the entry (bypassing server.emit which depends on net mock internals).
// The forwarding logic itself is independent of how the socket was connected.
describe('child stdout / stderr forwarding', () => {
  it('8a. should forward stdout to attached socket', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('stdout-test', 'cmd', { K: 'v' }, 'h1', false);

    // Simulate connected client by setting attachedSocket directly
    const conn = makeSocket();
    const entry = registry.get('stdout-test')!;
    entry.attachedSocket = conn;

    child.stdout.emit('data', Buffer.from('hello from pi\n'));

    expect(conn.write).toHaveBeenCalledWith(
      Buffer.from('hello from pi\n'), expect.any(Function),
    );
  });

  it('8b. should discard stdout when no client attached', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('discard-test', 'cmd', { K: 'v' }, 'h1', false);

    expect(() => {
      child.stdout.emit('data', Buffer.from('unattended output\n'));
    }).not.toThrow();

    const entry = registry.get('discard-test')!;
    expect(entry.lastActivity).toBeGreaterThan(0);
  });

  it('8c. detached control frame (extension_ui_request) → fail-closed kill (round 42 P1)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    child.kill = vi.fn((_signal?: string) => { child.exitCode = 0; return true; });
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('ctrl-drop-test', 'cmd', { K: 'v' }, 'h1', false);

    // detached(attachedSocket=null): 发控制帧 → 必须 kill(fail-closed)。
    child.stdout.emit('data', Buffer.from('{"type":"extension_ui_request","id":"ui-1"}\n'));

    // kill 被调 + entry 被 teardown 删除。
    await flushMicrotasks();
    expect(child.kill).toHaveBeenCalled();
    expect(registry.get('ctrl-drop-test')).toBeUndefined();
  });

  it('8f. resumes paused stdout when conn closes before drain (round 16 HIGH — backpressure hang fix)', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('backpressure-test', 'cmd', { K: 'v' }, 'h1', false);

    // 有连接且 write 返回 false(背压)→ child.stdout 被 pause
    const conn = makeSocket();
    conn.write = vi.fn(() => false); // 模拟缓冲满
    const entry = registry.get('backpressure-test')!;
    entry.attachedSocket = conn;

    child.stdout.emit('data', Buffer.from('big output'));

    // pause 被调用
    expect(child.stdout.paused).toBe(true);

    // 连接在 drain 前关闭(SSH 断)—— close 触发 resume
    conn.emit('close');

    expect(child.stdout.paused).toBe(false);
  });

  it('8c. should forward client data to child stdin', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('stdin-test', 'cmd', { K: 'v' }, 'h1', false);

    const conn = makeSocket();
    const entry = registry.get('stdin-test')!;
    entry.attachedSocket = conn;

    // The 'data' listener is normally registered by the server connection
    // handler. Since we bypass server.emit, register it manually.
    conn.on('data', (chunk: Buffer) => {
      if (!child.stdin.destroyed) child.stdin.write(chunk);
    });

    // Simulate client data arriving via the bridge socket
    conn.emit('data', Buffer.from('user input\n'));

    expect(child.stdin.write).toHaveBeenCalledWith(Buffer.from('user input\n'));
  });

  it('8d. should clear attachedSocket on connection close', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('close-test', 'cmd', { K: 'v' }, 'h1', false);

    const conn = makeSocket();
    const entry = registry.get('close-test')!;
    entry.attachedSocket = conn;
    // Register close handler (normally set up by server connection handler)
    conn.on('close', () => {
      if (entry.attachedSocket === conn) entry.attachedSocket = null;
    });
    expect(registry.list()[0].isAttached).toBe(true);

    conn.emit('close');
    expect(registry.list()[0].isAttached).toBe(false);
  });

  it('8e. should emit pi stderr to logger', async () => {
    const { registry, tmpDir } = await createRegistry();
    cleanupFns.push(() => { registry.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);
    mockCreateServer.mockReturnValueOnce(makeServer());
    await registry.ensure('stderr-test', 'cmd', { K: 'v' }, 'h1', false);

    // stderr data should not throw
    expect(() => {
      child.stderr.emit('data', Buffer.from('pi stderr message\n'));
    }).not.toThrow();
  });
});

// ── 9. close() ───────────────────────────────────────────
describe('close', () => {
  it('should clear the idle timer on close', async () => {
    const { registry, tmpDir } = await createRegistry({ idleTimeoutMs: 60_000 });
    cleanupFns.push(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    // close() should not throw
    expect(() => registry.close()).not.toThrow();
  });

  it('should be safe to close without idle timer (idleTimeoutMs=0)', async () => {
    const { registry, tmpDir } = await createRegistry({ idleTimeoutMs: 0 });
    cleanupFns.push(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    expect(() => registry.close()).not.toThrow();
  });
});

// ── 9. 凭证脱敏(key-aware, 轮 40-w4-t5 CRITICAL) ─────────
describe('scrubCredentialText key-aware redaction', () => {
  it('redacts 64-hex sessionToken by key name (value shape regex misses it)', () => {
    const line = 'CINDY_PI_MCP_BRIDGE={"token":"0123456789abcdef0123456789abcdef","server":"x"}';
    const out = scrubCredentialText(line);
    expect(out).not.toContain('0123456789abcdef0123456789abcdef');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts custom MCP header secret values by key name', () => {
    const line = 'CINDY_PI_REMOTE_MCP_SECRET_myprovider=opaque-value-123';
    const out = scrubCredentialText(line);
    expect(out).not.toContain('opaque-value-123');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts JSON api_key fields', () => {
    const line = '{"api_key":"someopaquevalue","other":"keep"}';
    const out = scrubCredentialText(line);
    expect(out).not.toContain('someopaquevalue');
    expect(out).toContain('keep');
  });

  it('keeps non-sensitive lines intact', () => {
    const line = 'pi started with model gpt-5.5 in /home/user/project';
    expect(scrubCredentialText(line)).toBe(line);
  });
});
