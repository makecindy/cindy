/** Production PortableAgentNetClient + native media range reader with real Web
 * Streams and signed fixture identities. Rule: media cancellation/timeout lasts
 * through body consumption, not only headers. The native crypto integration
 * never stalls a Fetch response, so it cannot catch detached abort wiring.
 * Unit tier: no network, disk or native process; fake time only for the deadline.
 */
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createPrivateNetwork, generateIdentity, signature, verifyCertificate } from '@cindy/agent-net-relay';
import { AgentNetClient } from '@cindy/agent-net-relay/client';
import { MEDIA_ENCRYPTED_HEADER_BYTES as HEADER } from '@cindy/agent-net-protocol';
import { PortableAgentNetClient } from '../portableClient.js';
import { readNativeMedia } from '../nativeMedia.js';
import type { NativeEnginePort } from '../nativeTransport.js';

afterEach(() => vi.useRealTimers());
function fixture(complete = false, kind: 'portable' | 'node' = 'portable', requestFetch?: typeof fetch, assertCurrent = () => {}) {
  const identity = generateIdentity('media-controller'), { bootstrap } = createPrivateNetwork('Media cancellation', identity);
  let upstream!: AbortSignal, source!: ReadableStreamDefaultController<Uint8Array>;
  let noteRead!: () => void;
  const reading = new Promise<void>(resolve => { noteRead = resolve; });
  const fetchResponse: typeof fetch = async (_url, init) => {
      upstream = init!.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        source = controller;
        upstream.addEventListener('abort', () => { try { controller.error(upstream.reason); } catch {} }, { once: true });
        if (complete) { controller.enqueue(new Uint8Array(HEADER)); controller.close(); }
      }, pull() { noteRead(); } }, { highWaterMark: 0 }),
      { status: 206, headers: { 'content-range': `bytes 0-${HEADER - 1}/${HEADER}` } });
    };
  const api = kind === 'node' ? new AgentNetClient('https://relay.example.test', identity,
    bootstrap.ownerCertificate, bootstrap.rootPublicKey, undefined, { fetch: requestFetch ?? fetchResponse })
    : new PortableAgentNetClient('https://relay.example.test', { identity,
      sign: async text => signature(identity.signingPrivateKey, text), random: async () => Buffer.alloc(32, 17).toString('base64url') },
    bootstrap.ownerCertificate, bootstrap.rootPublicKey, { verifyCertificate, assertCurrent, fetch: requestFetch ?? fetchResponse,
      sha256: value => createHash('sha256').update(value).digest('base64url'),
      createWebSocket() { throw new Error('No WebSocket in this fixture'); } });
  const command = vi.fn(async <T = unknown>(value: unknown): Promise<T> => ((value as { op: string }).op === 'mediaOpen'
    ? { id: 1, size: 0, encryptedSize: HEADER, header: '', headerSha256: '0'.repeat(64) } : true) as T);
  const engine = { command: command as NativeEnginePort['command'], destroy: async () => undefined };
  return { api, engine, reading, signal: () => upstream, stop() { try { source.error(new Error('fixture cleanup')); } catch {} } };
}

