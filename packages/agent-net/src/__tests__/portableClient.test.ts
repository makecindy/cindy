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
import { PortableAgentNetClient, type BinarySocket } from '../portableClient.js';
import { readNativeMedia } from '../nativeMedia.js';
import type { NativeEnginePort } from '../nativeTransport.js';

afterEach(() => vi.useRealTimers());

// App routing protocol, unit: real portable signing/WS handshake and presence
// serializer. Media tests never sent presence, so dropping metadata was invisible.
it('sends the App label in portable presence and accepts additive directory metadata', async () => {
  const identity = generateIdentity('app-controller'), { bootstrap } = createPrivateNetwork('App metadata', identity);
  let receive: BinarySocket['onmessage'] = null, ready!: () => void;
  const listening = new Promise<void>(resolve => { ready = resolve; });
  const send = vi.fn();
  const ws: BinarySocket = { readyState: 1, bufferedAmount: 0, binaryType: '', onerror: null, onclose: null,
    get onmessage() { return receive; }, set onmessage(callback) { receive = callback; ready(); }, send, close() {} };
  const api = new PortableAgentNetClient('https://relay.example.test', { identity,
    sign: async text => signature(identity.signingPrivateKey, text), random: async () => Buffer.alloc(32, 17).toString('base64url') },
    bootstrap.ownerCertificate, bootstrap.rootPublicKey, { verifyCertificate, assertCurrent() {},
      sha256: value => createHash('sha256').update(value).digest('base64url'), createWebSocket: () => ws });
  const connected = api.connect();
  await listening;
  ws.onmessage!({ data: JSON.stringify({ type: 'hello', deviceId: identity.deviceId, protocolVersion: 2,
    devices: [{ certificate: bootstrap.ownerCertificate, name: 'Phone', app: 'cindy', online: true, remoteControlEnabled: false, capabilities: [] }], delegations: [] }) });
  const uplink = await connected;
  try {
    uplink.presence(false, [], { platform: 'ios', app: 'cindy' });
    expect(JSON.parse(send.mock.calls.at(-1)![0] as string)).toMatchObject({ type: 'presence', app: 'cindy', platform: 'ios' });
    expect(uplink.devices[0].app).toBe('cindy');
  } finally { uplink.close(); }
});
function fixture(complete = false, kind: 'portable' | 'node' = 'portable', requestFetch?: typeof fetch, assertCurrent = () => {}, direct = false) {
  const identity = generateIdentity('media-controller'), { bootstrap } = createPrivateNetwork('Media cancellation', identity);
  let upstream!: AbortSignal, source!: ReadableStreamDefaultController<Uint8Array>;
  let noteRead!: () => void;
  const reading = new Promise<void>(resolve => { noteRead = resolve; });
  const fetchResponse: typeof fetch = async (_url, init) => {
      if (direct && String(_url).startsWith('https://relay.example.test')) return Response.json({ request: {
        method: 'GET', url: 'https://storage.example.test/object', headers: {}, expiresAt: Date.now() + 600_000,
      } }, { headers: { 'x-agent-net-media-transfer': 'direct-v1' } });
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
  return { api, engine, reading, signal: () => upstream, push(bytes: Uint8Array) { source.enqueue(bytes); }, finish() { source.close(); }, stop() { try { source.error(new Error('fixture cleanup')); } catch {} } };
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

// #10142 review: real native range consumer on both client transports. Unit tier,
// fake clock + Web Streams: existing stalled-body tests missed steady slow bytes
// and direct storage. Three header chunks over 80 seconds are the smallest input.
const mediaRoutes = (['portable', 'node'] as const).flatMap(kind => [false, true].map(direct => ({ kind, direct })));
it.each(mediaRoutes)('keeps $kind media alive on slow bytes (direct=$direct)', async ({ kind, direct }) => {
  vi.useFakeTimers();
  const value = fixture(false, kind, undefined, undefined, direct);
  const outcome = readNativeMedia(value.api, value.engine, 'unit-object', '0'.repeat(64), async () => undefined).catch(error => error);
  try {
    await value.reading;
    value.push(new Uint8Array(1));
    await vi.advanceTimersByTimeAsync(40_000);
    value.push(new Uint8Array(1));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(value.signal().aborted).toBe(false);
    value.push(new Uint8Array(HEADER - 2)); value.finish();
    expect(await outcome).toMatchObject({ size: 0 });
    expect(vi.getTimerCount()).toBe(0);
  } finally { value.stop(); await outcome; }
});

it.each(mediaRoutes)('expires $kind media after no new bytes (direct=$direct)', async ({ kind, direct }) => {
  vi.useFakeTimers();
  const value = fixture(false, kind, undefined, undefined, direct);
  const outcome = readNativeMedia(value.api, value.engine, 'unit-object', '0'.repeat(64), async () => undefined).catch(error => error);
  try {
    await value.reading;
    await vi.advanceTimersByTimeAsync(40_000); value.push(new Uint8Array(1));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(value.signal().aborted).toBe(false);
    value.push(new Uint8Array(0));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(value.signal().aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    expect(value.engine.command).not.toHaveBeenCalled();
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

// Direct media transfer, unit: the relay grants presigned storage requests and the portable client (mobile) must
// send each chunk to the storage with the Content-MD5 it was granted, confirm progress through the relay (a lost
// storage reply is not a lost write), read ranges from the storage, and go back to the relay when a cached read
// is refused. Minimal input: two 5-byte chunks and one 4-byte range. Stub Fetch, no network.
function directFixture(withMd5 = true) {
  const identity = generateIdentity('direct-owner'), { bootstrap } = createPrivateNetwork('Direct media', identity);
  const stored = new Map<string, Buffer>(), calls: string[] = [];
  let grants = 0, dropNextStorageReply = false, revokedGrants = 0, blocked = false, blockedCalls = 0, relayedReads = 0;
  const offers: boolean[] = [];
  const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  const fetchStub: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    calls.push(method + ' ' + url.host + url.pathname);
    if (url.host === 'storage.example.test') {
      if (blocked) { blockedCalls++; throw new TypeError('fetch failed'); }
      const id = url.pathname.slice(1);
      if (method === 'POST') {
        const body = Buffer.from(init!.body as Uint8Array);
        if ((init!.headers as Record<string, string>)['content-md5'] !== createHash('md5').update(body).digest('base64')) return new Response(null, { status: 400 });
        stored.set(id, Buffer.concat([stored.get(id) ?? Buffer.alloc(0), body]));
        if (dropNextStorageReply) { dropNextStorageReply = false; throw new TypeError('fetch failed'); }
        return new Response(null, { status: 200 });
      }
      if (Number(url.searchParams.get('grant')) <= revokedGrants) return new Response(null, { status: 403 });
      const object = stored.get(id)!, [, start, end] = /^bytes=(\d+)-(\d+)$/.exec((init!.headers as Record<string, string>).range)!.map(Number);
      return new Response(new Uint8Array(object.subarray(start, end + 1)), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${object.length}` } });
    }
    const id = url.pathname.split('/')[4];
    if (method === 'POST' && url.pathname.endsWith('/media')) {
      const body = JSON.parse(String(init!.body));
      offers.push(body.transfer === 'direct-v1');
      return json({ id: 'object-1', chunkBytes: 8 * 1024 * 1024, ...(body.transfer === 'direct-v1' ? { transfer: 'direct-v1' } : {}) });
    }
    if (url.pathname.endsWith('/upload')) {
      const body = JSON.parse(String(init!.body));
      return json({ request: { method: 'POST', url: `https://storage.example.test/${id}?position=${body.offset}`, headers: { 'content-md5': body.md5 }, expiresAt: Date.now() + 60_000 } });
    }
    if (url.pathname.endsWith('/commit')) return json({ received: stored.get(id)?.length ?? 0, complete: (stored.get(id)?.length ?? 0) === 10 });
    if (method === 'PUT') {
      stored.set(id, Buffer.concat([stored.get(id) ?? Buffer.alloc(0), Buffer.from(init!.body as Uint8Array)]));
      return json({ received: stored.get(id)!.length, complete: stored.get(id)!.length === 10 });
    }
    const headers = init!.headers as Record<string, string>;
    if (headers['x-agent-net-media-transfer'] !== 'direct-v1') {
      relayedReads++;
      const object = stored.get(id)!, [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.range)!.map(Number);
      return new Response(new Uint8Array(object.subarray(start, end + 1)), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${object.length}` } });
    }
    grants++;
    return json({ transfer: 'direct-v1', size: 10, request: { method: 'GET', url: `https://storage.example.test/${id}?grant=${grants}`, headers: {}, expiresAt: Date.now() + 60_000 } },
      { 'x-agent-net-media-transfer': 'direct-v1' });
  };
  const api = new PortableAgentNetClient('https://relay.example.test', { identity,
    sign: async text => signature(identity.signingPrivateKey, text), random: async () => Buffer.alloc(32, 17).toString('base64url') },
  bootstrap.ownerCertificate, bootstrap.rootPublicKey, { verifyCertificate, assertCurrent() {}, fetch: fetchStub,
    sha256: value => createHash('sha256').update(value).digest('base64url'),
    ...(withMd5 ? { md5: (value: Uint8Array) => new Uint8Array(createHash('md5').update(value).digest()) } : {}),
    createWebSocket() { throw new Error('No WebSocket in this fixture'); } });
  return { api, stored, calls, offers, dropReply() { dropNextStorageReply = true; }, refuse() { revokedGrants = grants; },
    block() { blocked = true; }, blockedCalls: () => blockedCalls, relayedReads: () => relayedReads };
}

it('sends media chunks and range reads straight to the granted storage, confirming each write through the relay', async () => {
  const value = directFixture();
  const created = await value.api.createMedia('recipient', 10);
  value.dropReply();
  await expect(value.api.putMediaChunk(created.id, 0, Buffer.from('hello'))).resolves.toEqual({ received: 5, complete: false });
  await expect(value.api.putMediaChunk(created.id, 5, Buffer.from('world'))).resolves.toEqual({ received: 10, complete: true });
  expect(value.stored.get('object-1')!.toString()).toBe('helloworld');
  expect(value.calls.filter(call => call.startsWith('PUT'))).toEqual([]);
  const read = () => value.api.withMediaResponse('object-1', 'bytes=3-6', async response => Buffer.from(await response.arrayBuffer()).toString());
  await expect(read()).resolves.toBe('lowo');
  const relayReads = () => value.calls.filter(call => call === 'GET relay.example.test/api/agent-net/media/object-1').length;
  await expect(read()).resolves.toBe('lowo');
  expect(relayReads()).toBe(1);
  value.refuse();
  await expect(read()).resolves.toBe('lowo');
  expect(relayReads()).toBe(2);
  expect(value.relayedReads()).toBe(0);
});

it('keeps media working through the relay when this network cannot reach the storage', async () => {
  const upload = directFixture();
  upload.block();
  const created = await upload.api.createMedia('recipient', 10);
  await expect(upload.api.putMediaChunk(created.id, 0, Buffer.from('hello'))).resolves.toEqual({ received: 5, complete: false });
  await expect(upload.api.putMediaChunk(created.id, 5, Buffer.from('world'))).resolves.toEqual({ received: 10, complete: true });
  expect(upload.stored.get('object-1')!.toString()).toBe('helloworld');
  expect(upload.blockedCalls()).toBe(1);
  // Later uploads from this client do not offer direct transfer for a while.
  await upload.api.createMedia('recipient', 10);
  expect(upload.offers).toEqual([true, false]);
  const download = directFixture();
  download.stored.set('object-1', Buffer.from('helloworld'));
  download.block();
  const read = () => download.api.withMediaResponse('object-1', 'bytes=3-6', async response => Buffer.from(await response.arrayBuffer()).toString());
  await expect(read()).resolves.toBe('lowo');
  await expect(read()).resolves.toBe('lowo');
  expect(download.blockedCalls()).toBe(1);
  expect(download.relayedReads()).toBe(2);
});

it('keeps media on the relay when the client cannot bind chunks with MD5', async () => {
  const value = directFixture(false);
  const created = await value.api.createMedia('recipient', 1);
  await value.api.putMediaChunk(created.id, 0, Buffer.from('x'));
  expect(value.calls).toEqual(['POST relay.example.test/api/agent-net/media', 'PUT relay.example.test/api/agent-net/media/object-1']);
});

/** 测试价值
 * - 生产入口与可观察结果：PortableAgentNetClient.connect 返回的手机端中转 WebSocket 上行（PortableUplink.send / close）。
 *   底层发送缓冲持续排不空满 1 秒后丢弃新的中转 UDP 封装包（不再往半开连接里堆积）；满 45 秒仍未排空且无新消息排空时主动关闭并上报
 *   close(1006)，交由 AgentNetSocket 重建中转连接；中途缓冲排空则清除卡死计时、连接保留。
 * - Bug／规则依据：React Native 的 WebSocket 没有控制帧 ping，而 Agent-Net 中转服务端（server.ts）拒绝除 presence 以外的客户端文本帧。
 *   对齐桌面端 DatagramSendQueue（1 秒丢包）与 AGENT_NET_UPLINK_KEEPALIVE（45 秒超时）。
 * - 现有覆盖缺口：已有测试只覆盖媒体流超时与握手文本帧，未覆盖 WebSocket 发送缓冲长期不排空的半开保护与恢复。
 * - 最小失败输入：一条已握手的 PortableUplink、两次相隔 1.1 秒的发包，以及 20 秒排空恢复／45 秒未排空关闭两分支。
 * - tier：unit，真实签名握手与二进制封装，内存 BinarySocket + 假计时器；约 10 毫秒。 */
it.each([
  ['verifies a stalled request against a silent relay', 'probe-silent'],
  ['keeps the relay after a probe reply', 'probe-answered'],
  ['closes the half-open socket after 45 s', 'dead'],
  ['recovers once bufferedAmount drains', 'drains'],
  ['keeps sending when bufferedAmount is undefined (React Native)', 'undefined'],
  ['still emits close once when ws.onerror fires after handshake', 'onerror'],
] as const)(
  'handles WebSocket send-buffer tracking: %s', async (_label, mode) => {
    vi.useFakeTimers();
    const identity = generateIdentity('uplink-stall'), { bootstrap } = createPrivateNetwork('Uplink stall', identity);
    let receive: BinarySocket['onmessage'] = null, ready!: () => void;
    const listening = new Promise<void>(resolve => { ready = resolve; });
    let stalled = mode !== 'undefined' && mode !== 'onerror';
    const send = vi.fn((payload: string | Uint8Array) => {
      if (stalled && payload instanceof Uint8Array) ws.bufferedAmount += payload.byteLength;
    });
    const close = vi.fn(() => {
      if (mode === 'onerror') {
        ws.readyState = 3;
        ws.onclose?.({ code: 1006 });
      }
    });
    const ws: BinarySocket = { readyState: 1, bufferedAmount: (mode === 'undefined' ? undefined : 0) as unknown as number,
      binaryType: '', onerror: null, onclose: null,
      get onmessage() { return receive; }, set onmessage(callback) { receive = callback; ready(); }, send, close };
    const api = new PortableAgentNetClient('https://relay.example.test', { identity,
      sign: async text => signature(identity.signingPrivateKey, text), random: async () => Buffer.alloc(32, 19).toString('base64url') },
      bootstrap.ownerCertificate, bootstrap.rootPublicKey, { verifyCertificate, assertCurrent() {},
        sha256: value => createHash('sha256').update(value).digest('base64url'), createWebSocket: () => ws });
    const connected = api.connect();
    await listening;
    ws.onmessage!({ data: JSON.stringify({ type: 'hello', deviceId: identity.deviceId, protocolVersion: 2,
      relayProbe: mode.startsWith('probe-'),
      devices: [{ certificate: bootstrap.ownerCertificate, name: 'Phone', online: true, remoteControlEnabled: false, capabilities: [] }], delegations: [] }) });
    const uplink = await connected;
    const closed = vi.fn(() => uplink.once('close', closed));
    uplink.once('close', closed);
    try {
      uplink.probeRelay?.();
      uplink.probeRelay?.();
      if (mode === 'probe-silent' || mode === 'probe-answered') {
        expect(send).toHaveBeenCalledExactlyOnceWith('{"type":"relay-probe"}');
        if (mode === 'probe-answered') ws.onmessage!({ data: '{"type":"relay-pong"}' });
        await vi.advanceTimersByTimeAsync(15_000);
        expect(closed).toHaveBeenCalledTimes(mode === 'probe-silent' ? 1 : 0);
        return;
      }
      expect(send).not.toHaveBeenCalled(); // Earlier relays only accept presence frames.
      uplink.send('peer-a', Uint8Array.of(1, 2, 3));
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);

      if (mode === 'onerror') {
        ws.onerror!({ message: 'socket reset' });
        await Promise.resolve();
        expect(close).toHaveBeenCalledOnce();
        expect(closed).toHaveBeenCalledExactlyOnceWith(1006);
        return;
      }

      if (mode === 'undefined') {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(close).not.toHaveBeenCalled();
        expect(closed).not.toHaveBeenCalled();
        uplink.send('peer-a', Uint8Array.of(4, 5, 6));
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledTimes(2);
        return;
      }

      expect(ws.bufferedAmount).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1_100);
      uplink.send('peer-a', Uint8Array.of(4, 5, 6));
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();

      if (mode === 'drains') {
        await vi.advanceTimersByTimeAsync(20_000);
        stalled = false;
        ws.bufferedAmount = 0;
        ws.onmessage!({ data: JSON.stringify({ type: 'directory', deviceId: identity.deviceId,
          devices: [{ certificate: bootstrap.ownerCertificate, name: 'Phone', online: true, remoteControlEnabled: false, capabilities: [] }], delegations: [] }) });
        await vi.advanceTimersByTimeAsync(40_000);
        expect(close).not.toHaveBeenCalled();
        expect(closed).not.toHaveBeenCalled();
        uplink.send('peer-a', Uint8Array.of(7, 8));
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledTimes(2);
      } else {
        await vi.advanceTimersByTimeAsync(44_000);
        expect(close).toHaveBeenCalledOnce();
        expect(closed).toHaveBeenCalledExactlyOnceWith(1006);
      }
    } finally {
      uplink.close();
      expect(vi.getTimerCount()).toBe(0);
    }
  });
