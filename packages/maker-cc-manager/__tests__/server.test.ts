/**
 * Server smoke tests: hello handshake + unknown method + initialized gate.
 *
 * Uses an in-memory pair of net.Socket via net.createServer + net.connect to a
 * Unix socket in OS temp dir. Skipped if the platform can't create unix sockets
 * (rare; Windows since build 17063 supports them).
 */

import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient, RpcClientError } from '../src/client.js';
import { encodeMessage } from '../src/codec.js';
import { ManagerServer } from '../src/server.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';

interface Ctx {
  server: ManagerServer;
  socketPath: string;
  socket: net.Socket;
  client: RpcClient;
}

let ctx: Ctx | null = null;

/**
 * Cross-platform IPC path:
 *   - posix: unix socket file under os.tmpdir()
 *   - win32: named pipe under \\.\pipe\ (unix sockets in tmpdir get EACCES)
 *
 * Node's net.createServer.listen() accepts both formats transparently.
 */
function makeIpcPath(): string {
  const uniq = `cc-mgr-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${uniq}`;
  }
  return path.join(os.tmpdir(), `${uniq}.sock`);
}

beforeEach(async () => {
  const socketPath = makeIpcPath();
  const server = new ManagerServer({
    socketPath,
    managerVersion: 'test-0.0.0',
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
  await server.start();
  const socket = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const client = new RpcClient(socket);
  ctx = { server, socketPath, socket, client };
});

afterEach(async () => {
  if (!ctx) return;
  ctx.client.dispose();
  ctx.socket.destroy();
  await ctx.server.stop();
  ctx = null;
});

describe('ManagerServer Phase 1 skeleton', () => {
  it('returns hello response with server version', async () => {
    const res = await ctx!.client.hello();
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(res.managerVersion).toBe('test-0.0.0');
  });

  it('rejects mismatched protocol version', async () => {
    await expect(
      ctx!.client.request('protocol/hello', { protocolVersion: 999 }),
    ).rejects.toBeInstanceOf(RpcClientError);
    try {
      await ctx!.client.request('protocol/hello', { protocolVersion: 999 });
    } catch (err) {
      expect((err as RpcClientError).rpcError.code).toBe('INVALID_PROTOCOL_VERSION');
    }
  });

  it('returns NOT_INITIALIZED for any method before hello', async () => {
    try {
      await ctx!.client.request('query/start', { sessionId: 'x' });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcClientError);
      expect((err as RpcClientError).rpcError.code).toBe('NOT_INITIALIZED');
    }
  });

  it('returns UNKNOWN_METHOD for an unregistered method (after hello)', async () => {
    await ctx!.client.hello();
    try {
      await ctx!.client.request('totally/made-up', {});
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcClientError);
      expect((err as RpcClientError).rpcError.code).toBe('UNKNOWN_METHOD');
    }
  });

  it('honors setHandler for custom methods', async () => {
    ctx!.server.setHandler('echo/test', async (params) => ({ echoed: params }));
    await ctx!.client.hello();
    const result = await ctx!.client.request<{ echoed: unknown }>('echo/test', { hello: 'world' });
    expect(result.echoed).toEqual({ hello: 'world' });
  });

  it('ignores reverse-request responses from a different connection', async () => {
    // 攻击面:同 daemon 的另一条连接按小负数 id 猜中 pendingServerRequests,
    // 注入伪造的 server→client 请求结果(approval / oauth 等)。修复后
    // handleServerRequestResponse 校验 entry.ctx === ctx(对齐 pi-manager
    // 轮 2 H-1),注入被忽略,发起方只接受目标连接自己的响应。
    const { server, socketPath } = ctx!;
    server.setHandler('test/trigger-inject', async (_params, srvCtx) => {
      const result = await server.sendRequest(srvCtx, 'client/ping', {}, { timeoutMs: 5000 });
      return { echoed: result };
    });

    const connectRaw = async (): Promise<net.Socket> => {
      const s = net.connect(socketPath);
      await new Promise<void>((resolve, reject) => {
        s.once('connect', resolve);
        s.once('error', reject);
      });
      return s;
    };
    const readFrame = (s: net.Socket): Promise<any> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('readFrame timeout'));
        }, 15_000);
        let buf = '';
        const onData = (chunk: Buffer): void => {
          buf += chunk.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          cleanup();
          try {
            resolve(JSON.parse(line));
          } catch (err) {
            reject(err);
          }
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error('socket closed before frame received'));
        };
        const onError = (err: Error): void => {
          cleanup();
          reject(err);
        };
        function cleanup(): void {
          clearTimeout(timer);
          s.removeListener('data', onData);
          s.removeListener('close', onClose);
          s.removeListener('error', onError);
        }
        s.on('data', onData);
        s.once('close', onClose);
        s.once('error', onError);
      });
    const doHello = async (s: net.Socket): Promise<void> => {
      s.write(encodeMessage({
        type: 'request',
        id: 1,
        method: 'protocol/hello',
        params: { protocolVersion: PROTOCOL_VERSION },
      }));
      await readFrame(s);
    };

    const socketA = await connectRaw();
    const socketB = await connectRaw();
    try {
      await doHello(socketA);
      await doHello(socketB);

      socketA.write(encodeMessage({ type: 'request', id: 2, method: 'test/trigger-inject', params: {} }));

      // A 收到反向请求(负 id)
      const reverseReq = await readFrame(socketA);
      expect(reverseReq.type).toBe('request');
      expect(reverseReq.id).toBeLessThan(0);

      // B 尝试注入伪造响应(同 id)。随后在 B 上发一个标记请求:同一 socket 的帧
      // 按序分发,等 B 收到标记响应即可确定伪造帧已被 server 处理完 —— 不依赖
      // 固定延迟(Greptile review:两 socket 间无跨连接顺序保证,延迟法在 CI
      // 慢跑时可能让 A 的真实响应先入队,回归测试误通过)。
      socketB.write(encodeMessage({ type: 'response', id: reverseReq.id, result: { injected: true } }));
      socketB.write(encodeMessage({
        type: 'request',
        id: 3,
        method: 'protocol/hello',
        params: { protocolVersion: PROTOCOL_VERSION },
      }));
      for (;;) {
        const frame = await readFrame(socketB);
        if (frame.type === 'response' && frame.id === 3) break;
      }

      // A 自己响应 —— 若 B 的注入生效,echoed 会是 { injected: true }
      socketA.write(encodeMessage({ type: 'response', id: reverseReq.id, result: { real: true } }));

      const finalResp = await readFrame(socketA);
      expect(finalResp.type).toBe('response');
      expect(finalResp.result).toEqual({ echoed: { real: true } });
    } finally {
      socketA.destroy();
      socketB.destroy();
    }
  });
});
