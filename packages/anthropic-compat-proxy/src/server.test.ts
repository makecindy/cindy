import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAnthropicCompatProxy,
  isFetchBlockedPort,
  listenOnFetchSafeLoopbackPort,
} from './server.js';
import {
  createActiveStripTransform,
  createEmptyAssistantMessageRecoveryRule,
  createEmptyThinkingRecoveryRule,
  createEncryptedContentRecoveryRule,
  createImageGenerationIdRecoveryRule,
  createToolUseProviderSpecificFieldsRecoveryRule,
  stripEncryptedContentFromBody,
} from './transform.js';
import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import { createThreadStripController } from './thread-strip-controller.js';
import type { ProxyHandle } from './types.js';

function startFakeUpstream(
  handler: (reqIndex: number, body: string, res: ServerResponse) => void,
): Promise<{ url: string; bodies: string[]; headers: Array<Record<string, string>>; paths: string[]; close: () => Promise<void> }> {
  const bodies: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const paths: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const idx = bodies.length;
      bodies.push(body);
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      headers.push(flat);
      paths.push(req.url ?? '');
      handler(idx, body, res);
    });
  });
  return listenOnAvailableLoopbackPort(server).then((port) => ({
    url: `http://127.0.0.1:${port}`,
    bodies,
    headers,
    paths,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }));
}

const ENC_ERROR_BODY = JSON.stringify({
  error: { message: 'Encrypted content gAAA... could not be decrypted or parsed.', code: 'invalid_encrypted_content' },
});

const XAI_ENC_ERROR_BODY = JSON.stringify({
  code: 'invalid-argument',
  error: 'Could not decrypt the provided encrypted_content. Ensure the value is the unmodified encrypted_content from a previous response.',
});

const IMAGE_GENERATION_ID_ERROR_BODY = JSON.stringify({
  error: {
    message: 'Image generation items without `id` are not supported for this request.',
    type: 'invalid_request_error',
    param: 'input',
    code: null,
  },
});

const TOOL_USE_PROVIDER_SPECIFIC_FIELDS_ERROR_BODY = JSON.stringify({
  error: {
    message: 'messages.2.content.0.tool_use.provider_specific_fields: Extra inputs are not permitted',
    type: 'invalid_request_error',
  },
});

let proxy: ProxyHandle | null = null;
let upstreamClose: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (proxy) { await proxy.dispose(); proxy = null; }
  if (upstreamClose) { await upstreamClose(); upstreamClose = null; }
});

async function post(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'thread-id': 'thread-a' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe('anthropic-compat-proxy loopback port guard', () => {
  it('tracks Fetch standard bad ports used by HTTP clients', () => {
    expect(isFetchBlockedPort(6000)).toBe(true);
    expect(isFetchBlockedPort(6001)).toBe(false);
    expect(isFetchBlockedPort(6063)).toBe(false);
    expect(isFetchBlockedPort(6566)).toBe(true);
    expect(isFetchBlockedPort(6667)).toBe(true);
    expect(isFetchBlockedPort(6679)).toBe(true);
    expect(isFetchBlockedPort(10080)).toBe(true);
    expect(isFetchBlockedPort(49152)).toBe(false);
  });

  it('returns a proxy URL that fetch can request directly', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreamClose = upstream.close;

    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
    });

    const port = Number(new URL(proxy.url).port);
    expect(isFetchBlockedPort(port)).toBe(false);

    const result = await post(proxy.url, { model: 'test-model' });
    expect(result).toEqual({ status: 200, text: JSON.stringify({ ok: true }) });
  });

  it('jumps out of a Windows excluded-port range after EACCES and cleans listeners', async () => {
    const attemptedPorts: number[] = [];
    let boundPort = 0;
    const fakeServer = new EventEmitter() as EventEmitter & {
      address: () => { address: string; family: string; port: number } | null;
      listen: (port: number) => void;
    };
    fakeServer.address = () => boundPort === 0
      ? null
      : { address: '127.0.0.1', family: 'IPv4', port: boundPort };
    fakeServer.listen = (port: number) => {
      attemptedPorts.push(port);
      queueMicrotask(() => {
        if (attemptedPorts.length === 1) {
          fakeServer.emit(
            'error',
            Object.assign(new Error('permission denied'), { code: 'EACCES' }),
          );
          return;
        }
        boundPort = port;
        fakeServer.emit('listening');
      });
    };

    const random = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.05)
      .mockReturnValueOnce(0.75);
    try {
      const port = await listenOnFetchSafeLoopbackPort(
        fakeServer as unknown as Server,
        '127.0.0.1',
        {},
      );
      expect(port).toBe(61440);
      expect(attemptedPorts).toEqual([49971, 61440]);
      expect(fakeServer.listenerCount('error')).toBe(0);
      expect(fakeServer.listenerCount('listening')).toBe(0);
    } finally {
      random.mockRestore();
    }
  });

  it('closes a listening proxy server before rejecting an invalid address', async () => {
    let closed = false;
    const fakeServer = new EventEmitter() as EventEmitter & {
      address: () => null;
      close: (callback: () => void) => void;
      listen: () => void;
    };
    fakeServer.address = () => null;
    fakeServer.close = (callback) => {
      closed = true;
      queueMicrotask(callback);
    };
    fakeServer.listen = () => queueMicrotask(() => fakeServer.emit('listening'));

    await expect(listenOnFetchSafeLoopbackPort(
      fakeServer as unknown as Server,
      '127.0.0.1',
      {},
    )).rejects.toThrow('anthropic-compat-proxy: failed to bind loopback port');
    expect(closed).toBe(true);
    expect(fakeServer.listenerCount('error')).toBe(0);
    expect(fakeServer.listenerCount('listening')).toBe(0);
  });

  it('closes a listening test server before rejecting an invalid address', async () => {
    let closed = false;
    const fakeServer = new EventEmitter() as EventEmitter & {
      address: () => null;
      close: (callback: () => void) => void;
      listen: () => void;
    };
    fakeServer.address = () => null;
    fakeServer.close = (callback) => {
      closed = true;
      queueMicrotask(callback);
    };
    fakeServer.listen = () => queueMicrotask(() => fakeServer.emit('listening'));

    await expect(
      listenOnAvailableLoopbackPort(fakeServer as unknown as Server),
    ).rejects.toThrow('test loopback server failed to resolve its listening port');
    expect(closed).toBe(true);
    expect(fakeServer.listenerCount('error')).toBe(0);
    expect(fakeServer.listenerCount('listening')).toBe(0);
  });

  it('reports a stable Error after exhausting test-server bind retries', async () => {
    const fakeServer = new EventEmitter() as EventEmitter & {
      address: () => null;
      listen: () => void;
    };
    fakeServer.address = () => null;
    fakeServer.listen = () => queueMicrotask(() => {
      fakeServer.emit(
        'error',
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );
    });

    await expect(
      listenOnAvailableLoopbackPort(fakeServer as unknown as Server),
    ).rejects.toThrow(
      'test loopback server failed to bind after 32 attempts; last error permission denied',
    );
    expect(fakeServer.listenerCount('error')).toBe(0);
    expect(fakeServer.listenerCount('listening')).toBe(0);
  });
});

