import { Agent, createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { createAnthropicCompatProxy } from './server.js';
import type { LocalRequestHandler, ProxyOptions } from './types.js';
import { controlRequestSize, type InlineImagePreprocessor } from './request-size-control.js';
import { recoverInlineAttachments as recover, type RecoveredAttachment } from './oversized-attachments.js';
import { closeTestConnections, fetchOverTestConnections as fetch, listenOnAvailableLoopbackPort } from './test-loopback-server.js';
const recoverInlineAttachments = (body: Parameters<typeof recover>[0], limit: number, prepare: (a: RecoveredAttachment) => Promise<string>) =>
  recover(body, limit, { prepare, commit: async () => {} });

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); await closeTestConnections(); });

// PR #10663: ingress recovery caches a parsed body before the text-only guard.
// Existing ingress tests did not combine a guard with a local parsed-body bridge.
// Unit tier; one image crossing an 8 KiB window must not reintroduce tools upstream.
it('invalidates the spooled parsed body after a text-only guard before local bridging', async () => {
  const received: unknown[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString())); res.end('ok');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const control = vi.fn<NonNullable<ProxyOptions['requestSizeController']>['control']>((body, format, policy) =>
    controlRequestSize(body, format, { ...policy, triggerBytes: 8192, targetBytes: 4096 }, async () => '/tmp/image.png'));
  const proxy = await createAnthropicCompatProxy({
    upstream: `http://127.0.0.1:${port}`, maxRequestBodyBytes: 8192,
    requestSizeController: { format: () => 'responses', control },
    requestGuard: () => ({
      transformBody: body => {
        const parsed = JSON.parse(body.toString()); delete parsed.tools;
        return Buffer.from(JSON.stringify(parsed));
      },
      response: () => new PassThrough(),
    }),
    routingTransform: () => ({ localHandler: async ({ parsedBody, res }) => {
      const upstreamResponse = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify(parsedBody) });
      res.end(await upstreamResponse.text());
    } }),
  });
  cleanup.push(() => proxy.dispose());
  const response = await fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tools: [{ type: 'function', name: 'execute' }], input: [{ role: 'user', content: [
      { type: 'input_image', image_url: `data:image/png;base64,${Buffer.alloc(9000).toString('base64')}` },
    ] }] }),
  });
  expect(response.status).toBe(200); expect(await response.text()).toBe('ok');
  expect(control).toHaveBeenCalledOnce();
  expect(received).toHaveLength(1);
  expect(received[0]).not.toHaveProperty('tools');
});

// PR #10663: early 413 recovery used raw compressed bytes without their encoding.
// Unit tier; one gzip error, complete or cut off, with no recoverable attachment.
// A partial error must become an explicit local error, never a truncated gzip stream.
it.each(['complete', 'partial'] as const)('returns a readable %s gzip 413 when recovery is unavailable', async mode => {
  const error = { error: { message: 'The upstream request is too large.' } };
  const compressed = gzipSync(JSON.stringify(error));
  let attempts = 0;
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    attempts++;
    res.writeHead(413, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': compressed.length });
    if (mode === 'complete') res.end(compressed);
    else res.write(compressed.subarray(0, 12));
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${port}`, transformRequest: [],
    requestSizeController: { format: () => 'responses', control: async () => null },
  });
  cleanup.push(() => proxy.dispose());
  const response = await fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"hello"}' });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual(mode === 'complete' ? error
    : { error: { type: 'request_too_large', message: 'Upstream rejected this request as too large.' } });
  expect(attempts).toBe(1);
});

it.each(['recover', 'still-413', 'storage-failure', 'text', 'not-smaller'] as const)(
  'handles upstream 413 below the local limit without an unbounded retry: %s', async mode => {
    const bodies: Buffer[] = [];
    const error = 'Failed to buffer the request body: length limit exceeded';
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      bodies.push(body);
      res.statusCode = mode === 'recover' && body.length < 1000 ? 200 : 413;
      res.end(res.statusCode === 200 ? 'ok' : error);
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const original = Buffer.alloc(8000, 2);
    const keep = vi.fn(async (attachment: RecoveredAttachment) => {
      if (mode === 'storage-failure') throw new Error('disk full');
      expect(await readFile(attachment.filePath)).toEqual(original);
      return '/tmp/kept.png';
    });
    const raw = JSON.stringify({ messages: [{ role: 'user', content: mode === 'text'
      ? 'x'.repeat(12000)
      : [1, 2].map(() => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${original.toString('base64')}` } })) }] });
    const proxy = await createAnthropicCompatProxy({
      upstream: `http://127.0.0.1:${port}`,
      oversizedRequestRecovery: () => (body, limit) => mode === 'not-smaller'
        ? Promise.resolve(Buffer.from(raw))
        : recoverInlineAttachments(body, limit, keep),
    });
    cleanup.push(() => proxy.dispose());
    const response = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
    });
    expect(response.status).toBe(mode === 'recover' ? 200 : 413);
    expect(await response.text()).toBe(mode === 'recover' ? 'ok' : error);
    expect(bodies).toHaveLength(mode === 'recover' || mode === 'still-413' ? 2 : 1);
    expect(bodies[0]).toEqual(Buffer.from(raw));
    if (bodies.length === 2) {
      expect(keep).toHaveBeenCalledTimes(2);
      expect(bodies[1].length).toBeLessThan(1000);
      expect(bodies[1].toString()).not.toContain('base64');
    }
  },
);

