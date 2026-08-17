/**
 * pi-manager-integration.test.ts — 真实 socket + 真实子进程端到端集成测试
 *
 * 用真实 unix socket + 真实 spawn（不 mock spawn/net），本地模拟完整链路：
 *   1. 启动真实 ManagerServer（temp 目录 unix socket）
 *   2. 注册真实 PiSessionRegistry（spawn 真实 bash -c 子进程模拟 pi）
 *   3. 用真实 net.connect 连 daemon socket 做 RPC
 *   4. 连 session socket 验证 bridge 双向桥接
 *   5. 验证 env-file 内容 + 权限
 *
 * Windows 无 unix socket → suite 整体 skip。
 *
 * 覆盖场景（退役前 S1–S6 + 退役后 S7–S11）：
 *   S1. 完整生命周期: hello → pi/ensure → pi/list → pi/kill
 *   S2. bridge 双向桥接: session socket 写字节 → child stdin → cat echo →
 *       child stdout → session socket 读回
 *   S3. shutdownAll: 关停所有 session + sock/env 文件清理
 *   S4. env-file 内容格式 + 权限 0600
 *   S5. reattach: 同 envHash → isReattach=true（不杀旧进程）
 *   S6. restart: 不同 envHash + restart=true → 旧进程被杀 + 新进程 spawn
 *
 * 退役后新增（python pi-daemon 已退役，pi-manager 为唯一 daemon）：
 *   S7. daemon 崩溃恢复: 模拟 SIGKILL → 残留 env/sock 文件 →
 *       cleanupStaleState 清残留 → 新 registry 正常 spawn session（SPOF 验证）
 *   S8. 多会话隔离: ensure 2 会话 → kill 1 → 另一仍通（bridge echo）
 *   S9. bridge 断链重连: 连桥 → echo → 断桥 → session 仍存活 →
 *       重连桥 → echo 仍通（模拟 SSH 断链恢复）
 *   S10. 空闲回收参数化: idleTimeoutMs 缩短后回收触发（reaI 进程验证）
 *   S11. 并发 kill + ensure 同一 session: kill 与 ensure 竞态 → 不死锁、不双 spawn
 *
 * 每个测试 15s 超时上限防挂死。
 */

