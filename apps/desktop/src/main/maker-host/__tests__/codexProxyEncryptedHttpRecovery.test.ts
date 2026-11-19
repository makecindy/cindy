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

// Proxy routing does not perform standby-share cloud mutations. Keep this
// external writer outside the test process rather than booting the whole app.
vi.mock('../../device-link/providerShareAvailabilityTransport.js', () => ({
  disableShareAvailability: () => { throw new Error('Unexpected standby-share mutation in proxy test'); },
}));

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
} from '../codex-proxy-host.desktop';

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

// Test value (#11278): exercise the production host/proxy/retry chain, which the
// mocked codexProxyHost tests cannot cover. Minimal failure: a historic tool MP3
// followed by attachment-free text receives this exact 400. Unit tier, ephemeral
// loopback upstream only; no native transcript, account or provider is accessed.
const AUDIO_ERROR = { error: { type: 'invalid_request_error', param: 'input', message: 'Audio input is not available.' } };
const AUDIO_PART = { type: 'input_audio', audio_url: 'data:audio/mpeg;base64,SUQz' };
const AUDIO_HISTORY = {
  model: 'gpt-6.2-sol',
  input: [
    { type: 'custom_tool_call', id: 'ctc_audio', call_id: 'call_audio', name: 'play', input: 'music' },
    { type: 'custom_tool_call_output', id: 'ctco_audio', call_id: 'call_audio', output: [
      { type: 'input_text', text: 'Here is the recording.' }, AUDIO_PART,
      { type: 'input_image', image_url: 'https://example.invalid/cover.png' },
    ] },
    { type: 'reasoning', id: 'rs_audio', summary: [], encrypted_content: 'valid-opaque-reasoning' },
    { role: 'user', content: 'Continue with text only.' },
  ],
};