it('cancels upstream 413 preservation without dispatching a retry', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const upstreamCall = vi.fn();
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    upstreamCall();
    res.writeHead(413); res.end('too large');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  let signal: AbortSignal | undefined;
  const proxy = await createAnthropicCompatProxy({
    upstream: `http://127.0.0.1:${port}`,
    oversizedRequestRecovery: () => async body => {
      signal = body.signal; entered(); await gate;
      body.signal.throwIfAborted();
      return Buffer.from('{}');
    },
  });
  cleanup.push(() => proxy.dispose());
  const abort = new AbortController();
  const pending = fetch(`${proxy.url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"messages":[]}', signal: abort.signal,
  }).catch(() => undefined);
  await started;
  abort.abort();
  await pending;
  await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  release();
  expect(upstreamCall).toHaveBeenCalledOnce();
});

it.each(['/v1/responses', '/v1/responses/compact', '/v1/messages', '/v1/chat/completions'])('recovers declared and chunked oversized requests before dispatch: %s', async endpoint => {
  const bodies: string[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString());
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const original = Buffer.alloc(90_000, 2);
  const keep = vi.fn(async attachment => {
    expect(await readFile(attachment.filePath)).toEqual(original);
    return '/tmp/kept-image.png';
  });
  const proxy = await createAnthropicCompatProxy({
    upstream: `http://127.0.0.1:${port}`, maxRequestBodyBytes: 1000,
    oversizedRequestRecovery: () => (body, limit) => recoverInlineAttachments(body, limit, keep),
  });
  cleanup.push(() => proxy.dispose());
  const raw = JSON.stringify({ model: 'gpt-test', input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${original.toString('base64')}` }] }] });
  const agent = new Agent({ keepAlive: true });
  cleanup.push(async () => agent.destroy());
  for (const chunked of [false, true]) {
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(`${proxy.url}${endpoint}`, { method: 'POST', agent, headers: { 'content-type': 'application/json', ...(chunked ? {} : { 'content-length': Buffer.byteLength(raw) }) } }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, text }));
      });
      req.on('error', reject);
      req.write(raw.slice(0, 200)); req.end(raw.slice(200));
    });
    expect(response).toEqual({ status: 200, text: '{"ok":true}' });
  }
  expect(keep).toHaveBeenCalledTimes(2);
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(Buffer.byteLength(body)).toBeLessThan(1000);
    expect(JSON.parse(body).input[0].content[0].text).toContain('/tmp/kept-image.png');
  }
});

it('uses the same recovered body for local provider handlers, and does not dispatch when preservation fails', async () => {
  const local = vi.fn<LocalRequestHandler>(async ({ rawBody, res }) => { res.end(rawBody); });
  let fail = false;
  const keep = vi.fn(async () => { if (fail) throw new Error('disk full'); return '/tmp/kept'; });
  const proxy = await createAnthropicCompatProxy({
    upstream: 'http://127.0.0.1:1', maxRequestBodyBytes: 1000,
    routingTransform: () => ({ localHandler: local }),
    oversizedRequestRecovery: () => (body, limit) => recoverInlineAttachments(body, limit, keep),
  });
  cleanup.push(() => proxy.dispose());
  const raw = JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${Buffer.alloc(90_000).toString('base64')}` }] }] });
  const send = () => fetch(`${proxy.url}/v1/responses/compact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  expect((await send()).status).toBe(200);
  expect(local).toHaveBeenCalledTimes(1);
  fail = true;
  expect((await send()).status).toBe(413);
  expect(local).toHaveBeenCalledTimes(1);
});

it('spools a request beyond the configured ingress window before request-size control', async () => {
  const received: Buffer[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks));
    res.end('ok');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const proxy = await createAnthropicCompatProxy({
    upstream: `http://127.0.0.1:${port}`,
    maxRequestBodyBytes: 100,
    requestSizeController: {
      enabled: () => true,
      format: () => 'responses',
      route: () => ({}),
      control: async () => ({ body: Buffer.from('{}'), changed: true, originalBytes: 0, bytes: 2, removedImages: 1, imageCount: 1, reason: 'test' }),
    },
  });
  cleanup.push(() => proxy.dispose());
  const raw = JSON.stringify({ model: 'gpt-test', input: [{ role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(10_000) }] }] });
  const response = await fetch(`${proxy.url}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) }, body: raw,
  });
  expect(response.status).toBe(200);
  expect(received).toEqual([Buffer.from('{}')]);
});

// Regression: the disabled controller used to replace legacy ingress recovery and
// reject recoverable histories. Production proxy + recovery, scaled to 8 KiB;
// unit tier, ephemeral loopback fixture. Also protects the legacy 413 retry budget
// when non-image text alone is larger than the new 44% target.
it.each(['ingress', 'upstream-413', 'upstream-400'] as const)(
  'disabled size control matches legacy %s bytes while retaining preprocessing', async mode => {
    let received: Buffer[] = [];
    let rejectNext = false;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push(Buffer.concat(chunks));
      if (rejectNext) {
        rejectNext = false;
        res.statusCode = mode === 'upstream-413' ? 413 : 400;
        res.end('Exceeded maximum number of images (50) allowed in the request.');
      } else res.end('ok');
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const image = (bytes: number) => ({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.alloc(bytes, 3).toString('base64')}` });
    const raw = Buffer.from(JSON.stringify({ model: 'gpt-test', input: [{ role: 'user', content: mode === 'ingress'
      ? [image(6000), image(2000)]
      : [{ type: 'input_text', text: 't'.repeat(12000) }, image(6000)] }] }));
    const prepare = vi.fn<InlineImagePreprocessor['prepare']>(async () => null);
    const retry = vi.fn(async () => Buffer.from('{}'));
    const targets: number[][] = [[], []];
    const sent: Buffer[][] = [];
    for (const disabled of [false, true]) {
      const index = Number(disabled);
      const options: ProxyOptions = {
        upstream: `http://127.0.0.1:${port}`, transformRequest: [],
        maxRequestBodyBytes: mode === 'ingress' ? 8192 : 32768,
        oversizedRequestRecovery: () => (body, target) => {
          targets[index].push(target);
          return recoverInlineAttachments(body, target, async () => '/tmp/legacy-kept.png');
        },
        ...(disabled ? {
          requestSizeController: {
            enabled: () => false,
            format: () => 'responses' as const,
            preprocessor: { prepare }, retry,
            control: (body, format, policy) => controlRequestSize(body, format,
              { ...policy, modelFamily: 'gpt', preprocessor: { prepare } }, async () => '/tmp/new-path-must-not-be-used.png'),
          },
          requestSizeRetry: retry,
        } : {}),
      };
      const proxy = await createAnthropicCompatProxy(options);
      cleanup.push(() => proxy.dispose());
      received = [];
      rejectNext = mode !== 'ingress';
      const response = await fetch(`${proxy.url}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
      });
      expect(response.status).toBe(mode === 'upstream-400' ? 400 : 200);
      await response.text();
      sent.push(received);
    }
    expect(sent[1]).toEqual(sent[0]);
    expect(targets[1]).toEqual(targets[0]);
    expect(prepare).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    if (mode === 'ingress') {
      expect(sent[1][0].length).toBeLessThanOrEqual(8192);
      expect(sent[1][0].toString()).toContain('Preserved local file:');
    } else if (mode === 'upstream-413') {
      expect(sent[1]).toHaveLength(2);
      expect(sent[1][1].length).toBeGreaterThan(raw.length * 0.44);
      expect(targets[1]).toEqual([raw.length - 1]);
    } else expect(sent[1]).toHaveLength(1);
  },
);

// Production HTTP entry: unknown formats and controller exceptions must preserve
// bytes and must not leak exception messages into skip diagnostics (unit tier).
it.each(['format-unknown', 'error'] as const)('logs %s without changing the forwarded request', async reason => {
  let received: Buffer | undefined;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks);
    res.end('ok');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const info = vi.fn();
  const warn = vi.fn();
  const control = vi.fn(async () => { throw new TypeError('private content /secret/path bearer-secret'); });
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${port}`, transformRequest: [], logger: { info, warn },
    requestSizeController: { format: () => reason === 'format-unknown' ? null : 'responses', control } });
  cleanup.push(() => proxy.dispose());
  const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] }] }));
  const response = await fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  expect(response.status).toBe(200);
  await response.text();
  expect(received).toEqual(raw);
  expect(info).toHaveBeenCalledWith('request size control skipped', {
    reqId: expect.any(Number), reason, originalBytes: raw.length, imageCount: 1,
    ...(reason === 'error' ? { errorType: 'TypeError' } : {}),
  });
  expect(JSON.stringify([info.mock.calls, warn.mock.calls])).not.toContain('bearer-secret');
  if (reason === 'format-unknown') expect(control).not.toHaveBeenCalled();
});

