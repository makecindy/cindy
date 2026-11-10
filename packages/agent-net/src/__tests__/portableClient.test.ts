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
function fixture(complete = false, kind: 'portable' | 'node' = 'portable') {
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
    bootstrap.ownerCertificate, bootstrap.rootPublicKey, undefined, { fetch: fetchResponse })
    : new PortableAgentNetClient('https://relay.example.test', { identity,
      sign: async text => signature(identity.signingPrivateKey, text), random: async () => Buffer.alloc(32, 17).toString('base64url') },
    bootstrap.ownerCertificate, bootstrap.rootPublicKey, { verifyCertificate, assertCurrent() {}, fetch: fetchResponse,
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
