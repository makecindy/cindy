/**
 * 生产入口：ensureOwnerAgentNetBootstrap/currentAgentNetClient；检验密钥只交现有 vault、Root 绑定和冷重启一致性。
 * 规则：凭据与本地存储规则、V2 独立身份/无损 V1。原 relay config 测试没有 V2 私钥与多实例首次初始化。
 * 最小失败输入：两个实例从同一旧 seed 初始化；错账号旧证书；损坏 V2 私钥。tier：unit，现有宿主边界注入。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { AgentNetWorkerSocket } from '@cindy/agent-net';
import { issueCertificate, publicBytes } from '@cindy/agent-net-relay';
import { AgentNetClient } from '@cindy/agent-net-relay/client';
import { outboundFetch } from '../../maker-host/outbound-fetch.desktop.js';
const state = vi.hoisted(() => ({ owner: 'membership-a', pending: false, enabled: true, onlyEncrypted: false, secrets: null as any, writes: [] as any[],
  official: false, officialApi: null as any, officialEnsure: vi.fn() }));
vi.mock('electron', () => ({ app: { getAppPath: () => '/unit-only-app' } }));
vi.mock('../../authManager.js', () => ({ getCurrentUserId: () => state.owner, getDeviceId: () => 'device-a' }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.owner, isAppSessionBoundaryPending: () => state.pending }));
vi.mock('../settings-store.desktop.js', () => ({ readDeviceLinkSettings: () => ({ agentNetEnabled: state.enabled, agentNetOnlyEncrypted: state.onlyEncrypted }) }));
vi.mock('../selfHostedRelayRouting.js', () => ({ activeSelfHostedRelay: () => state.official ? null : ({
  relayId: '11111111-1111-4111-8111-111111111111', name: 'unit relay', baseUrl: 'http://127.0.0.1:1', role: 'owner',
  deviceId: 'device-a', ownerPublicKey: state.secrets?.agentNet?.rootPublicKey,
}), isAgentNetOnlyRelay: (relay: { credential?: string } | null) => relay !== null && relay.credential === '' }));
vi.mock('../selfHostedRelayConfig.js', () => ({
  readRelaySecrets: () => state.secrets,
  writeRelaySecrets: (_id: string, value: unknown) => { state.writes.push(value); state.secrets = value; },
  relayDataPath: () => '/unit-only-never-written',
}));
vi.mock('../../maker-host/outbound-fetch.desktop.js', () => ({ createOutboundHttpAgent: vi.fn(), outboundFetch: vi.fn() }));
vi.mock('../agentNetOfficial.js', () => ({ officialAgentNetBase: () => state.official ? 'https://agent-net.example.test' : '',
  currentOfficialAgentNetClient: () => state.officialApi, ensureOfficialAgentNetClient: state.officialEnsure, officialAgentNetSlot: () => 'unit-slot' }));
vi.mock('../deviceName.js', () => ({ deviceName: () => 'Unit device' }));
import { ensureOwnerAgentNetBootstrap, currentAgentNetClient, agentNetAllowsLegacy, createAgentNetOrLegacySocket,
  createAgentNetAppSocket, agentNetPeerSnapshot } from '../agentNetRuntime.js';
import { readCurrentDeviceDirectory } from '../agentNetDeviceDirectory.js';
const relayId = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { state.owner = 'membership-a'; state.pending = false; state.enabled = true; state.onlyEncrypted = false; state.writes = [];
  state.official = false; state.officialApi = null; state.officialEnsure.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
// Privacy failure: an unpaired V2 device previously looked inactive and could use the V1 factory despite encrypted-only.
// Unit tier: call the real route factory with no V2 identity; the existing legacy factory must never open.
it('fails closed when encrypted-only is selected before a V2 identity is available', async () => {
  state.secrets = null; state.onlyEncrypted = true;
  const legacy = vi.fn(() => ({ legacy: true }));
  await expect(createAgentNetOrLegacySocket(legacy)).rejects.toThrow('AGENT_NET_ENCRYPTED_IDENTITY_REQUIRED');
  expect(agentNetAllowsLegacy()).toBe(false); expect(legacy).not.toHaveBeenCalled();
  state.enabled = false;
  expect(await createAgentNetOrLegacySocket(legacy)).toEqual({ legacy: true });
  state.onlyEncrypted = false;
});
it('keeps the V1 credential, stores private keys only through the existing vault and derives stable keys across first-start races', () => {
  const root = generateKeyPairSync('ed25519').privateKey;
  const original = { credential: 'unit-test-not-a-real-credential', seed: root.export({ format: 'jwk' }).d! };
  state.secrets = original;
  const first = ensureOwnerAgentNetBootstrap(relayId, 'Private network');
  expect(first.rootPublicKey).toBe(publicBytes(root));
  expect(JSON.stringify(first)).not.toContain('PRIVATE KEY'); expect(JSON.stringify(first)).not.toContain('PrivateKey');
  expect(state.secrets.credential).toBe(original.credential); expect(state.secrets.seed).toBe(original.seed);
  expect(state.secrets.agentNet.signingPrivateKey).toContain('PRIVATE KEY');
  state.secrets = { ...original }; // Another process saw the old file before the first writer committed.
  const second = ensureOwnerAgentNetBootstrap(relayId, 'Private network');
  expect(second.ownerCertificate.signingKey).toBe(first.ownerCertificate.signingKey);
  expect(second.ownerCertificate.transportKey).toBe(first.ownerCertificate.transportKey);
  expect(currentAgentNetClient()?.identity.deviceId).toBe('device-a');
  state.onlyEncrypted = true; expect(agentNetAllowsLegacy()).toBe(false);
  state.enabled = false; expect(agentNetAllowsLegacy()).toBe(true);
  state.onlyEncrypted = false;
});
it('rejects account-boundary changes and corrupted keys without replacing existing identity', () => {
  const root = generateKeyPairSync('ed25519').privateKey;
  state.secrets = { credential: 'unit-test-not-a-real-credential', seed: root.export({ format: 'jwk' }).d! };
  ensureOwnerAgentNetBootstrap(relayId, 'Private network'); state.writes = [];
  state.owner = 'another-membership';
  expect(() => ensureOwnerAgentNetBootstrap(relayId, 'Private network')).toThrow('AGENT_NET_IDENTITY_MISMATCH');
  state.owner = 'membership-a'; state.secrets.agentNet.signingPrivateKey = 'unit-only-invalid-pem';
  expect(() => ensureOwnerAgentNetBootstrap(relayId, 'Private network')).toThrow();
  expect(state.writes).toHaveLength(0);
  state.enabled = false; expect(currentAgentNetClient()).toBeNull();
});
// Unit: two real route-factory attempts finish out of order. The old attempt
// previously replaced the current transport before DeviceLinkClient discarded it.
it('keeps the newest completed transport when an older factory finishes late', async () => {
  state.secrets = { credential: 'unit', seed: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }).d! };
  state.onlyEncrypted = false;
  ensureOwnerAgentNetBootstrap(relayId, 'unit');
  vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('unit-cache-absent'), { code: 'ENOENT' }));
  vi.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  const make = (rttMs: number) => {
    const socket = new EventEmitter() as any;
    socket.peerSnapshot = () => ({ path: 'relay', rttMs });
    socket.close = vi.fn(() => socket.emit('close', 1000));
    return socket;
  };
  const old = make(1), newer = make(2);
  let release!: (value: any) => void;
  const open = vi.spyOn(AgentNetWorkerSocket, 'open')
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValueOnce(newer);
  const first = createAgentNetAppSocket().catch(error => error);
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(await createAgentNetAppSocket()).toBe(newer);
  release(old);
  expect((await first).message).toBe('AGENT_NET_CONNECTION_SUPERSEDED');
  expect(old.close).toHaveBeenCalledOnce();
  expect(agentNetPeerSnapshot('peer')).toEqual({ path: 'relay', rttMs: 2 });
  newer.close();
});

// Unit: real Node SDK Fetch boundary + production mixed-directory adapter.
// Runtime identity tests did not exercise a raw network failure after V1 succeeds.
it('retains the live V1 directory when Node Fetch fails, except in encrypted-only mode', async () => {
  state.secrets = { credential: 'unit', seed: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }).d! };
  ensureOwnerAgentNetBootstrap(relayId, 'unit');
  const legacy = { devices: [{ deviceId: 'old', name: 'Old computer', platform: null, appVersion: null,
    lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true, isSelf: false }] };
  vi.mocked(outboundFetch).mockRejectedValueOnce(new TypeError('fetch failed')).mockRejectedValueOnce(new TypeError('fetch failed'));
  expect(await readCurrentDeviceDirectory(async () => legacy, () => {})).toEqual(legacy);
  state.onlyEncrypted = true;
  await expect(readCurrentDeviceDirectory(async () => legacy, () => {})).rejects.toMatchObject({ status: 0 });
});

it('keeps directory certificate denial and late owner changes terminal even with a live V1 result', async () => {
  state.secrets = { credential: 'unit', seed: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }).d! };
  ensureOwnerAgentNetBootstrap(relayId, 'unit');
  vi.mocked(outboundFetch).mockResolvedValueOnce(Response.json({ error: { code: 'CERTIFICATE_INVALID' } }, { status: 403 }));
  await expect(readCurrentDeviceDirectory(async () => ({ devices: [] }), () => {})).rejects.toMatchObject({ status: 403 });
  vi.mocked(outboundFetch).mockImplementationOnce(async () => { state.owner = 'another-membership'; throw new TypeError('fetch failed'); });
  await expect(readCurrentDeviceDirectory(async () => ({ devices: [] }), () => {})).rejects.toThrow('DEVICE_LINK_SCOPE_CHANGED');
});

it('keeps a healthy socket when early renewal returns the unchanged valid certificate', async () => {
  const root = generateKeyPairSync('ed25519').privateKey;
  state.secrets = { credential: 'unit', seed: root.export({ format: 'jwk' }).d! };
  ensureOwnerAgentNetBootstrap(relayId, 'unit');
  const previous = currentAgentNetClient()!;
  const certificate = issueCertificate(root, { networkId: 'account:unit-network', subject: previous.certificate.subject,
    identity: previous.identity, role: 'owner', now: Date.now() - 13.5 * 24 * 60 * 60_000 });
  state.officialApi = new AgentNetClient(previous.base, previous.identity, certificate, previous.rootPublicKey);
  state.official = true; state.officialEnsure.mockResolvedValue(state.officialApi);
  vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('absent'), { code: 'ENOENT' }));
  vi.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.mocked(outboundFetch).mockResolvedValue(Response.json({}));
  const socket = new EventEmitter() as any;
  socket.close = vi.fn(() => socket.emit('close', 1000)); socket.replaceClient = vi.fn(async () => {});
  vi.spyOn(AgentNetWorkerSocket, 'open').mockResolvedValue(socket);
  vi.useFakeTimers();
  try {
    expect(await createAgentNetAppSocket()).toBe(socket);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.officialEnsure).toHaveBeenCalledTimes(2);
    expect(socket.replaceClient).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  } finally { socket.close(); }
});