// Real ingress + upstream 413 + media recovery: the learned route budget was
// missing from the spool branch. An 8 KiB ingress window reproduces CC/Pi's
// 32 MiB path without a large fixture; unit tier, ephemeral loopback servers.
it.each(['anthropic', 'chat', 'responses'] as const)('reuses a learned 413 budget on the next spooled %s request', async format => {
  const received: Buffer[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks));
    res.statusCode = received.length === 1 ? 413 : 200;
    res.end(received.length === 1 ? 'request too large' : 'ok');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const routePath = format === 'anthropic' ? '/v1/messages' : format === 'chat' ? '/v1/chat/completions' : '/v1/responses';
  const wire = (count: number, small = false) => Buffer.from(JSON.stringify({ metadata: { model: 'nested-decoy', note: 'a "quote" and a brace {' }, [format === 'responses' ? 'input' : 'messages']:
    Array.from({ length: count }, (_, index) => {
      const data = Buffer.alloc(small ? 120 : count > 2 && index === 0 ? 60_000 : 2400, index + 1).toString('base64');
      const image = format === 'anthropic' ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }
        : format === 'chat' ? { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }
        : { type: 'input_image', image_url: `data:image/png;base64,${data}` };
      return { role: 'user', content: [image] };
    }), model: 'gpt-test' }));
  const policies: unknown[] = [];
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${port}`, transformRequest: [], maxRequestBodyBytes: 8192,
    oversizedRequestRecovery: () => (body, target) => recoverInlineAttachments(body, target, async () => '/tmp/kept.png'),
    requestSizeController: {
      format: () => format,
      route: (ctx, body) => ({ endpoint: ctx.url, providerId: 'test-provider', modelId: (body as { model: string }).model, deniedMimeTypes: ['image/webp'] }),
      control: (body, wireFormat, policy) => {
        policies.push(Object.fromEntries(Object.entries(policy).filter(([key]) => key !== 'signal' && key !== 'context')));
        return controlRequestSize(body, wireFormat, { ...policy, triggerBytes: policy.triggerBytes ?? 8192, targetBytes: policy.targetBytes ?? 6000 },
          async () => '/tmp/kept.png');
      },
    },
  });
  cleanup.push(() => proxy.dispose());
  const send = async (body: Buffer) => {
    const response = await fetch(`${proxy.url}${routePath}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-only' }, body });
    expect(response.status).toBe(200);
    await response.text();
  };
  const initial = wire(2);
  const followup = wire(4);
  expect(initial.length).toBeLessThan(8192);
  expect(followup.lastIndexOf(Buffer.from('"model"'))).toBeGreaterThan(64 * 1024);
  await send(initial);
  const learnedTrigger = Math.floor(received[0].length * 0.44);
  const learnedTarget = Math.floor(learnedTrigger * 0.44);
  expect(received[1].length).toBeLessThanOrEqual(learnedTrigger);
  await send(followup);
  expect(received).toHaveLength(3);
  expect(received[2].length).toBeLessThanOrEqual(learnedTrigger);
  const spooledPolicy = policies.at(-1);
  expect(spooledPolicy).toMatchObject({ triggerBytes: learnedTrigger, targetBytes: learnedTarget, reason: 'learned', allowRemoval: true,
    route: { providerId: 'test-provider', modelId: 'gpt-test', deniedMimeTypes: ['image/webp'] } });
  await send(initial);
  expect(policies.at(-1)).toEqual(spooledPolicy); // Same route/policy through the memory path.
  expect(received[3]).toEqual(received[1]); // Retry and later replay of the same history match.
  const small = wire(1, true);
  await send(small);
  expect(received.at(-1)).toEqual(small);
});