describe('anthropic-compat-proxy tool_use provider field compatibility', () => {
  const bodyWithProviderSpecificFields = {
    model: 'claude-fable-5',
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'Get-ChildItem' },
            provider_specific_fields: null,
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ],
  };

  it('strips tool_use.provider_specific_fields before forwarding by default', async () => {
    const upstream = await startFakeUpstream((_idx, body, res) => {
      expect(body).not.toContain('provider_specific_fields');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreamClose = upstream.close;

    proxy = await createAnthropicCompatProxy({ upstream: upstream.url });

    const r = await post(proxy.url, bodyWithProviderSpecificFields);

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(1);
  });

  it('strips and retries once when LiteLLM rejects the provider field', async () => {
    const upstream = await startFakeUpstream((idx, body, res) => {
      if (idx === 0) {
        expect(body).toContain('provider_specific_fields');
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(TOOL_USE_PROVIDER_SPECIFIC_FIELDS_ERROR_BODY);
        return;
      }
      expect(body).not.toContain('provider_specific_fields');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createToolUseProviderSpecificFieldsRecoveryRule()],
    });

    const r = await post(proxy.url, bodyWithProviderSpecificFields);

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
  });
});

describe('anthropic-compat-proxy encrypted content retry', () => {
  it('retries invalid_encrypted_content once when enabled and marks the thread active', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(ENC_ERROR_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, attempt: idx }));
      }
    });
    upstreamClose = upstream.close;
    let marked: { threadId: string; model: string } | null = null;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEncryptedContentRecoveryRule({
        enabled: () => true,
        onRetry: (threadId, model) => { marked = { threadId, model }; },
      })],
    });

    const r = await post(proxy.url, { model: 'gpt-5.5', input: [{ type: 'reasoning', encrypted_content: 'gAAAsecret' }] });

    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ ok: true });
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[0]).toContain('encrypted_content');
    expect(upstream.bodies[1]).not.toContain('encrypted_content');
    expect(marked).toEqual({ threadId: 'thread-a', model: 'gpt-5.5' });
  });

  it('retries xAI encrypted_content decrypt failures on 422', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(XAI_ENC_ERROR_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, attempt: idx }));
      }
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEncryptedContentRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, { model: 'grok-4.5', input: [{ type: 'reasoning', encrypted_content: 'gAAAsecret' }] });

    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ ok: true });
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[0]).toContain('encrypted_content');
    expect(upstream.bodies[1]).not.toContain('encrypted_content');
  });

  it('keeps proactive stripping active when a provider transform rewrites the model id', async () => {
    const upstream = await startFakeUpstream((_idx, body, res) => {
      if (body.includes('encrypted_content')) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(XAI_ENC_ERROR_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    upstreamClose = upstream.close;
    const controller = createThreadStripController();
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [
        createActiveStripTransform({
          controller,
          enabled: () => true,
          strip: stripEncryptedContentFromBody,
        }),
        (body) => {
          const request = body as { model?: unknown };
          if (typeof request.model !== 'string' || !request.model.startsWith('xai/')) return null;
          return { ...request, model: request.model.slice('xai/'.length) };
        },
      ],
      recoveryRules: [createEncryptedContentRecoveryRule({
        enabled: () => true,
        onRetry: (threadId, model) => controller.markActive(threadId, model),
      })],
    });
    const body = {
      model: 'xai/grok-4.5',
      input: [{ type: 'reasoning', encrypted_content: 'gAAAsecret' }],
    };

    expect((await post(proxy.url, body)).status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect((await post(proxy.url, body)).status).toBe(200);

    // 第二轮应在发上游前主动剥离，只新增一次请求；若 marker 错记成改写后的
    // grok-4.5，会被入站 xai/grok-4.5 reconcile 清掉，再次产生 422 + retry。
    expect(upstream.bodies).toHaveLength(3);
    expect(upstream.bodies[2]).not.toContain('encrypted_content');
    expect(upstream.bodies.map((requestBody) => JSON.parse(requestBody).model)).toEqual([
      'grok-4.5',
      'grok-4.5',
      'grok-4.5',
    ]);
  });

  it('returns invalid_encrypted_content 400 without retry when disabled', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(ENC_ERROR_BODY);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEncryptedContentRecoveryRule({ enabled: () => false })],
    });

    const r = await post(proxy.url, { model: 'gpt-5.5', input: [{ encrypted_content: 'gAAA' }] });

    expect(r.status).toBe(400);
    expect(upstream.bodies).toHaveLength(1);
  });

  it('passes through ordinary 400 responses without retry', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Unknown parameter: 'foo'", code: 'invalid_request_error' } }));
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEncryptedContentRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, { model: 'gpt-5.5', input: [{ encrypted_content: 'gAAA' }] });

    expect(r.status).toBe(400);
    expect(r.text).toContain('Unknown parameter');
    expect(upstream.bodies).toHaveLength(1);
  });

  it('returns original 400 when the request has no encrypted_content to strip', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(ENC_ERROR_BODY);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEncryptedContentRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, { model: 'gpt-5.5', input: [{ role: 'user', content: 'hi' }] });

    expect(r.status).toBe(400);
    expect(upstream.bodies).toHaveLength(1);
  });

  it('passes through 2xx requests without proactive stripping', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({ upstream: upstream.url, transformRequest: [] });

    const r = await post(proxy.url, { model: 'gpt-5.5', input: [{ encrypted_content: 'gAAA' }] });

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(1);
    expect(upstream.bodies[0]).toContain('encrypted_content');
  });

  it('does not retry a second time after retry still returns invalid_encrypted_content', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(ENC_ERROR_BODY);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEncryptedContentRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, { model: 'gpt-5.5', input: [{ encrypted_content: 'gAAA' }] });

    expect(r.status).toBe(400);
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[1]).not.toContain('encrypted_content');
  });
});