async function postReplay(body: unknown, threadId = 'thread-audio') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(`${getCodexProxyEndpoint()}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'thread-id': threadId },
    }, (res) => { void readBody(res).then(body => resolve({ status: res.statusCode!, body }), reject); });
    req.once('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('Codex historic tool audio recovery (#11278)', () => {
  afterEach(async () => {
    unregister('session-audio');
    unregister('session-other');
    await disposeCodexProxy();
  });

  it('recovers text-only replay and scopes later stripping to the recovered thread, model and upstream', async () => {
    const sent: typeof AUDIO_HISTORY[] = [];
    let acceptsAudio = false;
    const upstream = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      sent.push(body);
      const hasAudio = JSON.stringify(body.input).includes('input_audio');
      res.writeHead(hasAudio && !acceptsAudio ? 400 : 200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(hasAudio && !acceptsAudio ? AUDIO_ERROR : { id: 'resp_ok', output: [] }));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    proxyUpstream.url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const original = JSON.stringify(AUDIO_HISTORY);
    try {
      setCodexProxyAuthInjection('oauth-bearer');
      await ensureCodexProxyReady();
      registerComposed('session-audio', 'thread-audio', 'PRODUCT_PROMPT');
      registerComposed('session-other', 'thread-other', 'PRODUCT_PROMPT');
      expect((await postReplay(AUDIO_HISTORY)).status).toBe(200);
      expect(sent).toHaveLength(2);
      expect(sent[0]!.input).toEqual(AUDIO_HISTORY.input);
      const expected = structuredClone(AUDIO_HISTORY.input);
      expected[1]!.output![1] = { type: 'input_text', text: '[Audio omitted: this model does not accept audio input.]' };
      expect(sent[1]!.input).toEqual(expected);
      expect(JSON.stringify(AUDIO_HISTORY)).toBe(original);

      expect((await postReplay(AUDIO_HISTORY)).status).toBe(200);
      expect(sent).toHaveLength(3);
      expect(sent[2]!.input).toEqual(expected);
      acceptsAudio = true;
      await postReplay(AUDIO_HISTORY, 'thread-other');
      expect(sent.at(-1)!.input).toEqual(AUDIO_HISTORY.input);
      await postReplay({ ...AUDIO_HISTORY, model: 'gpt-audio' });
      expect(sent.at(-1)!.input).toEqual(AUDIO_HISTORY.input);
      // Switching back cannot resurrect the old marker.
      await postReplay(AUDIO_HISTORY);
      expect(sent.at(-1)!.input).toEqual(AUDIO_HISTORY.input);

      acceptsAudio = false;
      await postReplay(AUDIO_HISTORY);
      await disposeCodexProxy();
      await ensureCodexProxyReady();
      registerComposed('session-audio', 'thread-audio', 'PRODUCT_PROMPT');
      acceptsAudio = true;
      await postReplay(AUDIO_HISTORY);
      expect(sent.at(-1)!.input).toEqual(AUDIO_HISTORY.input);

      acceptsAudio = false;
      await postReplay(AUDIO_HISTORY);
      acceptsAudio = true;
      // Same wire model on a different upstream must be tried with intact audio.
      proxyUpstream.url += '/alternate';
      await postReplay(AUDIO_HISTORY);
      expect(sent.at(-1)!.input).toEqual(AUDIO_HISTORY.input);

      acceptsAudio = false;
      await postReplay(AUDIO_HISTORY);
      unregister('session-audio');
      registerComposed('session-audio', 'thread-audio', 'PRODUCT_PROMPT');
      acceptsAudio = true;
      await postReplay(AUDIO_HISTORY);
      expect(sent.at(-1)!.input).toEqual(AUDIO_HISTORY.input);
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it('does not retry unrelated failures or user audio, and retries a matching rejection at most once', async () => {
    const sent: unknown[] = [];
    let error = AUDIO_ERROR;
    let status = 400;
    const upstream = createServer(async (req, res) => {
      sent.push(JSON.parse(await readBody(req)));
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(error));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    proxyUpstream.url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    try {
      setCodexProxyAuthInjection('oauth-bearer');
      await ensureCodexProxyReady();
      registerComposed('session-audio', 'thread-audio', 'PRODUCT_PROMPT');
      error = { error: { ...AUDIO_ERROR.error, message: 'Invalid audio format.' } };
      expect((await postReplay(AUDIO_HISTORY)).status).toBe(400);
      expect(sent).toHaveLength(1);
      error = AUDIO_ERROR;
      status = 500;
      expect((await postReplay(AUDIO_HISTORY)).status).toBe(500);
      expect(sent).toHaveLength(2);
      status = 400;
      expect((await postReplay({ model: AUDIO_HISTORY.model, input: [{ role: 'user', content: [AUDIO_PART] }] })).status).toBe(400);
      expect(sent).toHaveLength(3);
      const rejected = await postReplay(AUDIO_HISTORY);
      expect(rejected.status).toBe(400);
      expect(JSON.parse(rejected.body)).toEqual(AUDIO_ERROR);
      expect(sent).toHaveLength(5);
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});

describe('codex body recovery after WebSocket → HTTP fallback', () => {
  afterEach(async () => {
    unregister('session-switched');
    await disposeCodexProxy();
  });

  it.each([
    { reason: 'encrypted_content', history: HISTORY, error: ENCRYPTED_ERROR, rejectedField: 'encrypted_content' },
    { reason: 'responses_tool_audio', history: { ...AUDIO_HISTORY, stream: true }, error: { type: 'error', status: 400, ...AUDIO_ERROR }, rejectedField: 'input_audio' },
  ])('repairs $reason on the first HTTP replay instead of waiting for an upstream 400', async ({ reason, history, error, rejectedField }) => {
    const httpBodies: string[] = [];
    // 模拟 ChatGPT 订阅后端：WS 回 400 错误帧；HTTP 对同样的历史回 200 + SSE error，不给 400。
    const upstream = createServer(async (req, res) => {
      const body = await readBody(req);
      httpBodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      if (body.includes(rejectedField)) {
        res.end(`event: error\ndata: ${JSON.stringify(error)}\n\n`);
        return;
      }
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_ok', output: [] } })}\n\n`);
    });
    const wss = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', () => ws.send(JSON.stringify(error)));
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
      client.send(JSON.stringify({ type: 'response.create', ...history }));
      const [frame] = await rejection;
      expect(armCodexHttpRecovery({
        sessionId: 'session-switched',
        threadId: 'thread-switched',
        message: JSON.stringify(JSON.parse(frame.toString())),
      })).toBe(reason);

      // Codex 收到 426 后改发 HTTP，带着同一份历史。
      const replay = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(`${proxyUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'thread-id': 'thread-switched' },
        }, (res) => { void readBody(res).then(resolve, reject); });
        req.once('error', reject);
        req.end(JSON.stringify(history));
      });

      expect(replay).toContain('response.completed');
      expect(httpBodies).toHaveLength(1);
      const sent = JSON.parse(httpBodies[0]!) as { input: Array<Record<string, unknown>> };
      expect(JSON.stringify(sent.input)).not.toContain(rejectedField);
      if (reason === 'responses_tool_audio') {
        expect(sent.input[1]).toMatchObject({ id: 'ctco_audio', call_id: 'call_audio' });
        expect(sent.input[2]).toEqual(AUDIO_HISTORY.input[2]);
        expect(sent.input[3]).toEqual(AUDIO_HISTORY.input[3]);
      }
      // 可读的对话内容保持原样，只丢掉解不开的密文。
      expect(sent.input.filter((item) => item.type === 'message')).toEqual(
        history.input.filter((item) => item.type === 'message'),
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
