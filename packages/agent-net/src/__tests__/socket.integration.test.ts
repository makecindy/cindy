/**
 * 生产入口：AgentNetSocket + 真正 DeviceLinkClient、Rust WASM、V2 内核；验证真实 RPC 和权限。
 * 规则：agent-net 产品规则的 V2 独立运行及无损现有业务协议。原型不是生产入口，原 Node relay 测试不跑业务协议。
 * 最小失败输入：无预建 peer 时 link-open；流式大结果；伪造 src；中转断开但 UDP 仍通。
 * tier：integration，真实回环 HTTP/WS/UDP 和临时磁盘；临时测试密钥只存在内存，不读用户凭据。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createLocalJWKSet, SignJWT } from 'jose';
import { createAgentNetSharingAuth } from '@cindy/agent-net-relay/sharing-auth';
import { createPrivateNetwork, startAgentNetRelay, generateIdentity, createJoinRequest, approveJoin, createDelegation, issueCertificate, signature } from '@cindy/agent-net-relay';
import { notificationKeyPayload, MAX_GRANT_LIFETIME_MS, type DeviceView } from '@cindy/agent-net-protocol';
import { AgentNetClient, createDelegationApprover, submitJoin, uploadEncryptedMedia, openEncryptedMedia } from '@cindy/agent-net-relay/client';
import { DeviceLinkClient, PROTOCOL_VERSION, issueRelayDeviceCert, sharedTaskHostPeer, providerShareHostPeer,
  sharedTaskGuestPeer, providerShareGuestPeer, isSharedTaskAttachment, buildAttachmentOssRef, type Envelope, type InvokePayload } from '@cindy/device-link';
import { createProviderShareApi, createSharedTaskApi } from '@cindy/device-link';
import { AgentNetSharingClient } from '../sharingClient.js';
import { AgentNetSharingTransport } from '../sharingTransport.js';
import { grantAgentNetSharingExecutor, revokeAgentNetSharingExecutor, checkAgentNetSharingExecutor } from '../sharingExecutors.js';
import { buildAgentNetMediaKey } from '@cindy/agent-net-protocol';
import { verifyCertificate, verifyDelegation } from '@cindy/agent-net-relay';
import { nodeRelayAuthCrypto } from '@cindy/device-link/node-relay-crypto';
import { initializeRelay, startRelayServer, createDeviceCredential, hashSecret } from '@cindy/device-link-relay';
import { AgentNetSocket } from '../socket.js';
import { AgentNetWorkerSocket, type AgentNetAppSocket } from '../workerSocket.js';
import { startRelayGateway } from '../gateway.js';
import { StunClient } from '../stun.js';
import { createCoreTransport } from '../transport.js';
import WebSocket from 'ws';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function network(udp: boolean, ingress?: 'gateway', isolated = false, scoped = false,
  sharing?: import('@cindy/agent-net-relay').RelayOptions['sharing']) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cindy-agent-net-socket-'));
  cleanup.push(async () => {
    if (!path.resolve(directory).startsWith(path.join(tmpdir(), 'cindy-agent-net-socket-'))) throw new Error('UNSAFE_TEST_DIRECTORY');
    await rm(directory, { recursive: true, force: true });
  });
  const owner = generateIdentity('a-host');
  const { root, bootstrap } = createPrivateNetwork('test network', owner);
  if (sharing) bootstrap.ownerCertificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: 'owner-account', identity: owner, role: 'owner' });
  const notifications: Array<{ ciphertext: string }> = [];
  const relay = await startAgentNetRelay({ dataDir: directory, bootstrap, udpPort: 0,
    ...(sharing ? { sharing } : {}),
    ...(isolated ? { notify: async (value: { ciphertext: string }) => { notifications.push(value); } } : {}) });
  cleanup.push(() => relay.close());
  let base = relay.url, legacyClient: DeviceLinkClient | undefined;
  if (ingress) {
    const legacyDir = path.join(directory, 'legacy');
    const credential = createDeviceCredential().credential;
    const relayId = '11111111-1111-4111-8111-111111111111';
    const cert = issueRelayDeviceCert(nodeRelayAuthCrypto, root.export({ format: 'jwk' }).d!, {
      relayId, deviceId: owner.deviceId, publicKey: bootstrap.rootPublicKey, role: 'owner', issuedAt: Date.now(),
    });
    await initializeRelay({ dataDir: legacyDir, name: 'test', relayId, ownerUserId: bootstrap.ownerCertificate.subject,
      ownerDeviceId: owner.deviceId, ownerDeviceName: 'Legacy', ownerCredentialHash: hashSecret(credential), ownerPublicKey: bootstrap.rootPublicKey, ownerCert: cert });
    const legacy = await startRelayServer({ dataDir: legacyDir });
    cleanup.push(() => legacy.close()); base = legacy.localUrl;
    if (ingress === 'gateway') {
      const gateway = await startRelayGateway({ host: '127.0.0.1', port: 0, legacyUrl: legacy.localUrl, agentNetUrl: relay.url });
      cleanup.push(() => gateway.close()); base = 'http://127.0.0.1:' + gateway.port;
    }
    legacyClient = new DeviceLinkClient({ getWsUrl: () => base.replace(/^http/, 'ws') + '/api/device-link/ws',
      getToken: async () => credential, authorizationScheme: 'CindyRelay',
      getHello: () => ({ deviceName: 'Legacy', platform: 'test', appVersion: 'test', remoteControlEnabled: true, busy: false }),
      createWebSocket: (url, headers) => new WebSocket(url, { headers }), logger: { debug() {}, info() {}, warn() {}, error() {} } });
    cleanup.push(() => legacyClient!.stop()); legacyClient.start(); await legacyClient.waitUntilOnline(3000);
    const directoryResponse = await fetch(base + '/api/device-link/devices', { headers: { authorization: 'CindyRelay ' + credential } });
    expect(directoryResponse.ok).toBe(true);
    // The same origin must not allow a legacy credential to authenticate a V2 request.
    expect((await fetch(base + '/api/agent-net/directory', { headers: { authorization: 'CindyRelay ' + credential } })).status).toBe(401);
  }
  const a = new AgentNetClient(base, owner, bootstrap.ownerCertificate, bootstrap.rootPublicKey);
  const member = generateIdentity('b-controller');
  const code = await a.request<{ joinCode: string }>('POST', '/join-codes');
  const join = createJoinRequest(member, bootstrap.networkId, code.joinCode, 'Controller', 'test-only-pairing-secret');
  await submitJoin(base, join);
  const certificate = approveJoin(root, join, 'test-only-pairing-secret', bootstrap.ownerCertificate.subject);
  await a.request('POST', '/join-requests/' + join.requestId + '/approve', { certificate });
  const b = new AgentNetClient(base, member, certificate, bootstrap.rootPublicKey);
  const httpCalls: string[] = [], directories = new Map<string, DeviceView[]>();
  for (const api of [a, b]) api.transport.fetch = async (input, init) => {
    httpCalls.push((init?.method ?? 'GET') + ' ' + input);
    return fetch(input, init);
  };
  const module = await WebAssembly.compile(await readFile(new URL('../../../agent-net-core/dist/core.wasm', import.meta.url)));
  const captured: Buffer[] = [];
  const sockets: AgentNetAppSocket[] = [];
  const make = (api: AgentNetClient, remoteControlEnabled: boolean) => {
    const approvals = sharing && !api.delegation ? createDelegationApprover(api, () => undefined,
      async request => request.scope.guestSubject === 'guest-account') : undefined;
    if (approvals) cleanup.push(() => approvals.close());
    const client = new DeviceLinkClient({
      getWsUrl: () => 'ws://local-node.invalid',
      getToken: async () => 'local-node-marker',
      getHello: () => ({ deviceName: api.identity.deviceId, platform: 'test', appVersion: 'test', remoteControlEnabled, busy: false }),
      createWebSocket: async () => {
        const socket = await (isolated ? AgentNetWorkerSocket : AgentNetSocket).open({
          workerFile: new URL('../../dist/node-worker.mjs', import.meta.url),
          client: api, userId: bootstrap.ownerCertificate.subject, module, udp, bindAddress: '127.0.0.1', lanDiscovery: false, scoped,
          stunServers: ['127.0.0.1:' + relay.udpAddress!.port],
          onDirectory: values => { directories.set(api.identity.deviceId, values); },
          onDelegationRequests: values => approvals?.update(values),
          tap: (data) => captured.push(Buffer.from(data)),
        });
        if (isolated) expect(socket.certificateFor('a-host')?.signature).toBe(bootstrap.ownerCertificate.signature);
        sockets.push(socket); return socket;
      },
      // Keep the SDK's production ACK recovery window. A 100ms test override
      // can restart a healthy stream while a large result is still arriving.
      timing: { requestTimeoutMs: 4000, pingIntervalMs: 1000, reconnectBaseMs: 20, reconnectMaxMs: 100 },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    cleanup.push(() => client.stop()); client.start(); return client;
  };
  const host = make(a, true), controller = make(b, false);
  await Promise.all([host.waitUntilOnline(3000), controller.waitUntilOnline(3000)]);
  return { relay, host, controller, sockets, captured, legacyClient, a, b, bootstrap, root, module, make, httpCalls, notifications, directories };
}
const openPayload = { controllerName: 'test', protocolVersion: PROTOCOL_VERSION, appVersion: 'test' };
function serve(host: DeviceLinkClient) {
  host.onFrame((env) => {
    if (!env.src || !env.id) return;
    if (env.kind === 'link-open') { host.sendLinkAccept(env.src, env.id, { appVersion: 'test', allowlistHash: 'test' }); return; }
    if (env.kind === 'invoke') {
      const { channel, args } = env.payload as InvokePayload;
      host.sendInvokeResult(env.src, env.id, { ok: true, result: channel === 'test:large' ? 'confidential-result-'.repeat(160000) : args[0] });
    }
  });
}
it.each(['gateway'] as const)('serves real V1 and encrypted V2 clients on one origin with isolated auth (%s)', async (ingress) => {
  const f = await network(false, ingress); serve(f.host);
  await f.controller.openLink('a-host', openPayload);
  expect(await f.controller.invoke('a-host', { channel: 'test:echo', args: ['same-origin-v2'] })).toMatchObject({ ok: true, result: 'same-origin-v2' });
  expect(f.legacyClient?.getStatus()).toBe('online');
});
it.each([false, true])('runs existing RPC and multi-megabyte results through certified V2 peers (UDP=%s)', async (udp) => {
  const f = await network(udp); serve(f.host);
  await f.controller.openLink('a-host', openPayload);
  expect(await f.controller.invoke('a-host', { channel: 'test:echo', args: ['private-business-value-0123456789'] })).toMatchObject({ ok: true, result: 'private-business-value-0123456789' });
  // This checks intact multi-megabyte delivery, not a 4-second throughput SLA.
  // Use the production SDK deadline for the large transfer; ordinary RPCs keep
  // the fixture's short deadline. Slow hosted macOS/Windows CPUs must still
  // deliver every byte and satisfy the encryption assertions below.
  const socketCount = f.sockets.length;
  const large = await f.controller.invoke('a-host', { channel: 'test:large', args: [] }, 30_000);
  expect(large.ok && String(large.result).length).toBe('confidential-result-'.length * 160000);
  expect(f.sockets).toHaveLength(socketCount);
  expect(f.captured.length).toBeGreaterThan(100);
  expect(f.captured.some((bytes) => bytes.includes(Buffer.from('private-business-value-0123456789')) || bytes.includes(Buffer.from('confidential-result-')))).toBe(false);
  if (udp) {
    await vi.waitFor(() => expect(f.sockets.some((s) => s.pathTo('a-host') === 'direct')).toBe(true));
    await f.relay.close();
    expect(await f.controller.invoke('a-host', { channel: 'test:echo', args: ['after-relay-loss'] })).toMatchObject({ ok: true, result: 'after-relay-loss' });
  }
});

// Main must not perform network frame parsing, Noise or retransmission work. Real worker + proxy broker,
// rather than a mocked thread, protects the production boundary and shutdown/revocation behavior.
it('runs encrypted RPC in isolated workers while the host retains its outbound network factory', async () => {
  const f = await network(false, undefined, true); serve(f.host);
  await f.controller.openLink('a-host', openPayload);
  expect(await f.controller.invoke('a-host', { channel: 'test:echo', args: ['worker-business-value'] })).toMatchObject({ ok: true, result: 'worker-business-value' });
  expect(f.sockets.every((socket) => socket instanceof AgentNetWorkerSocket)).toBe(true);
  expect(f.captured.some((packet) => packet.includes(Buffer.from('worker-business-value')))).toBe(false);
  // A global fetch inside the worker would bypass Main's configured proxy.
  // Exercise the real worker/HTTP receipt, not an import or callback assertion.
  const plain = { v: 2 as const, networkId: f.bootstrap.networkId, deviceId: f.b.identity.deviceId,
    encryptionKey: generateIdentity('unit-independent-notification-key').transportKey };
  await f.b.request('PUT', '/push-token', { token: 'a'.repeat(64), provider: 'apns', appVariant: 'global', apnsEnv: 'sandbox',
    notificationKey: { ...plain, signature: signature(f.b.identity.signingPrivateKey, notificationKeyPayload(plain)) } });
  await vi.waitFor(() => expect(f.directories.get('a-host')?.find(view => view.certificate.deviceId === 'b-controller')?.notificationKey).toBeTruthy());
  expect(f.host.sendNotify({ category: 'session-done', title: 'Private notification', body: 'private-body',
    deepLink: '/sessions/unit', collapseId: 'unit' })).toBe(true);
  await vi.waitFor(() => expect(f.notifications).toHaveLength(1));
  expect(f.httpCalls).toContain('POST ' + f.a.base + '/api/agent-net/notify');
  expect(f.notifications[0].ciphertext).not.toContain('private-body');
  await f.a.request('DELETE', '/devices/b-controller');
  await vi.waitFor(() => expect(f.controller.getStatus()).not.toBe('online'));
});

// Regression: connected streams used to disappear from bufferedAmount while
// SendStream kept appending indefinitely. A synchronous burst on a real Rust
// stream cannot drain between sends; overflow must be rejected without closing
// the shared socket. Integration tier, real encrypted loopback transport.
it('bounds connected stream queues and reports backpressure without disconnecting other traffic', async () => {
  const f = await network(false); serve(f.host);
  await f.controller.openLink('a-host', openPayload);
  const socket = f.sockets.find(value => value.deviceId === 'b-controller')!;
  const rejected: Envelope[] = [];
  socket.on('message', raw => {
    const frame = JSON.parse(raw.toString()) as Envelope;
    if (frame.kind === 'relay-error' && (frame.payload as { code?: string }).code === 'BACKPRESSURE') rejected.push(frame);
  });
  const frame = JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', dst: 'a-host', payload: { channel: 'test:slow', args: ['x'.repeat(1024 * 1024)] } });
  for (let index = 0; index < 10; index++) socket.send(frame);
  expect(socket.bufferedAmount).toBeGreaterThan(0);
  expect(socket.bufferedAmount).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(rejected.length).toBeGreaterThan(0);
  expect(f.controller.getStatus()).toBe('online');
  await vi.waitFor(() => expect(socket.bufferedAmount).toBe(0), { timeout: 4000 });
  expect(await f.controller.invoke('a-host', { channel: 'test:echo', args: ['after pressure'] }))
    .toMatchObject({ ok: true, result: 'after pressure' });
});
it('binds inbound src and enforces target remote-control preference without trusting the relay', async () => {
  const f = await network(false); serve(f.host);
  await f.controller.openLink('a-host', openPayload);
  const frame = new Promise<Envelope>((resolve) => f.host.onFrame((env) => { if (env.kind === 'push') resolve(env); }));
  const socket = f.sockets.find((s) => s.deviceId === 'b-controller')!;
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', src: 'another-device', dst: 'a-host', payload: { channel: 'test:source', payload: 1 } }));
  expect((await frame).src).toBe('b-controller');
  f.host.sendPresence({ remoteControlEnabled: false });
  await expect(f.controller.invoke('a-host', { channel: 'test:echo', args: ['rejected'] })).rejects.toMatchObject({ code: 'REMOTE_DISABLED' });
});

// Real existing scoped DeviceLinkClient contract over encrypted V2 streams.
// Transport grants must not become full-device control or another resource.
it.each(['shared-task', 'provider-share'] as const)('carries %s requests with host-signed member scope and revokes only that guest', async kind => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://auth.example.test';
  const keys = createLocalJWKSet({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'unit-auth', alg: 'RS256' }] });
  const sharing = createAgentNetSharingAuth({ issuer }, keys);
  sharing.providers.identityCards = { async verify() { return { displayName: 'Unit identity', avatarUrl: null, region: 'global' }; },
    async inspect() { throw new Error('No cross-region fixture'); } };
  const f = await network(false, undefined, kind === 'provider-share', true, sharing); serve(f.host);
  const guest = generateIdentity('external-guest');
  const signer = (identity: typeof guest) => ({ identity, sign: async (value: string) => signature(identity.signingPrivateKey, value),
    random: async () => randomBytes(18).toString('base64url') });
  const guestSigner = signer(guest), headers: string[] = [];
  const business = (identity: typeof guest, subject: string, member?: AgentNetClient) => {
    const api = new AgentNetSharingClient({ base: f.a.base, networkId: f.bootstrap.networkId, rootPublicKey: f.bootstrap.rootPublicKey,
      signer: signer(identity), assertCurrent() {}, hash: bytes => createHash('sha256').update(bytes).digest(),
      memberAuthorization: member ? (method, path, body) => member.header(method, path, body) : undefined,
      async getIdentityCard(nonce) {
        const at = Math.floor(Date.now() / 1000), expiresAt = at + 300;
        return { card: await new SignJWT({ typ: 'identity-card', purpose: 'network-session', nonce, device: identity.deviceId, region: 'global' })
          .setProtectedHeader({ alg: 'RS256', kid: 'unit-auth' }).setIssuer(issuer).setAudience('cindy-agent-net-sharing')
          .setSubject(subject).setIssuedAt(at).setExpirationTime(expiresAt).sign(pair.privateKey), expiresAt: new Date(expiresAt * 1000).toISOString() };
      },
      fetch: async (input, init) => { headers.push(new Headers(init?.headers).get('authorization') ?? ''); return fetch(input, init); },
    });
    cleanup.push(() => api.close()); return api;
  };
  const ownerBusiness = business(f.a.identity, 'owner-account', f.a), guestBusiness = business(guest, 'guest-account');
  await expect(business(f.a.identity, 'different-account', f.a).request('/api/device-link/shared-tasks', {
    method: 'POST', body: { sessionId: 'foreign-account', title: 'Must not enter this network' },
  })).rejects.toMatchObject({ status: 403 });
  const adapter = (client: AgentNetSharingClient) => ({ captureScope: () => ({ isCurrent: () => true }),
    request: (path: string, options: import('../sharingClient.js').SharingRequestOptions) => client.request(path, options) });
  let resourceId: string, memberId: string;
  const hostTasks = createSharedTaskApi(adapter(ownerBusiness)), hostProviders = createProviderShareApi(adapter(ownerBusiness));
  if (kind === 'shared-task') {
    resourceId = (await hostTasks.create('unit-session', 'Unit shared task')).sharedTaskId;
    const invitation = await hostTasks.invite(resourceId);
    memberId = (await createSharedTaskApi(adapter(guestBusiness)).join(invitation.invitation, 'Guest')).memberId;
  } else {
    const invitation = await hostProviders.createLink({ providerId: 'unit-provider', providerLabel: 'Unit provider', deviceName: 'Host', identityCard: 'unit-fixture-profile' });
    resourceId = invitation.shareId;
    const request = await createProviderShareApi(adapter(guestBusiness)).sendRequest(invitation.invitation, 'unit-fixture-profile');
    memberId = (await hostProviders.approve(request.requestId)).memberId;
  }
  // Exercise the same portable lease acquisition used by native/Desktop hosts,
  // including host-signature/root/resource verification rather than trusting CSR status.
  const lease = new AgentNetSharingTransport({ client: guestBusiness, applicant: guestSigner, assertCurrent() {},
    verifyCertificate, verifyDelegation, scope: { kind, resourceId, memberId, guestSubject: 'guest-account',
      networkId: f.bootstrap.networkId, rootPublicKey: f.bootstrap.rootPublicKey, hostDeviceId: 'a-host' } });
  cleanup.push(() => lease.close());
  const delegation = await lease.acquire();
  expect(await lease.acquire()).toBe(delegation);
  expect(headers.length).toBeGreaterThan(3); expect(headers.every(value => value.startsWith('AgentNetIdentity '))).toBe(true);
  const api = new AgentNetClient(f.a.base, guest, f.a.certificate, f.a.rootPublicKey, delegation);
  const visitor = f.make(api, false);
  await visitor.waitUntilOnline(3000);
  const peer = kind === 'shared-task' ? sharedTaskHostPeer(resourceId, 'a-host') : providerShareHostPeer(resourceId, 'a-host');
  await visitor.openLink(peer, openPayload);
  expect(await visitor.invoke(peer, { channel: 'test:echo', args: ['scoped confidential value'] })).toMatchObject({
    ok: true, result: 'scoped confidential value',
  });
  const hostSocket = f.sockets.find(socket => socket.deviceId === 'a-host')!;
  const guestPeer = kind === 'shared-task' ? sharedTaskGuestPeer(resourceId, memberId, guest.deviceId)
    : providerShareGuestPeer(resourceId, memberId, guest.deviceId);
  const target = await vi.waitFor(() => { const value = hostSocket.scopedPeerTarget(guestPeer); expect(value).toBeTruthy(); return value!; });
  expect(target.relayId).toBe('guest:' + delegation.id); expect(target.transportKey).toBe(guest.transportKey);
  if (kind === 'provider-share') {
    // The old scoped-host case could only reach O. A real worker-backed G/M
    // link must use O's signed exact executor key, retain O when M is revoked,
    // and ignore a stale generation's cleanup. No official routing involved.
    serve(f.controller);
    const input = { shareId: resourceId, memberId, guestDeviceId: guest.deviceId, executorDeviceId: f.b.identity.deviceId };
    const ownerOptions = { client: f.a, sharing: ownerBusiness, assertCurrent() {} };
    const first = await grantAgentNetSharingExecutor(ownerOptions, input);
    const executorOptions = { client: f.b, sharing: business(f.b.identity, 'owner-account', f.b), assertCurrent() {} };
    await expect(checkAgentNetSharingExecutor(executorOptions, input)).resolves.toMatchObject({ active: true, generation: first.generation, ownerDeviceId: f.a.identity.deviceId });
    const executorPeer = providerShareHostPeer(resourceId, f.b.identity.deviceId), guestSocket = f.sockets.find(s => s.deviceId === guest.deviceId)!;
    await vi.waitFor(() => expect(guestSocket.scopedPeerTarget(executorPeer)).toMatchObject({ relayId: f.b.identity.deviceId }));
    await visitor.openLink(executorPeer, openPayload);
    expect(await visitor.invoke(executorPeer, { channel: 'test:echo', args: ['direct executor secret'] })).toMatchObject({ ok: true, result: 'direct executor secret' });
    const requestedAt = Date.now();
    await guestBusiness.request('/api/agent-net/sharing/transport', { method: 'POST', applicant: guestSigner, body: {
      kind, resourceId, memberId, signingKey: guest.signingKey, transportKey: guest.transportKey,
    } });
    const renewed = await f.a.acceptDelegationRequest({ id: delegation.id, kind, resourceId, networkId: delegation.networkId,
      hostDeviceId: delegation.hostDeviceId, guestDeviceId: guest.deviceId, guestSigningKey: guest.signingKey, guestTransportKey: guest.transportKey,
      scope: delegation.scope!, requestedAt, expiresAt: requestedAt + MAX_GRANT_LIFETIME_MS }, () => undefined);
    expect(renewed.executors?.[0]).toMatchObject({ generation: first.generation, expiresAt: first.expiresAt });
    await guestSocket.replaceClient(new AgentNetClient(api.base, guest, renewed.issuerCertificate, api.rootPublicKey, renewed));
    expect(visitor.getStatus()).toBe('online');
    expect(await visitor.invoke(executorPeer, { channel: 'test:echo', args: ['executor survives credential renewal'] }))
      .toMatchObject({ ok: true, result: 'executor survives credential renewal' });
    const next = await grantAgentNetSharingExecutor(ownerOptions, input);
    await revokeAgentNetSharingExecutor(ownerOptions, { ...input, generation: first.generation });
    await expect(checkAgentNetSharingExecutor(executorOptions, input)).resolves.toMatchObject({ active: true, generation: next.generation });
    await revokeAgentNetSharingExecutor(ownerOptions, { ...input, generation: next.generation });
    await vi.waitFor(() => expect(guestSocket.scopedPeerTarget(executorPeer)).toBeNull());
    await expect(checkAgentNetSharingExecutor(executorOptions, input)).resolves.toEqual({ active: false });
    await expect(visitor.openLink(executorPeer, openPayload)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await visitor.invoke(peer, { channel: 'test:echo', args: ['owner route survives'] })).toMatchObject({ ok: true, result: 'owner route survives' });
  }
  const plain = randomBytes(1024);
  const binding = 'cindy-agent-net/media-scope/3/' + kind + '/' + resourceId;
  const media = await uploadEncryptedMedia(f.a, target.relayId, target.transportKey, plain.length,
    async (offset, length) => plain.subarray(offset, offset + length), { binding });
  expect(Buffer.from(await (await openEncryptedMedia(api, media.id, media.headerSha256, undefined, 'image/png', { binding })).arrayBuffer())).toEqual(plain);
  await expect(openEncryptedMedia(f.a, media.id, media.headerSha256, undefined, 'image/png', { binding: binding + '-other' })).rejects.toThrow();
  const incoming = await uploadEncryptedMedia(api, f.a.identity.deviceId, f.a.identity.transportKey, plain.length,
    async (offset, length) => plain.subarray(offset, offset + length), { binding });
  if (kind === 'shared-task') {
    const key = buildAgentNetMediaKey({ slot: '11111111-1111-4111-8111-111111111111', networkId: f.bootstrap.networkId,
      grantId: delegation.id, id: media.id, headerSha256: media.headerSha256, contentType: 'image/png',
      sharedTask: { sharedTaskId: resourceId, deviceId: f.a.identity.deviceId } });
    const reference = buildAttachmentOssRef({ ossKey: key, mimeType: 'image/png', size: plain.length, sha256: media.sha256 });
    expect(isSharedTaskAttachment(reference, resourceId)).toBe(true);
    expect(isSharedTaskAttachment(reference, 'other-resource')).toBe(false);
  }
  const wrong = kind === 'shared-task' ? sharedTaskHostPeer('other-resource', 'a-host') : providerShareHostPeer('other-resource', 'a-host');
  await expect(visitor.openLink(wrong, openPayload)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(visitor.openLink('b-controller', openPayload)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  if (kind === 'shared-task') await hostTasks.remove(resourceId, memberId);
  else await hostProviders.setMember(memberId, 'pause');
  await vi.waitFor(() => expect(visitor.getStatus()).not.toBe('online'));
  // Revocation removes the visitor's access, not the host's already received
  // task attachment. Resource-bound encryption still prevents a forged scope.
  expect(Buffer.from(await (await openEncryptedMedia(f.a, incoming.id, incoming.headerSha256, undefined, 'image/png', { binding })).arrayBuffer())).toEqual(plain);
  await expect(api.mediaResponse(media.id)).rejects.toMatchObject({ status: 401 });
  await f.controller.openLink('a-host', openPayload);
  expect(await f.controller.invoke('a-host', { channel: 'test:echo', args: ['unrelated member stays connected'] }))
    .toMatchObject({ ok: true, result: 'unrelated member stays connected' });
});
// A real handshake can beat a newly verified directory/grant announcement.
// Remembered refusal must not keep the now-approved peer offline for 30 seconds.
it('admits a previously refused handshake after the verified admission version changes', async () => {
  let allowed = false, version = 0, refused!: () => void;
  const firstRefusal = new Promise<void>(resolve => { refused = resolve; });
  const target = await createCoreTransport({ udp: true, bindAddress: '127.0.0.1',
    admit() { if (!allowed) refused(); return allowed; }, admissionVersion: () => version, onIncoming() {} });
  cleanup.push(() => target.close());
  const source = await createCoreTransport({ udp: true, bindAddress: '127.0.0.1',
    admit: key => key === target.id, onIncoming() {} });
  cleanup.push(() => source.close());
  const pending = source.connect({ id: target.id, dial: target.dial });
  await firstRefusal; allowed = true; version++;
  expect((await pending).remoteId).toBe(target.id);
});
it('applies a member revocation immediately, rejects its cached restart and keeps another peer usable', async () => {
  const f = await network(false); serve(f.host);
  const identity = generateIdentity('c-controller');
  const code = await f.a.request<{ joinCode: string }>('POST', '/join-codes');
  const join = createJoinRequest(identity, f.bootstrap.networkId, code.joinCode, 'Another controller', 'unit-only-pairing-secret');
  await submitJoin(f.relay.url, join);
  const certificate = approveJoin(f.root, join, 'unit-only-pairing-secret', f.bootstrap.ownerCertificate.subject);
  await f.a.request('POST', '/join-requests/' + join.requestId + '/approve', { certificate });
  const other = f.make(new AgentNetClient(f.relay.url, identity, certificate, f.bootstrap.rootPublicKey), false);
  await other.waitUntilOnline(3000);
  await Promise.all([f.controller.openLink('a-host', openPayload), other.openLink('a-host', openPayload)]);
  const cachedDirectory = await f.b.directory();
  const removed = new Promise<void>((resolve) => f.sockets.find((s) => s.deviceId === 'b-controller')!.once('close', () => resolve()));
  await f.a.request('DELETE', '/devices/b-controller'); await removed;
  expect(await other.invoke('a-host', { channel: 'test:echo', args: ['still-available'] })).toMatchObject({ ok: true, result: 'still-available' });
  expect(f.host.getStatus()).toBe('online');
  await expect(AgentNetSocket.open({ client: f.b, userId: f.bootstrap.ownerCertificate.subject, module: f.module,
    udp: false, cachedDirectory, directoryExpiresAt: Date.now() + 1000 })).rejects.toThrow('AGENT_NET_UPGRADE_401');
});
it('keeps one usable encrypted connection after both endpoints dial at the same time', async () => {
  const f = await network(false); f.host.stop(); f.controller.stop();
  const a = await AgentNetSocket.open({ client: f.a, userId: f.bootstrap.ownerCertificate.subject, module: f.module, udp: false });
  const b = await AgentNetSocket.open({ client: f.b, userId: f.bootstrap.ownerCertificate.subject, module: f.module, udp: false });
  cleanup.push(() => a.close()); cleanup.push(() => b.close());
  await vi.waitFor(() => expect(a.knowsPeer('b-controller')).toBe(true));
  await Promise.all([a.dial('b-controller'), b.dial('a-host')]);
  for (const socket of [a, b]) socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: {
    deviceName: socket.deviceId, platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false,
  } }));
  const delivered = new Promise<Envelope>((resolve) => b.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Envelope; if (frame.kind === 'push') resolve(frame);
  }));
  a.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', dst: 'b-controller', payload: { channel: 'test:simultaneous', payload: 'still-private' } }));
  expect(await delivered).toMatchObject({ src: 'a-host', payload: { channel: 'test:simultaneous', payload: 'still-private' } });
});
it('starts encrypted relay RPC before an unanswered public-address query finishes', async () => {
  const pending: Array<(value: null) => void> = [];
  const query = vi.spyOn(StunClient.prototype, 'query').mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  try {
    const f = await network(true); serve(f.host);
    await f.controller.openLink('a-host', openPayload);
    expect(await f.controller.invoke('a-host', { channel: 'test:echo', args: ['without-stun'] })).toMatchObject({ ok: true, result: 'without-stun' });
    expect(pending.length).toBeGreaterThan(0);
  } finally { query.mockRestore(); for (const resolve of pending) resolve(null); }
});
it('does not renew an expired public-directory cache or use it for an offline business call', async () => {
  const f = await network(false), cachedDirectory = await f.b.directory();
  f.host.stop(); f.controller.stop(); await f.relay.close();
  const saved = vi.fn();
  const socket = await AgentNetSocket.open({ client: f.b, userId: f.bootstrap.ownerCertificate.subject, module: f.module,
    udp: false, cachedDirectory, directoryExpiresAt: Date.now() - 1, onDirectory: saved });
  cleanup.push(() => socket.close());
  expect(socket.knowsPeer('a-host')).toBe(true); expect(socket.supports('a-host')).toBe(false); expect(saved).not.toHaveBeenCalled();
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: false, busy: false } }));
  const denied = new Promise<Envelope>((resolve) => socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Envelope; if (frame.kind === 'relay-error') resolve(frame);
  }));
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'invoke', id: 'expired-cache-request', dst: 'a-host', payload: { channel: 'test:echo', args: [] } }));
  expect(await denied).toMatchObject({ payload: { code: 'DEVICE_OFFLINE' } });
});

// Bug: cached identities could keep an existing direct path, but could not find it after both nodes restarted.
// Integration tier: real signed loopback multicast LAN beacons + Noise UDP,
// while the relay is stopped before either node opens. Bind both discovery and
// transport to loopback so the result does not depend on a runner's VPN/LAN route.
it('rediscovers certified peers on the LAN after both nodes restart without any server', async () => {
  const f = await network(true), directory = await f.a.directory();
  f.host.stop(); f.controller.stop(); await f.relay.close();
  const opened: AgentNetSocket[] = [];
  const makeOffline = (api: AgentNetClient, remoteControlEnabled: boolean) => {
    const client = new DeviceLinkClient({ getWsUrl: () => 'ws://local-node.invalid', getToken: async () => 'local',
      getHello: () => ({ deviceName: api.identity.deviceId, platform: 'test', appVersion: '1', remoteControlEnabled, busy: false }),
      createWebSocket: async () => {
        const socket = await AgentNetSocket.open({ client: api, userId: f.bootstrap.ownerCertificate.subject, module: f.module,
          cachedDirectory: directory, directoryExpiresAt: Date.now() + 60_000, udp: true, bindAddress: '127.0.0.1' });
        opened.push(socket); cleanup.push(() => socket.close()); return socket;
      }, timing: { requestTimeoutMs: 4000 }, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    cleanup.push(() => client.stop()); client.start(); return client;
  };
  const host = makeOffline(f.a, true), guest = makeOffline(f.b, false); serve(host);
  await Promise.all([host.waitUntilOnline(3000), guest.waitUntilOnline(3000)]);
  await vi.waitFor(() => expect(opened.some((s) => s.pathTo('a-host') === 'direct')).toBe(true), { timeout: 8000 });
  await guest.openLink('a-host', openPayload);
  expect(await guest.invoke('a-host', { channel: 'test:echo', args: ['cold-start-offline'] })).toMatchObject({ ok: true, result: 'cold-start-offline' });
});