describe('anthropic-compat-proxy image generation id retry', () => {
  it('applies other safe recovery strippers before the single retry', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(ENC_ERROR_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, attempt: idx }));
      }
    });
    upstreamClose = upstream.close;
    const marked: string[] = [];
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [
        createEncryptedContentRecoveryRule({
          enabled: () => true,
          onRetry: (threadId, model) => { marked.push(`encrypted:${threadId}:${model}`); },
        }),
        createImageGenerationIdRecoveryRule({
          onRetry: (threadId, model) => { marked.push(`image:${threadId}:${model}`); },
        }),
      ],
    });

    const r = await post(proxy.url, {
      model: 'gpt-5.5',
      tools: [{ type: 'image_generation' }],
      input: [
        { type: 'reasoning', encrypted_content: 'gAAA' },
        { type: 'image_generation_end', call_id: 'ig_1', result: 'data:image/png;base64,xxx' },
        { type: 'image_generation_call', id: 'ig_1', result: 'data:image/png;base64,xxx' },
      ],
    });

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[1]).not.toContain('encrypted_content');
    expect(upstream.bodies[1]).not.toContain('image_generation_end');
    expect(upstream.bodies[1]).toContain('image_generation_call');
    expect(upstream.bodies[1]).toContain('"tools":[{"type":"image_generation"}]');
    expect(marked).toEqual(['encrypted:thread-a:gpt-5.5', 'image:thread-a:gpt-5.5']);
  });

  it('retries once after removing image generation history items without id', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(IMAGE_GENERATION_ID_ERROR_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, attempt: idx }));
      }
    });
    upstreamClose = upstream.close;
    let marked: { threadId: string; model: string } | null = null;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createImageGenerationIdRecoveryRule({
        onRetry: (threadId, model) => { marked = { threadId, model }; },
      })],
    });

    const r = await post(proxy.url, {
      model: 'gpt-5.5',
      input: [
        { type: 'image_generation_end', call_id: 'ig_1', result: 'data:image/png;base64,xxx' },
        { type: 'image_generation_call', id: 'ig_1', result: 'data:image/png;base64,xxx' },
      ],
    });

    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ ok: true });
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[0]).toContain('image_generation_end');
    expect(upstream.bodies[1]).not.toContain('image_generation_end');
    expect(upstream.bodies[1]).toContain('image_generation_call');
    expect(marked).toEqual({ threadId: 'thread-a', model: 'gpt-5.5' });
  });
});

