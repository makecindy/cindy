import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { Transform } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAnthropicCompatProxy,
  isFetchBlockedPort,
  listenOnFetchSafeLoopbackPort,
} from './server.js';
import {
  createActiveStripTransform,
  createDuplicateToolUseIdRecoveryRule,
  createEmptyAssistantMessageRecoveryRule,
  createEmptyThinkingRecoveryRule,
  createEncryptedContentRecoveryRule,
  createImageGenerationIdRecoveryRule,
  createToolExchangeAdjacencyRecoveryRule,
  createToolUseProviderSpecificFieldsRecoveryRule,
  dedupeDuplicateToolUseIds,
  repairToolExchangeAdjacency,
  stripEncryptedContentFromBody,
} from './transform.js';
import { createXaiModelInputRecoveryRule } from './xai-model-input.js';
import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import { createThreadStripController } from './thread-strip-controller.js';
import type { ProxyHandle, RequestTransform } from './types.js';

const TEST_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TEST_PI_BINARY = path.join(
  TEST_REPO_ROOT,
  'apps',
  'pi-bin',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'pi.exe' : 'pi',
);

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

  it('pipes successful response bodies through a request-scoped transform', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      const payload = '{"source":"upstream"}';
      res.writeHead(200, {
        'content-type': 'application/json', 'content-length': String(payload.length),
      }).end(payload);
    });
    upstreamClose = upstream.close;
    let requestBody = '';

    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [(body) => ({ ...(body as object), routed: true })],
      transformResponse: (ctx) => {
        requestBody = ctx.requestBody.toString('utf8');
        return new Transform({
          transform(chunk, _encoding, callback) {
            callback(null, String(chunk).replace('upstream', 'adapted-provider'));
          },
        });
      },
    });

    const response = await fetch(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{"model":"test-model"}',
    });
    expect(await response.json()).toEqual({ source: 'adapted-provider' });
    expect(response.headers.get('content-length')).toBeNull();
    expect(JSON.parse(requestBody)).toEqual({ model: 'test-model', routed: true });
  });

  it('settles request-scoped transform state after a non-2xx response', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'provider_unavailable' } }));
    });
    upstreamClose = upstream.close;
    const onRequestSettled = vi.fn();
    const requestTransform: RequestTransform = (body) => body;
    requestTransform.onRequestSettled = onRequestSettled;

    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [requestTransform],
    });

    const response = await post(proxy.url, { model: 'test-model' });

    expect(response.status).toBe(503);
    expect(onRequestSettled).toHaveBeenCalledOnce();
    expect(onRequestSettled).toHaveBeenCalledWith(1);
  });

  it('settles request-scoped transform state when the client closes during an async transform', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    upstreamClose = upstream.close;
    let resolveTransform!: () => void;
    let markTransformStarted!: () => void;
    const transformStarted = new Promise<void>((resolve) => {
      markTransformStarted = resolve;
    });
    const transformReleased = new Promise<void>((resolve) => {
      resolveTransform = resolve;
    });
    const onRequestSettled = vi.fn();
    const requestTransform: RequestTransform = async (body) => {
      markTransformStarted();
      await transformReleased;
      return body;
    };
    requestTransform.onRequestSettled = onRequestSettled;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [requestTransform],
    });

    const controller = new AbortController();
    const response = fetch(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"test-model"}',
      signal: controller.signal,
    }).catch(() => null);
    await transformStarted;
    controller.abort();
    await response;
    expect(onRequestSettled).not.toHaveBeenCalled();

    resolveTransform();
    await vi.waitFor(() => expect(onRequestSettled).toHaveBeenCalledOnce());
    expect(onRequestSettled).toHaveBeenCalledWith(1);
  });

  it('fails the client when a response transform rejects during async flush', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      transformResponse: () => new Transform({
        transform(chunk, _encoding, callback) {
          callback(null, chunk);
        },
        flush(callback) {
          setImmediate(() => callback(new Error('response transform flush failed')));
        },
      }),
    });

    const controller = new AbortController();
    const resultPromise = fetch(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"test-model"}',
      signal: controller.signal,
    }).then(async (response) => {
      await response.text();
      return 'resolved' as const;
    }).catch(() => 'rejected' as const);
    const result = await Promise.race([
      resultPromise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ]);
    controller.abort();

    expect(result).toBe('rejected');
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
  it('preserves readable agent progress when foreign reasoning ciphertext triggers recovery', async () => {
    const upstream = await startFakeUpstream((_idx, rawBody, res) => {
      const body = JSON.parse(rawBody) as {
        input?: Array<{ type?: string; content?: unknown[]; encrypted_content?: unknown }>;
      };
      const encryptedParts = (body.input ?? [])
        .filter((item) => item.type === 'agent_message' && Array.isArray(item.content))
        .flatMap((item) => item.content ?? [])
        .filter((part): part is Record<string, unknown> => (
          typeof part === 'object'
          && part !== null
          && 'type' in part
          && part.type === 'encrypted_content'
        ));
      const foreignReasoning = (body.input ?? []).some((item) => (
        item.type === 'reasoning'
        && item.encrypted_content === 'gAAAAA-foreign-reasoning'
      ));
      if (encryptedParts.some((part) => typeof part.encrypted_content !== 'string')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: "Missing required parameter: 'input[2].content[1].encrypted_content'.",
            code: 'missing_required_parameter',
          },
        }));
      } else if (foreignReasoning) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(ENC_ERROR_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    upstreamClose = upstream.close;
    const controller = createThreadStripController();
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [createActiveStripTransform({
        controller,
        enabled: () => true,
        strip: stripEncryptedContentFromBody,
      })],
      recoveryRules: [createEncryptedContentRecoveryRule({
        enabled: () => true,
        onRetry: (threadId, model) => controller.markActive(threadId, model),
      })],
    });
    const request = {
      model: 'gpt-5.6-sol',
      input: [
        { type: 'message', role: 'user', content: 'go' },
        {
          type: 'reasoning',
          id: 'foreign-reasoning',
          summary: [],
          encrypted_content: 'gAAAAA-foreign-reasoning',
        },
        {
          type: 'agent_message',
          author: '/root/progress_test',
          recipient: '/root',
          content: [
            { type: 'input_text', text: 'progress' },
            { type: 'encrypted_content', encrypted_content: 'gAAAAA-progress' },
          ],
          internal_chat_message_metadata_passthrough: { source: 'send_message' },
        },
        {
          type: 'agent_message',
          author: '/root/progress_test',
          recipient: '/root',
          content: [{ type: 'input_text', text: 'complete' }],
        },
        {
          type: 'agent_message',
          author: '/root/opaque',
          content: [{ type: 'encrypted_content', encrypted_content: 'gAAAAA-only' }],
        },
      ],
    };

    expect((await post(proxy.url, request)).status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(JSON.parse(upstream.bodies[1]).input).toEqual([
      { type: 'message', role: 'user', content: 'go' },
      {
        type: 'agent_message',
        author: '/root/progress_test',
        recipient: '/root',
        content: [{ type: 'input_text', text: 'progress' }],
        internal_chat_message_metadata_passthrough: { source: 'send_message' },
      },
      {
        type: 'agent_message',
        author: '/root/progress_test',
        recipient: '/root',
        content: [{ type: 'input_text', text: 'complete' }],
      },
    ]);

    expect((await post(proxy.url, request)).status).toBe(200);
    expect(upstream.bodies).toHaveLength(3);
    expect(upstream.bodies[2]).toBe(upstream.bodies[1]);
  });

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

  it('retries LiteLLM-wrapped xAI ModelInput 422 after sanitizing input', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'litellm.BadRequestError: XaiException - {"error":"Failed to deserialize the JSON body into the target type: data did not match any variant of untagged enum ModelInput"}',
        }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, attempt: idx }));
      }
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createXaiModelInputRecoveryRule()],
    });

    const r = await post(proxy.url, {
      model: 'my-custom-grok',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'agent_message', author: 'bot', content: 'done' },
      ],
    });

    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ ok: true });
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.bodies[0]).toContain('agent_message');
    expect(upstream.bodies[1]).not.toContain('agent_message');
    expect(JSON.parse(upstream.bodies[1]).input).toEqual([
      { type: 'message', role: 'user', content: 'hi' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '[collab bot]\ndone' }],
      },
    ]);
  });

  it('does not rewrite OpenAI collab history when another recovery rule retries', async () => {
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
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [
        createEncryptedContentRecoveryRule({ enabled: () => true }),
        createXaiModelInputRecoveryRule(),
      ],
    });

    const r = await post(proxy.url, {
      model: 'gpt-5.5',
      input: [
        { type: 'reasoning', encrypted_content: 'gAAAsecret' },
        { type: 'agent_message', author: 'bot', content: 'keep me' },
      ],
    });

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(JSON.parse(upstream.bodies[1]).input).toEqual([
      { type: 'agent_message', author: 'bot', content: 'keep me' },
    ]);
  });

  it('does not stack encrypted-content strip onto a ModelInput 422 retry', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'litellm.BadRequestError: XaiException - {"error":"data did not match any variant of untagged enum ModelInput"}',
        }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, attempt: idx }));
      }
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [
        createEncryptedContentRecoveryRule({ enabled: () => true }),
        createXaiModelInputRecoveryRule(),
      ],
    });

    const r = await post(proxy.url, {
      model: 'grok-4.5',
      input: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAkeep' },
        { type: 'agent_message', author: 'bot', content: 'done' },
      ],
    });

    expect(r.status).toBe(200);
    expect(JSON.parse(upstream.bodies[1]).input).toEqual([
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAkeep' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '[collab bot]\ndone' }],
      },
    ]);
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

  it('revalidateBeforeDispatch can divert a localHandler after routingTransform', async () => {
    let innerRan = false;
    proxy = await createAnthropicCompatProxy({
      upstream: () => '',
      transformRequest: [],
      routingTransform: () => ({
        localHandler: async ({ res }) => {
          innerRan = true;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ from: 'inner' }));
        },
      }),
      revalidateBeforeDispatch: () => ({
        localHandler: async ({ res }) => {
          res.writeHead(503, {
            'content-type': 'application/json',
            'retry-after': '1',
          });
          res.end(JSON.stringify({
            error: { type: 'owner_boundary_pending', code: 'owner_boundary_pending' },
          }));
        },
      }),
    });

    const result = await post(proxy.url, { model: 'subscription-direct-model' });
    expect(result.status).toBe(503);
    expect(JSON.parse(result.text)).toEqual({
      error: { type: 'owner_boundary_pending', code: 'owner_boundary_pending' },
    });
    expect(innerRan).toBe(false);
  });

  it('revalidates after async request transforms and does not forward', async () => {
    const custom = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamClose = custom.close;

    let pending = false;
    proxy = await createAnthropicCompatProxy({
      upstream: custom.url,
      transformRequest: [async () => {
        pending = true;
        return null;
      }],
      routingTransform: () => ({ headerOverride: { authorization: 'Bearer previous-owner' } }),
      revalidateBeforeDispatch: () => (pending
        ? {
          localHandler: async ({ res }) => {
            res.writeHead(503, {
              'content-type': 'application/json',
              'retry-after': '1',
            });
            res.end(JSON.stringify({
              error: { type: 'owner_boundary_pending', code: 'owner_boundary_pending' },
            }));
          },
        }
        : null),
    });

    const result = await post(proxy.url, { model: 'claude-haiku-4-5-20251001' });
    expect(result.status).toBe(503);
    expect(JSON.parse(result.text)).toEqual({
      error: { type: 'owner_boundary_pending', code: 'owner_boundary_pending' },
    });
    expect(custom.bodies).toHaveLength(0);
  });

  it('revalidates when owner scope changes during async transforms even if pending stays false', async () => {
    const custom = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamClose = custom.close;

    let ownerScope = 'cloud:owner-a:1';
    const ownerScopeByCtx = new WeakMap<object, string>();
    proxy = await createAnthropicCompatProxy({
      upstream: custom.url,
      transformRequest: [async () => {
        ownerScope = 'cloud:owner-b:2';
        return null;
      }],
      routingTransform: (_body, ctx) => {
        ownerScopeByCtx.set(ctx, ownerScope);
        return { headerOverride: { authorization: 'Bearer previous-owner' } };
      },
      revalidateBeforeDispatch: (_decision, ctx) => {
        const start = ctx ? ownerScopeByCtx.get(ctx) : undefined;
        if (start !== undefined && start !== ownerScope) {
          return {
            localHandler: async ({ res }) => {
              res.writeHead(503, {
                'content-type': 'application/json',
                'retry-after': '1',
              });
              res.end(JSON.stringify({
                error: { type: 'owner_boundary_pending', code: 'owner_boundary_pending' },
              }));
            },
          };
        }
        return null;
      },
    });

    const result = await post(proxy.url, { model: 'claude-haiku-4-5-20251001' });
    expect(result.status).toBe(503);
    expect(JSON.parse(result.text)).toEqual({
      error: { type: 'owner_boundary_pending', code: 'owner_boundary_pending' },
    });
    expect(custom.bodies).toHaveLength(0);
  });

  it('stamps owner scope before collecting the body so a switch during upload cannot re-baseline', async () => {
    const custom = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamClose = custom.close;

    let ownerScope = 'cloud:owner-a:1';
    const ownerScopeByCtx = new WeakMap<object, string>();
    proxy = await createAnthropicCompatProxy({
      upstream: custom.url,
      transformRequest: [],
      routingTransform: () => {
        // collectRequestBody 已经结束;若盖章拖到这里,会把 B 当成起始 scope。
        ownerScope = 'cloud:owner-b:2';
        return { headerOverride: { authorization: 'Bearer previous-owner' } };
      },
      revalidateBeforeDispatch: (_decision, ctx) => {
        if (ctx && !ownerScopeByCtx.has(ctx)) ownerScopeByCtx.set(ctx, ownerScope);
        const start = ctx ? ownerScopeByCtx.get(ctx) : undefined;
        if (start !== undefined && start !== ownerScope) {
          return {
            localHandler: async ({ res }) => {
              res.writeHead(503, {
                'content-type': 'application/json',
                'retry-after': '1',
              });
              res.end(JSON.stringify({
                error: { type: 'owner_boundary_pending', code: 'owner_boundary_pending' },
              }));
            },
          };
        }
        return null;
      },
    });

    const result = await post(proxy.url, { model: 'claude-haiku-4-5-20251001' });
    expect(result.status).toBe(503);
    expect(JSON.parse(result.text)).toEqual({
      error: { type: 'owner_boundary_pending', code: 'owner_boundary_pending' },
    });
    expect(custom.bodies).toHaveLength(0);
    expect(custom.headers).toHaveLength(0);
  });

  it('revalidates owner scope before a transparent recovery retry', async () => {
    let ownerScope = 'cloud:owner-a:1';
    const ownerScopeByCtx = new WeakMap<object, string>();
    const custom = await startFakeUpstream((idx, _body, res) => {
      ownerScope = 'cloud:owner-b:2';
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(ENC_ERROR_BODY);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamClose = custom.close;

    proxy = await createAnthropicCompatProxy({
      upstream: custom.url,
      transformRequest: [],
      routingTransform: () => ({ headerOverride: { authorization: 'Bearer previous-owner' } }),
      recoveryRules: [createEncryptedContentRecoveryRule({ enabled: () => true })],
      revalidateBeforeDispatch: (_decision, ctx) => {
        if (ctx && !ownerScopeByCtx.has(ctx)) ownerScopeByCtx.set(ctx, ownerScope);
        const start = ctx ? ownerScopeByCtx.get(ctx) : undefined;
        if (start !== undefined && start !== ownerScope) {
          return {
            localHandler: async ({ res }) => {
              res.writeHead(503, {
                'content-type': 'application/json',
                'retry-after': '1',
              });
              res.end(JSON.stringify({
                error: { type: 'owner_boundary_pending', code: 'owner_boundary_pending' },
              }));
            },
          };
        }
        return null;
      },
    });

    const r = await post(proxy.url, {
      model: 'gpt-5.5',
      input: [{ type: 'reasoning', encrypted_content: 'gAAAsecret' }],
    });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.text)).toEqual({
      error: { type: 'owner_boundary_pending', code: 'owner_boundary_pending' },
    });
    expect(custom.bodies).toHaveLength(1);
    expect(custom.headers[0]?.authorization).toBe('Bearer previous-owner');
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

// 混合 sync + async transform：锁定 runTransforms 的串行 await 语义（顺序保持、
// async 被 await、null 透传、失败回退）。防止后续改动误并行化破坏链式顺序依赖。
describe('anthropic-compat-proxy mixed sync+async transform chain', () => {
  it('awaits async transforms in order and keeps sync passthrough', async () => {
    const order: string[] = [];
    const custom = await startFakeUpstream((_i, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoed: JSON.parse(body) }));
    });
    upstreamClose = custom.close;

    proxy = await createAnthropicCompatProxy({
      upstream: custom.url,
      transformRequest: [
        // 第一个：sync transform 透传（返回 null），不改 body。
        () => {
          order.push('sync-passthrough');
          return null;
        },
        // 第二个：async transform，模拟视觉桥（延迟后改写 body）。
        async (body) => {
          order.push('async-begin');
          await new Promise((r) => setTimeout(r, 20));
          order.push('async-end');
          return { ...(body as Record<string, unknown>), model: 'rewritten-by-async' };
        },
        // 第三个：sync transform，在 async 结果上再改。
        (body) => {
          order.push('sync-after-async');
          return { ...(body as Record<string, unknown>), extra: true };
        },
      ],
    });

    await post(proxy.url, { model: 'original', messages: [{ role: 'user', content: 'x' }] });
    // 顺序：sync 透传 → async 开始 → async 结束 → sync 尾改（严格串行，无并行交错）。
    expect(order).toEqual(['sync-passthrough', 'async-begin', 'async-end', 'sync-after-async']);
    // async 的结果被下游消费：final body 同时含 async 与 sync 的改写。
    expect(custom.bodies).toHaveLength(1);
    const sent = JSON.parse(custom.bodies[0]);
    expect(sent.model).toBe('rewritten-by-async');
    expect(sent.extra).toBe(true);
  });

  it('recovers from a throwing async transform by skipping it (passthrough)', async () => {
    const custom = await startFakeUpstream((_i, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoed: JSON.parse(body) }));
    });
    upstreamClose = custom.close;

    proxy = await createAnthropicCompatProxy({
      upstream: custom.url,
      transformRequest: [
        async () => {
          throw new Error('boom');
        },
        (body) => ({ ...(body as Record<string, unknown>), survived: true }),
      ],
    });

    await post(proxy.url, { model: 'original', messages: [] });
    expect(custom.bodies).toHaveLength(1);
    // 抛错的 async transform 被跳过，后续 sync transform 照常执行。
    expect(JSON.parse(custom.bodies[0]).survived).toBe(true);
  });

  it('rejects locally when a fail-closed request transform throws', async () => {
    const custom = await startFakeUpstream((_i, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamClose = custom.close;
    const rejectingTransform: RequestTransform = () => {
      throw new Error('request cannot be adapted safely');
    };
    rejectingTransform.errorMode = 'reject-request';

    proxy = await createAnthropicCompatProxy({
      upstream: custom.url,
      transformRequest: [rejectingTransform],
    });

    const response = await post(proxy.url, { model: 'original', input: [] });

    expect(response.status).toBe(502);
    expect(JSON.parse(response.text)).toMatchObject({ error: { type: 'proxy_error' } });
    expect(custom.bodies).toHaveLength(0);
  });
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

// ───────────────────────────────────────────────────────────────────────────
// 重复 tool_use id(moonshot/kimi 序号 id 跨 turn 复用,2026-07 两个会话实测
// `Edit_306` / `Bash_256` 各复用 20+ 次致安静瘫痪)的全链路防御实测。
// ───────────────────────────────────────────────────────────────────────────

// kimi-k3 事故会话形态: 同一序号 id 的两对完整 tool 交换跨 turn 出现。
function kimiBodyWithDuplicatedToolUseIds(): Record<string, unknown> {
  return {
    model: 'moonshot/kimi-k3',
    messages: [
      { role: 'user', content: '把 race-2 修掉' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'Edit_306', name: 'Edit', input: { file: 'a.ts', old: 'x', new: 'y' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Edit_306', content: 'has been updated successfully' }] },
      { role: 'assistant', content: [{ type: 'text', text: '继续修复计划' }, { type: 'tool_use', id: 'Edit_306', name: 'Edit', input: { file: 'a.ts', old: 'x', new: 'y' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Edit_306', content: 'String to replace not found' }] },
    ],
  };
}

// Anthropic 文案的重复 id 400(LiteLLM 版本差 / 真 Anthropic 上游可见)。
const DUPLICATE_TOOL_USE_ID_ERROR_BODY = JSON.stringify({
  error: { type: 'invalid_request_error', message: 'messages: `tool_use` ids must be unique' },
});

// moonshot chatcmpl 校验透出的孤儿 result 400(原文双空格,kimi kosong 注释同款)。
const MOONSHOT_TOOL_CALL_ID_NOT_FOUND_BODY = JSON.stringify({
  error: { type: 'invalid_request_error', message: 'Invalid request: tool_call_id  is not found' },
});

describe('anthropic-compat-proxy duplicate tool_use id (kimi/moonshot 序号 id 复用)', () => {
  it('proactively rewrites duplicated ids before forwarding — no 400 needed', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [repairToolExchangeAdjacency, dedupeDuplicateToolUseIds], // host 同序: repair 先于 dedupe
      recoveryRules: [],
    });

    const r = await post(proxy.url, kimiBodyWithDuplicatedToolUseIds());

    expect(r.status).toBe(200);
    // 只发一次:主动 transform 在转发前修好,不等上游报错。
    expect(upstream.bodies).toHaveLength(1);
    const sent = JSON.parse(upstream.bodies[0]);
    // 第二对 Edit_306 被唯一化,首对与配对关系保持完整。
    expect(sent.messages[1].content[0].id).toBe('Edit_306');
    expect(sent.messages[2].content[0].tool_use_id).toBe('Edit_306');
    expect(sent.messages[3].content[1].id).toBe('Edit_306_2');
    expect(sent.messages[4].content[0].tool_use_id).toBe('Edit_306_2');
    // text 块与业务 input 原样保留。
    expect(sent.messages[3].content[0]).toEqual({ type: 'text', text: '继续修复计划' });
    expect(sent.messages[3].content[1].input).toEqual({ file: 'a.ts', old: 'x', new: 'y' });
  });

  it('passes a clean paired history through byte-identical (zero interference)', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [repairToolExchangeAdjacency, dedupeDuplicateToolUseIds], // host 同序: repair 先于 dedupe
      recoveryRules: [],
    });

    const cleanBody = {
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: 'run ls' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_256', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Bash_256', content: 'ok' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Read_257', name: 'Read', input: { file: 'a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Read_257', content: 'file content' }] },
      ],
    };
    const r = await post(proxy.url, cleanBody);

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(1);
    // cache 安全契约在链路上的实测:无异常时 upstream 收到的字节与客户端发出的一致。
    expect(upstream.bodies[0]).toBe(JSON.stringify(cleanBody));
  });

  it('recovers from a 400 "`tool_use` ids must be unique" via transparent retry', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(DUPLICATE_TOOL_USE_ID_ERROR_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      // 空 transform 链:验证 recovery 在主动 transform 未接入的链路上独立工作。
      transformRequest: [],
      recoveryRules: [createDuplicateToolUseIdRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, kimiBodyWithDuplicatedToolUseIds());

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    // 第一次原样发出(重复 id 还在),第二次已唯一化。
    expect(upstream.bodies[0]).toBe(JSON.stringify(kimiBodyWithDuplicatedToolUseIds()));
    const retried = JSON.parse(upstream.bodies[1]);
    expect(retried.messages[3].content[1].id).toBe('Edit_306_2');
    expect(retried.messages[4].content[0].tool_use_id).toBe('Edit_306_2');
  });

  it('recovers from the moonshot "tool_call_id is not found" 400 by dropping the orphan result', async () => {
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(MOONSHOT_TOOL_CALL_ID_NOT_FOUND_BODY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createToolExchangeAdjacencyRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, {
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_1', name: 'Bash', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'Bash_1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'Edit_999', content: 'stray' },
          ],
        },
      ],
    });

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    const retried = JSON.parse(upstream.bodies[1]);
    // 孤儿块被丢,合法配对保留。
    expect(retried.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'Bash_1', content: 'ok' },
    ]);
  });

  it('returns the 400 as-is when the history has nothing to repair', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(DUPLICATE_TOOL_USE_ID_ERROR_BODY);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createDuplicateToolUseIdRecoveryRule({ enabled: () => true })],
    });

    const r = await post(proxy.url, {
      model: 'moonshot/kimi-k3',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // strip 无东西可改 → 不重试,400 原样回客户端(不误伤)。
    expect(r.status).toBe(400);
    expect(upstream.bodies).toHaveLength(1);
  });

  it('repairs a multiply-polluted history in one proactive pass (host chain order)', async () => {
    // host 装配顺序的组合场景: 同一请求同时含重复 id + 错位 result + 缺失 result,
    // repair → dedupe 链式应用后一次修好,只发一次(不等 400)。
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [repairToolExchangeAdjacency, dedupeDuplicateToolUseIds], // host 同序: repair 先于 dedupe
      recoveryRules: [],
    });

    const r = await post(proxy.url, {
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Edit_306', name: 'Edit', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Edit_306', content: 'ok' }] },
        // 第二对: 同 id(重复)且 result 错位(隔了一条 user text)。
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Edit_306', name: 'Edit', input: { a: 2 } }] },
        { role: 'user', content: [{ type: 'text', text: 'intervening' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Edit_306', content: 'late' }] },
        // 第三个 call: 同 id 且从此无 result(缺失,后面有 assistant 推进 → 非 trailing)。
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Edit_306', name: 'Edit', input: { a: 3 } }] },
        { role: 'assistant', content: [{ type: 'text', text: '我以为发出去了' }] },
      ],
    });

    expect(r.status).toBe(200);
    expect(upstream.bodies).toHaveLength(1);
    const sent = JSON.parse(upstream.bodies[0]);
    // dedupe: 三个同 id call → Edit_306 / Edit_306_2 / Edit_306_3。
    const callIds = sent.messages
      .filter((m: { role: string }) => m.role === 'assistant')
      .flatMap((m: { content: Array<{ id?: string }> }) => m.content)
      .filter((b: { id?: string }) => b.id !== undefined)
      .map((b: { id?: string }) => b.id);
    expect(callIds).toEqual(['Edit_306', 'Edit_306_2', 'Edit_306_3']);
    // repair: 错位的 result(已改名 Edit_306_2)前移到第二对 call 紧邻的 user 消息开头;
    // 第三个 call 合成占位(Edit_306_3),新建 user 消息插入在两个 assistant 之间。
    const roles = sent.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(sent.messages[4].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'Edit_306_2', content: 'late' });
    expect(sent.messages[6].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'Edit_306_3' });
    // 每个 tool_use 都有紧邻的配对 result —— 修复后的历史对 strict 上游合法。
  });
});

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
  it.skipIf(!existsSync(TEST_PI_BINARY))(
    'real PI zstd request crosses the proxy parse boundary and reaches the raw local handler',
    { timeout: 30_000 },
    async () => {
      const gateway = await startFakeUpstream((_i, _b, res) => {
        res.writeHead(500);
        res.end('default upstream must not be reached');
      });
      upstreamClose = gateway.close;
      let seen: { raw: Buffer; encoding: string | undefined; parsed: unknown; url: string } | null = null;
      let resolveSeen: (() => void) | null = null;
      const seenPromise = new Promise<void>((resolve) => { resolveSeen = resolve; });
      proxy = await createAnthropicCompatProxy({
        upstream: gateway.url,
        transformRequest: [],
        routingTransform: (body, ctx) => {
          if (ctx.headers['x-native-route'] !== 'openai') return null;
          return {
            localHandler: async ({ rawBody, parsedBody, res }) => {
              seen = {
                raw: Buffer.from(rawBody),
                encoding: ctx.headers['content-encoding'],
                parsed: parsedBody,
                url: ctx.url,
              };
              resolveSeen?.();
              res.writeHead(401, { 'content-type': 'application/json' });
              res.end('{"error":{"message":"intentional test stop"}}');
            },
          };
        },
      });
      const configHome = mkdtempSync(path.join(tmpdir(), 'pi-zstd-proxy-e2e-'));
      const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
      const placeholderJwt = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
        'https://api.openai.com/auth': { chatgpt_account_id: 'cindy-pi-proxy' },
      })}.`;
      let child: ChildProcessWithoutNullStreams | null = null;
      try {
        writeFileSync(path.join(configHome, 'models.json'), JSON.stringify({
          providers: {
            'openai-codex': {
              baseUrl: proxy.url,
              apiKey: '$CINDY_PI_OPENAI_PROXY_KEY',
              headers: { 'x-native-route': 'openai' },
              models: [{
                id: 'gpt-cindy-zstd-test',
                name: 'GPT Cindy zstd test',
                reasoning: false,
                input: ['text'],
                contextWindow: 128_000,
                maxTokens: 16_000,
              }],
            },
          },
        }));
        writeFileSync(path.join(configHome, 'settings.json'), JSON.stringify({ transport: 'sse' }));
        child = spawn(TEST_PI_BINARY, [
          '--provider', 'openai-codex',
          '--model', 'gpt-cindy-zstd-test',
          '--no-session',
          '--no-tools',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-context-files',
          '--mode', 'rpc',
        ], {
          cwd: TEST_REPO_ROOT,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: configHome,
            CINDY_PI_OPENAI_PROXY_KEY: placeholderJwt,
          },
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        child.stdin.write(JSON.stringify({ id: 'test-prompt', type: 'prompt', message: 'ping' }) + '\n');
        let reachTimeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            seenPromise,
            new Promise<never>((_resolve, reject) => {
              reachTimeout = setTimeout(
                () => reject(new Error(`real PI did not reach proxy: ${stderr}`)),
                10_000,
              );
            }),
          ]);
        } finally {
          if (reachTimeout) clearTimeout(reachTimeout);
        }

        const observed = seen as {
          raw: Buffer;
          encoding: string | undefined;
          parsed: unknown;
          url: string;
        } | null;
        expect(observed).not.toBeNull();
        expect(observed?.url).toBe('/codex/responses');
        expect(observed?.encoding).toBe('zstd');
        expect(observed?.parsed).toBeUndefined();
        expect([...observed!.raw.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
        expect(gateway.bodies).toHaveLength(0);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
              resolve();
            }, 1_000);
            child!.once('close', () => {
              clearTimeout(timer);
              resolve();
            });
            child!.kill('SIGTERM');
          });
        }
        rmSync(configHome, { recursive: true, force: true });
      }
    },
  );

  it('JSON content-type with compressed bytes still routes by headers and preserves raw body', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    const compressed = gzipSync(Buffer.from(JSON.stringify({ model: 'gpt-native' })));
    let seen: Buffer | null = null;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      routingTransform: (body, ctx) => {
        expect(body).toBeUndefined();
        if (ctx.headers['x-native-route'] !== 'openai') return null;
        return {
          localHandler: async ({ rawBody, parsedBody, res }) => {
            seen = Buffer.from(rawBody);
            expect(parsedBody).toBeUndefined();
            res.writeHead(204);
            res.end();
          },
        };
      },
    });

    const response = await fetch(`${proxy.url}/codex/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-native-route': 'openai',
      },
      body: compressed,
    });

    expect(response.status).toBe(204);
    expect(seen).toEqual(compressed);
    expect(gateway.bodies).toHaveLength(0);
  });

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

  it('超出硬上限但在有界 ingress 内时先压缩,压缩后正常转发', async () => {
    const gateway = await startFakeUpstream((_i, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bytes: Buffer.byteLength(body, 'utf8'), body: JSON.parse(body) }));
    });
    upstreamClose = gateway.close;
    let compactorCalls = 0;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      maxRequestBodyBytes: 1024,
      oversizedRequestIngressBytes: 8 * 1024,
      oversizedRequestCompactor: (body) => {
        compactorCalls += 1;
        return { model: (body as Record<string, unknown>).model, compacted: true };
      },
    });
    const res = await post(proxy.url, { model: 'test-model', history: 'x'.repeat(4096) });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.text) as { bytes: number; body: Record<string, unknown> };
    expect(json.body.compacted).toBe(true);
    expect(json.bytes).toBeLessThan(1024);
    expect(compactorCalls).toBe(1);
  });

  it('命中 localHandler 时同样先压缩超限 JSON,再交给 handler', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(500);
      res.end('local handler must prevent forwarding');
    });
    upstreamClose = gateway.close;
    let compactorCalls = 0;
    let seen: { raw: string; parsed: Record<string, unknown> } | null = null;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      maxRequestBodyBytes: 1024,
      oversizedRequestIngressBytes: 8 * 1024,
      oversizedRequestCompactor: (body) => {
        compactorCalls += 1;
        return { model: (body as Record<string, unknown>).model, compacted: true };
      },
      routingTransform: () => ({
        localHandler: async ({ rawBody, parsedBody, res }) => {
          seen = { raw: rawBody.toString('utf8'), parsed: parsedBody as Record<string, unknown> };
          res.writeHead(204);
          res.end();
        },
      }),
    });

    const res = await post(proxy.url, { model: 'gpt-5.5', history: 'x'.repeat(4096) });
    expect(res.status).toBe(204);
    expect(compactorCalls).toBe(1);
    expect(seen).toEqual({
      raw: JSON.stringify({ model: 'gpt-5.5', compacted: true }),
      parsed: { model: 'gpt-5.5', compacted: true },
    });
    expect(gateway.bodies).toHaveLength(0);
  });

  it('硬上限以内的请求完全跳过 oversized compactor', async () => {
    const gateway = await startFakeUpstream((_i, _body, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    let compactorCalls = 0;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      maxRequestBodyBytes: 8 * 1024,
      oversizedRequestCompactor: () => {
        compactorCalls += 1;
        return null;
      },
    });
    const res = await post(proxy.url, { model: 'test-model', input: 'small' });
    expect(res.status).toBe(200);
    expect(compactorCalls).toBe(0);
  });

  it('压缩器无法安全缩小时,最终仍返回结构化 413', async () => {
    const gateway = await startFakeUpstream((_i, _body, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      maxRequestBodyBytes: 1024,
      oversizedRequestIngressBytes: 8 * 1024,
      oversizedRequestCompactor: () => null,
    });
    const res = await post(proxy.url, { model: 'test-model', history: 'x'.repeat(4096) });
    expect(res.status).toBe(413);
    const json = JSON.parse(res.text) as { error: { reason: string } };
    expect(json.error.reason).toBe('request_body_too_large');
    expect(gateway.bodies).toHaveLength(0);
  });

  it('超过 ingress 上限时仍立即 413,不会把无限 body 读入内存', async () => {
    const gateway = await startFakeUpstream((_i, _body, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    let compactorCalls = 0;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      maxRequestBodyBytes: 1024,
      oversizedRequestIngressBytes: 2048,
      oversizedRequestCompactor: () => {
        compactorCalls += 1;
        return null;
      },
    });
    const body = JSON.stringify({ model: 'test-model', history: 'x'.repeat(4096) });
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(413);
    const json = await res.json() as { error: { reason: string } };
    expect(json.error.reason).toBe('request_body_too_large');
    expect(compactorCalls).toBe(0);
    expect(gateway.bodies).toHaveLength(0);
  });

  it('非法 ingress 配置不会关闭流式大小守卫', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    let compactorCalls = 0;
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      maxRequestBodyBytes: 1024,
      oversizedRequestIngressBytes: Number.NaN,
      oversizedRequestCompactor: () => {
        compactorCalls += 1;
        return null;
      },
    });
    const body = JSON.stringify({ model: 'test-model', history: 'x'.repeat(4096) });
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(413);
    expect(compactorCalls).toBe(0);
    expect(gateway.bodies).toHaveLength(0);
  });

  it('启用压缩器时,非 JSON 请求仍按硬上限预检', async () => {
    const gateway = await startFakeUpstream((_i, _b, res) => { res.writeHead(200); res.end('{}'); });
    upstreamClose = gateway.close;
    const warns: Array<Record<string, unknown>> = [];
    proxy = await createAnthropicCompatProxy({
      upstream: gateway.url,
      transformRequest: [],
      maxRequestBodyBytes: 1024,
      oversizedRequestIngressBytes: 8 * 1024,
      oversizedRequestCompactor: () => null,
      logger: {
        warn: (msg, ctx) => {
          if (msg === '✖ request body exceeds proxy limit → 413') warns.push(ctx ?? {});
        },
      },
    });
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(4096),
    });
    expect(res.status).toBe(413);
    expect(warns).toHaveLength(1);
    expect(warns[0].receivedBytes).toBe(0);
    expect(gateway.bodies).toHaveLength(0);
  });
});

