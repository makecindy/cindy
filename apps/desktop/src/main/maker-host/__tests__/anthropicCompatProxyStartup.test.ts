/**
 * 测试价值（放行表第 24 行，24a）
 * - 可观察结果：走桌面真实的启动路径。ensureAnthropicCompatProxyReady 起代理前，
 *   getClaudeEndpoint 回落到上游地址；起来后是 127.0.0.1 回环地址；一条带网关 key 的
 *   Claude 请求经代理原样到达本机模拟上游，响应带回；关闭后又回落到上游地址。
 * - 规则依据：anthropic-compat-proxy-host.ts（现在只建桌面实例，实现在
 *   anthropicCompatProxyHostCore.ts）；bootstrap-electron.ts 建任务前 await 就绪、退出时关闭。
 * - 最小失败输入：绑定没把端口接到核心（上游地址读不到）、实例没起来、启动失败后回落直连。
 * - tier：integration（真实代理包与本机 HTTP 服务；假 key，不调模型）。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ upstream: '' }));
vi.mock('../runtime-configs', () => ({ claudeUpstreamEndpoint: () => state.upstream }));

describe('the desktop Claude proxy built from the shared core', () => {
  const requests: Array<{ url?: string; key?: string | string[]; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      requests.push({ url: req.url, key: req.headers['x-api-key'], body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const savedProxyEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // The upstream is local; no inherited proxy setting may redirect it.
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      savedProxyEnv[key] = process.env[key];
      delete process.env[key];
    }
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    state.upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(savedProxyEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('starts on loopback, forwards a Claude request to the upstream, and falls back after dispose', async () => {
    const proxy = await import('../anthropic-compat-proxy-host.js');
    expect(proxy.isAnthropicCompatProxyHandleReady()).toBe(false);
    expect(proxy.getClaudeEndpoint()).toBe(state.upstream);
    await proxy.ensureAnthropicCompatProxyReady();
    expect(proxy.isAnthropicCompatProxyHandleReady()).toBe(true);
    const endpoint = new URL(proxy.getClaudeEndpoint());
    expect(endpoint.hostname).toBe('127.0.0.1');
    expect(endpoint.origin).not.toBe(new URL(state.upstream).origin);

    const response = await fetch(new URL('/v1/messages', endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'fake-gateway-key', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { id: string }).id).toBe('msg_fixture');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: '/v1/messages', key: 'fake-gateway-key' });
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: 'claude-sonnet-4-5' });

    await proxy.disposeAnthropicCompatProxy();
    expect(proxy.isAnthropicCompatProxyHandleReady()).toBe(false);
    expect(proxy.getClaudeEndpoint()).toBe(state.upstream);
  }, 60_000);
});