async function postWithAuth(url: string, body: unknown, authorization: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'thread-id': 'thread-a', authorization },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe('anthropic-compat-proxy routingTransform', () => {
  it('routes an explicit upstream override without resolving an unavailable default upstream', async () => {
    const custom = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'custom' }));
    });
    upstreamClose = custom.close;

    proxy = await createAnthropicCompatProxy({
      upstream: () => '',
      transformRequest: [],
      routingTransform: () => ({ upstreamOverride: custom.url }),
    });

    const result = await post(proxy.url, { model: 'custom-model' });
    expect(result).toEqual({ status: 200, text: JSON.stringify({ from: 'custom' }) });
    expect(custom.bodies).toHaveLength(1);
  });

  it('forwards to an exact same-origin path override instead of appending the client path', async () => {
    const custom = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamClose = custom.close;

    proxy = await createAnthropicCompatProxy({
      upstream: `${custom.url}/base`,
      transformRequest: [],
      routingTransform: () => ({ pathOverride: '/tenant/acme/infer?stream=1' }),
    });

    await post(proxy.url, { model: 'custom-model' });
    expect(custom.paths).toEqual(['/base/tenant/acme/infer?stream=1']);
  });

  it('accepts a root override when the upstream base already names the endpoint', async () => {
    const custom = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamClose = custom.close;

    proxy = await createAnthropicCompatProxy({
      upstream: `${custom.url}/inference-endpoint`,
      transformRequest: [],
      routingTransform: () => ({ pathOverride: '/' }),
    });

    await post(proxy.url, { model: 'custom-model' });
    expect(custom.paths).toEqual(['/inference-endpoint/']);
  });

  it('preserves the upstream base query when applying a path override', async () => {
    const custom = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamClose = custom.close;

    proxy = await createAnthropicCompatProxy({
      upstream: `${custom.url}/base?tenant=acme`,
      transformRequest: [],
      routingTransform: () => ({ pathOverride: '/infer?stream=1&next=%2fadmin' }),
    });

    await post(proxy.url, { model: 'custom-model' });
    expect(custom.paths).toEqual(['/base/infer?tenant=acme&stream=1&next=%2fadmin']);
  });

  it.each([
    '//evil.example/infer',
    '/infer#fragment',
    '/infer\r\nx-injected: yes',
    '/my path',
    '/infer\tmode',
    '/infer\u0000mode',
    '/infer\u007fmode',
    '/infer\u0085mode',
    '/café',
    '/../admin',
    '/.%2e/admin',
    '/%2e%2e%2fadmin',
    '/safe%5Cpart',
    '/a<b',
    '/infer%2',
    '/%ZZ',
    '/模型',
    '/v1\\messages',
    `/${'a'.repeat(2_048)}`,
  ])('rejects an unsafe path override before contacting the upstream: %j', async (pathOverride) => {
    const custom = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamClose = custom.close;

    proxy = await createAnthropicCompatProxy({
      upstream: `${custom.url}/base`,
      transformRequest: [],
      routingTransform: () => ({ pathOverride }),
    });

    const result = await post(proxy.url, { model: 'custom-model' });
    expect(result.status).toBe(502);
    expect(JSON.parse(result.text)).toEqual({
      error: { type: 'proxy_error', message: 'selected request path invalid' },
    });
    expect(custom.paths).toHaveLength(0);
  });

  it('runs a local handler without resolving an unavailable default upstream', async () => {
    proxy = await createAnthropicCompatProxy({
      upstream: () => '',
      transformRequest: [],
      routingTransform: () => ({
        localHandler: async ({ res }) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ from: 'local-handler' }));
        },
      }),
    });

    const result = await post(proxy.url, { model: 'subscription-direct-model' });
    expect(result).toEqual({ status: 200, text: JSON.stringify({ from: 'local-handler' }) });
  });

  it('returns a controlled 503 only when the request actually needs an unavailable default upstream', async () => {
    proxy = await createAnthropicCompatProxy({
      upstream: () => '',
      transformRequest: [],
      routingTransform: () => ({ headerOverride: { authorization: 'Bearer gateway-key' } }),
    });

    const result = await post(proxy.url, { model: 'gateway-model' });
    expect(result.status).toBe(503);
    expect(JSON.parse(result.text)).toEqual({
      error: { type: 'proxy_error', message: 'default upstream unavailable' },
    });
  });

  it('awaits async routingTransform decisions before forwarding', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'gateway' }));
    });
    const xai = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'xai' }));
    });
    upstreamClose = async () => { await gateway.close(); await xai.close(); };

    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: async () => ({
        upstreamOverride: xai.url,
        headerOverride: { authorization: 'Bearer xai-token' },
      }),
    });

    const r = await postWithAuth(proxy.url, { model: 'xai/grok-4.3', input: [] }, 'Bearer openai-token');
    expect(JSON.parse(r.text)).toMatchObject({ from: 'xai' });
    expect(xai.headers.at(-1)?.authorization).toBe('Bearer xai-token');
    expect(gateway.bodies).toHaveLength(0);
  });

  it('overrides upstream and authorization header per request', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'gateway' }));
    });
    const chatgpt = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'chatgpt' }));
    });
    upstreamClose = async () => { await gateway.close(); await chatgpt.close(); };

    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: (body) => {
        const model = (body as { model?: string }).model ?? '';
        // 折扣: 默认 upstream(gateway) + 换 gateway key; 普通: override 到 chatgpt + 透传原 auth
        if (model.startsWith('codex/')) return { headerOverride: { authorization: 'Bearer gw-key' } };
        return { upstreamOverride: chatgpt.url };
      },
    });

    const r1 = await postWithAuth(proxy.url, { model: 'codex/gpt-5.5', input: [] }, 'Bearer oauth-token');
    expect(JSON.parse(r1.text)).toMatchObject({ from: 'gateway' });
    expect(gateway.headers.at(-1)?.authorization).toBe('Bearer gw-key');

    const r2 = await postWithAuth(proxy.url, { model: 'gpt-5.5', input: [] }, 'Bearer oauth-token');
    expect(JSON.parse(r2.text)).toMatchObject({ from: 'chatgpt' });
    expect(chatgpt.headers.at(-1)?.authorization).toBe('Bearer oauth-token');
  });

  it('deletes headers after merging headerOverride (e.g. strip the OAuth beta for gateway models)', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'gateway' }));
    });
    upstreamClose = gateway.close;

    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      // 模拟 OAuth 模式: provider 路由模型换 gateway key 并抹掉 OAuth 专用 beta header。
      // claude-* 透传(不动 header, 保留 oauth beta)。
      routingTransform: (body) => {
        const model = (body as { model?: string }).model ?? '';
        if (model.startsWith('claude-')) return null;
        return { headerOverride: { authorization: 'Bearer gw-key' }, headerDelete: ['anthropic-beta'] };
      },
    });

    // provider 路由模型: 客户端带 oauth bearer + oauth beta → 上游应收到 gateway key 且无 beta。
    const provider = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'thread-id': 'thread-a',
        authorization: 'Bearer oauth-token',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body: JSON.stringify({ model: 'gpt-5.5', messages: [] }),
    });
    expect(JSON.parse(await provider.text())).toMatchObject({ from: 'gateway' });
    expect(gateway.headers.at(-1)?.authorization).toBe('Bearer gw-key');
    expect(gateway.headers.at(-1)?.['anthropic-beta']).toBeUndefined();

    // claude-* 透传: header 原样保留(decision=null)。
    const anthropic = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'thread-id': 'thread-a',
        authorization: 'Bearer oauth-token',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
    });
    await anthropic.text();
    expect(gateway.headers.at(-1)?.authorization).toBe('Bearer oauth-token');
    expect(gateway.headers.at(-1)?.['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('routes by the ORIGINAL body even when a transform rewrites model', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    const chatgpt = await startFakeUpstream((_i, _b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    upstreamClose = async () => { await gateway.close(); await chatgpt.close(); };

    proxy = await createAnthropicCompatProxy({
      upstream: chatgpt.url,
      // transform 去掉 codex/ 前缀(发上游的 body.model 变 gpt-5.5)
      transformRequest: [(body) => {
        const b = body as { model?: string };
        if (typeof b.model === 'string' && b.model.startsWith('codex/')) return { ...b, model: b.model.slice('codex/'.length) };
        return null;
      }],
      // routing 看原始 body, 仍能识别 codex/ 前缀 → 落 gateway
      routingTransform: (body) => {
        const model = (body as { model?: string }).model ?? '';
        return model.startsWith('codex/') ? { upstreamOverride: gateway.url } : null;
      },
    });

    await post(proxy.url, { model: 'codex/gpt-5.5', input: [] });
    expect(gateway.bodies).toHaveLength(1);
    expect(chatgpt.bodies).toHaveLength(0);
    expect(JSON.parse(gateway.bodies[0]).model).toBe('gpt-5.5'); // 发上游已去前缀
  });

  it('without routingTransform, always uses default upstream (backward compat)', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    upstreamClose = gateway.close;
    proxy = await createAnthropicCompatProxy({ upstream: gateway.url, transformRequest: [] });
    await post(proxy.url, { model: 'gpt-5.5', input: [] });
    expect(gateway.bodies).toHaveLength(1);
  });

  it('runs routingTransform for body-less GET (e.g. /models poll) with undefined body and applies upstreamOverride', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ from: 'gateway' })); });
    // 模拟"凭证原生后端"(codex 的 /models 在 oauth 态应被 override 到这里)。
    const official = await startFakeUpstream((_i, _b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ from: 'official' })); });
    upstreamClose = async () => { await gateway.close(); await official.close(); };

    let bodyForGet: unknown = 'untouched';
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: (body, ctx) => {
        // GET 没有 body → routingTransform 现在也会被调用,body 为 undefined,可据 url 路由控制面请求。
        if (ctx.method === 'GET' && ctx.url.startsWith('/models')) {
          bodyForGet = body;
          return { upstreamOverride: official.url };
        }
        return null;
      },
    });

    const res = await fetch(`${proxy.url}/models?client_version=0.135.0`, { method: 'GET' });
    expect(JSON.parse(await res.text())).toMatchObject({ from: 'official' });
    expect(bodyForGet).toBeUndefined();              // GET 以 undefined body 调 transform
    expect(official.paths.at(-1)).toContain('/models');
    expect(gateway.bodies).toHaveLength(0);          // 没掉默认上游
  });

  it('GET with a null-returning routingTransform still uses default upstream (backward compat)', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ from: 'gateway' })); });
    upstreamClose = gateway.close;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: () => null, // 任何请求都不 override
    });
    const res = await fetch(`${proxy.url}/models`, { method: 'GET' });
    expect(JSON.parse(await res.text())).toMatchObject({ from: 'gateway' });
    expect(gateway.paths.at(-1)).toContain('/models');
  });

  it('▶ inbound 日志的 upstreamBase 显示本请求**最终**发往的 upstream(override / 默认)', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    // 模拟"订阅直连"上游(per-session 选 Anthropic 时 routingTransform 会 override 到它)。
    const direct = await startFakeUpstream((_i, _b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    upstreamClose = async () => { await gateway.close(); await direct.close(); };

    const debugs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      // gpt-* → override 到 direct(订阅直连);其余 → null(走默认 gateway upstream)。
      routingTransform: (body) => {
        const model = (body as { model?: string }).model ?? '';
        return model.startsWith('gpt-') ? { upstreamOverride: direct.url } : null;
      },
      logger: { isDebugEnabled: () => true, debug: (msg, ctx) => debugs.push({ msg, ctx }) },
    });

    // override 命中 → inbound 日志的 upstreamBase 是最终落点(direct),不是默认 gateway。
    await post(proxy.url, { model: 'gpt-5.5', input: [] });
    expect(debugs.find((d) => d.msg.includes('inbound request'))?.ctx?.upstreamBase).toBe(direct.url);

    // 无 override(decision=null)→ inbound 日志回落默认上游 gateway。
    debugs.length = 0;
    await post(proxy.url, { model: 'claude-opus-4-8', input: [] });
    expect(debugs.find((d) => d.msg.includes('inbound request'))?.ctx?.upstreamBase).toBe(gateway.url);
  });

  it('decodes a gzip-encoded non-2xx error body for errorType + debug dump', async () => {
    const errorJson = JSON.stringify({
      error: { message: 'Rate limit reached for gpt-5.5', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    });
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from(errorJson, 'utf8')));
    });
    upstreamClose = upstream.close;

    const warns: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      logger: { isDebugEnabled: () => true, warn: (msg, ctx) => warns.push({ msg, ctx }) },
    });

    const r = await post(proxy.url, { model: 'codex/gpt-5.5', input: [] });

    // 客户端侧: pipe + content-encoding 透传, undici 自动解压 → 拿到可读 JSON, 功能不受影响。
    expect(r.status).toBe(429);
    expect(JSON.parse(r.text)).toMatchObject({ error: { type: 'rate_limit_error' } });

    // 日志侧: 解压后才能抽出 errorType, dump 出的 body 是可读 JSON 而不是 gzip 乱码。
    const warn = warns.find((w) => w.msg.includes('non-2xx'));
    expect(warn?.ctx?.errorType).toBe('rate_limit_error');
    expect(String(warn?.ctx?.body)).toContain('Rate limit reached');
    expect(String(warn?.ctx?.body)).not.toContain('�'); // 无 replacement char(乱码标志)
  });

  it('detects gzip-encoded invalid_encrypted_content and still triggers transparent retry', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync(Buffer.from(ENC_ERROR_BODY, 'utf8')));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEncryptedContentRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, { model: 'gpt-5.5', input: [{ encrypted_content: 'gAAA' }] });

    // gzip 压缩的 400 错误体也能被识别 → 剥离 encrypted_content 重试一次 → 第二次 200。
    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[1]).not.toContain('encrypted_content');
  });

  it('encrypted retry after override still hits the override upstream', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    const chatgpt = await startFakeUpstream((idx, _b, res) => {
      if (idx === 0) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(ENC_ERROR_BODY); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }
    });
    upstreamClose = async () => { await gateway.close(); await chatgpt.close(); };

    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: () => ({ upstreamOverride: chatgpt.url }),
      recoveryRules: [createEncryptedContentRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, { model: 'gpt-5.5', input: [{ encrypted_content: 'gAAA' }] });
    expect(r.status).toBe(200);
    expect(chatgpt.bodies).toHaveLength(2); // 首次 400 + 重试都落 override upstream
    expect(gateway.bodies).toHaveLength(0);
  });

  it('tees successful responses to responseObserver without changing the response', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_123', service_tier: 'priority' }));
    });
    upstreamClose = upstream.close;
    const chunks: string[] = [];
    let observedEnd = false;
    let transformedReqId: number | null = null;
    let observedCtx: { reqId: number; url: string; status: number; upstreamBase: string } | null = null;
    const upstreamWithQuery = `${upstream.url}/tenant/acme?region=us`;
    proxy = await createAnthropicCompatProxy({
      upstream: upstreamWithQuery,
      transformRequest: [(_body, ctx) => {
        transformedReqId = ctx.reqId;
        return null;
      }],
      responseObserver: (ctx) => {
        observedCtx = {
          reqId: ctx.reqId,
          url: ctx.url,
          status: ctx.status,
          upstreamBase: ctx.upstreamBase,
        };
        return {
          onData: (chunk) => chunks.push(chunk.toString('utf8')),
          onEnd: () => { observedEnd = true; },
        };
      },
    });

    const r = await post(proxy.url, { model: 'gpt-5.5', input: [] });

    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ id: 'resp_123', service_tier: 'priority' });
    expect(transformedReqId).toBeTypeOf('number');
    expect(observedCtx).toEqual({
      reqId: transformedReqId,
      url: '/v1/responses',
      status: 200,
      upstreamBase: upstreamWithQuery,
    });
    expect(chunks.join('')).toBe(r.text);
    expect(observedEnd).toBe(true);
  });

  it('feeds observer on 400 buffered by recovery branch when no rule matches', async () => {
    // 回归:有 enabled recovery rule 时 400 走缓冲分支,规则不命中的回落路径也必须喂观察器,
    // 否则自定义供应商的普通 400(如 model_not_found)静默绕过上游错误分类 toast。
    const errBody = JSON.stringify({ error: { type: 'invalid_request_error', message: 'model x not found' } });
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(errBody);
    });
    upstreamClose = upstream.close;
    const chunks: string[] = [];
    let observedStatus = -1;
    let observedEnd = false;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEncryptedContentRecoveryRule({ enabled: () => true })], // 不会命中该错误体
      responseObserver: (ctx) => {
        observedStatus = ctx.status;
        return {
          onData: (chunk) => chunks.push(chunk.toString('utf8')),
          onEnd: () => { observedEnd = true; },
        };
      },
    });

    const r = await post(proxy.url, { model: 'gpt-5.5', input: [] });
    expect(r.status).toBe(400);
    expect(upstream.bodies).toHaveLength(1); // 无命中 → 不重试
    expect(observedStatus).toBe(400);
    expect(chunks.join('')).toBe(errBody);
    expect(observedEnd).toBe(true);
  });

  it('exposes the final routed headers to the observer, not the client-sent ones', async () => {
    // 回归:供应商 OAuth 是路由期经 headerOverride 注入的。观察器若只拿得到 requestHeaders,
    // 就只能看到 agent 子进程自带的那把 bearer —— 任何「这次请求用了哪把凭证」的判断
    // (如 xAI 凭证失效收口的等值关联)都会永远对不上,整条链路的收口静默失效。
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'unauthenticated:bad-credentials' }));
    });
    upstreamClose = upstream.close;
    let observedRequestAuth: string | undefined;
    let observedOutboundAuth: string | undefined;
    let observedOutboundBeta: string | undefined;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      routingTransform: () => ({
        headerOverride: { authorization: 'Bearer routed-xai-token' },
        headerDelete: ['anthropic-beta'],
      }),
      responseObserver: (ctx) => {
        observedRequestAuth = ctx.requestHeaders.authorization;
        observedOutboundAuth = ctx.outboundHeaders?.authorization;
        observedOutboundBeta = ctx.outboundHeaders?.['anthropic-beta'];
        return null;
      },
    });

    const r = await fetch(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'thread-id': 'thread-a',
        authorization: 'Bearer client-subprocess-token',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
    });

    expect(r.status).toBe(403);
    // 客户端原始头保持原样(反解 thread-id 等会话归属仍靠它)。
    expect(observedRequestAuth).toBe('Bearer client-subprocess-token');
    // 实际发往上游的是路由注入后的凭证,且 headerDelete 已生效。
    expect(observedOutboundAuth).toBe('Bearer routed-xai-token');
    expect(observedOutboundBeta).toBeUndefined();
  });
});

