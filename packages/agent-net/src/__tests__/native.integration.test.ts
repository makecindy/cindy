/**
 * Opt-in native C ABI interoperability gate, using the real compiled library.
 * Unlike the Rust simulator this crosses the actual Node/WASM <-> native ABI.
 * Set CINDY_AGENT_NET_NATIVE_LIBRARY after cargo build; no Python in production.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHash, verify } from 'node:crypto';
import WebSocket from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Endpoint, type Connection, type RecvStream } from '@cindy/agent-net-core/node';
import { approveJoin, createDelegation, createJoinRequest, createPrivateNetwork, generateIdentity, identityFromSeed, signature, startAgentNetRelay, verifyCertificate, verifyDelegation } from '@cindy/agent-net-relay';
import { AgentNetClient, submitJoin, uploadEncryptedMedia, openEncryptedMedia, sealNotification } from '@cindy/agent-net-relay/client';
import { notificationKeyPayload, delegationPayload } from '@cindy/agent-net-protocol';
import { DeviceLinkClient, providerShareHostPeer, sharedTaskHostPeer, type InvokePayload } from '@cindy/device-link';
import { PROTOCOL_VERSION } from '@cindy/device-link-protocol';
import { AgentNetSocket } from '../socket.js';
import { AgentNetSocket as PortableSocket } from '../portableSocket.js';
import { NativeTransport, type NativeEnginePort } from '../nativeTransport.js';
import { PortableAgentNetClient, type BinarySocket } from '../portableClient.js';
import type { SocketClient } from '../socketPorts.js';
import { uploadNativeMedia, readNativeMedia } from '../nativeMedia.js';
import { openNativeByteStream, openNativeMediaStream } from '../nativeMediaStream.js';

const library = process.env.CINDY_AGENT_NET_NATIVE_LIBRARY;
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

// Real C ABI + HTTP integration: downloading the entire video before yielding
// a player URL regressed V1 seeking/startup. Existing block tests never opened
// the production loopback player or checked that unopened bytes stay unread.
it.skipIf(!library)('streams only requested native video blocks and closes the loopback route on authorization failure', async () => {
  const native = new NativePeer(), seed = Buffer.alloc(32, 63).toString('base64url'), context = 'unit-range-player';
  await native.call({ seed, context, deviceId: 'native-video', udp: false }, 'create');
  const identity = identityFromSeed(context, seed, 'native-video'), owner = generateIdentity('video-owner');
  const { root, bootstrap } = createPrivateNetwork('Video fixture', owner);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cindy-agent-net-video-'));
  cleanups.push(async () => {
    if (!path.resolve(dataDir).startsWith(path.join(tmpdir(), 'cindy-agent-net-video-'))) throw new Error('UNSAFE_TEST_CLEANUP');
    await rm(dataDir, { recursive: true, force: true });
  });
  const relay = await startAgentNetRelay({ dataDir, bootstrap, udpPort: 0 }); cleanups.push(() => relay.close());
  const host = new AgentNetClient(relay.url, owner, bootstrap.ownerCertificate, bootstrap.rootPublicKey);
  const { joinCode } = await host.request<{ joinCode: string }>('POST', '/join-codes');
  const csr = createJoinRequest(identity, bootstrap.networkId, joinCode, 'Video', 'unit-video-secret');
  await submitJoin(relay.url, csr);
  const certificate = approveJoin(root, csr, 'unit-video-secret', bootstrap.ownerCertificate.subject);
  await host.request('POST', '/join-requests/' + csr.requestId + '/approve', { certificate });
  const api = new AgentNetClient(relay.url, identity, certificate, bootstrap.rootPublicKey);
  const block = 1024 * 1024, plain = Buffer.alloc(3 * block + 123);
  for (let i = 0; i < plain.length; i++) plain[i] = i % 251;
  const uploaded = await uploadEncryptedMedia(host, identity.deviceId, identity.transportKey, plain.length,
    async (offset, size) => plain.subarray(offset, offset + size));
  const reads = vi.spyOn(api, 'mediaResponse');
  const stream = await openNativeMediaStream(api, { command: command => native.call(command), destroy: () => native.destroy() },
    uploaded.id, uploaded.headerSha256, 'video/mp4; codecs="avc1"'); cleanups.push(() => stream.close());
  expect(reads).toHaveBeenCalledTimes(1); // authenticated header, no whole-file prefetch
  const head = await fetch(stream.url, { method: 'HEAD' });
  expect(head.headers.get('content-type')).toBe('video/mp4');
  expect(head.headers.get('content-length')).toBe(String(plain.length)); expect(reads).toHaveBeenCalledTimes(1);
  expect((await fetch(stream.url.replace(/\/[A-Za-z0-9_-]{43}$/, '/not-the-token'))).status).toBe(404);
  const response = await fetch(stream.url, { headers: { range: `bytes=${block - 13}-${block + 21}` } });
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe(`bytes ${block - 13}-${block + 21}/${plain.length}`);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(plain.subarray(block - 13, block + 22));
  expect(reads).toHaveBeenCalledTimes(3);
  const tail = await fetch(stream.url, { headers: { range: 'bytes=-17' } });
  expect(Buffer.from(await tail.arrayBuffer())).toEqual(plain.subarray(-17));
  // Block 1 remains cached after the tail read, block 2 does not. A mostly
  // cached range must not regress its progress when network bytes start again.
  const mixed = await fetch(stream.url, { headers: { range: `bytes=${block + 1}-${2 * block}` } });
  expect(Buffer.from(await mixed.arrayBuffer())).toEqual(plain.subarray(block + 1, 2 * block + 1));
  expect((await fetch(stream.url, { headers: { range: 'bytes=999999999-' } })).status).toBe(416);
  await host.request('DELETE', '/devices/' + identity.deviceId);
  // Block 0 has been evicted from the two-block cache. Revocation cannot yield new bytes.
  await expect((async () => {
    const denied = await fetch(stream.url, { headers: { range: `bytes=0-9` } });
    return denied.arrayBuffer();
  })()).rejects.toThrow();
  await vi.waitFor(() => expect(stream.isOpen()).toBe(false), { interval: 5 });
});

class NativePeer {
  private next = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private child = spawn(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), [fileURLToPath(new URL('../../../agent-net-native/tests/native-peer.py', import.meta.url)), library!], { stdio: ['pipe', 'pipe', 'pipe'] });
  private lines = createInterface({ input: this.child.stdout });
  constructor() {
    this.lines.on('line', line => {
      const response = JSON.parse(line), pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.code ?? 'NATIVE_PEER_ERROR'));
    });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('exit', code => this.fail(new Error('NATIVE_PEER_EXIT_' + code)));
    cleanups.push(() => { this.lines.close(); this.child.stdin.end(); this.child.kill(); });
  }
  private fail(error: Error) { for (const call of this.pending.values()) call.reject(error); this.pending.clear(); }
  call(value: unknown, op = 'command'): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, op, value }) + '\n');
    });
  }
  async destroy(): Promise<void> { this.child.stdin.end(); }
}

async function until(action: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await action())) {
    if (Date.now() >= deadline) throw new Error('NATIVE_INTEROP_DEADLINE');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

it.skipIf(!library)('derives the Node identity and exchanges Noise-protected UDP streams through the real native C ABI', async () => {
  const native = new NativePeer();
  const seed = Buffer.alloc(32, 31).toString('base64url'); // Public, deterministic unit fixture.
  await native.call({ seed, context: 'unit-native-interop', deviceId: 'native-host' }, 'create');
  const identity = await native.call({ op: 'identity' });
  const expected = identityFromSeed('unit-native-interop', seed, 'native-host');
  expect(identity.signingKey).toBe(expected.signingKey);
  expect(identity.transportKey).toBe(expected.transportKey);
  const proof = 'unit native request proof';
  const signed = await native.call({ op: 'sign', text: proof });
  expect(verify(null, Buffer.from(proof), expected.signingPrivateKey, Buffer.from(signed, 'base64url'))).toBe(true);

  const nodeIdentity = identityFromSeed('unit-native-interop', Buffer.alloc(32, 32).toString('base64url'), 'node-host');
  await native.call({ op: 'admit', peers: [{ key: nodeIdentity.transportKey, link: 1 }] });
  const captured: Buffer[] = [];
  const endpoint = await Endpoint.create({
    identity: nodeIdentity.transportPrivateKey, prologue: 'cindy/agent-net/device-link/2',
    bind: { address: '127.0.0.1' },
    tap: (_direction, data) => { captured.push(Buffer.from(data)); },
  });
  cleanups.push(() => endpoint.close());
  const connection: Connection = endpoint.connect(Buffer.from(identity.transportKey, 'base64url'), { address: '127.0.0.1', port: identity.udpPort });
  const output: Buffer[] = [];
  connection.on('stream', (stream: RecvStream) => stream.on('data', data => output.push(Buffer.from(data))));
  let nativeId: number | undefined;
  await until(async () => {
    const poll = await native.call({ op: 'poll' });
    const remote = poll.connections.find((value: any) => value.established);
    if (remote) nativeId = remote.id;
    return connection.established && !!remote;
  });
  const payload = Buffer.from('PRIVATE_NATIVE_INTEROP_MESSAGE_' + 'x'.repeat(55_000));
  connection.openStream('normal').write(payload);
  const nativeData: Buffer[] = [];
  await until(async () => {
    const poll = await native.call({ op: 'poll' });
    for (const connection of poll.connections) for (const chunk of connection.data) nativeData.push(Buffer.from(chunk.data, 'base64url'));
    return Buffer.concat(nativeData).length >= payload.length;
  });
  expect(Buffer.concat(nativeData)).toEqual(payload);
  const stream = await native.call({ op: 'openStream', id: nativeId });
  expect(await native.call({ op: 'write', id: nativeId, stream, data: payload.toString('base64url') })).toBe(payload.length);
  await until(async () => { await native.call({ op: 'poll' }); return Buffer.concat(output).length >= payload.length; });
  expect(Buffer.concat(output)).toEqual(payload);
  expect(captured.length).toBeGreaterThan(3);
  expect(captured.some(packet => packet.includes('PRIVATE_NATIVE_INTEROP_MESSAGE_'))).toBe(false);
  await native.call({ op: 'admit', peers: [] });
  expect((await native.call({ op: 'poll' })).connections).toHaveLength(0);
}, 15_000);

it.skipIf(!library)('runs real DeviceLinkClient requests and a multi-megabyte result through the shared native socket and private relay', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cindy-agent-net-native-'));
  cleanups.push(async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())
      || !path.basename(directory).startsWith('cindy-agent-net-native-')) throw new Error('UNSAFE_TEST_DIRECTORY');
    await rm(directory, { recursive: true, force: true });
  });
  const owner = generateIdentity('a-node-host');
  const { root, bootstrap } = createPrivateNetwork('native device-link fixture', owner);
  const notifications: Array<{ ciphertext: string }> = [];
  const relay = await startAgentNetRelay({ dataDir: directory, bootstrap, udpPort: 0,
    notify: async value => { notifications.push(value); } });
  cleanups.push(() => relay.close());
  const hostApi = new AgentNetClient(relay.url, owner, bootstrap.ownerCertificate, bootstrap.rootPublicKey);
  const seed = Buffer.alloc(32, 44).toString('base64url'), context = 'unit-native-device-link';
  const member = identityFromSeed(context, seed, 'b-native-controller');
  const code = await hostApi.request<{ joinCode: string }>('POST', '/join-codes');
  const join = createJoinRequest(member, bootstrap.networkId, code.joinCode, 'Native controller', 'unit-public-pairing-fixture');
  await submitJoin(relay.url, join);
  const certificate = approveJoin(root, join, 'unit-public-pairing-fixture', bootstrap.ownerCertificate.subject);
  await hostApi.request('POST', '/join-requests/' + join.requestId + '/approve', { certificate });
  const signingPeer = new NativePeer();
  await signingPeer.call({ seed, context, deviceId: member.deviceId, udp: false }, 'create');
  const controllerApi = new PortableAgentNetClient(relay.url, {
    identity: member, random: () => signingPeer.call({ op: 'random' }),
    sign: text => signingPeer.call({ op: 'sign', text }),
  }, certificate, bootstrap.rootPublicKey, {
    assertCurrent() {}, verifyCertificate, verifyDelegation,
    sha256: data => createHash('sha256').update(data).digest('base64url'),
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as unknown as BinarySocket,
  });
  expect((await controllerApi.directory()).some(view => view.certificate.deviceId === owner.deviceId)).toBe(true);
  // Notification reception must use a separately derived key and authenticate
  // sender/recipient/time before exposing text. The transport-only gate misses this ABI.
  const notificationKey = await signingPeer.call({ op: 'notificationKey' });
  expect(notificationKey.encryptionKey).not.toBe(member.transportKey);
  const keyBinding = { v: 2 as const, networkId: certificate.networkId, deviceId: member.deviceId,
    encryptionKey: notificationKey.encryptionKey };
  const boundKey = { ...keyBinding, signature: await signingPeer.call({ op: 'sign', text: notificationKeyPayload(keyBinding) }) };
  await controllerApi.request('PUT', '/push-token', { provider: 'apns', appVariant: 'global', apnsEnv: 'sandbox',
    token: 'a'.repeat(64), notificationKey: boundKey });
  await expect(controllerApi.request('PUT', '/push-token', { provider: 'apns', appVariant: 'global', apnsEnv: 'sandbox',
    token: 'a'.repeat(64), notificationKey: { ...boundKey, encryptionKey: owner.transportKey } })).rejects.toThrow('PUSH_REGISTRATION_INVALID');
  let nativeAdmissions = 0;
  const make = (api: SocketClient, nativeMode: boolean) => {
    const client = new DeviceLinkClient({
      getWsUrl: () => 'ws://local-node.invalid', getToken: async () => 'local-native-fixture',
      getHello: () => ({ deviceName: api.identity.deviceId, platform: 'unit', appVersion: 'unit',
        remoteControlEnabled: !nativeMode, busy: false }),
      createWebSocket: async () => {
        if (!nativeMode) return AgentNetSocket.open({ client: hostApi, userId: certificate.subject, udp: false, lanDiscovery: false, scoped: true });
        const peer = new NativePeer();
        await peer.call({ seed, context, deviceId: member.deviceId, udp: false }, 'create');
        const port: NativeEnginePort = { command: value => peer.call(value), destroy: () => peer.destroy() };
        return PortableSocket.openWithBindings({ client: api, userId: certificate.subject, lanDiscovery: false, scoped: true,
          bindings: { verifyCertificate, verifyDelegation, createTransport: options => NativeTransport.create(port, { ...options,
            onIncoming(channel) { nativeAdmissions++; options.onIncoming(channel); } }) } });
      },
      timing: { requestTimeoutMs: 10_000, pingIntervalMs: 60_000 },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    cleanups.push(() => client.stop()); return client;
  };
  const host = make(hostApi, false), controller = make(controllerApi, true);
  const large = 'native-confidential-result-'.repeat(85_000);
  const serve = (host: DeviceLinkClient) => host.onFrame(frame => {
    if (!frame.src || !frame.id) return;
    if (frame.kind === 'link-open') host.sendLinkAccept(frame.src, frame.id, { appVersion: 'unit', allowlistHash: 'unit' });
    if (frame.kind === 'invoke') {
      const invoke = frame.payload as InvokePayload;
      host.sendInvokeResult(frame.src, frame.id, { ok: true, result: invoke.channel === 'test:large' ? large : invoke.args[0] });
    }
  });
  serve(host); serve(controller);
  host.start(); controller.start();
  await Promise.all([host.waitUntilOnline(5000), controller.waitUntilOnline(5000)]);
  const notify = { category: 'session-done' as const, title: 'Native notification',
    body: 'private task result', deepLink: '/sessions/unit?deviceId=a-node-host', collapseId: 'unit' };
  expect(host.sendNotify(notify)).toBe(true);
  await until(async () => notifications.length === 1);
  expect(notifications[0].ciphertext).not.toContain(notify.body);
  const config = { secret: notificationKey.secret, networkId: certificate.networkId, deviceId: member.deviceId,
    expiresAt: Date.now() + 3600_000, peers: { [owner.deviceId]: owner.signingKey } };
  const notificationOpen = { op: 'notificationOpen', config, now: Date.now(), envelope: notifications[0].ciphertext };
  const clearNotification = await signingPeer.call(notificationOpen);
  expect(JSON.parse(Buffer.from(clearNotification.payload, 'base64url').toString())).toMatchObject(notify);
  await expect(signingPeer.call({ ...notificationOpen, now: Date.now() + 301_000 })).rejects.toThrow('INVALID_NOTIFICATION');
  await expect(signingPeer.call({ ...notificationOpen, config: { ...config, deviceId: 'other-device' } })).rejects.toThrow('INVALID_NOTIFICATION');
  await expect(signingPeer.call({ ...notificationOpen, config: { ...config, peers: {} } })).rejects.toThrow();
  const packet = Buffer.from(notifications[0].ciphertext, 'base64url'); packet[packet.length - 1] ^= 1;
  await expect(signingPeer.call({ ...notificationOpen, envelope: packet.toString('base64url') })).rejects.toThrow('INVALID_NOTIFICATION');
  const recipient = (await hostApi.directory()).find(view => view.certificate.deviceId === member.deviceId)!;
  expect(() => sealNotification(bootstrap.rootPublicKey, certificate.networkId, owner,
    { ...recipient, notificationKey: { ...boundKey, encryptionKey: owner.transportKey } }, notify)).toThrow('UNTRUSTED_NOTIFICATION_KEY');
  await controller.openLink(owner.deviceId, { controllerName: 'Native controller', appVersion: 'unit', protocolVersion: 1 });
  expect(await controller.invoke(owner.deviceId, { channel: 'test:echo', args: ['native authenticated RPC'] }))
    .toMatchObject({ ok: true, result: 'native authenticated RPC' });
  expect(await controller.invoke(owner.deviceId, { channel: 'test:large', args: [] })).toMatchObject({ ok: true, result: large });
  // Real native receiver + unchanged private relay: a fresh same-identity Node
  // host handshakes while the old SDK can still own the native peer slot.
  // Deterministic late-frame/abort/deadline ordering is covered at NativeEnginePort
  // in nativeTransport.test.ts; this gate validates the actual C ABI replacement.
  const admissionsBeforeRestart = nativeAdmissions;
  const restartedHost = make(hostApi, false); serve(restartedHost); restartedHost.start();
  await restartedHost.waitUntilOnline(5000);
  await until(async () => nativeAdmissions > admissionsBeforeRestart);
  host.stop();
  await controller.openLink(owner.deviceId, { controllerName: 'Native controller', appVersion: 'unit', protocolVersion: 1 });
  expect(await controller.invoke(owner.deviceId, { channel: 'test:echo', args: ['native receiver survives host restart'] }))
    .toMatchObject({ ok: true, result: 'native receiver survives host restart' });
  // Regression: a full-member native exchange cannot prove the cross-account
  // route projection/admission contract. Use the real C ABI with resource-only
  // host grants, and show that neither grant becomes full-device access.
  for (const kind of ['shared-task', 'provider-share'] as const) {
    const guestContext = 'unit-native-' + kind, guestSeed = Buffer.alloc(32, kind === 'shared-task' ? 45 : 46).toString('base64url');
    const guest = identityFromSeed(guestContext, guestSeed, 'native-guest-' + kind);
    const delegation = createDelegation(owner, bootstrap.ownerCertificate, { kind, resourceId: 'native-resource', guest,
      scope: { memberId: 'native-member', guestSubject: 'global:external-guest', memberVersion: 1 } });
    await hostApi.request('POST', '/grants', { delegation });
    const peer = new NativePeer();
    await peer.call({ seed: guestSeed, context: guestContext, deviceId: guest.deviceId, udp: false }, 'create');
    const guestApi = new PortableAgentNetClient(relay.url, { identity: guest,
      random: () => peer.call({ op: 'random' }), sign: text => peer.call({ op: 'sign', text }) },
    bootstrap.ownerCertificate, bootstrap.rootPublicKey, {
      assertCurrent() {}, verifyCertificate, verifyDelegation, delegation,
      sha256: bytes => createHash('sha256').update(bytes).digest('base64url'),
      createWebSocket: (url, headers) => new WebSocket(url, { headers }) as unknown as BinarySocket,
    });
    const live = { socket: null as PortableSocket | null };
    let holdPoll = false, pollPaused = false, pollEntered!: () => void, releasePoll!: () => void, dialEntered!: () => void;
    const pollHeld = new Promise<void>(resolve => { pollEntered = resolve; });
    const resumePoll = new Promise<void>(resolve => { releasePoll = resolve; });
    const dialStarted = new Promise<void>(resolve => { dialEntered = resolve; });
    cleanups.push(() => releasePoll());
    const visitor = new DeviceLinkClient({ getWsUrl: () => 'ws://local-node.invalid', getToken: async () => 'native-resource',
      getHello: () => ({ deviceName: guest.deviceId, platform: 'unit', appVersion: 'unit', remoteControlEnabled: false, busy: false }),
      createWebSocket: () => PortableSocket.openWithBindings({ client: guestApi, userId: 'global:external-guest', lanDiscovery: false,
        bindings: { verifyCertificate, verifyDelegation, createTransport: options => NativeTransport.create({
          async command<T>(value: Record<string, unknown>): Promise<T> {
            const result = await peer.call(value);
            if (value.op === 'poll' && holdPoll) { holdPoll = false; pollPaused = true; pollEntered(); await resumePoll; }
            if (value.op === 'connect' && pollPaused) dialEntered();
            return result as T;
          }, destroy: () => peer.destroy(),
        }, options) } }).then(socket => { live.socket = socket; return socket; }),
      timing: { requestTimeoutMs: 4000 }, logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    cleanups.push(() => visitor.stop()); visitor.start();
    await visitor.waitUntilOnline(3000);
    const resourcePeer = kind === 'shared-task' ? sharedTaskHostPeer('native-resource', owner.deviceId)
      : providerShareHostPeer('native-resource', owner.deviceId);
    await visitor.openLink(resourcePeer, { controllerName: 'Native visitor', appVersion: 'unit', protocolVersion: 1 });
    expect(await visitor.invoke(resourcePeer, { channel: 'test:echo', args: ['native scoped RPC'] }))
      .toMatchObject({ ok: true, result: 'native scoped RPC' });
    if (kind === 'provider-share') {
      // Native G -> native M must preserve the owner-signed scoped contract,
      // not merely the Node/WASM executor case. It still cannot open raw M.
      const plain = { ...delegation, executors: [{ generation: 'native-executor-generation', certificate, expiresAt: delegation.expiresAt }] };
      const endorsed = { ...plain, signature: signature(owner.signingPrivateKey, delegationPayload(plain)) };
      await hostApi.request('POST', '/grants', { delegation: endorsed, previousSignature: delegation.signature });
      const target = providerShareHostPeer('native-resource', member.deviceId);
      await until(async () => !!live.socket?.scopedPeerTarget(target));
      // Integration regression: the real native bridge returns an old poll after
      // the new executor dial starts. Existing ABI coverage only ran this race
      // by chance; keep a successful host peer while opening the second route.
      holdPoll = true; await pollHeld;
      const opened = visitor.openLink(target, { controllerName: 'Native visitor', appVersion: 'unit', protocolVersion: 1 });
      const accepted = expect(opened).resolves.toMatchObject({ appVersion: 'unit' });
      await dialStarted;
      await nextTurn(); releasePoll();
      await accepted;
      expect(await visitor.invoke(target, { channel: 'test:echo', args: ['native executor RPC'] })).toMatchObject({ ok: true, result: 'native executor RPC' });
      expect(await visitor.invoke(resourcePeer, { channel: 'test:echo', args: ['original host still works'] }))
        .toMatchObject({ ok: true, result: 'original host still works' });
    }
    await expect(visitor.openLink(member.deviceId, { controllerName: 'Forbidden', appVersion: 'unit', protocolVersion: 1 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await hostApi.request('DELETE', '/grants/' + delegation.id);
    await until(async () => visitor.getStatus() !== 'online');
    visitor.stop();
  }
  // The production native adapter must read Node's media-v3 objects and write
  // objects Node can open. Cross-block ranges and a changed header hash cover
  // the mobile crypto/ABI gap; the core transport simulator cannot cover it.
  const mediaPort: NativeEnginePort = { command: value => signingPeer.call(value), destroy: async () => undefined };
  const binding = 'cindy-agent-net/media-scope/3/11111111-1111-4111-8111-111111111111';
  const payload = Buffer.alloc(1024 * 1024 + 37);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const nativeUpload = await uploadNativeMedia(controllerApi, mediaPort, owner.deviceId, owner.transportKey,
    payload.length, async (offset, size) => payload.subarray(offset, offset + size), { binding });
  expect(nativeUpload.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
  const opened = await openEncryptedMedia(hostApi, nativeUpload.id, nativeUpload.headerSha256, undefined, 'application/octet-stream', { binding });
  expect(Buffer.from(await opened.arrayBuffer())).toEqual(payload);
  const nodeUpload = await uploadEncryptedMedia(hostApi, member.deviceId, member.transportKey,
    payload.length, async (offset, size) => payload.subarray(offset, offset + size), { binding });
  const rangeStart = 1024 * 1024 - 7, rangeEnd = 1024 * 1024 + 23;
  const received: Uint8Array[] = [];
  await readNativeMedia(controllerApi, mediaPort, nodeUpload.id, nodeUpload.headerSha256,
    async bytes => { received.push(bytes); }, { start: rangeStart, end: rangeEnd, binding });
  expect(Buffer.concat(received)).toEqual(payload.subarray(rangeStart, rangeEnd + 1));
  await expect(readNativeMedia(controllerApi, mediaPort, nodeUpload.id, nodeUpload.headerSha256,
    async () => { throw new Error('CROSS_RESOURCE_PLAINTEXT'); }, { binding: binding + '-other' })).rejects.toThrow('MEDIA_AUTHENTICATION_FAILED');
  const oldPort: NativeEnginePort = { ...mediaPort, command(value) {
    const { binding: _binding, ...legacy } = value; return mediaPort.command(legacy);
  } };
  const requests = vi.spyOn(controllerApi, 'request');
  try {
    await expect(uploadNativeMedia(controllerApi, oldPort, owner.deviceId, owner.transportKey, payload.length,
      async () => payload, { binding })).rejects.toThrow('AGENT_NET_NATIVE_UPDATE_REQUIRED');
    expect(requests).not.toHaveBeenCalled();
  } finally { requests.mockRestore(); }
  await expect(readNativeMedia(controllerApi, mediaPort, nodeUpload.id, '0'.repeat(64),
    async () => { throw new Error('UNAUTHENTICATED_PLAINTEXT'); })).rejects.toThrow('INVALID_MEDIA_HEADER');
  const tamperedApi = { request: controllerApi.request.bind(controllerApi), putMediaChunk: controllerApi.putMediaChunk.bind(controllerApi),
    async withMediaResponse<T>(id: string, range: string, consume: (response: Response) => Promise<T>, signal?: AbortSignal) {
      return controllerApi.withMediaResponse(id, range, async response => {
        if (range === 'bytes=0-220') return consume(response);
        const body = new Uint8Array(await response.arrayBuffer()); body[body.length - 1] ^= 1;
        return consume(new Response(body, { status: response.status, headers: response.headers }));
      }, signal);
    } };
  await expect(readNativeMedia(tamperedApi, mediaPort, nodeUpload.id, nodeUpload.headerSha256,
    async () => { throw new Error('UNAUTHENTICATED_PLAINTEXT'); }, { binding })).rejects.toThrow('MEDIA_AUTHENTICATION_FAILED');
  // A renewed native signer replaces the old handle without invalidating API
  const empty = await uploadNativeMedia(controllerApi, mediaPort, owner.deviceId, owner.transportKey, 0,
    async () => { throw new Error('EMPTY_FILE_MUST_NOT_READ_A_CHUNK'); });
  expect(await (await openEncryptedMedia(hostApi, empty.id, empty.headerSha256, undefined, 'text/css')).text()).toBe('');
  const nodeEmpty = await uploadEncryptedMedia(hostApi, member.deviceId, member.transportKey, 0,
    async () => { throw new Error('EMPTY_FILE_MUST_NOT_READ_A_CHUNK'); });
  expect(await readNativeMedia(controllerApi, mediaPort, nodeEmpty.id, nodeEmpty.headerSha256,
    async () => { throw new Error('EMPTY_FILE_MUST_NOT_WRITE_A_CHUNK'); })).toMatchObject({ size: 0 });
  // A renewed native signer replaces the old handle without invalidating API
  // objects retained by media readers. Cross-principal substitution is denied.
  expect(() => controllerApi.replaceCredentials({ identity: owner, random: async () => '', sign: async () => '' }, certificate)).toThrow('AGENT_NET_IDENTITY_CHANGED');
  const renewedSigner = new NativePeer();
  await renewedSigner.call({ seed, context, deviceId: member.deviceId, udp: false }, 'create');
  controllerApi.replaceCredentials({ identity: member, random: () => renewedSigner.call({ op: 'random' }),
    sign: text => renewedSigner.call({ op: 'sign', text }) }, certificate);
  await signingPeer.destroy();
  expect((await controllerApi.directory()).some(view => view.certificate.deviceId === owner.deviceId)).toBe(true);
  await hostApi.request('DELETE', '/devices/' + member.deviceId);
  await until(async () => { await new Promise(resolve => setTimeout(resolve, 10)); return controller.getStatus() !== 'online'; });
}, 20_000);

/** 测试价值
 * - 生产入口与可观察结果：手机用的 PortableSocket.useSessions + NativeTransport，真实编译的原生库（C 接口）、真实 V2 中转与
 *   Node 节点（电脑一端）。会话上建链、调用、拿回 1 MB 结果；中转转发的数据报经 UDP 收发；STUN 查到的地址成为候选。
 *   旧安装包里的原生库（没有 features、不认新操作）配新 JS 时，会话照样可用，也不去调新操作。
 * - Bug／规则依据：docs/agent-net-session-plan.md 第 10 节阶段 4（手机接入会话层与原生接口）、第 8 节中转 UDP；
 *   docs/dev-rules/mobile-development.md 冷更边界：热更的 JS 必须能在旧原生包上运行。
 * - 现有覆盖缺口：原生通道没有会话通道，手机只走 Device Link 帧；原生库没有中转 UDP 和 STUN，现有用例都不覆盖。
 * - 最小失败输入：一次建链、一次请求、一个 1 MB 结果；去掉原生的会话通道（不宣告、不开流）时会话一直不出现，
 *   去掉中转 UDP 时 1 MB 全经 WebSocket 回来。
 * - tier：integration，真实回环中转与 UDP，不开局域网发现。 */
