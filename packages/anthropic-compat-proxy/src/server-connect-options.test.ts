import { afterEach, describe, expect, it, vi } from 'vitest';

import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import { createEncryptedContentRecoveryRule } from './transform.js';
import type { ProxyHandle } from './types.js';

// 捕获 proxy → upstream 转发请求的 options(测试客户端用 fetch/undici,不走 node:http,
// 所以这里只会收到 forward() 的出站请求)。
const capturedOptions: Array<Record<string, unknown>> = [];
let testSocketTimeoutMs: number | undefined;
let socketTimeouts = 0;

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    request: ((options: Record<string, unknown>, ...rest: unknown[]) => {
      capturedOptions.push(options);
      // Accelerate only the timeout the proxy actually supplied. Keep real TCP,
      // Node's inactivity timer and every request/response event intact.
      const effectiveOptions = testSocketTimeoutMs !== undefined && Number(options.timeout) > 0
        ? { ...options, timeout: testSocketTimeoutMs }
        : options;
      const request = (actual.request as (...args: unknown[]) => ReturnType<typeof actual.request>)(effectiveOptions, ...rest);
      request.on('timeout', () => socketTimeouts++);
      return request;
    }) as typeof actual.request,
  };
});

let proxy: ProxyHandle | null = null;
let closeUpstream: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (proxy) { await proxy.dispose(); proxy = null; }
  if (closeUpstream) { await closeUpstream(); closeUpstream = null; }
  capturedOptions.length = 0;
  testSocketTimeoutMs = undefined;
  socketTimeouts = 0;
});

describe('anthropic-compat-proxy upstream connect options', () => {
  it('forwards with a relaxed Happy Eyeballs attempt timeout (regression: 502 AggregateError on slow networks)', async () => {
    const { createServer } = await vi.importActual<typeof import('node:http')>('node:http');
    const { createAnthropicCompatProxy } = await import('./server.js');

    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    closeUpstream = () => new Promise<void>((r) => upstream.close(() => r()));

    proxy = await createAnthropicCompatProxy({
      upstream: `http://127.0.0.1:${port}`,
      transformRequest: [],
    });

    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(capturedOptions.length).toBeGreaterThan(0);
    const opts = capturedOptions[0];
    // Node 默认的 autoSelectFamilyAttemptTimeout 只有 250ms,高延迟网络下会把上游连接
    // 全部砍成 AggregateError;转发请求必须显式带上放宽后的值,丢掉这个选项即回归。
    expect(opts.autoSelectFamilyAttemptTimeout).toBe(2500);
    expect(opts.timeout).toBe(10 * 60 * 1000);
  });

  it.each(['no headers', 'SSE headers only', 'partial SSE', 'non-SSE 2xx', 'buffered 400'] as const)(
    'settles an idle upstream with %s using the existing socket timeout, then accepts another request (#2650)',
    async (phase) => {
      const { createServer } = await vi.importActual<typeof import('node:http')>('node:http');
      const { createAnthropicCompatProxy } = await import('./server.js');
      testSocketTimeoutMs = 300;
      const event = 'event: message_start\ndata: {}\n\n';
      let calls = 0;
      const upstream = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          if (++calls > 1) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(event);
            return;
          }
          if (phase === 'no headers') return;
          if (phase === 'buffered 400' || phase === 'non-SSE 2xx') {
            res.writeHead(phase === 'buffered 400' ? 400 : 200, { 'content-type': 'application/json' });
            res.write('{');
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.flushHeaders();
          if (phase === 'partial SSE') res.write(event);
          // Leave TCP open without ending or emitting more bytes.
        });
      });
      const port = await listenOnAvailableLoopbackPort(upstream);
      closeUpstream = () => new Promise<void>((resolve) => {
        upstream.closeAllConnections();
        upstream.close(() => resolve());
      });
      proxy = await createAnthropicCompatProxy({
        upstream: `http://127.0.0.1:${port}`,
        recoveryRules: [createEncryptedContentRecoveryRule({ enabled: () => true })],
      });
      const send = () => fetch(`${proxy!.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', stream: true, messages: [] }),
        signal: AbortSignal.timeout(5000),
      });

      const response = await send();
      if (phase === 'partial SSE') {
        expect(response.status).toBe(200);
        // Once SSE is committed it must fail as a truncated stream, not end
        // successfully or append a synthetic successful terminal event.
        await expect(response.text()).rejects.toThrow();
      } else {
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({ error: { type: 'proxy_error' } });
      }
      expect(socketTimeouts).toBe(1);
      expect(capturedOptions[0].timeout).toBe(10 * 60 * 1000);

      const next = await send();
      expect(next.status).toBe(200);
      expect(await next.text()).toBe(event);
      expect(calls).toBe(2);
      expect(socketTimeouts).toBe(1);
    },
  );

  it('resets the existing inactivity budget when chunks arrive instead of imposing a total stream deadline', async () => {
    const { createServer } = await vi.importActual<typeof import('node:http')>('node:http');
    const { createAnthropicCompatProxy } = await import('./server.js');
    testSocketTimeoutMs = 400;
    const event = 'event: content_block_delta\ndata: {}\n\n';
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(event);
        let remaining = 8;
        const timer = setInterval(() => {
          res.write(event);
          if (--remaining === 0) {
            clearInterval(timer);
            res.end();
          }
        }, 100);
        res.on('close', () => clearInterval(timer));
      });
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    closeUpstream = () => new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
    proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${port}` });
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', stream: true, messages: [] }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(event.repeat(9));
    expect(socketTimeouts).toBe(0);
    expect(capturedOptions[0].timeout).toBe(10 * 60 * 1000);
  });
});