const THINKING_ERROR_BODY = JSON.stringify({
  error: {
    type: 'invalid_request_error',
    message: 'messages.7.content.0.thinking: each thinking block must contain thinking',
  },
});

// 跨厂商切回 Anthropic 模型: 历史里 gpt 留下的空壳 thinking 块 + 后面一句 text。
function anthropicBodyWithEmptyThinking(): unknown {
  return {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: '' },
          { type: 'text', text: 'ok' },
        ],
      },
    ],
  };
}

describe('anthropic-compat-proxy empty-thinking recovery', () => {
  it('strips empty thinking blocks and retries once on the thinking 400', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(THINKING_ERROR_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    upstreamClose = upstream.close;
    let marked: { threadId: string; model: string } | null = null;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEmptyThinkingRecoveryRule({
        enabled: () => true,
        onRetry: (threadId, model) => { marked = { threadId, model }; },
      })],
    });

    const r = await post(proxy.url, anthropicBodyWithEmptyThinking());

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[0]).toContain('"thinking":""');
    expect(upstream.bodies[1]).not.toContain('"thinking":""');
    expect(marked).toEqual({ threadId: 'thread-a', model: 'claude-sonnet-4-6' });
  });

  it('does not retry when there is no empty thinking block to strip (content-bearing block survives)', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(THINKING_ERROR_BODY);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEmptyThinkingRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'real reasoning', signature: '' }] }],
    });

    expect(r.status).toBe(400);
    expect(upstream.bodies).toHaveLength(1);
  });

  it('does not retry a second time after the retry still returns the thinking 400', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(THINKING_ERROR_BODY);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEmptyThinkingRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, anthropicBodyWithEmptyThinking());

    expect(r.status).toBe(400);
    expect(upstream.bodies).toHaveLength(2);
  });

  it('dispatches the right rule when encrypted + thinking rules coexist', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(THINKING_ERROR_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [
        createEncryptedContentRecoveryRule({ enabled: () => true }),
        createEmptyThinkingRecoveryRule({ enabled: () => true }),
      ],
    });

    const r = await post(proxy.url, anthropicBodyWithEmptyThinking());

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[1]).not.toContain('"thinking":""');
  });

  it('decodes a gzip-encoded thinking 400 and still triggers the retry', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync(Buffer.from(THINKING_ERROR_BODY, 'utf8')));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEmptyThinkingRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, anthropicBodyWithEmptyThinking());

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[1]).not.toContain('"thinking":""');
  });

  it('passes through a clean 2xx Anthropic request byte-identical (cache safe)', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEmptyThinkingRecoveryRule({ enabled: () => true })],
    });

    const clean = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'deep', signature: 'sig' }, { type: 'text', text: 'a' }] }],
    };
    const r = await post(proxy.url, clean);

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(1);
    expect(upstream.bodies[0]).toBe(JSON.stringify(clean));
  });
});

