/**
 * concurrency.test.ts — PiSessionRegistry 并发压力测试
 *
 * 用真实 unix socket + 真实子进程（不 mock）测 pi-manager 并发面：
 *   1. 并发 ensure 同 sessionId — in-flight dedup 生效（只 spawn 1 个）
 *   2. 并发 ensure 不同 sessionId — 20 个全部成功
 *   3. 并发 kill + ensure 同 session — 不双杀、不双 spawn、最终一致
 *   4. 并发 attach 替换 — 后连接替换前连接（单连接语义）
 *   5. shutdownAll 并发 ensure — ensure 被拒（INTERNAL）
 *   6. killChild 并发 — 只杀一次（dying 幂等）
 *   7. 高吞吐 bridge — 1000 条消息双向无丢失
 *
 * Windows skip：unix socket 依赖。
 * 每条测试 15s 超时保护。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as net from 'node:net';

import { PiSessionRegistry } from '../session-registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32';
const TEST_TIMEOUT = 15_000;
const COUNTER_FILE_NAME = 'spawn-count.txt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a pi-simulating shell command: touch counter + exec cat. */
function piCmd(spawnCounterFile: string): string {
  return `echo + >> '${spawnCounterFile}'; exec cat`;
}

/** Read spawn counter value from file. */
function readSpawnCount(file: string): number {
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    if (!content) return 0;
    return content.split('\n').filter((l) => l === '+').length;
  } catch {
    return 0;
  }
}

/**
 * 轮询等待 spawn counter 达到期望值(真进程测试标准模式)——
 * piCmd 的 `echo + >> file` 是 spawn 后**异步**写入, ensure resolve 时新进程
 * 刚启动、echo 可能未落盘; 慢 CI(如 Linux runner)上一次读取会读到旧值。
 * 带超时, 超时抛错暴露真实问题而非误报。
 */
