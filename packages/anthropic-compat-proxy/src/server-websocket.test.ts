import { ClientRequest, createServer, type IncomingMessage } from 'node:http';
import { connect, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAnthropicCompatProxy } from './server.js';
import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import { startSocks5Stub } from './test-socks5-stub.js';
import type { ProxyHandle } from './types.js';

interface UpgradeResponse {
  socket: Socket;
  head: string;
  rest: Buffer;
}

const sockets = new Set<Socket | Duplex>();
const cleanups: Array<() => Promise<void> | void> = [];
let proxy: ProxyHandle | null = null;

afterEach(async () => {
  if (proxy) {
    await proxy.dispose();
    proxy = null;
  }
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  while (cleanups.length) await cleanups.pop()!();
});

function upgradeRequest(
  path: string,
  host: string,
  tail = Buffer.alloc(0),
  extraHeaders: readonly string[] = [],
): Buffer {
  const head = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    ...extraHeaders,
    '',
    '',
  ].join('\r\n');
  return Buffer.concat([Buffer.from(head), tail]);
}

function openUpgrade(
  proxyUrl: string,
  path = '/v1/responses',
  tail = Buffer.alloc(0),
  extraHeaders: readonly string[] = [],
): Promise<UpgradeResponse> {
  const endpoint = new URL(proxyUrl);
  return new Promise<UpgradeResponse>((resolve, reject) => {
    const socket = connect(Number(endpoint.port), endpoint.hostname);
    sockets.add(socket);
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for upgrade response'));
    }, 2_000);
    const fail = (error: Error): void => {
      clearTimeout(timeout);
      reject(error);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(upgradeRequest(path, endpoint.host, tail, extraHeaders));
    });
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      const boundary = all.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      clearTimeout(timeout);
      socket.off('error', fail);
      socket.off('data', onData);
      resolve({
        socket,
        head: all.subarray(0, boundary + 4).toString('latin1'),
        rest: all.subarray(boundary + 4),
      });
    };
    socket.on('data', onData);
  });
}

async function readUpgradeFailure(
  proxyUrl: string,
  path = '/v1/responses',
  extraHeaders: readonly string[] = [],
): Promise<string> {
  const { socket, head, rest } = await openUpgrade(proxyUrl, path, Buffer.alloc(0), extraHeaders);
  const chunks = [rest];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for failed upgrade to close'));
    }, 2_000);
    socket.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    const finish = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    socket.once('end', finish);
    socket.once('close', finish);
  });
  return head + Buffer.concat(chunks).toString('utf8');
}

function waitForSocketText(socket: Socket, initial: Buffer, expected: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let collected = initial.toString('utf8');
    if (collected.includes(expected)) {
      resolve(collected);
      return;
    }
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for socket text ${expected}`));
    }, 2_000);
    const onData = (chunk: Buffer): void => {
      collected += chunk.toString('utf8');
      if (!collected.includes(expected)) return;
      clearTimeout(timeout);
      socket.off('data', onData);
      resolve(collected);
    };
    socket.on('data', onData);
  });
}

function startUpgradeUpstream(opts: { handshakeDelayMs?: number } = {}): Promise<{
  url: string;
  port: number;
  server: ReturnType<typeof createServer>;
  requests: IncomingMessage[];
  received: string[];
  connections: Duplex[];
}> {
  const requests: IncomingMessage[] = [];
  const received: string[] = [];
  const connections: Duplex[] = [];
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    connections.push(socket);
    requests.push(req);
    setTimeout(() => {
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Extensions: permessage-deflate',
        'X-Upstream: accepted',
        '',
        'SERVER_HEAD',
      ].join('\r\n'));
    }, opts.handshakeDelayMs ?? 0);
    socket.on('data', (chunk) => {
      received.push(chunk.toString('utf8'));
      if (Buffer.concat([Buffer.from(received.join(''))]).includes(Buffer.from('PING'))) {
        socket.write('PONG');
      }
    });
    // 模拟正常的 WebSocket 对端:收到 TCP FIN 后也结束自己的写侧,完成双向关闭。
    socket.on('end', () => socket.end());
  });
  return listenOnAvailableLoopbackPort(server).then((port) => {
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { url: `http://127.0.0.1:${port}`, port, server, requests, received, connections };
  });
}