// moonshot 线上 400 原文(2026-07-28,经 LiteLLM passthrough;request_id 取自真实捕获)。
const MOONSHOT_EMPTY_ASSISTANT_ERROR_BODY = JSON.stringify({
  error: {
    type: 'invalid_request_error',
    message: "Invalid request: the message at position 395 with role 'assistant' must not be empty",
  },
  request_id: 'f1b34454-8a63-11f1-bf3c-9ac780b5488d',
  type: 'error',
});

// moonshot/kimi-k3 线上污染会话形态(2026-07-28): 完整 tool_use/tool_result 上下文里
// 夹着一条 thinking-only 空 assistant(流中断后客户端持久化的未完成占位 block)。
function kimiBodyWithEmptyAssistant(): unknown {
  return {
    model: 'moonshot/kimi-k3',
    messages: [
      { role: 'user', content: 'run ls' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: '' }] },
      { role: 'user', content: 'continue' },
    ],
  };
}

describe('anthropic-compat-proxy empty-assistant-message recovery (moonshot/kimi)', () => {
  it('drops the empty assistant message and retries once on the moonshot 400', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(MOONSHOT_EMPTY_ASSISTANT_ERROR_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    upstreamClose = upstream.close;
    let marked: { threadId: string; model: string } | null = null;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEmptyAssistantMessageRecoveryRule({
        enabled: () => true,
        onRetry: (threadId, model) => { marked = { threadId, model }; },
      })],
    });

    const r = await post(proxy.url, kimiBodyWithEmptyAssistant());

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[0]).toContain('"thinking":""');
    // 重发 body: 空 thinking-only assistant 整条被丢(5 → 4 条),tool_use/tool_result 配对保留。
    const retried = JSON.parse(upstream.bodies[1]);
    expect(retried.messages).toHaveLength(4);
    expect(retried.messages.map((m: { role: string }) => m.role)).toEqual([
      'user', 'assistant', 'user', 'user',
    ]);
    expect(upstream.bodies[1]).not.toContain('"thinking":""');
    expect(marked).toEqual({ threadId: 'thread-a', model: 'moonshot/kimi-k3' });
  });

  it('does not retry when there is no empty assistant message to drop', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(MOONSHOT_EMPTY_ASSISTANT_ERROR_BODY);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEmptyAssistantMessageRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, {
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'real reasoning', signature: '' }, { type: 'text', text: 'ok' }] },
      ],
    });

    expect(r.status).toBe(400);
    expect(upstream.bodies).toHaveLength(1);
  });

  it('does not retry a second time after the retry still returns the moonshot 400', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(MOONSHOT_EMPTY_ASSISTANT_ERROR_BODY);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEmptyAssistantMessageRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, kimiBodyWithEmptyAssistant());

    expect(r.status).toBe(400);
    expect(upstream.bodies).toHaveLength(2);
  });

  it('also recovers when the stale assistant carries an empty text block instead of empty thinking', async () => {
    // PR #821 review 实测反馈形态: bridge 清理路径的 text-only 空块。
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(MOONSHOT_EMPTY_ASSISTANT_ERROR_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEmptyAssistantMessageRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, {
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
        { role: 'user', content: 'continue' },
      ],
    });

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(JSON.parse(upstream.bodies[1]).messages).toHaveLength(2);
  });

  it('decodes a gzip-encoded moonshot 400 and still triggers the retry', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync(Buffer.from(MOONSHOT_EMPTY_ASSISTANT_ERROR_BODY, 'utf8')));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEmptyAssistantMessageRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, kimiBodyWithEmptyAssistant());

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[1]).not.toContain('"thinking":""');
  });
});