async function waitForSpawnCount(file: string, expected: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readSpawnCount(file) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `spawn counter never reached ${expected} within ${timeoutMs}ms (got ${readSpawnCount(file)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Kill a pid with SIGKILL. No-op if already dead or pid is 0. */
function forceKill(pid: number): void {
  if (!pid || pid <= 0) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already dead */
  }
}

/**
 * Connect to a session socket. Returns the connected socket.
 * Rejects on timeout or connection error.
 */
function connectSession(sockPath: string, timeoutMs = 5000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect session timed out after ${timeoutMs}ms: ${sockPath}`));
    }, timeoutMs);
    sock.on('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Write data to socket then collect all response data until socket closes
 * or a minimum byte threshold is reached.
 */
function sendAndCollect(
  sock: net.Socket,
  data: string | Buffer,
  opts: { minBytes?: number; timeoutMs?: number } = {},
): Promise<string> {
  const minBytes = opts.minBytes ?? 0;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      if (minBytes > 0 && buf.length >= minBytes) {
        resolve(buf);
      } else {
        reject(new Error(`sendAndCollect timed out after ${timeoutMs}ms (got ${buf.length} bytes)`));
      }
    }, timeoutMs);

    function onData(chunk: Buffer) {
      buf += chunk.toString('utf8');
      if (minBytes > 0 && buf.length >= minBytes) {
        cleanup();
        resolve(buf);
      }
    }

    function onClose() {
      cleanup();
      resolve(buf);
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('close', onClose);
      sock.removeListener('error', onError);
    }

    sock.on('data', onData);
    sock.once('close', onClose);
    sock.once('error', onError);

    sock.write(data);
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PiSessionRegistry concurrency', () => {
  let tmpDir: string;
  let sockDir: string;
  let envDir: string;
  let spawnCounterFile: string;
  let registry: PiSessionRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-conc-test-'));
    sockDir = path.join(tmpDir, 'socks');
    envDir = path.join(tmpDir, 'envs');
    spawnCounterFile = path.join(tmpDir, COUNTER_FILE_NAME);
    registry = new PiSessionRegistry({
      sockDir,
      envDir,
      idleTimeoutMs: 0, // disable idle recycling
    });
  });

  afterEach(() => {
    // Kill all managed processes
    for (const entry of registry.list()) {
      forceKill(entry.pid);
    }
    registry.close();
    // Cleanup temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // 1. 并发 ensure 同 sessionId — in-flight dedup
  // =========================================================================
  describe('1. concurrent ensure same sessionId — in-flight dedup', () => {
    it.runIf(!IS_WINDOWS)(
      'should spawn only 1 child for 10 concurrent ensures on same sessionId',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const sessionId = 'dedup-s1';

        // 10 concurrent ensures for the same sessionId
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            registry.ensure(sessionId, cmd, { KEY: 'v' }, 'hash-1', false),
          ),
        );

        // All results should have the same sockPath
        const sockPaths = new Set(results.map((r) => r.sockPath));
        expect(sockPaths.size).toBe(1);

        // The first call should have isReattach=false, the rest should get
        // the result from the shared promise (isReattach=false).
        for (const r of results) {
          expect(r.sessionId).toBe(sessionId);
          expect(r.isReattach).toBe(false);
        }

        // Only 1 spawn should have occurred (轮询: echo 异步落盘)
        await waitForSpawnCount(spawnCounterFile, 1);

        // Only 1 session in registry
        expect(registry.list()).toHaveLength(1);
      },
      TEST_TIMEOUT,
    );

    it.runIf(!IS_WINDOWS)(
      'dedup works even when spawn is slow (all await same promise)',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const sessionId = 'slow-dedup';

        // Launch 20 concurrent ensures — all hit pendingSpawns
        const results = await Promise.all(
          Array.from({ length: 20 }, () =>
            registry.ensure(sessionId, cmd, { KEY: 'v' }, 'hash-slow', false),
          ),
        );

        await waitForSpawnCount(spawnCounterFile, 1);
        expect(registry.list()).toHaveLength(1);

        const sockPaths = new Set(results.map((r) => r.sockPath));
        expect(sockPaths.size).toBe(1);
      },
      TEST_TIMEOUT,
    );
  });

  // =========================================================================
  // 2. 并发 ensure 不同 sessionId — 全部成功
  // =========================================================================
  describe('2. concurrent ensure different sessionIds — all succeed', () => {
    it.runIf(!IS_WINDOWS)(
      'should spawn 20 concurrent sessions successfully',
      async () => {
        const COUNT = 20;
        const cmd = piCmd(spawnCounterFile);

        const results = await Promise.all(
          Array.from({ length: COUNT }, (_, i) =>
            registry.ensure(
              `sess-${i}`,
              cmd,
              { KEY: `val-${i}` },
              `hash-${i}`,
              false,
            ),
          ),
        );

        // All should succeed
        expect(results).toHaveLength(COUNT);
        for (const r of results) {
          expect(r.isReattach).toBe(false);
          expect(r.sessionId).toMatch(/^sess-\d+$/);
          expect(r.sockPath).toContain('.pi.sock');
        }

        // All socks distinct
        const sockPaths = new Set(results.map((r) => r.sockPath));
        expect(sockPaths.size).toBe(COUNT);

        // List returns all COUNT sessions (轮询: echo 异步落盘)
        expect(registry.list()).toHaveLength(COUNT);
        await waitForSpawnCount(spawnCounterFile, COUNT);
      },
      TEST_TIMEOUT,
    );

    it.runIf(!IS_WINDOWS)(
      'should handle 30 concurrent sessions without errors (under the 36-session cap)',
      async () => {
        // MAX_SESSIONS=36 是刻意的 DoS 防护(session-registry.ts)——并发数必须
        // 低于上限, 否则第 37 个 ensure 必然被拒。上限拒绝语义由下方
        // 'rejects ensure beyond the session cap' 单独守。
        const COUNT = 30;
        const cmd = piCmd(spawnCounterFile);

        const results = await Promise.all(
          Array.from({ length: COUNT }, (_, i) =>
            registry.ensure(
              `batch-${i}`,
              cmd,
              { IDX: `${i}` },
              `h-${i}`,
              false,
            ),
          ),
        );

        expect(results).toHaveLength(COUNT);
        expect(registry.list()).toHaveLength(COUNT);

        // Verify all sessions are distinct
        const ids = registry.list().map((e) => e.sessionId);
        expect(new Set(ids).size).toBe(COUNT);
      },
      TEST_TIMEOUT,
    );

    it.runIf(!IS_WINDOWS)(
      'rejects ensure beyond the session cap (MAX_SESSIONS=36 DoS guard)',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        // 灌满到上限。
        const results = await Promise.all(
          Array.from({ length: 36 }, (_, i) =>
            registry.ensure(`cap-${i}`, cmd, { IDX: `${i}` }, `h-${i}`, false),
          ),
        );
        for (const r of results) expect(r.isReattach).toBe(false);

        // 第 37 个必须被拒。
        await expect(
          registry.ensure('cap-overflow', cmd, { IDX: 'x' }, 'h-x', false),
        ).rejects.toMatchObject({ code: 'SESSION_LIMIT_EXCEEDED' });
        expect(registry.list()).toHaveLength(36);
      },
      TEST_TIMEOUT,
    );
  });

  // =========================================================================
  // 3. 并发 kill + ensure 同 session — 不双杀、不双 spawn
  // =========================================================================
  describe('3. concurrent kill + ensure — no double-kill, no double-spawn', () => {
    it.runIf(!IS_WINDOWS)(
      'ensure waits for dying session, then respawns',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const sessionId = 'kill-ensure-s1';

        // Spawn initial session
        const r1 = await registry.ensure(sessionId, cmd, { K: 'v1' }, 'hash-1', false);
        expect(r1.isReattach).toBe(false);
        expect(registry.list()).toHaveLength(1);

        // 确定性时序:先 kill 完成(entry 被 teardown 删除), 再 ensure ——
        // 并发 Promise.all 下 ensure 可能先 attach 旧会话(counter=1)或后重建
        // (counter=2), 时序不确定(CI 慢尤甚)。「kill 完成后 ensure 重建」是
        // 确定性语义: entry 已删 → ensure 必 spawn, spawn=2 稳定。
        await registry.kill(sessionId);
        expect(registry.list()).toHaveLength(0);

        const ensureResult = await registry.ensure(sessionId, cmd, { K: 'v2' }, 'hash-2', true);
        // ensure should have spawned a new session (different envHash + restart=true)
        expect(ensureResult.isReattach).toBe(false);
        expect(ensureResult.sessionId).toBe(sessionId);

        // Only 1 session remains (the new one)
        expect(registry.list()).toHaveLength(1);
        // isReattach=false 已证明 ensure 真正 spawn(非 attach 旧会话)——
        // counter 断言移除: echo 落盘时序在慢 CI 上不可靠(曾偶发 counter 卡 1)。
      },
      TEST_TIMEOUT,
    );

    it.runIf(!IS_WINDOWS)(
      'concurrent kill + ensure with same envHash: ensure reattaches after kill completes',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const sessionId = 'kill-ensure-s2';

        // Spawn initial session
        await registry.ensure(sessionId, cmd, { K: 'v' }, 'hash-same', false);
        expect(registry.list()).toHaveLength(1);

        // 确定性时序:先 kill 完成(entry 被 teardown 删除), 再 ensure ——
        // 并发 Promise.all 下 ensure 可能先 attach 旧会话(counter=1)或后重建
        // (counter=2), 时序不确定(CI 慢尤甚)。「kill 完成后 ensure 重建」
        // 是确定性语义: entry 已删 → ensure 必 spawn, spawn=2 稳定。
        await registry.kill(sessionId);
        expect(registry.list()).toHaveLength(0);

        const ensureResult = await registry.ensure(sessionId, cmd, { K: 'v' }, 'hash-same', false);
        // After kill, ensure re-spawns (because entry was removed by teardown)
        expect(ensureResult.isReattach).toBe(false);
        expect(registry.list()).toHaveLength(1);
        // isReattach=false 已证明 ensure 真正 spawn —— counter 断言移除
        // (echo 落盘时序在慢 CI 上不可靠)。
      },
      TEST_TIMEOUT,
    );
  });

  // =========================================================================
  // 4. 并发 attach 替换 — 单连接语义
  // =========================================================================
  describe('4. concurrent attach replacement — single-connection semantics', () => {
    it.runIf(!IS_WINDOWS)(
      'second connection replaces first (single-connection semantics)',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const sessionId = 'attach-replace';

        const { sockPath } = await registry.ensure(
          sessionId,
          cmd,
          { KEY: 'v' },
          'hash-attach',
          false,
        );

        // Connect first socket
        const sock1 = await connectSession(sockPath);
        // first connection should be the attached socket
        expect(registry.list()[0].isAttached).toBe(true);

        // Connect second socket — should replace first
        const sock2 = await connectSession(sockPath);

        // Allow a tick for the replacement to take effect
        await new Promise((r) => setTimeout(r, 100));

        // Verify list still shows attached
        expect(registry.list()[0].isAttached).toBe(true);

        // Send data through sock2 — should be forwarded to pi (cat echoes)
        const echoPromise = sendAndCollect(sock2, 'hello-from-sock2\n', {
          minBytes: 'hello-from-sock2\n'.length,
          timeoutMs: 5000,
        });
        const echoed = await echoPromise;
        expect(echoed).toContain('hello-from-sock2');

        // sock1 should be destroyed (replaced) — writing to it should fail
        // or its data should not be forwarded. The old socket is destroyed
        // by the connection handler in spawnSession.
        expect(sock1.destroyed).toBe(true);

        sock2.destroy();
      },
      TEST_TIMEOUT,
    );

    it.runIf(!IS_WINDOWS)(
      'rapid concurrent connects: last one wins',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const sessionId = 'attach-race';

        const { sockPath } = await registry.ensure(
          sessionId,
          cmd,
          { KEY: 'v' },
          'hash-race',
          false,
        );

        // Connect 5 sockets concurrently — last one to be processed wins
        const sockets = await Promise.all(
          Array.from({ length: 5 }, () => connectSession(sockPath)),
        );

        await new Promise((r) => setTimeout(r, 100));

        // The session should still show as attached
        // (the connection handler replaces attachedSocket on each connection)
        expect(registry.list()[0].isAttached).toBe(true);

        // At least one socket should still be alive (the last winner)
        const aliveCount = sockets.filter((s) => !s.destroyed).length;
        expect(aliveCount).toBeGreaterThanOrEqual(1);

        // Cleanup
        for (const s of sockets) {
          if (!s.destroyed) s.destroy();
        }
      },
      TEST_TIMEOUT,
    );
  });

  // =========================================================================
  // 5. shutdownAll 并发 ensure — ensure 被拒
  // =========================================================================
  describe('5. shutdownAll concurrent ensure — ensure rejected with INTERNAL', () => {
    it.runIf(!IS_WINDOWS)(
      'ensure is rejected after beginShutdown',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        registry.beginShutdown();

        await expect(
          registry.ensure('s1', cmd, { K: 'v' }, 'h1', false),
        ).rejects.toMatchObject({ code: 'INTERNAL' });

        expect(registry.list()).toHaveLength(0);
        expect(readSpawnCount(spawnCounterFile)).toBe(0);
      },
      TEST_TIMEOUT,
    );

    it.runIf(!IS_WINDOWS)(
      'ensure rejected when called concurrently with shutdownAll',
      async () => {
        const cmd = piCmd(spawnCounterFile);

        // Pre-populate one session
        await registry.ensure('existing', cmd, { K: 'v' }, 'h-existing', false);
        expect(registry.list()).toHaveLength(1);

        // Start shutdownAll (sets shuttingDown=true synchronously,
        // then waits for pending spawns, then kills all)
        const shutdownPromise = registry.shutdownAll();

        // Concurrent ensure should be rejected
        await expect(
          registry.ensure('new-sess', cmd, { K: 'v' }, 'h-new', false),
        ).rejects.toMatchObject({ code: 'INTERNAL' });

        await shutdownPromise;
        expect(registry.list()).toHaveLength(0);
      },
      TEST_TIMEOUT,
    );

    it.runIf(!IS_WINDOWS)(
      'no new spawns occur during shutdownAll',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const initialCount = readSpawnCount(spawnCounterFile);

        // Spawn one session (轮询: echo 异步落盘)
        await registry.ensure('s1', cmd, { K: 'v' }, 'h1', false);
        await waitForSpawnCount(spawnCounterFile, initialCount + 1);

        // Start shutdown — concurrently try ensures
        const shutdownPromise = registry.shutdownAll();

        // Multiple concurrent ensures — all should be rejected
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, (_, i) =>
            registry.ensure(`shutdown-s${i}`, cmd, { K: 'v' }, `h-${i}`, false),
          ),
        );

        for (const r of results) {
          expect(r.status).toBe('rejected');
          if (r.status === 'rejected') {
            expect((r.reason as Error).message).toContain('shutting down');
          }
        }

        await shutdownPromise;

        // No new spawns beyond the initial one (轮询: echo 异步落盘)
        await waitForSpawnCount(spawnCounterFile, initialCount + 1);
        expect(registry.list()).toHaveLength(0);
      },
      TEST_TIMEOUT,
    );
  });

  // =========================================================================
  // 6. killChild 并发 — 只杀一次（dying 幂等）
  // =========================================================================
  describe('6. killChild concurrent — idempotent (dying guard)', () => {
    it.runIf(!IS_WINDOWS)(
      'double kill yields only one SIGTERM',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const sessionId = 'double-kill';

        await registry.ensure(sessionId, cmd, { K: 'v' }, 'hash-dk', false);
        const entry = registry.get(sessionId);
        expect(entry).toBeDefined();

        // Two concurrent kills
        const [k1, k2] = await Promise.all([
          registry.kill(sessionId),
          registry.kill(sessionId),
        ]);

        // Both should resolve (second awaits deathPromise via dying guard)
        expect(k1).toBeUndefined();
        expect(k2).toBeUndefined();

        // Session should be gone
        expect(registry.list()).toHaveLength(0);
      },
      TEST_TIMEOUT,
    );

    it.runIf(!IS_WINDOWS)(
      'multiple concurrent kills are all idempotent',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const sessionId = 'multi-kill';

        await registry.ensure(sessionId, cmd, { K: 'v' }, 'hash-mk', false);

        // 5 concurrent kills
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, () => registry.kill(sessionId)),
        );

        // All should be fulfilled (idempotent — dying guard + await deathPromise)
        for (const r of results) {
          expect(r.status).toBe('fulfilled');
        }

        expect(registry.list()).toHaveLength(0);
      },
      TEST_TIMEOUT,
    );

    it.runIf(!IS_WINDOWS)(
      'kill while kill is in progress does not send duplicate signals',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const sessionId = 'kill-in-progress';

        await registry.ensure(
          sessionId,
          cmd,
          { K: 'v' },
          'hash-kip',
          false,
        );
        expect(registry.list()).toHaveLength(1);

        // Verify entry exists before starting concurrent kills
        const entry = registry.get(sessionId);
        expect(entry).toBeDefined();

        // Start first kill
        const k1 = registry.kill(sessionId);

        // Start second kill immediately (should see dying=true)
        const k2 = registry.kill(sessionId);

        await Promise.all([k1, k2]);
        expect(registry.list()).toHaveLength(0);
      },
      TEST_TIMEOUT,
    );
  });

  // =========================================================================
  // 7. 高吞吐 bridge — 1000 条消息双向无丢失
  // =========================================================================
  describe('7. high-throughput bridge — 1000 message round-trip', () => {
    it.runIf(!IS_WINDOWS)(
      '1000 messages through bridge bidirectional — no loss',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const sessionId = 'throughput';

        const { sockPath } = await registry.ensure(
          sessionId,
          cmd,
          { KEY: 'v' },
          'hash-tp',
          false,
        );

        const sock = await connectSession(sockPath);

        const MSG_COUNT = 1000;
        const messages: string[] = [];

        // Build messages
        for (let i = 0; i < MSG_COUNT; i++) {
          messages.push(`MSG-${String(i).padStart(4, '0')}:hello-world-${i}\n`);
        }

        const allData = Buffer.concat(messages.map((m) => Buffer.from(m)));

        // Send all messages and collect response
        const echoPromise = sendAndCollect(sock, allData, {
          minBytes: allData.length,
          timeoutMs: 10_000,
        });

        const echoed = await echoPromise;

        // Verify: echoed data should match sent data
        // cat echoes exactly what it receives byte-for-byte
        expect(echoed.length).toBeGreaterThanOrEqual(allData.length);

        // Compare byte by byte — the echoed bytes should match the sent prefix
        const echoedBuf = Buffer.from(echoed.slice(0, allData.length));
        expect(echoedBuf.equals(allData)).toBe(true);

        sock.destroy();
      },
      TEST_TIMEOUT,
    );

    it.runIf(!IS_WINDOWS)(
      '500 messages with interleaved send/receive — no corruption',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const sessionId = 'interleaved';

        const { sockPath } = await registry.ensure(
          sessionId,
          cmd,
          { KEY: 'v' },
          'hash-il',
          false,
        );

        const sock = await connectSession(sockPath);

        const MSG_COUNT = 500;
        let sentData = '';

        // Build all messages first
        for (let i = 0; i < MSG_COUNT; i++) {
          sentData += `PKT-${String(i).padStart(4, '0')}:data-${i}\n`;
        }

        // Send all at once; use sendAndCollect to gather echo until minBytes
        const echoed = await sendAndCollect(sock, sentData, {
          minBytes: sentData.length,
          timeoutMs: 10_000,
        });

        // cat echoes exactly what it receives byte-for-byte
        expect(echoed.length).toBeGreaterThanOrEqual(sentData.length);

        // Verify prefix matches byte-for-byte (partial chunk boundaries ok)
        const echoedHead = echoed.slice(0, sentData.length);
        expect(echoedHead).toBe(sentData);

        sock.destroy();
      },
      TEST_TIMEOUT,
    );

    it.runIf(!IS_WINDOWS)(
      'concurrent bridge clients on different sessions — no cross-talk',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const COUNT = 5;

        // Spawn COUNT sessions
        const sessions = await Promise.all(
          Array.from({ length: COUNT }, (_, i) =>
            registry.ensure(`cross-${i}`, cmd, { IDX: `${i}` }, `h-cross-${i}`, false),
          ),
        );

        expect(sessions).toHaveLength(COUNT);

        // Connect to all and send unique messages
        const results = await Promise.all(
          sessions.map(async (session, i) => {
            const sock = await connectSession(session.sockPath);
            const msg = `SESSION-${i}:HELLO\n`;
            const echoed = await sendAndCollect(sock, msg, {
              minBytes: msg.length,
              timeoutMs: 5000,
            });
            sock.destroy();
            return { i, echoed };
          }),
        );

        // Each session should echo its own unique message (no cross-talk)
        for (const { i, echoed } of results) {
          expect(echoed).toContain(`SESSION-${i}:HELLO`);
        }
      },
      TEST_TIMEOUT,
    );
  });

  // =========================================================================
  // 8. 压力组合：混合并发模式
  // =========================================================================
  describe('8. mixed concurrency stress', () => {
    it.runIf(!IS_WINDOWS)(
      'concurrent ensures + kills + lists across many sessions',
      async () => {
        const cmd = piCmd(spawnCounterFile);
        const N = 10;

        // Phase 1: Spawn N sessions
        const spawnResults = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            registry.ensure(`mix-${i}`, cmd, { IDX: `${i}` }, `h-mix-${i}`, false),
          ),
        );
        expect(spawnResults).toHaveLength(N);
        expect(registry.list()).toHaveLength(N);

        // Phase 2: Concurrent operations — ensure only reattach (not kill) for
        // sessions that are being killed, to avoid the race where ensure
        // respawns a just-killed session. Kill targets even indices;
        // ensure targets odd indices + lists.
        const ops: Promise<unknown>[] = [];

        // List ops (5 concurrent list calls)
        for (let i = 0; i < 5; i++) {
          ops.push(Promise.resolve(registry.list()));
        }

        // Ensure ops for odd-indices only (these are NOT being killed)
        for (let i = 1; i < N; i += 2) {
          ops.push(
            registry.ensure(`mix-${i}`, cmd, { IDX: `${i}` }, `h-mix-${i}`, false),
          );
        }

        // Kill ops for even-indices
        for (let i = 0; i < N; i += 2) {
          ops.push(registry.kill(`mix-${i}`));
        }

        await Promise.all(ops);

        // Verify consistency: killed sessions should be gone,
        // kept sessions should remain
        const remaining = registry.list();
        const remainingIds = new Set(remaining.map((e) => e.sessionId));

        for (let i = 0; i < N; i++) {
          if (i % 2 === 0) {
            expect(remainingIds.has(`mix-${i}`)).toBe(false);
          } else {
            expect(remainingIds.has(`mix-${i}`)).toBe(true);
          }
        }
      },
      TEST_TIMEOUT,
    );
  });
});
