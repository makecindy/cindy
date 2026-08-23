/**
 * ManagerServer test suite — covers hello, guards, error mapping, notifyAll,
 * sendRequest (server→client), and disconnect cleanup.
 *
 * Uses real IPC (unix socket / Windows named pipe) via net.connect.
 * Cross-platform — named pipe on Windows, unix socket elsewhere.
 */

import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ManagerServer, makeServerError } from '../server.js';
import { PROTOCOL_VERSION } from '../protocol.js';
import { encodeMessage } from '../codec.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIpcPath(): string {
  const uniq = `pi-mgr-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${uniq}`;
  }
  return path.join(os.tmpdir(), `${uniq}.sock`);
}

function silentLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/**
 * Read the next complete NDJSON frame from a socket.
 * Rejects on timeout, socket close, or socket error.
 */
// 模块级 per-socket 帧缓冲:一个 chunk 可能含多帧(CI 慢时帧合并), readNextFrame
// resolve 后若丢弃 buf 剩余帧, 下一次调用永远读不到它们(轮 40-w4 SERVER_BUSY
// 测试踩过的坑, makeFrameReader 注释)。跨调用保留剩余帧, 保持 readNextFrame
// 的一次取一帧形态。
const socketFrameBuffers = new Map<net.Socket, string>();

