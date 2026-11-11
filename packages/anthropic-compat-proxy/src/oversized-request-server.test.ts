import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createAnthropicCompatProxy } from './server.js';
import type { LocalRequestHandler } from './types.js';
import { recoverInlineAttachments as recover, type RecoveredAttachment } from './oversized-attachments.js';
import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
const recoverInlineAttachments = (body: Parameters<typeof recover>[0], limit: number, prepare: (a: RecoveredAttachment) => Promise<string>) =>
  recover(body, limit, { prepare, commit: async () => {} });

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

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
    for await (const _ of req) { /* consume */ }
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
  for (const chunked of [false, true]) {
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(`${proxy.url}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(chunked ? {} : { 'content-length': Buffer.byteLength(raw) }) } }, res => {
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
