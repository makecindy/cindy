/**
 * WS 命中 invalid_encrypted_content 后经 426 落回 HTTP 的端到端恢复。
 *
 * 实测（2026-10-18）：任务从网关模型切到 ChatGPT 订阅后，订阅后端在 WS 上回 400
 * invalid_encrypted_content，但同一历史走 HTTP 时回 200 + 一条 SSE error 事件，从不回 400。
 * 只认 400/422 的 recoveryRules 因此永远不触发，每轮都以
 * "stream closed before response.completed" 失败。
 *
 * codexProxyHost.test.ts 把剥离链路整体 mock 成 no-op，看不到请求体是否真被清洗；本文件
 * 保留真实的 strip controller / active strip transform / recovery rule，只把上游换成本地
 * 模拟订阅后端的 server。
 */
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

const proxyUpstream = vi.hoisted(() => ({ url: '' }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp/cindy-codex-encrypted-recovery-test'), getAppPath: vi.fn(() => process.cwd()) },
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));
vi.mock('../../logger.js', () => {
  const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: () => logger, getLogLevel: () => 'info', getLogDir: () => '/tmp/cindy-codex-encrypted-recovery-test/logs' };
});
vi.mock('../../clientEndpointsService.js', async () => {
  const { TEST_CLIENT_ENDPOINTS } = await import('../../../test/vitest/clientEndpointsFixture');
  return {
    getClientEndpoint: (key: keyof typeof TEST_CLIENT_ENDPOINTS) => TEST_CLIENT_ENDPOINTS[key],
  };
});
vi.mock('../../model-access/effectiveEndpoint.js', async () => {
  const { TEST_XD_GATEWAY_BASE_URL } = await import('../../../test/vitest/clientEndpointsFixture');
  return { effectiveXdGatewayBaseUrl: () => TEST_XD_GATEWAY_BASE_URL };
});
// 只把上游指向本地模拟 server；剥离相关的 transform / rule / controller 全部保持真实。
vi.mock('@cindy/anthropic-compat-proxy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/anthropic-compat-proxy')>();
  return {
    ...actual,
    createAnthropicCompatProxy: (opts: Parameters<typeof actual.createAnthropicCompatProxy>[0]) =>
      actual.createAnthropicCompatProxy({
        ...opts,
        upstream: proxyUpstream.url,
        resolveOutboundProxy: () => null,
        resolveWebSocketUpstream: (ctx) => (opts.resolveWebSocketUpstream?.(ctx) ? proxyUpstream.url : null),
        routingTransform: async (body, ctx) => ({
          ...(await opts.routingTransform?.(body, ctx)),
          upstreamOverride: proxyUpstream.url,
        }),
      }),
  };
});

import {
  armCodexHttpRecovery,
  disposeCodexProxy,
  ensureCodexProxyReady,
  getCodexProxyEndpoint,
  registerComposed,
  setCodexProxyAuthInjection,
  unregister,
} from '../codex-proxy-host';

const ENCRYPTED_ERROR = {
  type: 'error',
  status: 400,
  error: {
    type: 'invalid_request_error',
    code: 'invalid_encrypted_content',
    param: 'input',
    message: 'The encrypted content for item rs_gateway could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
  },
};

// 历史来自另一个供应商：reasoning 的密文当前账号解不开。
const HISTORY = {
  model: 'gpt-6.1-sol',
  stream: true,
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '上一轮的问题' }] },
    { type: 'reasoning', id: 'rs_gateway', summary: [], encrypted_content: 'gAAAA-issued-by-gateway' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '上一轮的回答' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
  ],
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('codex encrypted-content recovery after WebSocket → HTTP fallback', () => {
  afterEach(async () => {
    unregister('session-switched');
    await disposeCodexProxy();
  });

  it('strips undecryptable reasoning on the first HTTP replay instead of waiting for an upstream 400', async () => {
    const httpBodies: string[] = [];
    // 模拟 ChatGPT 订阅后端：WS 回 400 错误帧；HTTP 对同样的历史回 200 + SSE error，不给 400。
    const upstream = createServer(async (req, res) => {
      const body = await readBody(req);
      httpBodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      if (body.includes('encrypted_content')) {
        res.end(`event: error\ndata: ${JSON.stringify(ENCRYPTED_ERROR)}\n\n`);
        return;
      }
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_ok', output: [] } })}\n\n`);
    });
    const wss = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', () => ws.send(JSON.stringify(ENCRYPTED_ERROR)));
    }));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    proxyUpstream.url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    let client: WebSocket | null = null;
    try {
      setCodexProxyAuthInjection('oauth-bearer');
      await ensureCodexProxyReady();
      const proxyUrl = getCodexProxyEndpoint();
      registerComposed('session-switched', 'thread-switched', 'PRODUCT_PROMPT');

      client = new WebSocket(`${proxyUrl.replace(/^http/, 'ws')}/v1/responses`, { headers: { 'thread-id': 'thread-switched' } });
      await once(client, 'open');
      const rejection = once(client, 'message');
      client.send(JSON.stringify({ type: 'response.create', ...HISTORY }));
      const [frame] = await rejection;
      expect(armCodexHttpRecovery({
        sessionId: 'session-switched',
        threadId: 'thread-switched',
        message: JSON.stringify(JSON.parse(frame.toString())),
      })).toBe('encrypted_content');

      // Codex 收到 426 后改发 HTTP，带着同一份历史。
      const replay = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(`${proxyUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'thread-id': 'thread-switched' },
        }, (res) => { void readBody(res).then(resolve, reject); });
        req.once('error', reject);
        req.end(JSON.stringify(HISTORY));
      });

      expect(replay).toContain('response.completed');
      expect(httpBodies).toHaveLength(1);
      const sent = JSON.parse(httpBodies[0]!) as { input: Array<Record<string, unknown>> };
      expect(JSON.stringify(sent.input)).not.toContain('encrypted_content');
      // 可读的对话内容保持原样，只丢掉解不开的密文。
      expect(sent.input.filter((item) => item.type === 'message')).toEqual(
        HISTORY.input.filter((item) => item.type === 'message'),
      );
    } finally {
      client?.terminate();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