// Approved Codex HTTP fallback cap: scale MiB to KiB so all four real ingress
// paths run cheaply. The host assembly test separately locks production 42 MiB.
// Unit tier, real collector/replay/recovery and an ephemeral loopback upstream.
it.each(['controlled', 'disabled', 'unowned-above', 'unowned-below'] as const)(
  'applies the 42 MiB fallback contract through scaled ingress: %s', async mode => {
    const received: Buffer[] = [];
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push(Buffer.concat(chunks));
      res.end('ok');
    });
    const port = await listenOnAvailableLoopbackPort(upstream);
    cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const limit = 42 * 1024;
    const target = 14 * 1024;
    const unowned = mode.startsWith('unowned');
    const prepare = vi.fn<InlineImagePreprocessor['prepare']>(async ({ bytes, mimeType }) => mode === 'unowned-above'
      ? { bytes: bytes.subarray(0, bytes.length - 64), mimeType, width: 1, height: 1, changed: true, cacheKey: 'fake' }
      : null);
    const preserve = vi.fn(async () => '/tmp/controlled.png');
    const recover = vi.fn((body: Parameters<typeof recoverInlineAttachments>[0], budget: number) =>
      recoverInlineAttachments(body, budget, async () => '/tmp/legacy.png'));
    let controlledBytes: number | undefined;
    const proxy = await createAnthropicCompatProxy({
      upstream: `http://127.0.0.1:${port}`, transformRequest: [], maxRequestBodyBytes: limit,
      oversizedRequestRecovery: () => unowned ? null : recover,
      requestSizeController: {
        enabled: () => mode !== 'disabled', format: () => 'responses',
        control: async (body, format, policy) => {
          const result = await controlRequestSize(body, format, {
            ...policy, allowRemoval: unowned ? false : policy.allowRemoval, preprocessor: { prepare },
            triggerBytes: 32 * 1024, targetBytes: target,
          }, preserve);
          controlledBytes = result?.bytes ?? body.length;
          return result;
        },
      },
    });
    cleanup.push(() => proxy.dispose());
    const request = { model: 'gpt-test', input: [{ role: 'user', content: [
      { type: 'input_image', image_url: `data:image/png;base64,${Buffer.alloc(30_000, 7).toString('base64')}` },
    ] }], padding: '' };
    const bytes = mode === 'unowned-below' ? Math.floor(41.9 * 1024) : 44 * 1024;
    request.padding = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(request)));
    const raw = Buffer.from(JSON.stringify(request));
    expect(raw.length).toBe(bytes);
    const response = await fetch(`${proxy.url}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(bytes) }, body: raw,
    });
    expect(response.status).toBe(mode === 'unowned-above' ? 413 : 200);
    await response.text();
    if (mode === 'unowned-above') {
      expect(prepare).toHaveBeenCalledOnce();
      expect(controlledBytes).toBeLessThan(bytes);
      expect(controlledBytes).toBeGreaterThan(limit);
      expect(preserve).not.toHaveBeenCalled();
      expect(received).toEqual([]);
    } else if (mode === 'unowned-below') {
      expect(prepare).toHaveBeenCalledOnce();
      expect(preserve).not.toHaveBeenCalled();
      expect(received).toEqual([raw]);
    } else if (mode === 'disabled') {
      expect(recover).toHaveBeenCalledOnce();
      expect(recover.mock.calls[0][1]).toBe(limit);
      expect(preserve).not.toHaveBeenCalled();
      expect(received).toHaveLength(1);
      expect(received[0].length).toBeLessThanOrEqual(limit);
      expect(received[0].toString()).toContain('/tmp/legacy.png');
    } else {
      expect(recover).not.toHaveBeenCalled();
      expect(preserve).toHaveBeenCalledOnce();
      expect(received).toHaveLength(1);
      expect(received[0].length).toBeLessThanOrEqual(target);
    }
  },
);

// Real retry/forwarding state machine, tiny inline fixtures. Learned rules must
// be committed on success, apply to later tasks on the same route, and replay
// from the same original history as the retry (not the already-cut wire body).
// PR #10693: unrelated scenarios shared one timeout and exceeded 5s on Windows.
// Keep each stateful history intact, but give independent rules fresh fixtures.
// Unit tier; all three protocols still use the production HTTP proxy/controller.
it.each((['responses', 'anthropic', 'chat'] as const).flatMap(format => [
  'replay and route isolation', 'unusable advertised limits', 'progressive tightening',
  'independent byte and count limits', 'tiny count-only retries', 'unknown count limits',
].map(scenario => ({ format, scenario }))))('learns $format count rules: $scenario', async ({ format, scenario }) => {
  const received: Buffer[] = [];
  let reject: { count?: number; failRetry?: boolean; maxBytes?: number } | undefined;
  let pendingFailure = false;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks));
    if (pendingFailure) { pendingFailure = false; res.writeHead(503); res.end('retry failed'); return; }
    if (reject) {
      const next = reject; reject = undefined; pendingFailure = next.failRetry === true;
      res.writeHead(400);
      res.end(JSON.stringify({ error: { message: `NovaException - ${JSON.stringify({ error: { message: `${next.count === undefined ? 'Too many images.' : `Exceeded maximum number of images (${next.count}) allowed in the request.`}${next.maxBytes ? ` Max size is ${next.maxBytes} bytes` : ''}` } })}` } }));
    } else res.end('ok');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const path = format === 'responses' ? '/v1/responses' : format === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  const wire = (count: number, size = 1200) => Buffer.from(JSON.stringify({ model: 'grok-test', [format === 'responses' ? 'input' : 'messages']:
    Array.from({ length: count }, (_, index) => {
      const data = Buffer.alloc(size, index + 1).toString('base64');
      return { role: 'user', content: [format === 'responses' ? { type: 'input_image', image_url: `data:image/png;base64,${data}` }
        : format === 'chat' ? { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }
        : { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] };
    }) }));
  const imageCount = (body: Buffer) => (body.toString().match(/"type":"(?:input_image|image|image_url)"/g) ?? []).length;
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${port}`, transformRequest: [],
    requestSizeController: { format: () => format,
      route: (ctx) => ({ modelId: 'grok-test', providerId: ctx.headers['x-test-provider'] ?? 'route-a' }),
      control: (body, wireFormat, policy) => controlRequestSize(body, wireFormat, policy, async (bytes, mime, index) => `/tmp/image-${index}.${mime.split('/')[1]}-${bytes.length}`),
    },
  });
  cleanup.push(() => proxy.dispose());
  const send = async (count: number, status = 200, provider = 'route-a', size = 1200) => {
    const response = await fetch(`${proxy.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-provider': provider }, body: wire(count, size) });
    expect(response.status).toBe(status); await response.text(); return received.at(-1)!;
  };
  if (scenario === 'replay and route isolation') {
    reject = { count: 50 };
    const retry = await send(60);
    expect(received).toHaveLength(2);
    expect(imageCount(received[0])).toBe(60);
    expect(imageCount(retry)).toBe(31);
    expect(await send(60)).toEqual(retry);
    const appended = await send(61);
    expect(imageCount(appended)).toBe(32);
    expect(appended.subarray(0, retry.length - 2)).toEqual(retry.subarray(0, -2));
    expect(await send(1)).toEqual(wire(1));
    expect(await send(60, 200, 'route-b')).toEqual(wire(60));

    // Route C has no prior rule. Failed retries must not teach anything.
    reject = { count: 50, failRetry: true };
    await send(60, 503, 'route-c');
    expect(await send(60, 200, 'route-c')).toEqual(wire(60));
    return;
  }

  if (scenario === 'unusable advertised limits') {
    for (const advertised of [100, 60]) {
      reject = { count: advertised };
      const recovered = await send(60, 200, `route-limit-${advertised}`);
      expect(imageCount(recovered)).toBe(12); // Greater than OR equal to actual count is not a usable limit.
      expect(await send(60, 200, `route-limit-${advertised}`)).toEqual(recovered);
    }
    return;
  }

  if (scenario === 'progressive tightening') {
    reject = { count: 50 };
    expect(imageCount(await send(60))).toBe(31);
    // A stricter second rejection must replay the original 60 images, not just
    // the 31 images sent on the preceding attempt: 30 -> 13 gives 24 at the tail.
    reject = { count: 30 };
    const tightened = await send(60);
    expect(imageCount(tightened)).toBe(24);
    expect(await send(60)).toEqual(tightened);
    reject = { count: 80 }; // Above the actual 24 images: treat the limit as unknown and tighten again.
    const tighterAgain = await send(60);
    expect(imageCount(tighterAgain)).toBe(4); // 24 * 44% -> trigger 10, target 4; replay the original 60.
    expect(await send(60)).toEqual(tighterAgain);
    return;
  }

  if (scenario === 'independent byte and count limits') {
    reject = { count: 50, maxBytes: 32000 };
    const both = await send(60, 200, 'route-d');
    expect(both.length).toBeLessThanOrEqual(32000);
    expect(imageCount(both)).toBeLessThanOrEqual(50);
    expect(await send(60, 200, 'route-d')).toEqual(both);
    expect(imageCount(await send(60, 200, 'route-d', 3))).toBe(31); // Below the byte cap, count still applies.
    expect((await send(6, 200, 'route-d', 5000)).length).toBeLessThanOrEqual(32000); // Below count cap, bytes still apply.
    return;
  }

  if (scenario === 'tiny count-only retries') {
    reject = { count: 50 };
    const tinyRetry = await send(60, 200, 'route-e', 3);
    expect(imageCount(tinyRetry)).toBe(31); // Placeholders can make this retry larger in bytes.
    expect(tinyRetry.length).toBeGreaterThan(wire(60, 3).length);
    expect(await send(60, 200, 'route-e', 3)).toEqual(tinyRetry);
    return;
  }

  expect(scenario).toBe('unknown count limits');
  reject = {};
  const unknownCount = await send(60, 200, 'route-f');
  expect(imageCount(unknownCount)).toBe(12); // No L: 60 * 44% -> trigger 26, target 11.
  expect(await send(60, 200, 'route-f')).toEqual(unknownCount);
});

it.each([400, 413])('does not learn a rule when the %i recovery retry fails', async status => {
  const received: Buffer[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks));
    res.statusCode = received.length === 1 ? status : received.length === 2 ? 503 : 200;
    res.end(received.length === 1 ? (status === 400 ? 'Exceeded maximum number of images (50) allowed in the request.' : 'Request size is too large') : 'ok');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const raw = Buffer.from(JSON.stringify({ model: 'grok-test', input: Array.from({ length: 60 }, () => ({ role: 'user', content: [
    { type: 'input_image', image_url: `data:image/png;base64,${Buffer.alloc(1200, 1).toString('base64')}` },
  ] })) }));
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${port}`, transformRequest: [],
    oversizedRequestRecovery: () => (body, limit) => recoverInlineAttachments(body, limit, async () => '/tmp/kept.png'),
    requestSizeController: { format: () => 'responses', control: (body, format, policy) => controlRequestSize(body, format, policy, async () => '/tmp/kept.png') },
  });
  cleanup.push(() => proxy.dispose());
  const send = () => fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  const first = await send(); expect(first.status).toBe(503); await first.text();
  expect(received).toHaveLength(2);
  const next = await send(); expect(next.status).toBe(200); await next.text();
  expect(received.at(-1)).toEqual(raw);
});

