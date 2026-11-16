/** Production runtime registration -> real attachment entry. Known V2 offline
 * errors must prevent plaintext, while V1 sharing stays usable. The media-player
 * suite mocks agentNetRuntime and manually installed a backend, so it could not
 * catch the production callback swallowing errors. This suite loads the real
 * runtime once; native/notification/transport boundaries are inert memory fakes.
 * Unit tier: one scoped offline destination and one V1-only route, no I/O/waits.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { RoutedDeviceLinkClient, sharedTaskHostPeer } from '@cindy/device-link';
import { createPrivateNetwork, generateIdentity, verifyCertificate } from '../../../../packages/agent-net-relay/src/index.js';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { parseAttachmentOssRef } from '@/session/attachmentOssRef';

const fake = vi.hoisted(() => ({ target: vi.fn(), open: vi.fn(), identity: vi.fn(), enabled: false,
  createTransport: vi.fn(), verifyCertificate: vi.fn(), readDirectory: vi.fn() }));
vi.mock('@cindy/agent-net/portable', async original => ({ ...await original<typeof import('@cindy/agent-net/portable')>(),
  AgentNetSocket: { openWithBindings: fake.open }, NativeTransport: { create: fake.createTransport } }));
vi.mock('expo-network', () => ({ getIpAddressAsync: vi.fn() }));
vi.mock('react-native', () => ({ AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://relay.example.test',
  getOfficialDeviceLinkApiBaseUrl: () => 'https://relay.example.test', getOfficialAgentNetApiBaseUrl: () => 'https://agent-net.example.test' }));
vi.mock('@/device-link/agentNetNative', () => ({ MobileAgentNetEngine: { available: () => true } }));
vi.mock('@/device-link/agentNetIdentity', () => ({ ensureMobileAgentNetIdentity: fake.identity, clearMobileAgentNetIdentity: vi.fn(), currentMobileAgentNetIdentity: () => null }));
vi.mock('@/device-link/selfHostedRelayRouting', () => ({ getActiveSelfHostedRelay: () => null,
  getSelfHostedRelayRouteGeneration: () => 0, isAgentNetOnlyRoute: () => false,
  subscribeSelfHostedRelayRoute: () => () => {}, deviceLinkMediaApiBaseUrl: () => 'https://relay.example.test' }));
vi.mock('@/device-link/agentNetPreferences', () => ({ getMobileAgentNetPreferences: () => ({ ready: true, enabled: fake.enabled, onlyEncrypted: false, generation: 0 }),
  mobileAgentNetRequiresEncryption: () => false, subscribeMobileAgentNetPreferences: () => () => {} }));
vi.mock('@/device-link/agentNetNotifications', () => ({ clearMobileAgentNetNotifications: vi.fn(),
  clearMobileAgentNetNotificationDelivery: vi.fn(), refreshMobileAgentNetNotificationPreferences: vi.fn(),
  mobileAgentNetNotificationScope: vi.fn(), mutateMobileAgentNetNotificationRegistration: vi.fn(),
  updateMobileAgentNetNotificationTrust: vi.fn(), sendMobileAgentNetNotification: vi.fn() }));
vi.mock('@/device-link/agentNetLan', () => ({ mobileAgentNetDiscovery: vi.fn() }));
vi.mock('@/device-link/agentNetProtocol', () => ({ verifyMobileAgentNetCertificate: fake.verifyCertificate, verifyMobileAgentNetDelegation: vi.fn() }));
vi.mock('@/device-link/agentNetDirectoryCache', () => ({ readMobileAgentNetDirectory: fake.readDirectory, writeMobileAgentNetDirectory: vi.fn() }));
vi.mock('@/device-link/agentNetMode', () => ({ verifyMobileAgentNetModeProof: vi.fn() }));
vi.mock('@/device-link/agentNetSharing', () => ({ mobileAgentNetSharingMediaTarget: fake.target }));

import { openMobileAgentNetSocket, mobileAgentNetShouldUseLegacyPeer, mobileAgentNetShouldProbeLegacyPeer } from '@/device-link/agentNetRuntime';
import { uploadMobileAttachment } from '@/session/mobileAttachmentUpload';
beforeEach(() => {
  fake.target.mockReset(); fake.open.mockReset(); fake.identity.mockReset(); fake.enabled = false;
  fake.readDirectory.mockReset().mockResolvedValue(null);
  fake.createTransport.mockReset(); fake.verifyCertificate.mockReset().mockImplementation(verifyCertificate);
  setMobileAuthOwner('unit-media-owner');
});
afterEach(() => setMobileAuthOwner(null));
const deviceId = sharedTaskHostPeer('unit-shared-task', 'host');
const candidate = { name: 'note.txt', size: 1, mimeType: 'text/plain' };

it('keeps the installed backend from presigning or PUTing plaintext when a known V2 peer is unavailable', async () => {
  fake.target.mockImplementation(() => { throw new Error('AGENT_NET_MEDIA_PEER_UNAVAILABLE'); });
  const legacy = vi.fn();
  await expect(uploadMobileAttachment(candidate, new Uint8Array([1]).buffer, { token: 'unit-unused-token',
    deviceId, sharedTaskId: 'unit-shared-task', deps: { apiFetch: legacy, fetch: legacy } })).rejects.toThrow('AGENT_NET_MEDIA_PEER_UNAVAILABLE');
  expect(legacy).not.toHaveBeenCalled();
});

it('keeps the actual legacy upload path for a scoped peer with no V2 route', async () => {
  const apiFetch = vi.fn(async () => ({ putUrl: 'https://oss.example.test/put', key: 'legacy-note' }));
  const put = vi.fn(async () => new Response(null, { status: 200 }));
  const attachment = await uploadMobileAttachment(candidate, new Uint8Array([1]).buffer, { token: 'unit-unused-token',
    deviceId, sharedTaskId: 'unit-shared-task', deps: { apiFetch: apiFetch as any, fetch: put } });
  expect(parseAttachmentOssRef(attachment.path)?.ossKey).toBe('legacy-note');
  expect(apiFetch).toHaveBeenCalledOnce(); expect(put).toHaveBeenCalledOnce();
});

// A retained V2 identity survives directory removal. Absence of its current
// certificate is not evidence that this ordinary peer can safely use plaintext.
it.each([false, true])('handles an ordinary peer missing a certificate without downgrading known V2 (known=%s)', async known => {
  fake.enabled = true;
  const socket = new EventEmitter() as any;
  socket.close = () => socket.emit('close', 1000);
  socket.knowsPeer = () => known; socket.certificateFor = () => undefined;
  fake.open.mockResolvedValue(socket);
  fake.identity.mockResolvedValue({ api: { identity: { deviceId: 'phone' }, certificate: { expiresAt: Date.now() + 48 * 60 * 60_000 } },
    signer: {}, newTransportEngine: async () => ({ destroy: vi.fn() }) });
  await openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => null });
  const apiFetch = vi.fn(async () => ({ putUrl: 'https://oss.example.test/put', key: 'legacy-note' }));
  const put = vi.fn(async () => new Response(null, { status: 200 }));
  const work = uploadMobileAttachment(candidate, new Uint8Array([1]).buffer, { token: 'unit-unused-token',
    deviceId: 'computer', deps: { apiFetch: apiFetch as any, fetch: put } });
  if (known) {
    await expect(work).rejects.toThrow('AGENT_NET_MEDIA_PEER_UNAVAILABLE');
    expect(apiFetch).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  } else {
    expect(parseAttachmentOssRef((await work).path)?.ossKey).toBe('legacy-note');
    expect(apiFetch).toHaveBeenCalledOnce(); expect(put).toHaveBeenCalledOnce();
  }
});

/** Production Mobile startup + real PortableSocket/RoutedDeviceLinkClient.
 * Agent-Net's V1 parity rule: a relay outage with no directory must not disable
 * a healthy legacy link. Earlier media tests stubbed socket startup; Portable
 * recovery tests supplied a cached remote peer. Minimal input: our valid local
 * certificate, no cache, and one failed V2 connection. Unit: signed certificates
 * and real routing, only native transport and WebSocket I/O are in-memory fakes.
 */