function readNextFrame(socket: net.Socket, timeoutMs = 15000, skipId?: number): Promise<any> {
  return new Promise((resolve, reject) => {
    // 先消费上次调用残留的帧(若有)。
    let buf = socketFrameBuffers.get(socket) ?? '';
    socketFrameBuffers.delete(socket);

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`readNextFrame timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function onData(chunk: Buffer) {
      buf += chunk.toString('utf8');
      drain();
    }

    /** 从 buf 取一帧;取完但 buf 仍有剩余帧 → 存回共享缓冲(不丢)。 */
    function drain(): void {
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      // skipId 指定时跳过该 id 的 response 帧 —— reverse-request 测试里
      // id=2 的请求响应可能抢在 server→client 的 reverse request 前到达
      // (真 socket 时序, Linux 慢 runner 尤甚)。只读下一帧。
      if (skipId !== undefined && frame.type === 'response' && frame.id === skipId) {
        drain();
        return;
      }
      if (buf.trim().length > 0) socketFrameBuffers.set(socket, buf);
      cleanup();
      resolve(frame);
    }

    function onClose() {
      cleanup();
      reject(new Error('socket closed before frame received'));
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
    }

    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
    // 上次残留帧直接消费(无需等新 data)。
    drain();
  });
}

/** Write an RPC request frame (NDJSON line). */
function writeRequest(socket: net.Socket, id: number, method: string, params: unknown = {}): void {
  socket.write(encodeMessage({ type: 'request', id, method, params }));
}

/** Connect a raw socket and wait for the connection to be established. */
async function connectRaw(socketPath: string): Promise<net.Socket> {
  const socket = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

/** Perform hello handshake on a raw socket. Returns the hello result payload. */
async function doHello(socket: net.Socket, clientId?: string): Promise<any> {
  const params: any = { protocolVersion: PROTOCOL_VERSION };
  if (clientId) params.clientId = clientId;
  writeRequest(socket, 1, 'protocol/hello', params);
  const resp = await readNextFrame(socket);
  if (resp.error) throw new Error(`hello failed: ${resp.error.code}: ${resp.error.message}`);
  return resp.result;
}

/**
 * 常驻帧队列读取器:持续累积 data, 按 \n 切帧。与 readNextFrame 的区别是
 * 不丢合并帧 —— readNextFrame 每次临时注册 onData, 若一个 chunk 含多帧只取
 * 第一帧、其余静默丢弃(轮 40-w4 SERVER_BUSY 测试踩坑:release 后 32 帧合并
 * 进同一 chunk, 循环 readNextFrame 只收到第一帧, 其余帧永不触发 data 事件)。
 * 返回按序取帧的 async 函数。
 */
function makeFrameReader(socket: net.Socket): () => Promise<any> {
  let buf = '';
  // 已解析待消费的帧(一个 chunk 可含多帧, 消费方逐个取)。
  const frames: unknown[] = [];
  const waiters: Array<{
    resolve: (frame: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    while (true) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      const w = waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(JSON.parse(line));
      } else {
        // 帧多于消费方:缓存, 等下一个 nextFrame() 直接取(不丢帧)。
        frames.push(JSON.parse(line));
      }
    }
  });
  return () => {
    const queued = frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('frame timeout')), 5000);
      waiters.push({ resolve, reject, timer });
    });
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ManagerServer', () => {
  let server: ManagerServer;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = makeIpcPath();
    server = new ManagerServer({
      socketPath,
      managerVersion: 'test-0.0.0',
      logger: silentLogger(),
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  // -----------------------------------------------------------------------
  // 1. hello handshake
  // -----------------------------------------------------------------------
  describe('hello handshake', () => {
    it('accepts correct protocolVersion and returns server info', async () => {
      const socket = await connectRaw(socketPath);
      const result = await doHello(socket, 'test-client-1');
      expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(result.managerVersion).toBe('test-0.0.0');
      socket.destroy();
    });

    it('accepts hello without clientId', async () => {
      const socket = await connectRaw(socketPath);
      const result = await doHello(socket);
      expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
      socket.destroy();
    });

    it('rejects mismatched protocolVersion with INVALID_PROTOCOL_VERSION', async () => {
      const socket = await connectRaw(socketPath);
      writeRequest(socket, 1, 'protocol/hello', { protocolVersion: 999 });
      const resp = await readNextFrame(socket);
      expect(resp.type).toBe('response');
      expect(resp.id).toBe(1);
      expect(resp.error).toBeDefined();
      expect(resp.error.code).toBe('INVALID_PROTOCOL_VERSION');
      expect(resp.error.message).toContain('999');
      socket.destroy();
    });

    it('rejects missing protocolVersion with INVALID_PARAMS', async () => {
      const socket = await connectRaw(socketPath);
      writeRequest(socket, 2, 'protocol/hello', {});
      const resp = await readNextFrame(socket);
      expect(resp.error).toBeDefined();
      expect(resp.error.code).toBe('INVALID_PARAMS');
      expect(resp.error.message).toContain('protocolVersion');
      socket.destroy();
    });

    it('rejects non-number protocolVersion with INVALID_PARAMS', async () => {
      const socket = await connectRaw(socketPath);
      writeRequest(socket, 3, 'protocol/hello', { protocolVersion: 'v1' });
      const resp = await readNextFrame(socket);
      expect(resp.error).toBeDefined();
      expect(resp.error.code).toBe('INVALID_PARAMS');
      socket.destroy();
    });

    it('allows client to proceed with requests after successful hello', async () => {
      server.setHandler('test/ping', async () => 'pong');
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'test/ping', {});
      const resp = await readNextFrame(socket);
      expect(resp.result).toBe('pong');
      socket.destroy();
    });

    it('records clientId from hello params (verified by log independence)', async () => {
      server.setHandler('test/who', async (_params, ctx) => `You are ${ctx.clientId ?? 'unknown'}`);
      const socketA = await connectRaw(socketPath);
      const socketB = await connectRaw(socketPath);
      await doHello(socketA, 'client-A');
      await doHello(socketB, 'client-B');

      writeRequest(socketA, 2, 'test/who', {});
      writeRequest(socketB, 2, 'test/who', {});
      const [respA, respB] = await Promise.all([readNextFrame(socketA), readNextFrame(socketB)]);
      expect(respA.result).toBe('You are client-A');
      expect(respB.result).toBe('You are client-B');

      socketA.destroy();
      socketB.destroy();
    });

    it('rejects duplicate hello with INVALID_PARAMS (round 2 M-1)', async () => {
      const socket = await connectRaw(socketPath);
      await doHello(socket, 'first');
      writeRequest(socket, 5, 'protocol/hello', { protocolVersion: PROTOCOL_VERSION, clientId: 'second' });
      const resp = await readNextFrame(socket);
      expect(resp.error).toBeDefined();
      expect(resp.error.code).toBe('INVALID_PARAMS');
      expect(resp.error.message).toContain('already completed');
      // 后续请求仍可用, clientId 未被覆盖(协议其余部分不受影响)。
      server.setHandler('test/who2', async (_params, ctx) => `You are ${ctx.clientId ?? 'unknown'}`);
      writeRequest(socket, 6, 'test/who2', {});
      const resp2 = await readNextFrame(socket);
      expect(resp2.result).toBe('You are first');
      socket.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 2. NOT_INITIALIZED guard
  // -----------------------------------------------------------------------
  describe('NOT_INITIALIZED guard', () => {
    it('rejects pi/list before hello with NOT_INITIALIZED', async () => {
      const socket = await connectRaw(socketPath);
      writeRequest(socket, 1, 'pi/list', {});
      const resp = await readNextFrame(socket);
      expect(resp.error).toBeDefined();
      expect(resp.error.code).toBe('NOT_INITIALIZED');
      expect(resp.error.message).toContain('protocol/hello');
      socket.destroy();
    });

    it('rejects any non-hello method before initialization', async () => {
      const socket = await connectRaw(socketPath);
      writeRequest(socket, 1, 'pi/ensure', { sessionId: 'x' });
      const resp = await readNextFrame(socket);
      expect(resp.error.code).toBe('NOT_INITIALIZED');
      socket.destroy();
    });

    it('allows hello before initialization (no NOT_INITIALIZED for hello itself)', async () => {
      const socket = await connectRaw(socketPath);
      const result = await doHello(socket);
      expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
      socket.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 3. UNKNOWN_METHOD
  // -----------------------------------------------------------------------
  describe('UNKNOWN_METHOD', () => {
    it('returns UNKNOWN_METHOD for unregistered method after hello', async () => {
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'totally/made-up', {});
      const resp = await readNextFrame(socket);
      expect(resp.error).toBeDefined();
      expect(resp.error.code).toBe('UNKNOWN_METHOD');
      expect(resp.error.message).toContain('totally/made-up');
      socket.destroy();
    });

    it('returns UNKNOWN_METHOD even for plausible-but-unregistered methods', async () => {
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 3, 'protocol/version', {});
      const resp = await readNextFrame(socket);
      expect(resp.error.code).toBe('UNKNOWN_METHOD');
      socket.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 4. negative id rejection
  // -----------------------------------------------------------------------
  describe('negative id rejection', () => {
    it('rejects requests with negative id (after hello) with INVALID_PARAMS', async () => {
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      // Send a negative-ID request after initialization
      writeRequest(socket, -1, 'pi/list', {});
      const resp = await readNextFrame(socket);
      expect(resp.error).toBeDefined();
      expect(resp.error.code).toBe('INVALID_PARAMS');
      expect(resp.error.message).toContain('non-negative');
      socket.destroy();
    });

    it('rejects negative-ID hello before NOT_INITIALIZED or hello handler',
      async () => {
        // Even protocol/hello with negative ID should be rejected for the
        // negative ID — NOT processed by the hello handler or NOT_INITIALIZED.
        const socket = await connectRaw(socketPath);
        writeRequest(socket, -2, 'protocol/hello', {
          protocolVersion: PROTOCOL_VERSION,
        });
        const resp = await readNextFrame(socket);
        expect(resp.error.code).toBe('INVALID_PARAMS');
        expect(resp.error.message).toContain('non-negative');
        socket.destroy();
      });

    it('negative id check fires before NOT_INITIALIZED for non-hello methods',
      async () => {
        // A non-hello method with negative ID must get INVALID_PARAMS,
        // not NOT_INITIALIZED.
        const socket = await connectRaw(socketPath);
        writeRequest(socket, -3, 'pi/list', {});
        const resp = await readNextFrame(socket);
        expect(resp.error.code).toBe('INVALID_PARAMS');
        expect(resp.error.message).toContain('non-negative');
        socket.destroy();
      });

    it('accepts id=0 as valid (non-negative)', async () => {
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      server.setHandler('test/echo', async (params) => params);
      writeRequest(socket, 0, 'test/echo', { ok: true });
      const resp = await readNextFrame(socket);
      expect(resp.type).toBe('response');
      expect(resp.id).toBe(0);
      expect(resp.result).toEqual({ ok: true });
      socket.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 5. error code mapping
  // -----------------------------------------------------------------------
  describe('error code mapping', () => {
    it('passes through known error codes from handler throws', async () => {
      server.setHandler('test/known-error', async () => {
        throw makeServerError('INVALID_PARAMS', 'bad params', { field: 'x' });
      });
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'test/known-error', {});
      const resp = await readNextFrame(socket);
      expect(resp.error.code).toBe('INVALID_PARAMS');
      expect(resp.error.message).toBe('bad params');
      expect(resp.error.data).toEqual({ field: 'x' });
      socket.destroy();
    });

    it('maps unknown error codes to INTERNAL', async () => {
      server.setHandler('test/unknown-code', async () => {
        const err = new Error('something went wrong') as Error & { code: string };
        err.code = 'WEIRD_CUSTOM_CODE';
        throw err;
      });
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'test/unknown-code', {});
      const resp = await readNextFrame(socket);
      expect(resp.error.code).toBe('INTERNAL');
      expect(resp.error.message).toBe('something went wrong');
      socket.destroy();
    });

    it('maps throws without code property to INTERNAL', async () => {
      server.setHandler('test/no-code', async () => {
        throw new Error('plain error');
      });
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'test/no-code', {});
      const resp = await readNextFrame(socket);
      expect(resp.error.code).toBe('INTERNAL');
      expect(resp.error.message).toBe('plain error');
      socket.destroy();
    });

    it('maps non-Error throws to INTERNAL with fallback message', async () => {
      server.setHandler('test/throw-string', async () => {
        throw 'just a string';
      });
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'test/throw-string', {});
      const resp = await readNextFrame(socket);
      expect(resp.error.code).toBe('INTERNAL');
      expect(resp.error.message).toBe('internal error');
      socket.destroy();
    });

    it('maps null-throws to INTERNAL with fallback message', async () => {
      server.setHandler('test/throw-null', async () => {
        throw null;
      });
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'test/throw-null', {});
      const resp = await readNextFrame(socket);
      expect(resp.error.code).toBe('INTERNAL');
      expect(resp.error.message).toBe('internal error');
      socket.destroy();
    });

    it('maps SESSION_NOT_FOUND from handler', async () => {
      server.setHandler('test/session-not-found', async () => {
        throw makeServerError('SESSION_NOT_FOUND', 'no such session', {
          sessionId: 'abc',
        });
      });
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'test/session-not-found', {});
      const resp = await readNextFrame(socket);
      expect(resp.error.code).toBe('SESSION_NOT_FOUND');
      expect(resp.error.data).toEqual({ sessionId: 'abc' });
      socket.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 6. notifyAll
  // -----------------------------------------------------------------------
  describe('notifyAll', () => {
    it('delivers notification to all connected clients', async () => {
      const socket1 = await connectRaw(socketPath);
      const socket2 = await connectRaw(socketPath);
      await doHello(socket1, 'c1');
      await doHello(socket2, 'c2');

      const msg1Promise = readNextFrame(socket1);
      const msg2Promise = readNextFrame(socket2);

      server.notifyAll({
        type: 'notification',
        method: 'session/closed',
        params: { sessionId: 's1', reason: 'killed', detail: 'test' },
      });

      const [msg1, msg2] = await Promise.all([msg1Promise, msg2Promise]);

      expect(msg1.type).toBe('notification');
      expect(msg1.method).toBe('session/closed');
      expect(msg1.params.sessionId).toBe('s1');
      expect(msg1.params.reason).toBe('killed');

      expect(msg2.type).toBe('notification');
      expect(msg2.method).toBe('session/closed');
      expect(msg2.params.sessionId).toBe('s1');

      socket1.destroy();
      socket2.destroy();
    });

    it('notifyAll delivers to each independently (one slow does not block)', async () => {
      const socket1 = await connectRaw(socketPath);
      const socket2 = await connectRaw(socketPath);
      await doHello(socket1);
      await doHello(socket2);

      const msg1Promise = readNextFrame(socket1);
      const msg2Promise = readNextFrame(socket2);

      server.notifyAll({
        type: 'notification',
        method: 'test/broadcast',
        params: { seq: 1 },
      });

      const [msg1, msg2] = await Promise.all([msg1Promise, msg2Promise]);
      expect(msg1.params.seq).toBe(1);
      expect(msg2.params.seq).toBe(1);

      socket1.destroy();
      socket2.destroy();
    });

    it('skips destroyed sockets in notifyAll', async () => {
      const socket1 = await connectRaw(socketPath);
      const socket2 = await connectRaw(socketPath);
      await doHello(socket1);
      await doHello(socket2);

      socket2.destroy();
      await new Promise((r) => setTimeout(r, 100));

      const msg1Promise = readNextFrame(socket1);

      server.notifyAll({
        type: 'notification',
        method: 'test/broadcast',
        params: { seq: 2 },
      });

      const msg1 = await msg1Promise;
      expect(msg1.params.seq).toBe(2);

      socket1.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 7. sendRequest (server→client)
  // -----------------------------------------------------------------------
  describe('sendRequest (server to client)', () => {
    it('resolves with client response when client replies', async () => {
      server.setHandler('test/trigger-reverse', async (_params, ctx) => {
        const result = await server.sendRequest(
          ctx,
          'client/ping',
          { foo: 'bar' },
          { timeoutMs: 5000 },
        );
        return { echoed: result };
      });

      const socket = await connectRaw(socketPath);
      await doHello(socket);

      writeRequest(socket, 2, 'test/trigger-reverse', {});

      // Read the server→client reverse request
      const reverseReq = await readNextFrame(socket, 15000, 2);
      expect(reverseReq.type).toBe('request');
      expect(reverseReq.method).toBe('client/ping');
      expect(reverseReq.params).toEqual({ foo: 'bar' });
      expect(reverseReq.id).toBeLessThan(0);

      // Client responds to the reverse request
      socket.write(
        encodeMessage({
          type: 'response',
          id: reverseReq.id,
          result: { pong: true },
        }),
      );

      // Read the final response to our original request
      const finalResp = await readNextFrame(socket);
      expect(finalResp.type).toBe('response');
      expect(finalResp.id).toBe(2);
      expect(finalResp.result).toEqual({ echoed: { pong: true } });

      socket.destroy();
    });

    it('uses decrementing negative IDs for consecutive sendRequest calls', async () => {
      // Test that server uses id=-1, id=-2, etc. for reverse requests.
      // We test one reverse request at a time to avoid race conditions.
      const ids: number[] = [];

      server.setHandler('test/one-reverse', async (_params, ctx) => {
        const result = await server.sendRequest(
          ctx,
          'client/ping',
          {},
          { timeoutMs: 5000 },
        );
        ids.push((result as any).serverId);
        return { ok: true };
      });

      // First connection: first reverse request should use id=-1
      const socket1 = await connectRaw(socketPath);
      await doHello(socket1);
      writeRequest(socket1, 2, 'test/one-reverse', {});
      const rev1 = await readNextFrame(socket1, 15000, 2);
      expect(rev1.id).toBe(-1);
      socket1.write(
        encodeMessage({
          type: 'response',
          id: rev1.id,
          result: { serverId: rev1.id },
        }),
      );
      const final1 = await readNextFrame(socket1);
      expect(final1.result.ok).toBe(true);
      socket1.destroy();

      // Second connection: still from same server, so id should continue decrementing
      const socket2 = await connectRaw(socketPath);
      await doHello(socket2);
      writeRequest(socket2, 2, 'test/one-reverse', {});
      const rev2 = await readNextFrame(socket2, 15000, 2);
      expect(rev2.id).toBe(-2);
      socket2.write(
        encodeMessage({
          type: 'response',
          id: rev2.id,
          result: { serverId: rev2.id },
        }),
      );
      const final2 = await readNextFrame(socket2);
      expect(final2.result.ok).toBe(true);
      socket2.destroy();
    });

    it('rejects on timeout when client does not respond', async () => {
      server.setHandler('test/trigger-timeout', async (_params, ctx) => {
        try {
          await server.sendRequest(ctx, 'client/slow', {}, { timeoutMs: 200 });
          return { ok: false };
        } catch (err) {
          return { error: (err as Error).message };
        }
      });

      const socket = await connectRaw(socketPath);
      await doHello(socket);

      writeRequest(socket, 2, 'test/trigger-timeout', {});

      // Read the reverse request from server
      const reverseReq = await readNextFrame(socket, 15000, 2);
      expect(reverseReq.type).toBe('request');
      expect(reverseReq.method).toBe('client/slow');

      // Do NOT respond — wait for timeout

      // Read the handler's response (it caught the timeout error)
      const finalResp = await readNextFrame(socket);
      expect(finalResp.result.error).toContain('timed out');
      expect(finalResp.result.error).toContain('client/slow');

      socket.destroy();
    });

    it('ignores cross-connection response injection (round 2 H-1)', async () => {
      // 攻击:连接 B 猜负 id 向 pendingServerRequests 注入伪造响应。
      // 修复后:handleServerRequestResponse 校验 entry.ctx === ctx, B 的注入
      // 被忽略, A 的 handler 正常收到 A 自己的响应。
      server.setHandler('test/trigger-inject', async (_params, ctx) => {
        const result = await server.sendRequest(
          ctx,
          'client/ping',
          {},
          { timeoutMs: 2000 },
        );
        return { echoed: result };
      });

      const socketA = await connectRaw(socketPath);
      const socketB = await connectRaw(socketPath);
      await doHello(socketA);
      await doHello(socketB);

      writeRequest(socketA, 2, 'test/trigger-inject', {});

      // A 收到反向请求(负 id)
      const reverseReq = await readNextFrame(socketA);
      expect(reverseReq.type).toBe('request');
      expect(reverseReq.id).toBeLessThan(0);

      // B 尝试注入伪造响应(同 id)
      socketB.write(
        encodeMessage({
          type: 'response',
          id: reverseReq.id,
          result: { injected: true },
        }),
      );

      // A 的 handler 仍挂起 —— 注入被忽略。A 自己响应。
      socketA.write(
        encodeMessage({
          type: 'response',
          id: reverseReq.id,
          result: { real: true },
        }),
      );

      const finalResp = await readNextFrame(socketA);
      expect(finalResp.result).toEqual({ echoed: { real: true } });

      socketA.destroy();
      socketB.destroy();
    });

    it('rejects immediately when socket is already destroyed', async () => {
      let capturedError: string | null = null;
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });

      server.setHandler('test/destroy-then-send', async (_params, ctx) => {
        ctx.socket.destroy();
        try {
          await server.sendRequest(ctx, 'client/ping', {}, { timeoutMs: 1000 });
        } catch (err) {
          capturedError = (err as Error).message;
          resolveDone();
          throw err;
        }
      });

      const socket = await connectRaw(socketPath);
      await doHello(socket);

      writeRequest(socket, 2, 'test/destroy-then-send', {});

      await done;
      expect(capturedError).toContain('destroyed');

      socket.destroy();
    });

    it('rejects immediately on cyclic params (serialization failure) without leaking pending (round 18-U3 HIGH)', async () => {
      // sendRequest 在 JSON.stringify(循环引用)抛错时, 必须删除 pendingServerRequests
      // 并清 timer —— 否则 handler 挂到超时 / pending 泄漏(server.ts:210-217)。
      let capturedError: string | null = null;
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });

      server.setHandler('test/cyclic-send', async (_params, ctx) => {
        const cyclic: Record<string, unknown> = { self: null };
        cyclic.self = cyclic;
        try {
          await server.sendRequest(ctx, 'client/cyclic', { payload: cyclic }, { timeoutMs: 50 });
          resolveDone();
        } catch (err) {
          capturedError = (err as Error).message;
          resolveDone();
          throw err;
        }
      });

      const socket = await connectRaw(socketPath);
      await doHello(socket);

      writeRequest(socket, 2, 'test/cyclic-send', {});

      await done;
      expect(capturedError).toContain('serialization failed');

      // handler 抛错 → 服务器回 id=2 的 error 响应(先读掉)。
      const errResp = await readNextFrame(socket);
      expect(errResp.id).toBe(2);
      expect(errResp.error).toBeDefined();

      // pending 已清理 → 后续同连接请求仍可正常响应(不会超时/卡死)。
      server.setHandler('test/ping-after-cyclic', async () => ({ ok: true }));
      writeRequest(socket, 3, 'test/ping-after-cyclic', {});
      const resp = await readNextFrame(socket);
      expect(resp.id).toBe(3);
      expect(resp.result).toEqual({ ok: true });

      socket.destroy();
    });

    it('sends reverse request and allows no-timeout (timeoutMs=0)', async () => {
      // timeoutMs=0 disables the timer. Verify the request still arrives
      // and the default path works (no premature timeout).
      server.setHandler('test/no-timeout', async (_params, ctx) => {
        // Fire the reverse request; we don't await it — just verify it was sent.
        // Clean up the pending entry by catching the eventual rejection when
        // the socket is destroyed.
        const promise = server.sendRequest(
          ctx,
          'client/need-reply',
          {},
          { timeoutMs: 0 },
        );
        // Attach a noop catch to prevent unhandled rejection when socket closes
        promise.catch(() => {});
        return { sent: true };
      });

      const socket = await connectRaw(socketPath);
      await doHello(socket);

      writeRequest(socket, 2, 'test/no-timeout', {});

      // The server should have sent a reverse request to us
      const reverseReq = await readNextFrame(socket, 15000, 2);
      expect(reverseReq.type).toBe('request');
      expect(reverseReq.method).toBe('client/need-reply');

      // And the handler returned (it didn't await the reverse request)
      const finalResp = await readNextFrame(socket);
      expect(finalResp.result).toEqual({ sent: true });

      socket.destroy();
    }, 15_000); // 慢 CI 下真 socket 帧到达可超 5s, 放宽 vitest 超时
  });

  // -----------------------------------------------------------------------
  // 8. disconnect cleanup
  // -----------------------------------------------------------------------
  describe('disconnect cleanup', () => {
    it('rejects pending server requests when client disconnects', async () => {
      let capturedError: string | null = null;
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });

      server.setHandler('test/disconnect-test', async (_params, ctx) => {
        try {
          await server.sendRequest(ctx, 'client/ping', {}, { timeoutMs: 10000 });
        } catch (err) {
          capturedError = (err as Error).message;
          resolveDone();
          throw err;
        }
      });

      const socket = await connectRaw(socketPath);
      await doHello(socket);

      writeRequest(socket, 2, 'test/disconnect-test', {});

      // Read the reverse request from server
      const reverseReq = await readNextFrame(socket, 15000, 2);
      expect(reverseReq.type).toBe('request');
      expect(reverseReq.method).toBe('client/ping');

      // Disconnect without responding
      socket.destroy();

      // Wait for the rejection to propagate through close handler
      await done;
      expect(capturedError).toContain('disconnected');
    });

    it('calls onClientClose listeners when client disconnects', async () => {
      let closedClientId: string | undefined;
      const closePromise = new Promise<void>((resolve) => {
        server.onClientClose((ctx) => {
          closedClientId = ctx.clientId;
          resolve();
        });
      });

      const socket = await connectRaw(socketPath);
      await doHello(socket, 'listener-test-client');
      socket.destroy();

      await closePromise;
      expect(closedClientId).toBe('listener-test-client');
    });

    it('cleans up multiple pending requests for the same disconnected client', async () => {
      let errorCount = 0;
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });

      server.setHandler('test/multi-pending', async (_params, ctx) => {
        const p1 = server
          .sendRequest(ctx, 'client/a', {}, { timeoutMs: 10000 })
          .catch(() => {
            errorCount++;
          });
        const p2 = server
          .sendRequest(ctx, 'client/b', {}, { timeoutMs: 10000 })
          .catch(() => {
            errorCount++;
          });
        await Promise.allSettled([p1, p2]);
        resolveDone();
        return { errorCount };
      });

      const socket = await connectRaw(socketPath);
      await doHello(socket);

      writeRequest(socket, 2, 'test/multi-pending', {});

      // Read both reverse requests (skipId=2: 先跳过 id=2 的 response 帧)
      const rev1 = await readNextFrame(socket, 15000, 2);
      const rev2 = await readNextFrame(socket);
      expect(rev1.type).toBe('request');
      expect(rev2.type).toBe('request');

      // Disconnect — should reject both pending requests
      socket.destroy();

      await done;
      expect(errorCount).toBe(2);
    }, 15_000); // 慢 CI 下真 socket 帧到达可超 5s, 放宽 vitest 超时

    it('stale server requests from one client do not affect another client', async () => {
      server.setHandler('test/make-pending', async (_params, ctx) => {
        // Fire-and-forget a sendRequest — reject on disconnect
        server
          .sendRequest(ctx, 'client/no-reply', {}, { timeoutMs: 10000 })
          .catch(() => {
            /* expected */
          });
        return { pending: true };
      });

      const socketA = await connectRaw(socketPath);
      const socketB = await connectRaw(socketPath);
      await doHello(socketA, 'client-A');
      await doHello(socketB, 'client-B');

      // Trigger pending on socketA (skipId=2: 先跳过 id=2 的 response 帧)
      writeRequest(socketA, 2, 'test/make-pending', {});
      const revA = await readNextFrame(socketA, 15000, 2);
      expect(revA.type).toBe('request');
      const respA = await readNextFrame(socketA);
      expect(respA.result).toEqual({ pending: true });

      // Disconnect socketA
      socketA.destroy();
      await new Promise((r) => setTimeout(r, 100));

      // socketB should still work
      server.setHandler('test/still-works', async () => 'all-good');
      writeRequest(socketB, 3, 'test/still-works', {});
      const respB = await readNextFrame(socketB);
      expect(respB.result).toBe('all-good');

      socketB.destroy();
    }, 15_000); // 慢 CI 下真 socket 帧到达可超 5s, 放宽 vitest 超时
  });

  // -----------------------------------------------------------------------
  // 9. Custom handlers and edge cases
  // -----------------------------------------------------------------------
  describe('custom handlers', () => {
    it('honors setHandler and returns result', async () => {
      server.setHandler('echo/test', async (params) => ({ echoed: params }));
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'echo/test', { hello: 'world', num: 42 });
      const resp = await readNextFrame(socket);
      expect(resp.result).toEqual({ echoed: { hello: 'world', num: 42 } });
      socket.destroy();
    });

    it('allows handler override via setHandler', async () => {
      server.setHandler('test/version', async () => 'v1');
      server.setHandler('test/version', async () => 'v2');
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'test/version', {});
      const resp = await readNextFrame(socket);
      expect(resp.result).toBe('v2');
      socket.destroy();
    });

    it('handles async handler returning undefined as valid result', async () => {
      server.setHandler('test/void', async () => {
        /* no return */
      });
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'test/void', {});
      const resp = await readNextFrame(socket);
      expect(resp.type).toBe('response');
      expect(resp.id).toBe(2);
      expect(resp.result).toBeUndefined();
      socket.destroy();
    });

    it('rejects requests beyond per-client in-flight cap with SERVER_BUSY (round 40-w4 MEDIUM-2)', async () => {
      // 永不 resolve 的 handler:让前 32 个请求占满 in-flight 槽位。
      // 注意:每次调用都 push 新的 release(不能用单变量 —— 会被最后一个覆盖)。
      const releases: Array<() => void> = [];
      server.setHandler('test/hang', async () => new Promise<void>((r) => { releases.push(r); }));
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      // 常驻帧读取器:release 后 32 帧可能合并进同一 chunk, 逐次 readNextFrame
      // 会丢合并帧 —— 用常驻队列逐帧取。
      const nextFrame = makeFrameReader(socket);
      for (let i = 0; i < 32; i += 1) writeRequest(socket, 100 + i, 'test/hang', {});
      // 第 33 个:in-flight 已满 → 同步返回 SERVER_BUSY(是所有请求里第一个响应)。
      writeRequest(socket, 200, 'test/hang', {});
      const resp = await nextFrame();
      expect(resp.id).toBe(200);
      expect(resp.error?.code).toBe('SERVER_BUSY');
      expect(resp.error?.message).toMatch(/in-flight/);
      // 释放挂起的 handler, 全部 32 个请求都拿到正常响应(限流不破坏既有请求,
      // 顺序不定 —— 收集全部)。
      releases.forEach((r) => r());
      const ids = new Set<number>();
      for (let i = 0; i < 32; i += 1) {
        const released = await nextFrame();
        expect(released.error).toBeUndefined();
        ids.add(released.id);
      }
      expect(ids.size).toBe(32); // 100..131 全部响应, 无重复无丢失
      socket.destroy();
    });

    it('handles synchronous handler', async () => {
      server.setHandler('test/sync', (params: any) => ({
        doubled: (params?.x ?? 0) * 2,
      }));
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      writeRequest(socket, 2, 'test/sync', { x: 21 });
      const resp = await readNextFrame(socket);
      expect(resp.result).toEqual({ doubled: 42 });
      socket.destroy();
    });

    it('builtin hello handler can be overridden', async () => {
      server.setHandler('protocol/hello', async () => ({
        custom: 'hello-world',
      }));
      const socket = await connectRaw(socketPath);
      writeRequest(socket, 1, 'protocol/hello', {
        protocolVersion: PROTOCOL_VERSION,
      });
      const resp = await readNextFrame(socket);
      expect(resp.result).toEqual({ custom: 'hello-world' });
      socket.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 10. Server lifecycle
  // -----------------------------------------------------------------------
  describe('server lifecycle', () => {
    it('start() is idempotent', async () => {
      await server.start();
      await server.start();
      const socket = await connectRaw(socketPath);
      await doHello(socket);
      socket.destroy();
    });

    it('stop() is idempotent', async () => {
      await server.stop();
      await server.stop();
      // Should not throw
    });

    it('does not accept connections after stop()', async () => {
      await server.stop();
      try {
        await connectRaw(socketPath);
        expect.unreachable('should not connect after stop');
      } catch {
        // Expected — connection refused
      }
    });
  });

  // -----------------------------------------------------------------------
  // 11. MAX_CLIENTS connection limit (退役审轮 3 M-2)
  // -----------------------------------------------------------------------
  describe('MAX_CLIENTS connection limit', () => {
    it('accepts exactly 16 concurrent connections (at limit)', async () => {
      const sockets: net.Socket[] = [];
      try {
        for (let i = 0; i < 16; i++) {
          sockets.push(await connectRaw(socketPath));
        }
        expect(sockets).toHaveLength(16);

        // All 16 should be functional — do hello on a random one
        const helloResult = await doHello(sockets[7], `client-7`);
        expect(helloResult.protocolVersion).toBe(PROTOCOL_VERSION);
      } finally {
        for (const s of sockets) s.destroy();
      }
    });

    it('rejects 17th connection — socket destroyed immediately', async () => {
      const sockets: net.Socket[] = [];
      try {
        // Fill up to MAX_CLIENTS=16
        for (let i = 0; i < 16; i++) {
          sockets.push(await connectRaw(socketPath));
        }

        // 17th connection should be destroyed immediately
        const socket17 = net.connect(socketPath);
        await new Promise<void>((resolve) => {
          socket17.on('error', () => resolve());
          socket17.on('close', () => resolve());
          // Timeout safety net
          setTimeout(resolve, 2000);
        });
        // Give event loop a tick
        await new Promise((r) => setTimeout(r, 50));
        expect(socket17.destroyed).toBe(true);
      } finally {
        for (const s of sockets) s.destroy();
      }
    });

    it('accepts new connections after clients disconnect (slot reuse)', async () => {
      const sockets: net.Socket[] = [];
      try {
        // Fill to limit
        for (let i = 0; i < 16; i++) {
          sockets.push(await connectRaw(socketPath));
        }

        // Disconnect 4 clients
        for (let i = 0; i < 4; i++) {
          sockets[i].destroy();
        }
        // Wait for server to process close events
        await new Promise((r) => setTimeout(r, 50));

        // Should now accept 4 new connections
        const newSockets: net.Socket[] = [];
        for (let i = 0; i < 4; i++) {
          const s = await connectRaw(socketPath);
          newSockets.push(s);
        }
        expect(newSockets).toHaveLength(4);

        // Verify new connections work
        const helloResult = await doHello(newSockets[0], 'new-after-disconnect');
        expect(helloResult.protocolVersion).toBe(PROTOCOL_VERSION);

        for (const s of newSockets) s.destroy();
        // Remove the destroyed sockets from the array to avoid double-destroy
        for (let i = 0; i < 4; i++) sockets[i] = null as any;
        for (const s of sockets) {
          if (s && !s.destroyed) s.destroy();
        }
      } finally {
        for (const s of sockets) {
          if (s && !s.destroyed) s.destroy();
        }
      }
    });

    it('MAX_CLIENTS applies pre-hello (raw connections count)', async () => {
      const sockets: net.Socket[] = [];
      try {
        // Connect 16 raw sockets WITHOUT doing hello
        for (let i = 0; i < 16; i++) {
          sockets.push(await connectRaw(socketPath));
        }

        // 17th should be rejected even though none have completed hello
        const socket17 = net.connect(socketPath);
        await new Promise<void>((resolve) => {
          socket17.on('error', () => resolve());
          socket17.on('close', () => resolve());
          setTimeout(resolve, 2000);
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(socket17.destroyed).toBe(true);
      } finally {
        for (const s of sockets) s.destroy();
      }
    });

    it('server still functional after hitting and releasing limit', async () => {
      // Hit the limit
      const sockets: net.Socket[] = [];
      for (let i = 0; i < 16; i++) {
        sockets.push(await connectRaw(socketPath));
      }

      // Disconnect all
      for (const s of sockets) s.destroy();
      await new Promise((r) => setTimeout(r, 50));

      // Server should be back to normal — accept new connections
      const fresh = await connectRaw(socketPath);
      const helloResult = await doHello(fresh, 'after-limit-release');
      expect(helloResult.protocolVersion).toBe(PROTOCOL_VERSION);

      // Register custom handler and use it
      server.setHandler('test/after-limit', async () => 'limit-ok');
      writeRequest(fresh, 2, 'test/after-limit', {});
      const resp = await readNextFrame(fresh);
      expect(resp.result).toBe('limit-ok');

      fresh.destroy();
    });
  });
});
