import { afterEach, describe, expect, it, vi } from 'vitest';

import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import type { ProxyHandle } from './types.js';

// 捕获 proxy → upstream 转发请求的 options(测试客户端用 fetch/undici,不走 node:http,
// 所以这里只会收到 forward() 的出站请求)。
const capturedOptions: Array<Record<string, unknown>> = [];

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    request: ((options: Record<string, unknown>, ...rest: unknown[]) => {
      capturedOptions.push(options);
      return (actual.request as (...args: unknown[]) => unknown)(options, ...rest);
    }) as typeof actual.request,
  };
});

let proxy: ProxyHandle | null = null;
let closeUpstream: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (proxy) { await proxy.dispose(); proxy = null; }
  if (closeUpstream) { await closeUpstream(); closeUpstream = null; }
  capturedOptions.length = 0;
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
});