it('keeps the stricter rule when an earlier, looser retry completes last', async () => {
  let finishEarlier!: () => void;
  const count = (body: Buffer) => (body.toString().match(/"type":"input_image"/g) ?? []).length;
  const received: Array<{ lane: string; body: Buffer }> = [];
  const attempts = new Map<string, number>();
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const lane = String(req.headers['x-test-lane']);
    received.push({ lane, body: Buffer.concat(chunks) });
    const attempt = (attempts.get(lane) ?? 0) + 1; attempts.set(lane, attempt);
    if (attempt === 1 && lane !== 'check') {
      res.writeHead(400); res.end(`Exceeded maximum number of images (${lane === 'earlier' ? 50 : 30}) allowed.`);
    } else if (lane === 'earlier') {
      res.writeHead(200); res.write('accepted'); finishEarlier = () => res.end('done');
    } else res.end('ok');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const raw = Buffer.from(JSON.stringify({ model: 'grok-test', input: Array.from({ length: 60 }, () => ({ role: 'user', content: [
    { type: 'input_image', image_url: `data:image/png;base64,${Buffer.alloc(1200, 1).toString('base64')}` },
  ] })) }));
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${port}`, transformRequest: [],
    requestSizeController: { format: () => 'responses', control: (body, format, policy) => controlRequestSize(body, format, policy, async () => '/tmp/kept.png') },
  });
  cleanup.push(() => proxy.dispose());
  const send = (lane: string) => fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-lane': lane }, body: raw });
  const earlier = await send('earlier');
  try {
    const tighter = await send('tighter'); expect(tighter.status).toBe(200); await tighter.text();
    expect(count(received.find(item => item.lane === 'tighter')!.body)).toBe(60); // Merely receiving 200 headers did not learn the earlier rule.
    expect(count(received.at(-1)!.body)).toBe(24);
  } finally { finishEarlier(); await earlier.text(); }
  const check = await send('check'); expect(check.status).toBe(200); await check.text();
  expect(count(received.at(-1)!.body)).toBe(24);
});

// Retry must count the rejected wire protocol, then replay the original protocol
// and reapply translation/model routing. Otherwise unknown count limits become 0
// and the learned route gets stored under the upstream model alias.
it('replays and learns across protocol translation and an upstream model alias', async () => {
  const received: Buffer[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks));
    res.statusCode = received.length === 1 ? 400 : 200;
    res.end(received.length === 1 ? 'Too many images.' : 'ok');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const proxy = await createAnthropicCompatProxy({
    upstream: `http://127.0.0.1:${port}`, transformRequest: [],
    routingTransform: () => ({ transformRequestBody: body => {
      const original = JSON.parse(body.toString());
      return { body: Buffer.from(JSON.stringify({ model: 'upstream-alias', messages: original.input.map((item: { role: string; content: Array<{ type: string; image_url?: string; text?: string }> }) => ({
        role: item.role, content: item.content.map(block => block.type === 'input_image'
          ? { type: 'image_url', image_url: { url: block.image_url } } : { type: 'text', text: block.text }),
      })) })) };
    } }),
    requestSizeController: {
      format: () => 'responses', route: (_ctx, body) => ({ modelId: (body as { model: string }).model }),
      control: (body, format, policy) => controlRequestSize(body, format, policy, async () => '/tmp/media.png'),
    },
  });
  cleanup.push(() => proxy.dispose());
  const raw = Buffer.from(JSON.stringify({ model: 'grok-original', input: Array.from({ length: 60 }, (_, i) => ({ role: 'user',
    content: [{ type: 'input_image', image_url: `data:image/png;base64,${Buffer.alloc(1200, i).toString('base64')}` }],
  })) }));
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    expect(response.status).toBe(200);
    await response.text();
  }
  expect(received).toHaveLength(3);
  const retried = JSON.parse(received[1].toString());
  expect(retried.model).toBe('upstream-alias');
  expect(retried.messages.filter((item: { content: Array<{ type: string }> }) => item.content[0].type === 'image_url')).toHaveLength(12);
  expect(received[2]).toEqual(received[1]);
});