describe('anthropic-compat-proxy 客户端中断传播', () => {
  it('客户端在流式响应中途断开时,同步掐掉上游请求(费用泄漏止血)', async () => {
    let sawAbort!: () => void;
    const upstreamAborted = new Promise<void>((r) => { sawAbort = r; });
    const errorLogs: string[] = [];
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {}\n\n');
      // 永不 end —— 模拟仍在生成的 SSE。中断传播生效时,proxy destroy 上游请求,
      // 这里的 'close' 才会在 upstream.close() 之前触发。
      res.on('close', () => sawAbort());
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      logger: { error: (msg) => { errorLogs.push(msg); } },
    });

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
    expect(errorLogs.filter((m) => m.includes('upstream response stream error'))).toHaveLength(0);
  });

  it('透明重试后的上游 2xx SSE 中断时,立即收口且旧 listener 不误报客户端断开', async () => {
    const errorLogs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const infoLogs: string[] = [];
    const observerErrors: string[] = [];
    let observerEnds = 0;
    const upstream = await startFakeUpstream((idx, _body, res) => {
      if (idx === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(ENC_ERROR_BODY);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {}\n\n');
      // 不发送 end,模拟上游生成过程中连接被对端掐断。Node 可能发
      // `aborted`、`error`、`close` 中的一个或多个,代理必须幂等收口。
      setTimeout(() => res.destroy(), 50);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      recoveryRules: [createEncryptedContentRecoveryRule({ enabled: () => true })],
      logger: {
        info: (msg) => infoLogs.push(msg),
        error: (msg, ctx) => errorLogs.push({ msg, ctx }),
      },
      responseObserver: () => ({
        onEnd: () => { observerEnds += 1; },
        onError: (err) => { observerErrors.push(err.message); },
      }),
    });

    const controller = new AbortController();
    let responseStatus: number | null = null;
    let clientError: unknown = null;
    const operation = fetch(`${proxy.url}/v1/messages?api_key=must-not-appear-in-logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        input: [{ type: 'reasoning', encrypted_content: 'gAAAsecret' }],
      }),
      signal: controller.signal,
    }).then(async (res) => {
      responseStatus = res.status;
      await res.text();
    }).catch((err: unknown) => {
      // destroy() 后 undici 通常会以 body read error 收口,这正是期望的
      // “立即失败”语义;测试只关心它不能悬挂到 watchdog。
      clientError = err;
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      operation.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), 1000);
      }),
    ]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (outcome === 'timeout') controller.abort();

    expect(outcome).toBe('settled');
    expect(responseStatus).toBe(200);
    expect(clientError).toBeInstanceOf(Error);
    expect(upstream.bodies).toHaveLength(2);
    expect(infoLogs.filter((m) => m.includes('client disconnected'))).toHaveLength(0);
    const responseFailures = errorLogs.filter((entry) => entry.msg === 'upstream response stream error');
    expect(responseFailures).toHaveLength(1);
    expect(responseFailures[0].ctx).toMatchObject({
      status: 200,
      reason: expect.stringMatching(/^(error|aborted|close)$/),
      bytes: expect.any(Number),
      lastChunkBytes: expect.any(Number),
      lastChunkAt: expect.any(Number),
    });
    expect(responseFailures[0].ctx?.path).toBe('/v1/messages');
    expect(JSON.stringify(responseFailures[0].ctx)).not.toContain('must-not-appear-in-logs');
    expect(Number(responseFailures[0].ctx?.bytes)).toBeGreaterThan(0);
    expect(responseFailures[0].ctx).not.toHaveProperty('body');
    expect(responseFailures[0].ctx).not.toHaveProperty('requestBody');
    expect(responseFailures[0].ctx).not.toHaveProperty('chunk');
    expect(observerErrors).toHaveLength(1);
    expect(observerEnds).toBe(0);
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
    const errorLogs: string[] = [];
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      // 此测试同时确保 upstream end 后迟到的 request/response error 不会重复收口。
      logger: {
        info: (msg) => { infoLogs.push(msg); },
        error: (msg) => { errorLogs.push(msg); },
      },
    });

    const r1 = await post(proxy.url, { model: 'test-model' });
    const r2 = await post(proxy.url, { model: 'test-model' });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(upstream.bodies).toHaveLength(2);
    expect(infoLogs.filter((m) => m.includes('client disconnected'))).toHaveLength(0);
    expect(errorLogs.filter((m) => m.includes('upstream response stream error'))).toHaveLength(0);
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

describe('tool_use id 响应流去重改写(kimi 撞车自愈)', () => {
  const SSE_BODY =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"id":"chatcmpl-x","role":"assistant","content":[]}}\n\n' +
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"想"}}\n\n' +
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"Bash_210","name":"Bash","input":{}}}\n\n' +
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"Bash_999","name":"Bash","input":{}}}\n\n' +
    'event: message_stop\n' +
    'data: {"type":"message_stop"}\n\n';

  function sseUpstream() {
    return startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE_BODY);
    });
  }

  it('请求历史带铸造形态 id 时, 响应里撞车的 tool_use id 被改名, 新 id 不动', async () => {
    const upstream = await sseUpstream();
    upstreamClose = upstream.close;
    const infos: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
      logger: { info: (msg, ctx) => infos.push({ msg, ctx }) },
    });

    const res = await post(proxy.url, {
      model: 'kimi-k3',
      messages: [
        { role: 'user', content: '分析' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_210', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Bash_210', content: 'ok' }] },
      ],
    });
    expect(res.status).toBe(200);
    // 撞车 id 被改名; 新 id(Bash_999)与历史无关 → 不动
    expect(res.text).toContain('"id":"Bash_210_dup2"');
    expect(res.text).toContain('"id":"Bash_999"');
    expect(res.text).not.toContain('"id":"Bash_210"');
    // thinking / 事件框架行原样
    expect(res.text).toContain('event: message_stop');
    expect(
      infos.some(
        (l) => l.msg.includes('renamed duplicate tool_use id') && l.ctx?.from === 'Bash_210' && l.ctx?.to === 'Bash_210_dup2',
      ),
    ).toBe(true);
  });

  it('请求历史无铸造形态 id 时, 响应流字节透传(零干预)', async () => {
    const upstream = await sseUpstream();
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
    });

    const res = await post(proxy.url, {
      model: 'claude-sonnet-4',
      messages: [
        { role: 'user', content: '分析' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01Jx4AbC', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01Jx4AbC', content: 'ok' }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe(SSE_BODY);
  });

  it('非 SSE 响应不接管(字节透传)', async () => {
    const upstream = await startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-x',
          content: [{ type: 'tool_use', id: 'Bash_210', name: 'Bash', input: {} }],
        }),
      );
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
    });

    const res = await post(proxy.url, {
      model: 'kimi-k3',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_210', name: 'Bash', input: {} }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"id":"Bash_210"');
  });

  it('SSE 改写长度变化时自动剥离 content-length,客户端不截断(GPT-5.5 第 5 轮 P1)', async () => {
    const upstream = await startFakeUpstream((_i, _b, res) => {
      const sseBody =
        'event: content_block_start\n' +
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"Bash_210","name":"Bash","input":{}}}\n\n' +
        'event: message_stop\n' +
        'data: {"type":"message_stop"}\n\n';
      // upstream 发出定长 content-length(改写后 body 会变得更长)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'content-length': String(Buffer.byteLength(sseBody)),
      });
      res.end(sseBody);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
    });

    const res = await post(proxy.url, {
      model: 'kimi-k3',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_210', name: 'Bash', input: {} }] },
      ],
    });
    expect(res.status).toBe(200);
    // 改写后 id 被改名,且完整的 SSE 帧无截断(message_stop 存在)
    expect(res.text).toContain('"id":"Bash_210_dup2"');
    expect(res.text).toContain('"type":"message_stop"');
  });
});

describe('压缩 SSE 不接管(Greptile review)', () => {
  it('content-encoding 存在时保持字节透传,不改名、不删 content-length', async () => {
    const { gzipSync } = await import('node:zlib');
    const upstream = await startFakeUpstream((_i, _b, res) => {
      const sseBody =
        'event: content_block_start\n' +
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"Bash_210","name":"Bash","input":{}}}\n\n';
      // 真实 gzip 压缩的 SSE:改写器不得接管(压缩字节按明文行切分会漏改/误改)
      const gzipped = gzipSync(Buffer.from(sseBody, 'utf8'));
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'content-encoding': 'gzip',
        'content-length': String(gzipped.length),
      });
      res.end(gzipped);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
    });

    const res = await post(proxy.url, {
      model: 'kimi-k3',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_210', name: 'Bash', input: {} }] },
      ],
    });
    expect(res.status).toBe(200);
    // 字节透传:客户端自解压后内容完整、id 不改名(未进入改写器)
    expect(res.text).toContain('"id":"Bash_210"');
    expect(res.text).not.toContain('Bash_210_dup2');
  });

  it('content-encoding: identity(明文,不压缩)仍接管改写(Greptile P1)', async () => {
    const upstream = await startFakeUpstream((_i, _b, res) => {
      const sseBody =
        'event: content_block_start\n' +
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"Bash_210","name":"Bash","input":{}}}\n\n';
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'content-encoding': 'identity',
        'content-length': String(Buffer.byteLength(sseBody)),
      });
      res.end(sseBody);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({
      upstream: upstream.url,
      transformRequest: [],
    });

    const res = await post(proxy.url, {
      model: 'kimi-k3',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_210', name: 'Bash', input: {} }] },
      ],
    });
    expect(res.status).toBe(200);
    // identity 是明文:必须接管并改名(改写后长度变化,content-length 被剥离)
    expect(res.text).toContain('"id":"Bash_210_dup2"');
  });
});

describe('per-thread 已见 id 缓存(codex-connector P1:请求体缺席历史 id 时仍拦截重铸)', () => {
  const MINTED_SSE =
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"Bash_210","name":"Bash","input":{}}}\n\n';

  function mintingUpstream() {
    return startFakeUpstream((_i, _b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(MINTED_SSE);
    });
  }

  // per-thread 缓存需要**同一 proxy 实例**跨请求累积(每个请求独立建 proxy 会丢缓存),
  // 因此 postAs 复用同一个 upstream + proxy。
  async function setupSingleProxy(): Promise<void> {
    const upstream = await mintingUpstream();
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({ upstream: upstream.url, transformRequest: [] });
  }

  async function postAs(sessionId: string, body: unknown): Promise<string> {
    const res = await fetch(`${proxy!.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': sessionId },
      body: JSON.stringify(body),
    });
    return res.text();
  }

  it('全新 kimi 会话(无 minted id 历史)仍接管并记录首个 streamed id(codex-connector P1)', async () => {
    await setupSingleProxy();
    // 全新 kimi 会话: 请求体无任何铸造形态 id → requestedIds null, cache 空;
    // 修复前 responseToolUseIds 也 null → 不接管 → 首 fresh id 未记录。
    // 修复后: 请求体 model=kimi 判定接管, onObserved 记录 Bash_210。
    const r1 = await postAs('sess-fresh', {
      model: 'moonshot/kimi-k3',
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(r1).toContain('"id":"Bash_210"'); // fresh id 透传(无撞车)

    // 第二次请求(同 session, 无铸造 id 历史, 模拟 rewind): 缓存里已有 Bash_210
    // → 响应铸 Bash_210 仍被拦截改名
    const r2 = await postAs('sess-fresh', {
      model: 'moonshot/kimi-k3',
      messages: [{ role: 'user', content: '继续' }],
    });
    expect(r2).not.toContain('"id":"Bash_210"');
    expect(r2).toMatch(/Bash_210_dup\d+/);
  });

  it('Kimi Code 的 k3 模型 id 同样判定为 kimi 会话(codex-connector P1)', async () => {
    await setupSingleProxy();
    // catalog 里 moonshot-kimi-code provider 的 claude-code runtime model id 是裸 `k3`
    // (Kimi K3), 不带 kimi 前缀 —— 修复前 isKimiRequest 对 k3 返回 false → 不接管
    const r1 = await postAs('sess-k3', {
      model: 'k3',
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(r1).toContain('"id":"Bash_210"'); // fresh id 透传(无撞车)

    // 第二次请求(同 session, 模拟 rewind): 缓存里已有 Bash_210 → 拦截改名
    const r2 = await postAs('sess-k3', {
      model: 'k3',
      messages: [{ role: 'user', content: '继续' }],
    });
    expect(r2).not.toContain('"id":"Bash_210"');
    expect(r2).toMatch(/Bash_210_dup\d+/);
  });

  it('请求1(历史含 Bash_210)改名;请求2(同 session,历史不含 Bash_210)仍拦截重铸', async () => {
    await setupSingleProxy();
    // 请求1: 历史带 Bash_210 → 响应铸 Bash_210 → 撞车 → 改名; Bash_210 进线程缓存
    const r1 = await postAs('sess-1', {
      model: 'kimi-k3',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_210', name: 'Bash', input: {} }] },
      ],
    });
    expect(r1).toContain('"id":"Bash_210_dup2"');

    // 请求2: 同 session, 历史**不含** Bash_210(模拟 rewind 后历史缺席)
    // → 若只从请求体建 usedIds, 该 id 会被当「新 id」放行; per-thread 缓存必须拦截
    const r2 = await postAs('sess-1', {
      model: 'kimi-k3',
      messages: [{ role: 'user', content: '继续分析' }],
    });
    // 缓存让 r2 仍设防:响应铸 Bash_210 被改名(后缀可能顺延为 _dup3,因为 r1
    // 的 onRename 已把 _dup2 写进缓存),绝不能原样放行 Bash_210
    expect(r2).not.toContain('"id":"Bash_210"');
    expect(r2).toMatch(/Bash_210_dup\d+/);
  });

  it('请求2 仍含部分铸造 id 时,缓存里缺席的旧 id 也并入种子(codex-connector P1)', async () => {
    await setupSingleProxy();
    // 请求1: 历史带 Bash_210 → 改名 → 进缓存
    const r1 = await postAs('sess-partial', {
      model: 'kimi-k3',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_210', name: 'Bash', input: {} }] },
      ],
    });
    expect(r1).toContain('"id":"Bash_210_dup2"');

    // 请求2: 同 session, 请求体**仍含另一个**铸造 id(Read_5, 使 requestedIds 非空),
    // 但 Bash_210 缺席 —— 若只从请求体建种子, Bash_210 会漏; 缓存必须并入。
    // fake upstream 恒铸 Bash_210 → 必须仍被改名, 不得原样放行。
    const r2 = await postAs('sess-partial', {
      model: 'kimi-k3',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Read_5', name: 'Read', input: {} }] },
      ],
    });
    expect(r2).not.toContain('"id":"Bash_210"');
    expect(r2).toMatch(/Bash_210_dup\d+/);
  });

  it('不同 session 的缓存互不串扰', async () => {
    await setupSingleProxy();
    // 请求1 在 sess-A 铸 Bash_210(缓存入 sess-A)
    await postAs('sess-A', {
      model: 'kimi-k3',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Bash_210', name: 'Bash', input: {} }] },
      ],
    });
    // 请求2 在 sess-B(全新会话, 无缓存)铸 Bash_210 → 请求体不带历史 id → 应放行
    const r2 = await postAs('sess-B', {
      model: 'kimi-k3',
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(r2).toContain('"id":"Bash_210"');
    expect(r2).not.toContain('Bash_210_dup2');
  });
});

describe('streaming response validity gate (#2242)', () => {
  const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' };
  const SSE_BODY = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

  it('流式请求收到空 2xx → 结构化 502(empty_stream_response)', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end();
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({ upstream: upstream.url });

    const result = await post(proxy.url, { model: 'test-model', stream: true });
    expect(result.status).toBe(502);
    const parsed = JSON.parse(result.text) as { error: { type: string; code?: string } };
    expect(parsed.error.type).toBe('proxy_error');
    expect(parsed.error.code).toBe('empty_stream_response');
  });

  it('流式请求收到非 SSE 2xx → 502(non_sse_stream_response)', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'gateway_hiccup', message: 'nope' } }));
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({ upstream: upstream.url });

    const result = await post(proxy.url, { model: 'test-model', stream: true });
    expect(result.status).toBe(502);
    expect((JSON.parse(result.text) as { error: { code?: string } }).error.code)
      .toBe('non_sse_stream_response');
  });

  it('零事件 SSE(只有注释/心跳)正常结束 → 502(sse_without_events)', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(': ping\n\n');
      res.end(': bye\n\n');
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({ upstream: upstream.url });

    const result = await post(proxy.url, { model: 'test-model', stream: true });
    expect(result.status).toBe(502);
    expect((JSON.parse(result.text) as { error: { code?: string } }).error.code)
      .toBe('sse_without_events');
  });

  it('合法 SSE 原样透传,事件前的注释心跳不丢', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(': keepalive\n\n');
      res.end(SSE_BODY);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({ upstream: upstream.url });

    const result = await post(proxy.url, { model: 'test-model', stream: true });
    expect(result.status).toBe(200);
    expect(result.text).toBe(`: keepalive\n\n${SSE_BODY}`);
  });

  it('压缩 SSE 不按明文扫行:首字节提交并透传', async () => {
    const gz = gzipSync(Buffer.from(SSE_BODY, 'utf8'));
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { ...SSE_HEADERS, 'content-encoding': 'gzip' });
      res.end(gz);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({ upstream: upstream.url });

    const result = await post(proxy.url, { model: 'test-model', stream: true });
    expect(result.status).toBe(200);
    expect(result.text).toBe(SSE_BODY);
  });

  it('非流式请求不受门控:空 200 照旧字节透传(行为保持)', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end();
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({ upstream: upstream.url });

    const result = await post(proxy.url, { model: 'test-model' });
    expect(result).toEqual({ status: 200, text: '' });
  });

  it('已提交后的截断保持连接失败语义,不补成正常结束', async () => {
    const upstream = await startFakeUpstream((_idx, _body, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => res.destroy(), 30);
    });
    upstreamClose = upstream.close;
    proxy = await createAnthropicCompatProxy({ upstream: upstream.url });

    await expect(post(proxy.url, { model: 'test-model', stream: true })).rejects.toThrow();
  });
});
