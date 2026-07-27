import { createServer as createHttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAnthropicCompatProxy } from './server.js';
import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import type { ProxyHandle } from './types.js';

/**
 * 出站代理链路的 server 级验证。代理路径用保证不可解析的 `.invalid` 假域 ——
 * 经代理转发时压根不需要解析上游域名(http 走绝对形式、https 由代理端拨号),
 * 因此「请求打到了 mini 代理」本身就证明代理路径生效；直连回退则使用本机测试
 * 上游，确定性验证 fail-open 后请求确实抵达直连目标。
 */
describe('anthropic-compat-proxy outbound proxy wiring', () => {
  let proxy: ProxyHandle | null = null;
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    if (proxy) { await proxy.dispose(); proxy = null; }
    while (cleanups.length) await cleanups.pop()!();
  });

  it('forwards http upstreams via absolute-form request to the outbound proxy', async () => {
    const seen: Array<{ url: string; host?: string; proxyAuth?: string }> = [];
    const miniProxy = createHttpServer((req, res) => {
      seen.push({
        url: req.url ?? '',
        host: req.headers.host,
        proxyAuth: req.headers['proxy-authorization'] as string | undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ via: 'outbound-proxy' }));
    });
    const miniProxyPort = await listenOnAvailableLoopbackPort(miniProxy);
    cleanups.push(() => new Promise<void>((r) => miniProxy.close(() => r())));

    proxy = await createAnthropicCompatProxy({
      upstream: 'http://upstream.invalid:8080/v1',
      transformRequest: [],
      resolveOutboundProxy: () => `http://user:secret@127.0.0.1:${miniProxyPort}`,
    });

    const res = await fetch(`${proxy.url}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: 'outbound-proxy' });

    expect(seen).toHaveLength(1);
    // 绝对形式 URL 指向真实上游;Host 头按 RFC 9110 带非默认端口;凭证进 Proxy-Authorization。
    expect(seen[0].url).toBe('http://upstream.invalid:8080/v1/messages');
    expect(seen[0].host).toBe('upstream.invalid:8080');
    expect(seen[0].proxyAuth).toBe(`Basic ${Buffer.from('user:secret').toString('base64')}`);
  });

  it('routes https upstreams through a CONNECT tunnel to the outbound proxy', async () => {
    const connects: string[] = [];
    const miniProxy = createHttpServer();
    miniProxy.on('connect', (req, clientSocket) => {
      connects.push(req.url ?? '');
      // 拒绝隧道:断言只关心「CONNECT 打到了代理」;成功隧道路径由
      // outbound-proxy.test.ts 的 TunnelingHttpsAgent 用例覆盖。
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    const miniProxyPort = await listenOnAvailableLoopbackPort(miniProxy);
    cleanups.push(() => new Promise<void>((r) => miniProxy.close(() => r())));

    proxy = await createAnthropicCompatProxy({
      upstream: 'https://upstream.invalid',
      transformRequest: [],
      resolveOutboundProxy: () => `http://127.0.0.1:${miniProxyPort}`,
    });

    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('upstream unreachable');
    expect(body.error.message).toContain('CONNECT');
    expect(connects).toEqual(['upstream.invalid:443']);
  });

  it('never consults the resolver for loopback upstreams', async () => {
    const upstream = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ direct: true }));
    });
    const upstreamPort = await listenOnAvailableLoopbackPort(upstream);
    cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));

    const resolver = vi.fn(() => 'http://127.0.0.1:1');
    proxy = await createAnthropicCompatProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      transformRequest: [],
      resolveOutboundProxy: resolver,
    });

    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('falls back to direct connection when the resolver throws or returns unsupported urls', async () => {
    let directRequests = 0;
    const upstream = createHttpServer((_req, res) => {
      directRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ direct: true }));
    });
    const upstreamPort = await listenOnAvailableLoopbackPort(upstream);
    cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));

    const warns: string[] = [];
    proxy = await createAnthropicCompatProxy({
      // URL parsing keeps 0.0.0.0 distinct from the explicit loopback forms that
      // bypass the resolver, while Node routes it to this local test server.
      upstream: `http://0.0.0.0:${upstreamPort}`,
      transformRequest: [],
      resolveOutboundProxy: () => { throw new Error('resolver boom'); },
      logger: { warn: (msg) => { warns.push(msg); } },
    });

    // resolver 异常不能炸掉请求；fail-open 后必须实际抵达直连上游。
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ direct: true });
    expect(warns.some((m) => m.includes('outbound proxy resolver threw'))).toBe(true);

    await proxy.dispose();

    const warns2: string[] = [];
    proxy = await createAnthropicCompatProxy({
      upstream: `http://0.0.0.0:${upstreamPort}`,
      transformRequest: [],
      resolveOutboundProxy: () => 'socks5://127.0.0.1:1080',
      logger: { warn: (msg) => { warns2.push(msg); } },
    });
    const res2 = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ direct: true });
    expect(warns2.some((m) => m.includes('unsupported outbound proxy url'))).toBe(true);
    expect(directRequests).toBe(2);
  });
});