describe('anthropic-compat-proxy localHandler(路由决策交本地 handler,不转发上游)', () => {
  it('命中 handler:收到原始字节 + 已解析 body + ctx,自写响应(含 SSE 流式),上游零请求', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    const seen: Array<{ parsed: unknown; raw: string; url: string; hasHeader: boolean }> = [];
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: (body) => {
        const model = (body as { model?: string } | undefined)?.model ?? '';
        if (!model.startsWith('chatgpt/')) return null;
        return {
          localHandler: async ({ rawBody, parsedBody, ctx, res }) => {
            seen.push({ parsed: parsedBody, raw: rawBody.toString('utf8'), url: ctx.url, hasHeader: ctx.headers['thread-id'] === 'thread-a' });
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('event: message_start\ndata: {}\n\n');
            res.end('event: message_stop\ndata: {}\n\n');
          },
        };
      },
    });

    const body = { model: 'chatgpt/gpt-5.5', messages: [] };
    const r = await post(proxy.url, body);
    expect(r.status).toBe(200);
    expect(r.text).toContain('message_start');
    expect(r.text).toContain('message_stop');
    expect(seen).toHaveLength(1);
    expect(seen[0].parsed).toEqual(body);          // parsedBody 复用路由阶段解析结果
    expect(seen[0].raw).toBe(JSON.stringify(body)); // rawBody 是原始字节
    expect(seen[0].url).toContain('/v1/responses');
    expect(seen[0].hasHeader).toBe(true);
    expect(gateway.bodies).toHaveLength(0);         // 上游一个请求都没收到

    // 同一 proxy 上不命中 handler 的请求照常转发(混跑不互扰)。
    const r2 = await post(proxy.url, { model: 'claude-opus-4-8', messages: [] });
    expect(r2.status).toBe(200);
    expect(gateway.bodies).toHaveLength(1);
  });

  it('handler 抛错且未写头 → 502 fail-open;上游不受影响', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: () => ({ localHandler: async () => { throw new Error('boom'); } }),
    });
    const r = await post(proxy.url, { model: 'chatgpt/gpt-5.5' });
    expect(r.status).toBe(502);
    expect(r.text).toContain('local handler failed');
    expect(gateway.bodies).toHaveLength(0);
  });

  it('handler resolve 但没 end 响应 → 防御性收尾(未写头按 502),请求不悬挂', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: () => ({ localHandler: async () => { /* 什么都不写 */ } }),
    });
    const r = await post(proxy.url, { model: 'chatgpt/gpt-5.5' });
    expect(r.status).toBe(502);
    expect(r.text).toContain('no response');
  });

  it('handler 已写头后抛错 → 连接被 destroy(与上游流中断语义一致)', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: () => ({
        localHandler: async ({ res }) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: message_start\ndata: {}\n\n');
          throw new Error('mid-stream boom');
        },
      }),
    });
    await expect(post(proxy.url, { model: 'chatgpt/gpt-5.5' })).rejects.toThrow();
  });

  it('GET(无 body)也可命中 handler:parsedBody undefined、rawBody 空', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: (body, ctx) => {
        if (body !== undefined || !ctx.url.includes('/bridge-models')) return null;
        return {
          localHandler: async ({ rawBody, parsedBody, res }) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ raw: rawBody.length, parsed: parsedBody === undefined }));
          },
        };
      },
    });
    const res = await fetch(`${proxy.url}/bridge-models`, { method: 'GET' });
    expect(JSON.parse(await res.text())).toEqual({ raw: 0, parsed: true });
    expect(gateway.bodies).toHaveLength(0);
  });

  it('decision 同时给 handler 与转发字段时 handler 优先,转发字段忽略(互斥契约)', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: () => ({
        upstreamOverride: gateway.url,
        headerOverride: { authorization: 'Bearer x' },
        localHandler: async ({ res }) => { res.writeHead(204); res.end(); },
      }),
    });
    const r = await post(proxy.url, { model: 'chatgpt/gpt-5.5' });
    expect(r.status).toBe(204);
    expect(gateway.bodies).toHaveLength(0);
  });
});