it.skipIf(!library)('carries sessions on the real native engine, relays them over UDP, and keeps working on an older native build', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cindy-agent-net-native-'));
  cleanups.push(async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())
      || !path.basename(directory).startsWith('cindy-agent-net-native-')) throw new Error('UNSAFE_TEST_DIRECTORY');
    await rm(directory, { recursive: true, force: true });
  });
  // The phone has the lower id, so it is the side that dials (PortableSocket.dialRoster), as when it opens a computer.
  const owner = generateIdentity('b-node-host');
  const { root, bootstrap } = createPrivateNetwork('native session fixture', owner);
  const relay = await startAgentNetRelay({ dataDir: directory, bootstrap, udpPort: 0 });
  cleanups.push(() => relay.close());
  const udpServer = '127.0.0.1:' + relay.udpAddress!.port, userId = bootstrap.ownerCertificate.subject;
  const hostApi = new AgentNetClient(relay.url, owner, bootstrap.ownerCertificate, bootstrap.rootPublicKey);
  const seed = Buffer.alloc(32, 52).toString('base64url'), context = 'unit-native-session';
  const member = identityFromSeed(context, seed, 'a-native-phone');
  const code = await hostApi.request<{ joinCode: string }>('POST', '/join-codes');
  const join = createJoinRequest(member, bootstrap.networkId, code.joinCode, 'Native phone', 'unit-public-pairing-fixture');
  await submitJoin(relay.url, join);
  const certificate = approveJoin(root, join, 'unit-public-pairing-fixture', bootstrap.ownerCertificate.subject);
  await hostApi.request('POST', '/join-requests/' + join.requestId + '/approve', { certificate });
  const hello = (socket: { send(text: string): void; deviceId: string }) => socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello',
    payload: { deviceName: socket.deviceId, platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
  const host = await AgentNetSocket.open({ client: hostApi, userId, udp: false, lanDiscovery: false });
  cleanups.push(() => host.close());
  const large = 'native-session-result-'.repeat(48_000);
  host.useSessions({ laneFor: () => 'normal', handlers: () => ({
    onOpen: (id) => { host.session(member.deviceId)!.accept(id, { appVersion: 'host' }); },
    onRequest: (request) => { host.session(member.deviceId)!.respond(request.id, { ok: true, result: request.channel === 'test:large' ? large : request.args[0] }); },
  }) });
  hello(host);
  for (const build of ['current', 'older'] as const) {
    const peer = new NativePeer();
    await peer.call({ seed, context, deviceId: member.deviceId, enhancedTransport: build === 'current' }, 'create');
    const newOps: string[] = [];
    // An installed binary from before this change: no `features`, and the operations it lacks fail as unknown.
    const port: NativeEnginePort = build === 'current' ? { command: value => peer.call(value), destroy: () => peer.destroy() } : {
      async command(value) {
        if (value.op === 'stun' || value.op === 'relayUdp') { newOps.push(value.op); throw new Error('UNKNOWN_NATIVE_OPERATION'); }
        const result = await peer.call(value);
        if (value.op === 'identity') { const { features: _features, ...older } = result; return older; }
        if (value.op === 'poll') { const { mapped: _mapped, relayUdp: _relayUdp, ...older } = result;
          return { ...older, connections: older.connections.map(({ buffered: _buffered, ...connection }: Record<string, unknown>) => connection) }; }
        return result;
      }, destroy: () => peer.destroy() };
    const api = new PortableAgentNetClient(relay.url, { identity: member, random: () => peer.call({ op: 'random' }),
      sign: text => peer.call({ op: 'sign', text }) }, certificate, bootstrap.rootPublicKey, {
      assertCurrent() {}, verifyCertificate, verifyDelegation, relayUdpEnabled: () => true,
      sha256: data => createHash('sha256').update(data).digest('base64url'),
      createWebSocket: (url, headers) => new WebSocket(url, { headers }) as unknown as BinarySocket,
    });
    let transport: NativeTransport | undefined, relayedOverWebSocket = 0;
    const phone = await PortableSocket.openWithBindings({ client: api, userId, lanDiscovery: false,
      bindings: { verifyCertificate, verifyDelegation, createTransport: async options => {
        const uplink = options.relay!.uplink;
        transport = await NativeTransport.create(port, { ...options, stunServers: [udpServer], relayUdpServer: udpServer,
          relay: { ...options.relay!, uplink: { ...uplink, onDatagram: receive => uplink.onDatagram((id, bytes) => {
            relayedOverWebSocket += bytes.length; receive(id, bytes);
          }) } } });
        return transport;
      } } });
    phone.useSessions({ laneFor: () => 'normal', handlers: () => ({}) });
    hello(phone);
    if (build === 'current') {
      // The relay's STUN answered on the engine's own port, and relayed datagrams switched to UDP once it acknowledged.
      await until(async () => transport!.candidates().some(candidate => candidate.address === '127.0.0.1'));
      await until(async () => transport!.relayOverUdp);
    }
    await until(async () => phone.supports(owner.deviceId));
    expect(await phone.connectSession(owner.deviceId)).toBe(true);
    await until(async () => !!phone.session(owner.deviceId) && !!host.session(member.deviceId));
    const session = phone.session(owner.deviceId)!;
    await expect(session.open({ controllerName: 'phone' }, 5_000)).resolves.toEqual({ appVersion: 'host' });
    await expect(session.request('test:echo', [build], { timeoutMs: 5_000 })).resolves.toEqual({ ok: true, result: build });
    const before = relayedOverWebSocket;
    await expect(session.request('test:large', [], { timeoutMs: 15_000 })).resolves.toEqual({ ok: true, result: large });
    if (build === 'current') expect(relayedOverWebSocket - before).toBeLessThan(256 * 1024);
    else { expect(newOps).toEqual([]); expect(relayedOverWebSocket - before).toBeGreaterThan(large.length / 2); }
    // The next build reconnects as the same phone right away: its new connection replaces this one on the host, which may
    // not have noticed this close yet (relayed close packets race the relay WebSocket's own close).
    phone.close();
  }
}, 30_000);
// #10142, integration tier: the old fixed 30s deadline truncates both HTTP
// bodies. Use real time/C ABI to cross even the new 60s inactivity budget;
// unit ticket-policy tests cover exact deadline edges without waiting.
it.skipIf(!library)('keeps progressing and queued native HTTP requests alive beyond a total deadline', async () => {
  const native = new NativePeer();
  await native.call({ seed: Buffer.alloc(32, 74).toString('base64url'), context: 'progress-player', deviceId: 'player', udp: false }, 'create');
  const size = 1024 * 1024, events: unknown[] = [];
  const began = Date.now();
  let release!: () => void;
  const firstDone = new Promise<void>(resolve => { release = resolve; });
  let first = true, hold = false, cancelled = false;
  let reading!: () => void;
  const heldRead = new Promise<void>(resolve => { reading = resolve; });
  const stream = await openNativeByteStream({ command: async <T>(value: Record<string, unknown>): Promise<T> => {
    const result = await native.call(value);
    if (value.op !== 'httpMediaPoll' || (value.updates as unknown[] | undefined)?.length) {
      events.push({ ms: Date.now() - began, op: value.op, id: value.id, updates: value.updates,
        result: value.op === 'httpMediaReply' ? result : undefined });
    }
    return result as T;
  }, destroy: () => native.destroy() },
    'video/mp4', async () => ({ size, close: async () => {}, async read(start, end, write, activity) {
      if (hold) {
        hold = false; reading();
        await new Promise<void>((_, reject) => activity!.signal!.addEventListener('abort', () => {
          cancelled = true; reject(new Error('PLAYER_CANCELLED'));
        }, { once: true }));
      }
      if (!first) { activity?.('queued'); await firstDone; activity?.('active'); }
      else {
        first = false;
        for (let loaded = 0; loaded < end - start + 1; loaded += 64 * 1024) {
          // real-wait: prove real Rust C ABI survives >60s with actual incoming bytes.
          await new Promise(resolve => setTimeout(resolve, 4100));
          await write(new Uint8Array(Math.min(64 * 1024, end - start + 1 - loaded)).fill(74), loaded);
        }
        release(); return;
      }
      await write(new Uint8Array(end - start + 1).fill(74), 0);
    } }));
  cleanups.push(() => stream.close());
  const firstResponse = await fetch(stream.url);
  const firstBody = firstResponse.arrayBuffer();
  const secondResponse = await fetch(stream.url);
  const secondBody = secondResponse.arrayBuffer();
  const result = await Promise.all([firstBody, secondBody]).catch(cause => {
    throw new Error('NATIVE_HTTP_PROGRESS: ' + JSON.stringify(events), { cause });
  });
  for (const bytes of result) expect(Buffer.from(bytes)).toEqual(Buffer.alloc(size, 74));
  hold = true;
  const controller = new AbortController();
  const abandoned = await fetch(stream.url, { signal: controller.signal, headers: { range: 'bytes=0-0' } });
  const abandonedBody = expect(abandoned.arrayBuffer()).rejects.toThrow();
  await heldRead; controller.abort(); await abandonedBody;
  await vi.waitFor(() => expect(cancelled).toBe(true), { interval: 10 });
  const healthy = await fetch(stream.url, { headers: { range: 'bytes=0-0' } });
  expect(Buffer.from(await healthy.arrayBuffer())).toEqual(Buffer.from([74]));
  expect(stream.isOpen()).toBe(true);
}, 85_000);