describe('anthropic-compat-proxy websocket upgrades', () => {
  it('forwards the upgrade handshake, strips /v1, and pipes buffered bytes both ways', async () => {
    const upstream = await startUpgradeUpstream();
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => `${upstream.url}/backend-api/codex`,
    });

    const response = await openUpgrade(
      proxy.url,
      '/v1/responses?feature=websocket',
      Buffer.from('CLIENT_HEAD'),
      [
        'Authorization: Bearer test-token',
        'OpenAI-Beta: responses_websockets=2026-02-06',
        'X-Codex-Turn-Metadata: test-metadata',
      ],
    );
    expect(response.head).toContain('HTTP/1.1 101 Switching Protocols');
    expect(response.head.toLowerCase()).toContain('connection: upgrade');
    expect(response.head.toLowerCase()).toContain('upgrade: websocket');
    expect(response.head.toLowerCase()).toContain(
      'sec-websocket-extensions: permessage-deflate',
    );
    expect(response.head.toLowerCase()).toContain('x-upstream: accepted');
    expect(response.rest.toString('utf8')).toContain('SERVER_HEAD');

    response.socket.write('PING');
    const clientBytes = await waitForSocketText(response.socket, response.rest, 'PONG');
    expect(clientBytes).toContain('SERVER_HEAD');
    expect(clientBytes).toContain('PONG');

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].url).toBe('/backend-api/codex/responses?feature=websocket');
    expect(upstream.requests[0].headers.connection?.toLowerCase()).toBe('upgrade');
    expect(upstream.requests[0].headers.upgrade?.toLowerCase()).toBe('websocket');
    expect(upstream.requests[0].headers.host).toBe(
      new URL(upstream.url).host,
    );
    expect(upstream.requests[0].headers.authorization).toBe('Bearer test-token');
    expect(upstream.requests[0].headers['openai-beta']).toBe(
      'responses_websockets=2026-02-06',
    );
    expect(upstream.requests[0].headers['x-codex-turn-metadata']).toBe('test-metadata');
    expect(upstream.received.join('')).toContain('CLIENT_HEAD');
    expect(upstream.received.join('')).toContain('PING');
  });

  it('uses a short timeout for the websocket handshake', async () => {
    const setTimeoutSpy = vi.spyOn(ClientRequest.prototype, 'setTimeout');
    try {
      const upstream = await startUpgradeUpstream();
      proxy = await createAnthropicCompatProxy({
        upstream: 'http://unused.invalid',
        transformRequest: [],
        resolveWebSocketUpstream: () => upstream.url,
      });

      const response = await openUpgrade(proxy.url);
      expect(response.head).toContain('HTTP/1.1 101 Switching Protocols');
      expect(setTimeoutSpy.mock.calls.some(([timeout]) => timeout === 15_000)).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('returns 426 as a complete HTTP response when the host requests HTTP fallback', async () => {
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => null,
    });

    const response = await readUpgradeFailure(proxy.url);
    expect(response).toBe(
      'HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n',
    );
  });

  it('holds only a proven thread reconnect until its websocket upstream recovers', async () => {
    const upstream = await startUpgradeUpstream();
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => upstream.url,
      retryProvenWebSocketUpgrades: true,
    });
    const handshakeHeaders = [
      'Thread-Id: thread-proven',
      'Sec-WebSocket-Extensions: permessage-deflate',
    ];

    const first = await openUpgrade(
      proxy.url,
      '/v1/responses',
      Buffer.alloc(0),
      handshakeHeaders,
    );
    expect(first.head).toContain('HTTP/1.1 101 Switching Protocols');
    expect(upstream.requests).toHaveLength(1);

    // Drop the established path and stop accepting new upstream connections, matching a network cut.
    first.socket.destroy();
    for (const connection of upstream.connections) connection.destroy();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));

    const reconnect = await openUpgrade(
      proxy.url,
      '/v1/responses',
      Buffer.alloc(0),
      handshakeHeaders,
    );
    expect(reconnect.head).toContain('HTTP/1.1 101 Switching Protocols');
    expect(reconnect.head.toLowerCase()).toContain(
      'sec-websocket-extensions: permessage-deflate',
    );
    expect(reconnect.head).toContain(
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    );
    expect(upstream.requests).toHaveLength(1);

    // A different thread has no successful-101 proof and must not be captured by this recovery path.
    const otherThread = await readUpgradeFailure(
      proxy.url,
      '/v1/responses',
      ['Thread-Id: thread-other'],
    );
    expect(otherThread).toBe(
      'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n',
    );

    // Write while offline. The proxy pauses reads instead of accumulating an unbounded user-space queue.
    reconnect.socket.write('PING_AFTER_RECONNECT');
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      upstream.server.once('error', onError);
      upstream.server.listen(upstream.port, '127.0.0.1', () => {
        upstream.server.off('error', onError);
        resolve();
      });
    });

    await expect(
      waitForSocketText(reconnect.socket, reconnect.rest, 'PONG'),
    ).resolves.toContain('PONG');
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.received.join('')).toContain('PING_AFTER_RECONNECT');
  });

  it('forgets one thread proof so a provider switch cannot reuse its websocket recovery', async () => {
    const upstream = await startUpgradeUpstream();
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => upstream.url,
      retryProvenWebSocketUpgrades: true,
    });
    const threadHeaders = ['Thread-Id: thread-provider-switch'];
    const first = await openUpgrade(
      proxy.url,
      '/v1/responses',
      Buffer.alloc(0),
      threadHeaders,
    );
    expect(first.head).toContain('HTTP/1.1 101 Switching Protocols');

    const firstClosed = new Promise<void>((resolve) => first.socket.once('close', () => resolve()));
    expect(proxy.forgetWebSocketStateForThread?.('thread-provider-switch')).toBe(1);
    await firstClosed;
    for (const connection of upstream.connections) connection.destroy();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));

    const response = await readUpgradeFailure(
      proxy.url,
      '/v1/responses',
      threadHeaders,
    );
    expect(response).toBe(
      'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n',
    );
  });

  it('stops holding a proven thread when the real upstream returns an HTTP refusal', async () => {
    let acceptUpgrade = true;
    const upstream = createServer();
    upstream.on('upgrade', (_req, socket) => {
      sockets.add(socket);
      if (!acceptUpgrade) {
        socket.end([
          'HTTP/1.1 503 Service Unavailable',
          'Content-Length: 4',
          'Connection: close',
          '',
          'down',
        ].join('\r\n'));
        return;
      }
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'));
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => `http://127.0.0.1:${port}`,
      retryProvenWebSocketUpgrades: true,
    });
    const threadHeaders = ['Thread-Id: thread-refused'];
    const first = await openUpgrade(
      proxy.url,
      '/v1/responses',
      Buffer.alloc(0),
      threadHeaders,
    );
    first.socket.destroy();
    acceptUpgrade = false;

    const held = await openUpgrade(
      proxy.url,
      '/v1/responses',
      Buffer.alloc(0),
      threadHeaders,
    );
    expect(held.head).toContain('HTTP/1.1 101 Switching Protocols');
    await new Promise<void>((resolve) => held.socket.once('close', () => resolve()));

    const refusal = await readUpgradeFailure(proxy.url, '/v1/responses', threadHeaders);
    expect(refusal).toContain('HTTP/1.1 503 Service Unavailable');
    expect(refusal).toContain('down');
  });

  it('returns 500 instead of falling back when the websocket resolver throws', async () => {
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => {
        throw new Error('resolver failed');
      },
    });

    const response = await readUpgradeFailure(proxy.url);
    expect(response).toBe(
      'HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n',
    );
  });

  it('returns 500 instead of falling back for an unusable websocket upstream url', async () => {
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => 'ws://upstream.invalid/backend-api/codex',
    });

    const response = await readUpgradeFailure(proxy.url);
    expect(response).toBe(
      'HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n',
    );
  });

  it('returns 502 instead of falling back on pre-handshake network errors', async () => {
    // A closed loopback port deterministically produces ECONNREFUSED. DNS ENOTFOUND,
    // ECONNRESET and TLS failures enter the same ClientRequest error branch.
    const unavailable = createServer();
    const port = await listenOnAvailableLoopbackPort(unavailable);
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));

    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => `http://127.0.0.1:${port}`,
    });

    const response = await readUpgradeFailure(proxy.url);
    expect(response).toBe(
      'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n',
    );
  });

  it('returns 504 instead of falling back when the websocket handshake times out', async () => {
    const upstream = createServer();
    upstream.on('upgrade', (_req, socket) => {
      sockets.add(socket);
      // Intentionally leave the handshake pending. The ClientRequest timeout spy below
      // fires the production timeout callback without making this test wait 15 seconds.
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    cleanups.push(() => new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    }));
    const setTimeoutSpy = vi.spyOn(ClientRequest.prototype, 'setTimeout');
    setTimeoutSpy.mockImplementation(function (
      this: ClientRequest,
      msecs: number,
      callback?: () => void,
    ): ClientRequest {
      if (msecs === 15_000 && callback) queueMicrotask(callback);
      return this;
    });

    try {
      proxy = await createAnthropicCompatProxy({
        upstream: 'http://unused.invalid',
        transformRequest: [],
        resolveWebSocketUpstream: () => `http://127.0.0.1:${port}`,
      });

      const response = await readUpgradeFailure(proxy.url);
      expect(response).toBe(
        'HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n',
      );
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('handles an asynchronous socket error while writing an early 426 response', async () => {
    const originalEnd = Socket.prototype.end;
    let injectedWriteError = false;
    const endSpy = vi.spyOn(Socket.prototype, 'end');
    const implementation = function (
      this: Socket,
      chunk?: unknown,
      ...rest: unknown[]
    ): Socket {
      if (
        !injectedWriteError
        && typeof chunk === 'string'
        && chunk.startsWith('HTTP/1.1 426 Upgrade Required')
      ) {
        injectedWriteError = true;
        queueMicrotask(() => {
          const error = Object.assign(new Error('simulated early upgrade write failure'), {
            code: 'EPIPE',
          });
          this.emit('error', error);
        });
        return this;
      }
      return Reflect.apply(originalEnd, this, [chunk, ...rest]) as Socket;
    };
    endSpy.mockImplementation(implementation as typeof Socket.prototype.end);

    try {
      proxy = await createAnthropicCompatProxy({
        upstream: 'http://unused.invalid',
        transformRequest: [],
        resolveWebSocketUpstream: () => null,
      });
      const endpoint = new URL(proxy.url);
      await new Promise<void>((resolve, reject) => {
        const socket = connect(Number(endpoint.port), endpoint.hostname);
        sockets.add(socket);
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error('timed out waiting for failed upgrade socket to close'));
        }, 2_000);
        socket.once('error', () => {
          // Server-side simulated EPIPE may surface as a reset to this test client.
        });
        socket.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.once('connect', () => {
          socket.write(upgradeRequest('/v1/responses', endpoint.host));
        });
      });
      expect(injectedWriteError).toBe(true);
    } finally {
      endSpy.mockRestore();
    }
  });

  it('forwards an upstream at-capacity response without stale chunk framing', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(503, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
        'x-upstream': 'capacity',
      });
      res.write('{"error":{"code":"');
      res.end('server_is_overloaded"}}');
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => `http://127.0.0.1:${port}`,
    });

    const response = await readUpgradeFailure(proxy.url);
    const [head, body] = response.split('\r\n\r\n', 2);
    expect(head).toContain('HTTP/1.1 503 Service Unavailable');
    expect(head.toLowerCase()).not.toContain('transfer-encoding');
    expect(head.toLowerCase()).not.toContain('content-length');
    expect(head.toLowerCase()).toContain('connection: close');
    expect(head).toContain('x-upstream: capacity');
    expect(body).toBe('{"error":{"code":"server_is_overloaded"}}');
  });

  it('closes the client when a preserved refusal body fails mid-stream', async () => {
    const warns: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const upstream = createServer((_req, res) => {
      res.writeHead(503, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      });
      const socket = res.socket;
      res.write('{"error":"partial', () => socket?.destroy());
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => `http://127.0.0.1:${port}`,
      logger: { warn: (msg, ctx) => warns.push({ msg, ctx }) },
    });

    const response = await readUpgradeFailure(proxy.url);
    expect(response).toContain('HTTP/1.1 503 Service Unavailable');
    expect(response).toContain('{"error":"partial');
    expect(warns).toContainEqual(expect.objectContaining({
      msg: 'websocket refusal response body failed',
      ctx: expect.objectContaining({ reason: 'aborted', status: 503 }),
    }));
  });

  it('falls back to HTTP when the network path refuses websocket upgrades', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('websocket blocked by intermediary');
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => `http://127.0.0.1:${port}`,
    });

    const response = await readUpgradeFailure(proxy.url);
    expect(response).toBe(
      'HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n',
    );
  });

  it('still falls back when the discarded refusal body fails mid-stream', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(403, {
        'content-type': 'text/plain',
        'transfer-encoding': 'chunked',
      });
      const socket = res.socket;
      res.write('websocket blocked', () => socket?.destroy());
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => `http://127.0.0.1:${port}`,
    });

    const response = await readUpgradeFailure(proxy.url);
    expect(response).toBe(
      'HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n',
    );
  });

  it.each([
    [401, 'Unauthorized'],
    [429, 'Too Many Requests'],
  ])('preserves upstream status %i instead of hiding it behind HTTP fallback', async (
    status,
    statusText,
  ) => {
    const upstream = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(`{"error":{"status":${status}}}`);
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => `http://127.0.0.1:${port}`,
    });

    const response = await readUpgradeFailure(proxy.url);
    expect(response).toContain(`HTTP/1.1 ${status} ${statusText}`);
    expect(response).toContain(`{"error":{"status":${status}}}`);
  });

  it('does not impose a local websocket capacity limit', async () => {
    // 容量由 Codex / 上游控制。proxy 自设连接上限会凭空制造 503,让 Cindy 的
    // at-capacity 行为与官方 Codex 不一致。
    const upstream = await startUpgradeUpstream({ handshakeDelayMs: 25 });
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => upstream.url,
    });

    const attempts = await Promise.all(
      Array.from({ length: 9 }, (_, i) => openUpgrade(proxy!.url, `/v1/responses?slot=${i}`)),
    );
    expect(attempts).toHaveLength(9);
    expect(attempts.every((result) => result.head.includes(' 101 '))).toBe(true);
  });

  it('disconnects only the prewarmed websocket clients for the requested thread', async () => {
    const upstream = await startUpgradeUpstream();
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => upstream.url,
    });

    const threadA = await openUpgrade(
      proxy.url,
      '/v1/responses',
      Buffer.alloc(0),
      ['Thread-Id: thread-a'],
    );
    const threadB = await openUpgrade(
      proxy.url,
      '/v1/responses',
      Buffer.alloc(0),
      ['Thread-Id: thread-b'],
    );
    const threadAClosed = new Promise<void>((resolve) => {
      threadA.socket.once('close', () => resolve());
    });

    expect(proxy.disconnectWebSocketsForThread?.('thread-a')).toBe(1);
    await threadAClosed;
    expect(threadA.socket.destroyed).toBe(true);
    expect(threadB.socket.destroyed).toBe(false);

    threadB.socket.write('PING');
    await expect(waitForSocketText(threadB.socket, threadB.rest, 'PONG')).resolves.toContain('PONG');
    expect(proxy.disconnectWebSocketsForThread?.('thread-missing')).toBe(0);
  });

  it('does not evict a genuinely unscoped generic socket for another thread', async () => {
    const upstream = await startUpgradeUpstream();
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => upstream.url,
    });

    const unscoped = await openUpgrade(
      proxy.url,
      '/v1/responses',
      Buffer.alloc(0),
      ['X-Client-Request-Id: request-only-id'],
    );
    const target = await openUpgrade(
      proxy.url,
      '/v1/responses',
      Buffer.alloc(0),
      ['Thread-Id: thread-target'],
    );
    const other = await openUpgrade(
      proxy.url,
      '/v1/responses',
      Buffer.alloc(0),
      ['Thread-Id: thread-other'],
    );
    const targetClosed = new Promise<void>((resolve) => {
      target.socket.once('close', () => resolve());
    });

    expect(proxy.disconnectWebSocketsForThread?.('thread-target')).toBe(1);
    await targetClosed;
    expect(unscoped.socket.destroyed).toBe(false);
    expect(target.socket.destroyed).toBe(true);
    expect(other.socket.destroyed).toBe(false);

    unscoped.socket.write('PING');
    await expect(
      waitForSocketText(unscoped.socket, unscoped.rest, 'PONG'),
    ).resolves.toContain('PONG');
    other.socket.write('PING');
    await expect(waitForSocketText(other.socket, other.rest, 'PONG')).resolves.toContain('PONG');
  });

  it('returns 502 when an HTTP CONNECT proxy cannot reach the websocket upstream', async () => {
    const connects: string[] = [];
    const outbound = createServer();
    outbound.on('connect', (req, clientSocket) => {
      connects.push(req.url ?? '');
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    const outboundPort = await listenOnAvailableLoopbackPort(outbound);
    cleanups.push(() => new Promise<void>((resolve) => outbound.close(() => resolve())));

    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => 'https://upstream.invalid/backend-api/codex',
      resolveOutboundProxy: () => `http://127.0.0.1:${outboundPort}`,
    });

    const response = await readUpgradeFailure(proxy.url);
    expect(response).toContain('HTTP/1.1 502 Bad Gateway');
    expect(connects).toEqual(['upstream.invalid:443']);
  });

  it('tunnels a websocket through SOCKS5 and leaves upstream DNS to the proxy', async () => {
    const upstream = await startUpgradeUpstream();
    const upstreamPort = Number(new URL(upstream.url).port);
    const socks = await startSocks5Stub({ tunnelToPort: upstreamPort });
    cleanups.push(() => socks.close());

    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => 'http://upstream.invalid:8080/backend-api/codex',
      resolveOutboundProxy: () => `socks5://127.0.0.1:${socks.port}`,
    });

    const response = await openUpgrade(proxy.url);
    expect(response.head).toContain('HTTP/1.1 101 Switching Protocols');
    expect(socks.requests).toEqual([
      { atyp: 0x03, host: 'upstream.invalid', port: 8080 },
    ]);
    expect(upstream.requests[0].url).toBe('/backend-api/codex/responses');
  });

  it('dispose closes both sides of established websockets instead of leaking the upstream', async () => {
    const upstream = await startUpgradeUpstream();
    proxy = await createAnthropicCompatProxy({
      upstream: 'http://unused.invalid',
      transformRequest: [],
      resolveWebSocketUpstream: () => upstream.url,
    });
    const response = await openUpgrade(proxy.url);
    const upstreamSocket = upstream.connections[0];
    if (!upstreamSocket) throw new Error('expected established upstream socket');
    const clientClosed = new Promise<void>((resolve) => response.socket.once('close', () => resolve()));
    const upstreamClosed = new Promise<void>((resolve) => upstreamSocket.once('close', () => resolve()));

    await proxy.dispose();
    proxy = null;
    await Promise.all([clientClosed, upstreamClosed]);

    expect(response.socket.destroyed).toBe(true);
    expect(upstreamSocket.destroyed).toBe(true);
  });
});
