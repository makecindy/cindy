/**
 * 测试价值
 * - 可观察结果：配置了 authorizeInbound 时，被拒的 HTTP 请求与 WebSocket 升级都在本地应答，
 *   模拟上游一次请求都收不到，超大请求恢复、请求守卫、路由变换都不被调用；放行时门里改写的
 *   凭据头就是转发出去的那份；检查函数抛错按 401 处理；不配置时与原来一样直接转发。
 * - 规则依据：Host 的回环代理要求入站凭据（放行表第 24 行），门在所有路由与变换之前。
 * - 最小失败输入：门放在恢复或路由之后；升级路径没有过门；改写后的头没有被转发。
 * - tier：integration（真实代理与本机 HTTP 服务，不出本机）。
 */
import { createServer, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAnthropicCompatProxy } from './server.js';
import { closeTestConnections, fetchOverTestConnections, listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import type { InboundAdmissionCtx, ProxyHandle, ProxyOptions } from './types.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  await closeTestConnections();
});

async function upstream() {
  const seen: Array<{ url?: string; headers: IncomingMessage['headers'] }> = [];
  let upgrades = 0;
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.on('upgrade', (_req, socket) => { upgrades += 1; socket.destroy(); });
  const port = await listenOnAvailableLoopbackPort(server);
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}`, seen, upgrades: () => upgrades };
}

async function start(options: Partial<ProxyOptions>, upstreamUrl: string): Promise<ProxyHandle> {
  const proxy = await createAnthropicCompatProxy({ upstream: upstreamUrl, transformRequest: [], ...options });
  cleanups.push(() => proxy.dispose());
  return proxy;
}

const post = (proxy: ProxyHandle, headers: Record<string, string>, body = '{"model":"m","messages":[]}') =>
  fetchOverTestConnections(new URL('/v1/messages', proxy.url), {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  });

function upgradeStatus(proxyUrl: string, headers: readonly string[] = []): Promise<string> {
  const endpoint = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(endpoint.port), endpoint.hostname);
    let data = '';
    // real-wait: bound the handshake if the proxy never answers.
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade timed out')); }, 2_000);
    socket.once('error', reject);
    socket.once('connect', () => socket.write([
      'GET /v1/responses HTTP/1.1', `Host: ${endpoint.host}`, 'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', ...headers, '', '',
    ].join('\r\n')));
    socket.on('data', chunk => { data += chunk.toString('latin1'); });
    socket.once('close', () => { clearTimeout(timer); resolve(data.split('\r\n')[0] ?? ''); });
  });
}

describe('inbound admission', () => {
  it('rejects before recovery, guards, routing and transforms, and sends nothing upstream', async () => {
    const target = await upstream();
    const recovery = vi.fn(() => null);
    const guard = vi.fn(() => null);
    const routing = vi.fn(() => null);
    const transform = vi.fn(() => null);
    const resolveWs = vi.fn(() => `${target.url.replace('http', 'ws')}/v1/responses`);
    const proxy = await start({
      authorizeInbound: ({ headers }) => headers['x-api-key'] === 'good'
        ? null : { status: 401, code: 'inbound_credentials_required', message: 'credentials required' },
      oversizedRequestRecovery: recovery, requestGuard: guard, routingTransform: routing,
      transformRequest: [transform], resolveWebSocketUpstream: resolveWs,
    }, target.url);

    for (const headers of [{}, { 'x-api-key': 'wrong' }] as Array<Record<string, string>>) {
      const res = await post(proxy, headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: 'inbound_credentials_required' } });
    }
    expect(await upgradeStatus(proxy.url)).toBe('HTTP/1.1 401 Unauthorized');
    expect(target.seen).toHaveLength(0);
    expect(target.upgrades()).toBe(0);
    for (const hook of [recovery, guard, routing, transform, resolveWs]) expect(hook).not.toHaveBeenCalled();

    const ok = await post(proxy, { 'x-api-key': 'good' });
    expect(ok.status).toBe(200);
    expect(target.seen).toHaveLength(1);
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(routing).toHaveBeenCalledTimes(1);
  });

  it('forwards the credential headers the check rewrote', async () => {
    const target = await upstream();
    const seenByRouting: string[] = [];
    const proxy = await start({
      authorizeInbound: (ctx: InboundAdmissionCtx) => {
        if (ctx.headers['x-api-key'] !== 'runtime-secret') return { status: 401, code: 'no', message: 'no' };
        ctx.headers['x-api-key'] = 'placeholder';
        return null;
      },
      routingTransform: (_body, ctx) => { seenByRouting.push(ctx.headers['x-api-key'] ?? ''); return null; },
    }, target.url);
    expect((await post(proxy, { 'x-api-key': 'runtime-secret' })).status).toBe(200);
    expect(seenByRouting).toEqual(['placeholder']);
    expect(target.seen[0]?.headers['x-api-key']).toBe('placeholder');
  });

  it('treats a throwing check as a rejection', async () => {
    const target = await upstream();
    const proxy = await start({ authorizeInbound: () => { throw new Error('boom'); } }, target.url);
    const res = await post(proxy, { 'x-api-key': 'anything' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'inbound_admission_failed' } });
    expect(target.seen).toHaveLength(0);
  });

  it('without a check, a request without credentials is forwarded as before', async () => {
    const target = await upstream();
    const proxy = await start({}, target.url);
    expect((await post(proxy, {})).status).toBe(200);
    expect(target.seen).toHaveLength(1);
  });
});