describe('anthropic-compat-proxy request body limit(超限回可读 413,不斩连接)', () => {
  it('content-length 声明超限 → 立即 413 可读 JSON + connection: close,上游零请求', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    const warns: Array<Record<string, unknown>> = [];
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      maxRequestBodyBytes: 1024,
      logger: {
        warn: (msg, ctx) => {
          if (msg === '✖ request body exceeds proxy limit → 413') warns.push(ctx ?? {});
        },
      },
    });
    const body = JSON.stringify({ model: 'gpt-5.5', input: 'x'.repeat(4096) });
    const res = await fetch(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'thread-id': 'thread-huge' },
      body,
    });
    expect(res.status).toBe(413);
    expect(res.headers.get('connection')).toBe('close');
    const json = await res.json() as { error: { type: string; message: string } };
    expect(json.error.type).toBe('proxy_error');
    expect(json.error.message).toContain('1024');
    // 上游零请求:预检直接拦下,客户端不用白传 body
    expect(gateway.bodies).toHaveLength(0);
    // warn 日志带 threadId + 字节数,线上可 grep(旧实现这条路径完全静默)
    expect(warns).toHaveLength(1);
    expect(warns[0].threadId).toBe('thread-huge');
    expect(warns[0].limitBytes).toBe(1024);
    expect(warns[0].declaredBytes).toBe(Buffer.byteLength(body));
  });

  it('chunked 上传(无 content-length)超限 → 流式守卫命中,仍收到完整 413', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    const warns: Array<Record<string, unknown>> = [];
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      maxRequestBodyBytes: 256 * 1024,
      logger: {
        warn: (msg, ctx) => {
          if (msg === '✖ request body exceeds proxy limit → 413') warns.push(ctx ?? {});
        },
      },
    });
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 16; i++) controller.enqueue(chunk); // 1MB > 256KB 上限
        controller.close();
      },
    });
    const res = await fetch(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      // Node fetch(undici)流式上传必须显式 half duplex
      ...({ duplex: 'half' } as Record<string, unknown>),
    });
    expect(res.status).toBe(413);
    const json = await res.json() as { error: { type: string } };
    expect(json.error.type).toBe('proxy_error');
    expect(gateway.bodies).toHaveLength(0);
    expect(warns).toHaveLength(1);
    expect(warns[0].declaredBytes).toBeUndefined();
    expect(Number(warns[0].receivedBytes)).toBeGreaterThan(256 * 1024);
  });

  it('自定义上限内的请求正常转发,行为不受影响', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    upstreamClose = gateway.close;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      maxRequestBodyBytes: 1024 * 1024,
    });
    const r = await post(proxy.url, { model: 'gpt-5.5', input: 'x'.repeat(4096) });
    expect(r.status).toBe(200);
    expect(gateway.bodies).toHaveLength(1);
  });
});

describe('anthropic-compat-proxy 客户端中断传播', () => {
  it('客户端在流式响应中途断开时,同步掐掉上游请求(费用泄漏止血)', async () => {
    let sawAbort!: () => void;
    const upstreamAborted = new Promise<void>((r) => { sawAbort = r; });
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {}\n\n');
      // 永不 end —— 模拟仍在生成的 SSE。中断传播生效时,proxy destroy 上游请求,
      // 这里的 'close' 才会在 upstream.close() 之前触发。
      res.on('close', () => sawAbort());
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({ upstream: upstream.url, transformRequest: [] });

    const controller = new AbortController();
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model' }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    // 确认已收到首个 SSE 字节、进入流式阶段后再中断
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();
    await upstreamAborted;
  });

  it('正常完成的响应不受影响:不误判为客户端断开,连接复用下后续请求照常', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreamClose = upstream.close;
    // 记录型 logger:锁住 writableEnded 守卫 —— 正常完成的请求绝不能触发
    // "client disconnected mid-response" 的中断传播路径(否则每笔请求都会对
    // 完成态上游请求调 destroy 并刷一条误导日志)。
    const infoLogs: string[] = [];
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      logger: { info: (msg) => { infoLogs.push(msg); } },
    });

    const r1 = await post(proxy.url, { model: 'test-model' });
    const r2 = await post(proxy.url, { model: 'test-model' });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(infoLogs.filter((m) => m.includes('client disconnected'))).toHaveLength(0);
  });
});

describe('anthropic-compat-proxy 入站请求体 dump 开关(debugDumpRequestBody,默认关)', () => {
  it('默认(不传开关)debug inbound 日志只有元数据,不含 body dump', async () => {
    const upstream = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamClose = upstream.close;

    const debugs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      logger: { isDebugEnabled: () => true, debug: (msg, ctx) => debugs.push({ msg, ctx }) },
    });

    await post(proxy.url, { model: 'test-model', secretPayload: 'x'.repeat(2048) });
    const inbound = debugs.find((d) => d.msg.includes('inbound request'));
    expect(inbound).toBeDefined();
    // 元数据照旧(reqId/method/url/bytes),定位问题不受影响。
    expect(inbound?.ctx?.method).toBe('POST');
    expect(typeof inbound?.ctx?.bytes).toBe('number');
    // 但绝不 dump 请求体 —— dev trace 级别 + 高并发下这是 main event loop 风暴源。
    expect(inbound?.ctx).not.toHaveProperty('body');
  });

  it('显式开启后 debug inbound 日志携带截断 dump(诊断模式)', async () => {
    const upstream = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamClose = upstream.close;

    const debugs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      debugDumpRequestBody: true,
      logger: { isDebugEnabled: () => true, debug: (msg, ctx) => debugs.push({ msg, ctx }) },
    });

    await post(proxy.url, { model: 'test-model', marker: 'dump-me' });
    const inbound = debugs.find((d) => d.msg.includes('inbound request'));
    expect(String(inbound?.ctx?.body)).toContain('dump-me');
  });

  it('localHandler 分支同样受开关约束(默认不 dump)', async () => {
    const debugs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    proxy = await createAnthropicCompatProxy({
      upstream: () => '',
      transformRequest: [],
      routingTransform: () => ({
        localHandler: async ({ res }) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        },
      }),
      logger: { isDebugEnabled: () => true, debug: (msg, ctx) => debugs.push({ msg, ctx }) },
    });

    await post(proxy.url, { model: 'local-model', secretPayload: 'y'.repeat(2048) });
    const inbound = debugs.find((d) => d.msg.includes('inbound request'));
    expect(inbound).toBeDefined();
    expect(inbound?.ctx).not.toHaveProperty('body');
  });
});