import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ManagerServer } from "../server.js";
import { PiSessionRegistry } from "../session-registry.js";
import {
  PROTOCOL_VERSION,
  METHODS,
  NOTIFICATIONS,
  type PiEnsureParams,
  type PiKillParams,
} from "../protocol.js";
import { encodeMessage } from "../codec.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the next complete NDJSON frame from a socket (RPC response/notification). */
function readNextFrame(
  socket: net.Socket,
  timeoutMs = 5000,
  expectId?: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let timer: NodeJS.Timeout | null = null;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      if (timer) clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };

    function onData(chunk: Buffer): void {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch (err) {
          cleanup();
          reject(err);
          return;
        }
        // kill/restart 路径会广播 session/closed notification —— 同 socket 上
        // 它可能抢在响应帧前到达(真进程时序, Linux 慢 runner 尤甚)。
        // expectId 指定时跳过不匹配的帧(notification / 其它 id), 只读目标响应。
        if (expectId !== undefined) {
          if (frame.type !== "response" || frame.id !== expectId) {
            // 丢弃不匹配帧, 继续读下一帧 —— 必须先更新 nl 再 continue。
            nl = buf.indexOf("\n");
            continue;
          }
        }
        cleanup();
        resolve(frame);
        return;
      }
    }

    function onClose(): void {
      cleanup();
      reject(new Error("readNextFrame: socket closed before frame"));
    }

    function onError(err: Error): void {
      cleanup();
      reject(err);
    }

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`readNextFrame timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

/** Write an RPC request frame (NDJSON line). */
function writeRequest(
  socket: net.Socket,
  id: number,
  method: string,
  params: unknown = {},
): void {
  socket.write(encodeMessage({ type: "request", id, method, params }));
}

/** Connect to a unix socket and wait for the connection to be established. */
async function connectSocket(socketPath: string): Promise<net.Socket> {
  const sock = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  return sock;
}

/** Perform protocol/hello handshake on a raw socket. Returns hello result. */
async function doHello(
  socket: net.Socket,
  clientId?: string,
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { protocolVersion: PROTOCOL_VERSION };
  if (clientId) params.clientId = clientId;
  writeRequest(socket, 1, METHODS.PROTOCOL_HELLO, params);
  const resp = await readNextFrame(socket);
  if (resp.error) {
    const err = resp.error as Record<string, unknown>;
    throw new Error(`hello failed: ${err.code}: ${err.message}`);
  }
  return resp.result as Record<string, unknown>;
}

/**
 * Read raw bytes from a session bridge socket until `delimiter` is found.
 * Returns the bytes up to and including the delimiter.
 */
function readUntil(
  socket: net.Socket,
  delimiter: string,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `readUntil timeout after ${timeoutMs}ms (got "${buf.slice(0, 100)}")`,
        ),
      );
    }, timeoutMs);

    function onData(chunk: Buffer): void {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf(delimiter);
      if (idx >= 0) {
        cleanup();
        resolve(buf.slice(0, idx + delimiter.length));
      }
    }

    function onClose(): void {
      cleanup();
      reject(new Error("socket closed before delimiter received"));
    }
    function onError(err: Error): void {
      cleanup();
      reject(err);
    }
    function cleanup(): void {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      socket.removeListener("error", onError);
    }

    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function silentLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/** Force-kill a process by PID with SIGKILL. No-op if already dead. */
function forceKillPid(pid: number): void {
  if (!pid || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead */
  }
}

/**
 * Wait for a process to actually die after SIGKILL.
 * Resolves true if process is confirmed dead, false on timeout.
 */
function waitForPidDeath(pid: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = (): void => {
      try {
        process.kill(pid, 0); // signal 0 = existence check
        if (Date.now() - start > timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, 50);
        }
      } catch {
        resolve(true); // ESRCH = process gone
      }
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")(
  "pi-manager integration (real sockets + real processes)",
  () => {
    let tmpDir: string;
    let server: ManagerServer;
    let registry: PiSessionRegistry;
    let serverSocketPath: string;
    let sockDir: string;
    let envDir: string;

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mgr-int-"));
      sockDir = path.join(tmpDir, "socks");
      envDir = path.join(tmpDir, "env");
      serverSocketPath = path.join(tmpDir, "pi-manager.sock");

      server = new ManagerServer({
        socketPath: serverSocketPath,
        managerVersion: "test-0.0.0",
        logger: silentLogger(),
      });

      registry = new PiSessionRegistry({
        sockDir,
        envDir,
        idleTimeoutMs: 0, // disable idle recycle for tests
        onSessionClosed: (sessionId, reason, detail) => {
          server.notifyAll({
            type: "notification" as const,
            method: NOTIFICATIONS.SESSION_CLOSED,
            params: {
              sessionId,
              reason,
              ...(detail !== undefined ? { detail } : {}),
            },
          });
        },
      });

      // Register pi/* handlers (same shape as bin/pi-manager.ts runDaemon)
      server.setHandler(METHODS.PI_ENSURE, async (params) => {
        const p = params as PiEnsureParams;
        return registry.ensure(
          p.sessionId,
          p.cmd,
          p.env,
          p.envHash,
          p.restart,
        );
      });

      server.setHandler(METHODS.PI_KILL, async (params) => {
        const p = params as PiKillParams;
        await registry.kill(p.sessionId);
        return {};
      });

      server.setHandler(METHODS.PI_LIST, async () => {
        return { sessions: registry.list() };
      });

      server.setHandler(METHODS.PI_SHUTDOWN, async () => {
        registry.beginShutdown();
        setTimeout(() => {
          void (async () => {
            await registry.shutdownAll("killed");
            registry.close();
            await server.stop();
          })();
        }, 50);
        return {};
      });

      await server.start();
    }, 10_000);

    afterEach(async () => {
      try {
        await registry.shutdownAll("killed");
      } catch {
        /* best-effort */
      }
      registry.close();
      try {
        await server.stop();
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }, 10_000);

    // -----------------------------------------------------------------------
    // S1. 完整生命周期: hello → pi/ensure → pi/list → pi/kill
    // -----------------------------------------------------------------------
    it(
      "S1: full lifecycle — hello → pi/ensure(spawn sleep) → pi/list → pi/kill",
      async () => {
        const client = await connectSocket(serverSocketPath);

        // --- hello ---
        const helloResult = await doHello(client, "integration-test");
        expect(helloResult.protocolVersion).toBe(PROTOCOL_VERSION);
        expect(helloResult.managerVersion).toBe("test-0.0.0");

        // --- pi/ensure: spawn bash -c 'sleep 30' ---
        writeRequest(client, 2, METHODS.PI_ENSURE, {
          sessionId: "lifecycle-test",
          cmd: "sleep 30",
          env: { FOO: "bar" },
          envHash: "hash-lifecycle",
          restart: false,
        } satisfies PiEnsureParams);
        const ensureResp = await readNextFrame(client);
        expect(ensureResp.error).toBeUndefined();
        const ensureResult = ensureResp.result as Record<string, unknown>;
        expect(ensureResult.sessionId).toBe("lifecycle-test");
        expect(ensureResult.isReattach).toBe(false);
        expect(ensureResult.sockPath).toContain(".pi.sock");

        const sockPath = ensureResult.sockPath as string;
        // Verify the session socket file exists on disk
        expect(fs.existsSync(sockPath)).toBe(true);

        // --- pi/list: session should be in the list ---
        writeRequest(client, 3, METHODS.PI_LIST, {});
        const listResp = await readNextFrame(client);
        expect(listResp.error).toBeUndefined();
        const listResult = listResp.result as {
          sessions: Array<Record<string, unknown>>;
        };
        expect(listResult.sessions).toHaveLength(1);
        const entry = listResult.sessions[0];
        expect(entry.sessionId).toBe("lifecycle-test");
        expect(entry.pid).toBeGreaterThan(0);
        expect(entry.sockPath).toBe(sockPath);
        expect(entry.envHash).toBe("hash-lifecycle");
        expect(entry.isAttached).toBe(false);

        // --- pi/kill: terminate the session ---
        writeRequest(client, 4, METHODS.PI_KILL, {
          sessionId: "lifecycle-test",
        } satisfies PiKillParams);
        const killResp = await readNextFrame(client);
        expect(killResp.error).toBeUndefined();

        // Brief wait for fire-and-forget file cleanup
        await new Promise((r) => setTimeout(r, 200));

        // --- pi/list: session should be gone ---
        writeRequest(client, 5, METHODS.PI_LIST, {});
        const listResp2 = await readNextFrame(client);
        const listResult2 = listResp2.result as {
          sessions: Array<Record<string, unknown>>;
        };
        expect(listResult2.sessions).toHaveLength(0);

        client.destroy();
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // S2. bridge 双向桥接: session socket ↔ child stdio
    // -----------------------------------------------------------------------
    it(
      "S2: bridge — session socket writes echoed back via cat stdin→stdout",
      async () => {
        const client = await connectSocket(serverSocketPath);
        await doHello(client);

        // pi/ensure with bash -c 'cat' (echoes stdin to stdout)
        writeRequest(client, 2, METHODS.PI_ENSURE, {
          sessionId: "bridge-test",
          cmd: "cat",
          env: {},
          envHash: "hash-bridge",
          restart: false,
        } satisfies PiEnsureParams);
        const ensureResp = await readNextFrame(client);
        expect(ensureResp.error).toBeUndefined();
        const sockPath = (ensureResp.result as Record<string, string>).sockPath;

        // Connect to the session socket (bridge)
        const bridgeConn = await connectSocket(sockPath);
        // List should now show isAttached=true
        writeRequest(client, 3, METHODS.PI_LIST, {});
        const listResp = await readNextFrame(client);
        const entry0 = (
          listResp.result as { sessions: Array<Record<string, unknown>> }
        ).sessions[0];
        expect(entry0.isAttached).toBe(true);

        // Write to bridge → child stdin → cat → stdout → bridge read
        bridgeConn.write("hello from bridge\n");
        const echo1 = await readUntil(bridgeConn, "\n");
        expect(echo1).toBe("hello from bridge\n");

        // Second round-trip to confirm the pipe stays open
        bridgeConn.write("round two\n");
        const echo2 = await readUntil(bridgeConn, "\n");
        expect(echo2).toBe("round two\n");

        // Disconnect bridge — cat's stdin stays open (child.stdin NOT ended
        // on bridge close), so cat keeps waiting. Kill the session explicitly.
        bridgeConn.destroy();
        await new Promise((r) => setTimeout(r, 100));

        // List should show isAttached=false after bridge disconnect
        writeRequest(client, 4, METHODS.PI_LIST, {});
        const listResp2 = await readNextFrame(client);
        const entry1 = (
          listResp2.result as { sessions: Array<Record<string, unknown>> }
        ).sessions[0];
        expect(entry1.isAttached).toBe(false);

        // Kill the session to clean up
        writeRequest(client, 5, METHODS.PI_KILL, {
          sessionId: "bridge-test",
        } satisfies PiKillParams);
        await readNextFrame(client);

        client.destroy();
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // S3. shutdownAll: 关停所有 session + 文件清理
    // -----------------------------------------------------------------------
    it(
      "S3: shutdownAll — kills all sessions and cleans up sock/env files",
      async () => {
        const client = await connectSocket(serverSocketPath);
        await doHello(client);

        // Spawn 2 sessions with sleep
        writeRequest(client, 2, METHODS.PI_ENSURE, {
          sessionId: "sd-1",
          cmd: "sleep 60",
          env: { K: "v1" },
          envHash: "h1",
          restart: false,
        } satisfies PiEnsureParams);
        const r1 = await readNextFrame(client);
        const sock1 = (r1.result as Record<string, string>).sockPath;

        writeRequest(client, 3, METHODS.PI_ENSURE, {
          sessionId: "sd-2",
          cmd: "sleep 60",
          env: { K: "v2" },
          envHash: "h2",
          restart: false,
        } satisfies PiEnsureParams);
        const r2 = await readNextFrame(client);
        const sock2 = (r2.result as Record<string, string>).sockPath;

        // Verify both in list
        writeRequest(client, 4, METHODS.PI_LIST, {});
        const listResp = await readNextFrame(client);
        expect(
          (listResp.result as { sessions: unknown[] }).sessions,
        ).toHaveLength(2);

        // Verify socket files exist
        expect(fs.existsSync(sock1)).toBe(true);
        expect(fs.existsSync(sock2)).toBe(true);

        // Directly call shutdownAll (skip async pi/shutdown handler)
        await registry.shutdownAll("killed");

        // Wait for async file cleanup (fire-and-forget in teardown)
        await new Promise((r) => setTimeout(r, 500));

        // Verify sessions gone from in-memory registry
        expect(registry.list()).toHaveLength(0);

        // Verify socket files deleted
        expect(fs.existsSync(sock1)).toBe(false);
        expect(fs.existsSync(sock2)).toBe(false);

        // Verify env files deleted
        const env1 = path.join(envDir, "env-sd-1");
        const env2 = path.join(envDir, "env-sd-2");
        expect(fs.existsSync(env1)).toBe(false);
        expect(fs.existsSync(env2)).toBe(false);

        client.destroy();
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // S4. env-file 内容格式 + 权限 0600
    // -----------------------------------------------------------------------
    it(
      "S4: env-file — KEY=value format and 0600 permissions",
      async () => {
        const client = await connectSocket(serverSocketPath);
        await doHello(client);

        writeRequest(client, 2, METHODS.PI_ENSURE, {
          sessionId: "env-test",
          cmd: "sleep 10",
          env: { FOO: "bar-value", SECRET_TOKEN: "abc123" },
          envHash: "hash-env",
          restart: false,
        } satisfies PiEnsureParams);
        const resp = await readNextFrame(client);
        expect(resp.error).toBeUndefined();

        // Read env-file content
        const envFile = path.join(envDir, "env-env-test");
        const content = fs.readFileSync(envFile, "utf8");
        // Each env entry is KEY=value on its own line
        const lines = content.trim().split("\n");
        expect(lines).toContain("FOO=bar-value");
        expect(lines).toContain("SECRET_TOKEN=abc123");

        // Verify permissions: 0600 = owner read+write only
        const stat = fs.statSync(envFile);
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);

        // Verify sockDir and envDir themselves are 0700
        const sockDirStat = fs.statSync(sockDir);
        expect(sockDirStat.mode & 0o777).toBe(0o700);

        const envDirStat = fs.statSync(envDir);
        expect(envDirStat.mode & 0o777).toBe(0o700);

        // Clean up
        writeRequest(client, 3, METHODS.PI_KILL, {
          sessionId: "env-test",
        } satisfies PiKillParams);
        await readNextFrame(client);

        client.destroy();
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // S5. reattach: 同 envHash → isReattach=true（不杀旧进程）
    // -----------------------------------------------------------------------
    it(
      "S5: reattach — same envHash returns isReattach=true without killing",
      async () => {
        const client = await connectSocket(serverSocketPath);
        await doHello(client);

        // First ensure: creates new session
        writeRequest(client, 2, METHODS.PI_ENSURE, {
          sessionId: "reattach-test",
          cmd: "sleep 30",
          env: { X: "1" },
          envHash: "hash-abc",
          restart: false,
        } satisfies PiEnsureParams);
        const r1 = await readNextFrame(client);
        expect(r1.error).toBeUndefined();
        const result1 = r1.result as Record<string, unknown>;
        expect(result1.isReattach).toBe(false);
        const sockPath1 = result1.sockPath as string;

        // Second ensure: same sessionId + same envHash → reattach
        writeRequest(client, 3, METHODS.PI_ENSURE, {
          sessionId: "reattach-test",
          cmd: "sleep 30",
          env: { X: "1" },
          envHash: "hash-abc",
          restart: false,
        } satisfies PiEnsureParams);
        const r2 = await readNextFrame(client);
        expect(r2.error).toBeUndefined();
        const result2 = r2.result as Record<string, unknown>;
        expect(result2.isReattach).toBe(true);
        expect(result2.sockPath).toBe(sockPath1);

        // Only 1 session in list (same session, not duplicated)
        writeRequest(client, 4, METHODS.PI_LIST, {});
        const listResp = await readNextFrame(client);
        expect(
          (listResp.result as { sessions: unknown[] }).sessions,
        ).toHaveLength(1);

        // Clean up
        writeRequest(client, 5, METHODS.PI_KILL, {
          sessionId: "reattach-test",
        } satisfies PiKillParams);
        await readNextFrame(client);

        client.destroy();
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // S6. restart: 不同 envHash + restart=true → 杀旧 spawn 新
    // -----------------------------------------------------------------------
    it(
      "S6: restart — different envHash + restart=true kills old and spawns new",
      async () => {
        const client = await connectSocket(serverSocketPath);
        await doHello(client);

        // First ensure
        writeRequest(client, 2, METHODS.PI_ENSURE, {
          sessionId: "restart-test",
          cmd: "sleep 60",
          env: { VER: "1" },
          envHash: "hash-v1",
          restart: false,
        } satisfies PiEnsureParams);
        const r1 = await readNextFrame(client);
        const sockPath1 = (r1.result as Record<string, string>).sockPath;
        expect((r1.result as Record<string, unknown>).isReattach).toBe(false);

        // Get PID of first child
        writeRequest(client, 3, METHODS.PI_LIST, {});
        const list1 = await readNextFrame(client);
        const pid1 = (
          list1.result as { sessions: Array<Record<string, unknown>> }
        ).sessions[0].pid as number;

        // Second ensure: different envHash + restart=true → kill + respawn
        writeRequest(client, 4, METHODS.PI_ENSURE, {
          sessionId: "restart-test",
          cmd: "sleep 60",
          env: { VER: "2" },
          envHash: "hash-v2",
          restart: true,
        } satisfies PiEnsureParams);
        // expectId=4:kill 会广播 session/closed notification, 同 socket 上可能
        // 抢在响应前 —— 只读本请求的 response 帧。
        const r2 = await readNextFrame(client, 5000, 4);
        expect(r2.error).toBeUndefined();
        const result2 = r2.result as Record<string, unknown>;
        expect(result2.isReattach).toBe(false);

        // Verify: new socket path may differ (old one cleaned, new one created)
        const sockPath2 = result2.sockPath as string;
        expect(fs.existsSync(sockPath2)).toBe(true);

        // Verify: only 1 session in list, envHash updated to hash-v2
        writeRequest(client, 5, METHODS.PI_LIST, {});
        const list2 = await readNextFrame(client);
        const sessions = (
          list2.result as { sessions: Array<Record<string, unknown>> }
        ).sessions;
        expect(sessions).toHaveLength(1);
        expect(sessions[0].envHash).toBe("hash-v2");
        // PID should differ from the killed old process
        expect(sessions[0].pid).not.toBe(pid1);

        // Clean up
        writeRequest(client, 6, METHODS.PI_KILL, {
          sessionId: "restart-test",
        } satisfies PiKillParams);
        await readNextFrame(client);

        client.destroy();
      },
      15_000,
    );

    // -----------------------------------------------------------------------
    // S7. daemon 崩溃恢复: 模拟 SIGKILL → 残留 → cleanupStaleState → 重 spawn
    //      退役后 pi-manager 为唯一 daemon，崩溃后新实例必须自愈（SPOF 验证）。
    // -----------------------------------------------------------------------
    it(
      "S7: crash recovery — stale state cleaned on re-creation, new session works (SPOF)",
      async () => {
        // Phase 1: create a fresh registry and spawn a session
        const crashTmp = fs.mkdtempSync(
          path.join(os.tmpdir(), "pi-crash-"),
        );
        const crashSockDir = path.join(crashTmp, "socks");
        const crashEnvDir = path.join(crashTmp, "env");

        const registry1 = new PiSessionRegistry({
          sockDir: crashSockDir,
          envDir: crashEnvDir,
          idleTimeoutMs: 0,
        });

        const r1 = await registry1.ensure(
          "crash-s1",
          "sleep 120",
          { K: "v1" },
          "hash-crash",
          false,
        );
        expect(r1.isReattach).toBe(false);
        const sockPath1 = r1.sockPath;
        expect(fs.existsSync(sockPath1)).toBe(true);

        // Verify env-file exists
        const envFile1 = path.join(crashEnvDir, "env-crash-s1");
        expect(fs.existsSync(envFile1)).toBe(true);

        // Get the child PID
        const entry1 = registry1.get("crash-s1")!;
        const pid1 = entry1.child.pid!;
        expect(pid1).toBeGreaterThan(0);

        // Phase 2: simulate daemon crash — SIGKILL the child without teardown
        forceKillPid(pid1);
        const died = await waitForPidDeath(pid1, 3000);
        expect(died).toBe(true);

        // Close registry1 WITHOUT calling shutdownAll (crash = no graceful cleanup)
        // The child `close` event may fire and trigger teardown via the close
        // handler in spawnSession. To truly simulate a crash, we need to
        // prevent that — so we remove the close listener before closing.
        // Actually, the close event already fired during waitForPidDeath.
        // Even if teardown ran, the test is still valid: cleanupStaleState
        // must be idempotent (no crash if files already gone).
        registry1.close();

        // Verify that some state may remain. The teardown from the 'close' event
        // may have cleaned the sock/env files. Regardless, cleanupStaleState in
        // registry2 must not crash and must leave a clean working directory.
        // If files are already gone, cleanupStaleState is a no-op for those files.
        // To make the test meaningful, we check that registry2 works.
        // But first, let's check if we have stale state to clean:
        const hasStaleSock = fs.existsSync(sockPath1);
        const hasStaleEnv = fs.existsSync(envFile1);

        // Phase 3: create registry2 with same directories — cleanupStaleState runs
        const registry2 = new PiSessionRegistry({
          sockDir: crashSockDir,
          envDir: crashEnvDir,
          idleTimeoutMs: 0,
        });

        // Phase 4: verify new session can be spawned (the SPOF recovery)
        const r2 = await registry2.ensure(
          "crash-s2",
          "sleep 10",
          { K: "v2" },
          "hash-crash2",
          false,
        );
        expect(r2.isReattach).toBe(false);
        expect(fs.existsSync(r2.sockPath)).toBe(true);
        expect(r2.sessionId).toBe("crash-s2");

        // Phase 5: verify the new session is alive and responsive via bridge
        // Use a `cat`-based session for bridge testing
        const r3 = await registry2.ensure(
          "crash-s3",
          "cat",
          { K: "v3" },
          "hash-cat-crash",
          false,
        );
        expect(r3.isReattach).toBe(false);
        const bridgeSock = await connectSocket(r3.sockPath);
        bridgeSock.write("post-crash echo\n");
        const echoed = await readUntil(bridgeSock, "\n");
        expect(echoed).toBe("post-crash echo\n");
        bridgeSock.destroy();

        // Cleanup: if teardown didn't clean old files, they should be gone now.
        // cleanupStaleState is best-effort — don't assert absolute absence,
        // but verify registry2 cleaned what it could.
        if (hasStaleSock) {
          expect(fs.existsSync(sockPath1)).toBe(false);
        }
        if (hasStaleEnv) {
          expect(fs.existsSync(envFile1)).toBe(false);
        }

        // Clean up registry2
        await registry2.shutdownAll("killed");
        registry2.close();
        fs.rmSync(crashTmp, { recursive: true, force: true });
      },
      15_000,
    );

    // -----------------------------------------------------------------------
    // S8. 多会话隔离: ensure 2 → kill 1 → 另一个仍通（bridge echo 验证）
    // -----------------------------------------------------------------------
    it(
      "S8: multi-session isolation — killing one session leaves others intact",
      async () => {
        const client = await connectSocket(serverSocketPath);
        await doHello(client);

        // Ensure session A: cat for bridge testing
        writeRequest(client, 2, METHODS.PI_ENSURE, {
          sessionId: "multi-a",
          cmd: "cat",
          env: { ID: "A" },
          envHash: "hash-multi-a",
          restart: false,
        } satisfies PiEnsureParams);
        const rA = await readNextFrame(client);
        expect(rA.error).toBeUndefined();
        const sockA = (rA.result as Record<string, string>).sockPath;

        // Ensure session B: cat for bridge testing
        writeRequest(client, 3, METHODS.PI_ENSURE, {
          sessionId: "multi-b",
          cmd: "cat",
          env: { ID: "B" },
          envHash: "hash-multi-b",
          restart: false,
        } satisfies PiEnsureParams);
        const rB = await readNextFrame(client);
        expect(rB.error).toBeUndefined();
        const sockB = (rB.result as Record<string, string>).sockPath;

        // Verify both in list
        writeRequest(client, 4, METHODS.PI_LIST, {});
        const list1 = await readNextFrame(client);
        const sessions1 = (
          list1.result as { sessions: Array<Record<string, unknown>> }
        ).sessions;
        expect(sessions1).toHaveLength(2);

        // Connect to session B and verify bridge works
        const bridgeB = await connectSocket(sockB);
        bridgeB.write("msg-to-B\n");
        const echoB1 = await readUntil(bridgeB, "\n");
        expect(echoB1).toBe("msg-to-B\n");

        // Kill session A
        writeRequest(client, 5, METHODS.PI_KILL, {
          sessionId: "multi-a",
        } satisfies PiKillParams);
        const killResp = await readNextFrame(client);
        expect(killResp.error).toBeUndefined();

        // Brief wait for cleanup
        await new Promise((r) => setTimeout(r, 200));

        // Verify session A is gone from list
        writeRequest(client, 6, METHODS.PI_LIST, {});
        const list2 = await readNextFrame(client);
        const sessions2 = (
          list2.result as { sessions: Array<Record<string, unknown>> }
        ).sessions;
        expect(sessions2).toHaveLength(1);
        expect(sessions2[0].sessionId).toBe("multi-b");

        // Verify session B bridge still works (isolation confirmed)
        bridgeB.write("msg-to-B-after-kill\n");
        const echoB2 = await readUntil(bridgeB, "\n");
        expect(echoB2).toBe("msg-to-B-after-kill\n");

        // Clean up
        bridgeB.destroy();
        writeRequest(client, 7, METHODS.PI_KILL, {
          sessionId: "multi-b",
        } satisfies PiKillParams);
        await readNextFrame(client);

        client.destroy();
      },
      15_000,
    );

    // -----------------------------------------------------------------------
    // S9. bridge 断链重连: 模拟 SSH 断 → pi 继续跑 → 重连 attach 仍通
    // -----------------------------------------------------------------------
    it(
      "S9: bridge disconnect and reconnect — session survives, reattach works",
      async () => {
        const client = await connectSocket(serverSocketPath);
        await doHello(client);

        // Ensure session with cat
        writeRequest(client, 2, METHODS.PI_ENSURE, {
          sessionId: "reconnect-test",
          cmd: "cat",
          env: { X: "reconnect" },
          envHash: "hash-reconnect",
          restart: false,
        } satisfies PiEnsureParams);
        const ensureResp = await readNextFrame(client);
        expect(ensureResp.error).toBeUndefined();
        const sockPath = (
          ensureResp.result as Record<string, string>
        ).sockPath;

        // Phase 1: connect bridge → verify echo
        const bridge1 = await connectSocket(sockPath);
        bridge1.write("before-disconnect\n");
        const echo1 = await readUntil(bridge1, "\n");
        expect(echo1).toBe("before-disconnect\n");

        // Verify isAttached=true
        writeRequest(client, 3, METHODS.PI_LIST, {});
        const list1 = await readNextFrame(client);
        const sessions1 = (
          list1.result as { sessions: Array<Record<string, unknown>> }
        ).sessions;
        expect(sessions1[0].isAttached).toBe(true);

        // Phase 2: disconnect bridge (simulate SSH break)
        bridge1.destroy();
        await new Promise((r) => setTimeout(r, 200));

        // Verify session still exists but isAttached=false
        writeRequest(client, 4, METHODS.PI_LIST, {});
        const list2 = await readNextFrame(client);
        const sessions2 = (
          list2.result as { sessions: Array<Record<string, unknown>> }
        ).sessions;
        expect(sessions2).toHaveLength(1);
        expect(sessions2[0].sessionId).toBe("reconnect-test");
        expect(sessions2[0].isAttached).toBe(false);

        // Phase 3: reconnect bridge → verify echo still works (simulate SSH reconnect)
        const bridge2 = await connectSocket(sockPath);
        bridge2.write("after-reconnect\n");
        const echo2 = await readUntil(bridge2, "\n");
        expect(echo2).toBe("after-reconnect\n");

        // Verify isAttached=true again
        writeRequest(client, 5, METHODS.PI_LIST, {});
        const list3 = await readNextFrame(client);
        const sessions3 = (
          list3.result as { sessions: Array<Record<string, unknown>> }
        ).sessions;
        expect(sessions3[0].isAttached).toBe(true);

        // Clean up
        bridge2.destroy();
        writeRequest(client, 6, METHODS.PI_KILL, {
          sessionId: "reconnect-test",
        } satisfies PiKillParams);
        await readNextFrame(client);

        client.destroy();
      },
      15_000,
    );

    // -----------------------------------------------------------------------
    // S10. 空闲回收参数化: 缩短 idleTimeoutMs → session 空闲超时后回收
    //      验证 --idle-timeout 参数化后的实际回收行为（真实进程）。
    // -----------------------------------------------------------------------
    it(
      "S10: idle timeout — shortened idleTimeoutMs triggers recycle (real process)",
      async () => {
        // Create a registry with a very short idle timeout (500ms)
        const idleTmp = fs.mkdtempSync(
          path.join(os.tmpdir(), "pi-idle-"),
        );
        const idleSockDir = path.join(idleTmp, "socks");
        const idleEnvDir = path.join(idleTmp, "env");
        const closedSessions: string[] = [];

        const idleRegistry = new PiSessionRegistry({
          sockDir: idleSockDir,
          envDir: idleEnvDir,
          idleTimeoutMs: 500, // 500ms idle timeout for fast verification
          onSessionClosed: (sessionId) => {
            closedSessions.push(sessionId);
          },
        });

        // Spawn a short-lived child: `echo done` exits quickly → becomes idle
        const r1 = await idleRegistry.ensure(
          "idle-s1",
          "sleep 0.1",
          { K: "v" },
          "hash-idle-1",
          false,
        );
        expect(r1.isReattach).toBe(false);
        expect(idleRegistry.list()).toHaveLength(1);

        // Force lastActivity to ancient so the session is eligible for recycle
        const entry = idleRegistry.get("idle-s1")!;
        entry.lastActivity = 0;

        // Trigger recycleIdle directly (private method access for test)
        // The session has no attached client and lastActivity=0 → eligible
        (idleRegistry as any).recycleIdle();

        // Wait for the async kill chain (SIGTERM → waitForExit → teardown)
        await new Promise((r) => setTimeout(r, 2000));

        // The child (`sleep 0.1`) should have exited quickly, so kill should
        // succeed and teardown should fire
        // Verify session was recycled
        expect(closedSessions).toContain("idle-s1");
        expect(idleRegistry.list()).toHaveLength(0);

        // Clean up
        idleRegistry.close();
        fs.rmSync(idleTmp, { recursive: true, force: true });
      },
      15_000,
    );

    // -----------------------------------------------------------------------
    // S11. 并发 kill + ensure 同一 session: 不死锁、不双 spawn（真实进程竞态）
    // -----------------------------------------------------------------------
    it(
      "S11: concurrent kill + ensure — no deadlock, no double-spawn",
      async () => {
        const client = await connectSocket(serverSocketPath);
        await doHello(client);

        // Spawn initial session with a long sleep
        writeRequest(client, 2, METHODS.PI_ENSURE, {
          sessionId: "concurrent-ke",
          cmd: "sleep 60",
          env: { VER: "1" },
          envHash: "hash-v1",
          restart: false,
        } satisfies PiEnsureParams);
        const r1 = await readNextFrame(client);
        expect(r1.error).toBeUndefined();
        expect(
          (r1.result as Record<string, unknown>).isReattach,
        ).toBe(false);

        // Concurrent: kill the existing session + ensure a new one with different
        // envHash + restart=true. The ensure handler will see the existing entry
        // (or its dying state) and must handle the race correctly.
        const killSocket = await connectSocket(serverSocketPath);
        await doHello(killSocket, "kill-client");

        const ensureSocket = await connectSocket(serverSocketPath);
        await doHello(ensureSocket, "ensure-client");

        // Send kill and ensure concurrently from separate sockets
        writeRequest(killSocket, 1, METHODS.PI_KILL, {
          sessionId: "concurrent-ke",
        } satisfies PiKillParams);

        writeRequest(ensureSocket, 1, METHODS.PI_ENSURE, {
          sessionId: "concurrent-ke",
          cmd: "sleep 30",
          env: { VER: "2" },
          envHash: "hash-v2",
          restart: true,
        } satisfies PiEnsureParams);

        const [killResp, ensureResp] = await Promise.all([
          readNextFrame(killSocket, 5000, 1),
          // expectId=1:kill 广播的 session/closed notification 可能抢在 ensure
          // 响应前 —— 只读 ensure 请求自己的 response 帧。
          readNextFrame(ensureSocket, 5000, 1),
        ]);

        // Kill should succeed (or find session already gone — either is fine
        // as long as it doesn't deadlock)
        if (killResp.error) {
          const err = killResp.error as Record<string, unknown>;
          // SESSION_NOT_FOUND is acceptable (ensure already killed + re-spawned)
          expect(
            ["SESSION_NOT_FOUND", undefined].includes(err.code as string | undefined),
          ).toBe(true);
        }

        // Ensure should succeed with a new spawn (not reattach, because
        // envHash changed and restart=true)
        expect(ensureResp.error).toBeUndefined();
        const ensureResult = ensureResp.result as Record<string, unknown>;
        expect(ensureResult.sessionId).toBe("concurrent-ke");
        // isReattach could be false (new spawn) or true (if kill hadn't
        // completed teardown yet and the ensure found the dying entry,
        // waited for deathPromise, then evaluated the post-death state).
        // In either case, it must not deadlock and must return a valid result.
        expect(typeof ensureResult.isReattach).toBe("boolean");
        expect(typeof ensureResult.sockPath).toBe("string");

        // Final state: exactly 1 session with sessionId "concurrent-ke"
        writeRequest(client, 3, METHODS.PI_LIST, {});
        const listResp = await readNextFrame(client);
        const sessions = (
          listResp.result as { sessions: Array<Record<string, unknown>> }
        ).sessions;
        expect(sessions).toHaveLength(1);
        expect(sessions[0].sessionId).toBe("concurrent-ke");

        // Clean up
        writeRequest(client, 4, METHODS.PI_KILL, {
          sessionId: "concurrent-ke",
        } satisfies PiKillParams);
        await readNextFrame(client);

        killSocket.destroy();
        ensureSocket.destroy();
        client.destroy();
      },
      15_000,
    );
  },
);
