import { Agent, createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
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
  const wire = (count: number) => Buffer.from(JSON.stringify({ metadata: { model: 'nested-decoy', note: 'a "quote" and a brace {' }, [format === 'responses' ? 'input' : 'messages']:
    Array.from({ length: count }, (_, index) => {
      const data = Buffer.alloc(count > 2 && index === 0 ? 60_000 : 2400, index + 1).toString('base64');
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
  const learnedTarget = Math.floor(received[0].length * 0.44);
  await send(followup);
  expect(received).toHaveLength(3);
  expect(received[2].length).toBeLessThanOrEqual(learnedTarget);
  const spooledPolicy = policies.at(-1);
  expect(spooledPolicy).toMatchObject({ triggerBytes: received[0].length, targetBytes: learnedTarget, reason: 'learned', allowRemoval: true,
    route: { providerId: 'test-provider', modelId: 'gpt-test', deniedMimeTypes: ['image/webp'] } });
  await send(initial);
  expect(policies.at(-1)).toEqual(spooledPolicy); // Same route/policy through the memory path.
});