// Regression: gateways can report 100 MB even when rejecting a 14 MiB request.
// Exercise real 413 forwarding and the production replay controller, including
// the next request and the no-images terminal case. Unit tier; 3 image blocks.
it('shrinks a 14 MiB rejection with a misleading 100 MB limit and learns the tighter rule', async () => {
  const received: Buffer[] = [];
  let reject = true;
  const error = JSON.stringify({ error: 'Request size is too large. Max size is 100 MB' });
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks));
    res.statusCode = reject ? 413 : 200;
    res.end(reject ? error : 'ok'); reject = false;
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  cleanup.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const policies: Array<{ triggerBytes?: number; targetBytes?: number }> = [];
  const proxy = await createAnthropicCompatProxy({ upstream: `http://127.0.0.1:${port}`, transformRequest: [],
    requestSizeController: { format: () => 'responses', route: () => ({ modelId: 'gpt-test' }),
      control: (body, format, policy) => {
        policies.push(policy);
        return controlRequestSize(body, format, { ...policy, modelFamily: 'gpt' }, async () => '/tmp/saved.png');
      },
    },
  });
  cleanup.push(() => proxy.dispose());
  const raw = Buffer.from(JSON.stringify({ input: Array.from({ length: 3 }, (_, index) => ({ role: 'user', content: [
    { type: 'input_image', image_url: `data:image/png;base64,${Buffer.alloc(3.5 * 1024 * 1024, index).toString('base64')}` },
  ] })) }));
  const send = async (body: Buffer, status = 200) => {
    const response = await fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(response.status).toBe(status); return response.text();
  };
  await send(raw);
  expect(received).toHaveLength(2);
  const trigger = Math.floor(raw.length * 0.44);
  expect(policies[1]).toMatchObject({ triggerBytes: trigger, targetBytes: Math.floor(trigger * 0.44) });
  expect(received[1].length).toBeLessThanOrEqual(trigger);
  await send(raw);
  expect(received[2].equals(received[1])).toBe(true);
  reject = true;
  const text = Buffer.from(JSON.stringify({ input: 'no images to remove' }));
  const before = received.length;
  expect(await send(text, 413)).toBe(error);
  expect(received).toHaveLength(before + 1); // No retry loop when no image can be removed.
});