it.each(['portable', 'node'] as const)('cancels a %s native range read after Fetch has already returned its headers', async kind => {
  const value = fixture(false, kind), caller = new AbortController();
  const outcome = readNativeMedia(value.api, value.engine, 'unit-object', '0'.repeat(64), async () => undefined,
    { signal: caller.signal }).catch(error => error);
  try {
    await value.reading; expect(value.signal().aborted).toBe(false);
    caller.abort();
    expect(value.signal().aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    expect(value.engine.command).not.toHaveBeenCalled();
  } finally { value.stop(); await outcome; }
});

it.each(['portable', 'node'] as const)('keeps the %s media deadline armed while the response stream is stalled', async kind => {
  vi.useFakeTimers();
  const value = fixture(false, kind);
  const outcome = readNativeMedia(value.api, value.engine, 'unit-object', '0'.repeat(64), async () => undefined).catch(error => error);
  try {
    await value.reading;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(value.signal().aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  } finally { value.stop(); await outcome; }
});

it('removes the caller listener and deadline after the complete body has been consumed', async () => {
  vi.useFakeTimers();
  const value = fixture(true), caller = new AbortController();
  const remove = vi.spyOn(caller.signal, 'removeEventListener');
  expect(await readNativeMedia(value.api, value.engine, 'unit-object', '0'.repeat(64), async () => undefined,
    { signal: caller.signal })).toMatchObject({ size: 0 });
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  expect(value.engine.command).toHaveBeenCalledWith({ op: 'mediaClose', id: 1 });
});

it('also cancels an upload acknowledgement whose JSON body stalls after headers', async () => {
  const value = fixture(), caller = new AbortController();
  const outcome = value.api.putMediaChunk('unit-object', 0, new Uint8Array([1]), caller.signal).catch(error => error);
  try {
    await value.reading; caller.abort();
    expect(value.signal().aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
  } finally { value.stop(); await outcome; }
});

// Directory fallback receives SDK errors, not ApiError. Previous media coverage
// never exercised raw Fetch failures or the control request's 10-second deadline.
// Unit: real request/signing/JSON path with injected Fetch, no I/O or real waits.
const requestCases = (['portable', 'node'] as const).flatMap(kind => (['headers', 'body'] as const).map(stage => ({ kind, stage })));
it.each(requestCases)('classifies a $kind network failure during $stage as an unavailable request', async ({ kind, stage }) => {
  const requestFetch = vi.fn<typeof fetch>(async () => {
    if (stage === 'headers') throw new TypeError('Network request failed');
    return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('Network request failed')); } }));
  });
  const value = fixture(false, kind, requestFetch);
  await expect(value.api.request('GET', '/directory')).rejects.toMatchObject({ status: 0, code: 'AGENT_NET_NETWORK_ERROR' });
  expect(requestFetch).toHaveBeenCalledTimes(1);
});

it.each(requestCases)('classifies the $kind request deadline during $stage without waiting in real time', async ({ kind, stage }) => {
  vi.useFakeTimers();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const requestFetch: typeof fetch = async (_url, init) => {
    const signal = init!.signal!;
    started();
    if (stage === 'headers') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
  };
  const value = fixture(false, kind, requestFetch);
  const outcome = value.api.request('GET', '/directory').catch(error => error);
  await ready;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await outcome).toMatchObject({ status: 0, code: 'AGENT_NET_REQUEST_TIMEOUT' });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['portable', 'node'] as const)('preserves %s certificate denial and malformed JSON as terminal failures', async kind => {
  const denied = fixture(false, kind, async () => Response.json({ error: { code: 'CERTIFICATE_INVALID' } }, { status: 403 }));
  await expect(denied.api.request('GET', '/directory')).rejects.toMatchObject({ status: 403, code: 'CERTIFICATE_INVALID' });
  const malformed = fixture(false, kind, async () => new Response('not JSON'));
  await expect(malformed.api.request('GET', '/directory')).rejects.toBeInstanceOf(SyntaxError);
  const unreadableDenial = fixture(false, kind, async () => new Response(new ReadableStream({ start(controller) {
    controller.error(new TypeError('Network request failed'));
  } }), { status: 403 }));
  await expect(unreadableDenial.api.request('GET', '/directory')).rejects.toMatchObject({ status: 403 });
});

it.each(['portable', 'node'] as const)('does not reclassify %s caller cancellation as a transient outage', async kind => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const value = fixture(false, kind, async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); started();
  }));
  const caller = new AbortController(), outcome = value.api.request('GET', '/directory', undefined, { signal: caller.signal }).catch(error => error);
  await ready; caller.abort();
  const error = await outcome;
  expect(error.name).toBe('AbortError');
  expect(error.status).toBeUndefined();
});

it.each(['portable', 'node'] as const)('preserves a %s service outage status when a proxy returns non-JSON', async kind => {
  const value = fixture(false, kind, async () => new Response('Service unavailable', { status: 503 }));
  await expect(value.api.request('GET', '/directory')).rejects.toMatchObject({ status: 503 });
});

it('keeps an owner change terminal when Fetch fails at the same time', async () => {
  let changed = false;
  const value = fixture(false, 'portable', async () => { changed = true; throw new TypeError('Network request failed'); },
    () => { if (changed) throw new Error('AGENT_NET_OWNER_CHANGED'); });
  await expect(value.api.request('GET', '/directory')).rejects.toThrow('AGENT_NET_OWNER_CHANGED');
});