it('opens a legacy link with no cached directory while the V2 relay is offline, without admitting unknown V2 peers', async () => {
  fake.enabled = true;
  const identity = generateIdentity('phone'), { bootstrap } = createPrivateNetwork('Offline mobile', identity);
  const { AgentNetSocket } = await vi.importActual<typeof import('@cindy/agent-net/portable')>('@cindy/agent-net/portable');
  fake.open.mockImplementation(AgentNetSocket.openWithBindings.bind(AgentNetSocket));
  fake.identity.mockResolvedValue({ api: { base: 'https://agent-net.example.test', rootPublicKey: bootstrap.rootPublicKey,
    identity, certificate: bootstrap.ownerCertificate, connect: async () => { throw new Error('offline'); } },
    signer: {}, newTransportEngine: async () => ({ destroy: vi.fn() }) });
  const connect = vi.fn();
  fake.createTransport.mockResolvedValue({ id: 'phone', dial: {}, connect, close: async () => undefined });
  const socket = await openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => null });
  expect(socket).not.toBeNull();
  await expect(socket!.dial('unknown')).rejects.toThrow('UNAUTHORIZED_PEER');
  expect(connect).not.toHaveBeenCalled();
  const frames: any[] = [];
  const legacy = Object.assign(new EventEmitter(), { bufferedAmount: 0,
    send: (text: string) => { frames.push(JSON.parse(text)); }, close: () => legacy.emit('close', 1000) });
  const options = { getWsUrl: () => 'wss://legacy.example.test', getToken: async () => 'unit-marker',
    getHello: () => ({ deviceName: 'Phone', platform: 'test', appVersion: '1', remoteControlEnabled: false, busy: false }),
    logger: { debug() {}, info() {}, warn() {}, error() {} } };
  const client = new RoutedDeviceLinkClient({ ...options, createWebSocket: () => socket! }, undefined, {
    active: () => true, useForPeer: mobileAgentNetShouldUseLegacyPeer, probeForPeer: mobileAgentNetShouldProbeLegacyPeer,
    options: { ...options, createWebSocket: () => legacy },
  });
  try {
    client.start();
    await vi.waitFor(() => expect(legacy.listenerCount('open')).toBeGreaterThan(0), { interval: 1 });
    legacy.emit('open');
    legacy.emit('message', JSON.stringify({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1,
      deviceId: 'phone', userId: 'unit-media-owner', capabilities: [] } }));
    const opened = client.openLink('legacy-desktop', {}, 1000);
    await vi.waitFor(() => expect(frames.find(frame => frame.kind === 'link-open')).toBeDefined(), { interval: 1 });
    const request = frames.find(frame => frame.kind === 'link-open');
    legacy.emit('message', JSON.stringify({ v: 1, kind: 'link-accept', id: request.id, src: 'legacy-desktop',
      payload: { appVersion: '1', allowlistHash: 'unit' } }));
    await expect(opened).resolves.toMatchObject({ appVersion: '1', allowlistHash: 'unit' });
    expect(client.connectionFor('legacy-desktop')).not.toBe(client);
  } finally { client.stop(); socket?.close(); }
});

it('fences the original account while the selected media module loads asynchronously', async () => {
  let started!: () => void, release!: () => void;
  const importing = new Promise<void>(resolve => { started = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  const upload = vi.fn(async () => ({ key: 'agent-net-v3/unit-selected', sha256: 'a'.repeat(64) }));
  vi.doMock('@/device-link/agentNetMedia', async () => { started(); await ready; return { uploadMobileAgentNetMedia: upload }; });
  fake.target.mockReturnValue({});
  const legacy = vi.fn();
  const outcome = uploadMobileAttachment(candidate, new Uint8Array([1]).buffer, { token: 'unit-unused-token',
    deviceId, sharedTaskId: 'unit-shared-task', deps: { apiFetch: legacy, fetch: legacy } }).catch(error => error);
  await importing; setMobileAuthOwner('other-owner'); release();
  expect(await outcome).toMatchObject({ message: 'AGENT_NET_OWNER_CHANGED' });
  expect(upload).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
});
