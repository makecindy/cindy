/**
 * 生产入口：ensureOfficialAgentNetClient；官方 CSR、续签、固定根与账号边界。
 * 依据：V2 独立身份/现有凭据安全规则；已有私有中转测试不覆盖账号 enrollment。
 * 最小失败输入：两个同时初始化、续签更换根、请求期间换账号；tier：unit，只有宿主 IO 边界注入。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { enrollmentPayload } from '@cindy/agent-net-protocol';
import { issueCertificate, publicBytes, verifySignature } from '@cindy/agent-net-relay';
const state = vi.hoisted(() => ({
  subject: 'membership-a', scope: 'scope-a', base: 'https://agent-net.example.test', pending: false, unreadable: false,
  root: null as any, secrets: new Map<string, any>(), writes: [] as any[], requests: 0,
  beforeIssue: null as null | (() => Promise<void>),
}));
vi.mock('node:fs/promises', () => ({ default: { mkdir: vi.fn(async () => undefined) } }));
vi.mock('node:fs', async (original) => ({ ...await original<any>(), existsSync: () => state.unreadable }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.scope, isAppSessionBoundaryPending: () => state.pending }));
vi.mock('../../authManager.js', () => ({ getCurrentUserId: () => state.subject, getActiveAuthRealm: () => 'global', getDeviceId: () => 'unit-device' }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => state.base }));
vi.mock('../selfHostedRelayRouting.js', () => ({ activeSelfHostedRelay: () => null }));
vi.mock('../selfHostedRelayConfig.js', () => ({
  readRelaySecrets: (id: string) => state.secrets.get(id) ?? null,
  writeRelaySecrets: (id: string, value: unknown) => { state.writes.push(value); state.secrets.set(id, value); },
  relayDataPath: (...parts: string[]) => '/unit-only-never-written/' + parts.join('/'),
}));
vi.mock('../crossProcessLock.js', () => ({ withCrossProcessLock: async (_path: string, _options: unknown, action: any) => action({ held: true }) }));
vi.mock('../../maker-host/outbound-fetch.desktop.js', () => ({ outboundFetch: vi.fn(), createOutboundHttpAgent: vi.fn() }));
vi.mock('../../serverApiClient.desktop.js', () => ({ serverApiFetch: vi.fn(async (_path: string, options: any) => {
  options.baseUrl(); state.requests++;
  const body = options.body;
  expect(verifySignature(body.signingKey, enrollmentPayload(body), body.signature)).toBe(true);
  await state.beforeIssue?.();
  const certificate = issueCertificate(state.root, { networkId: 'account:unit-network', subject: 'membership-a', role: 'owner',
    identity: { deviceId: body.deviceId, signingKey: body.signingKey, transportKey: body.transportKey } });
  return { rootPublicKey: publicBytes(state.root), certificate };
}) }));
import { ensureOfficialAgentNetClient, officialAgentNetSlot } from '../agentNetOfficial.js';
beforeEach(() => {
  state.subject = 'membership-a'; state.scope = 'scope-a'; state.pending = false; state.unreadable = false;
  state.base = 'https://agent-net.example.test'; state.root = generateKeyPairSync('ed25519').privateKey;
  state.secrets.clear(); state.writes = []; state.requests = 0; state.beforeIssue = null;
});
afterEach(() => vi.useRealTimers());
it('single-flights account enrollment and keeps the signed identity in the existing encrypted vault', async () => {
  const [first, second] = await Promise.all([ensureOfficialAgentNetClient('Unit device'), ensureOfficialAgentNetClient('Unit device')]);
  expect(first).toBe(second); expect(state.requests).toBe(1);
  const saved = state.secrets.get(officialAgentNetSlot());
  expect(saved.agentNet.certificate.deviceId).toBe('unit-device');
  expect(saved.agentNet.signingPrivateKey).toContain('PRIVATE KEY');
  expect((await ensureOfficialAgentNetClient('Renamed')).identity.signingKey).toBe(first.identity.signingKey);
  expect(state.requests).toBe(1);
});
it('pins the original root across renewal and never replaces an unreadable credential file', async () => {
  const first = await ensureOfficialAgentNetClient('Unit device');
  const saved = state.secrets.get(officialAgentNetSlot());
  saved.agentNet.certificate = issueCertificate(state.root, { networkId: first.certificate.networkId, subject: first.certificate.subject,
    identity: first.identity, role: 'owner', now: Date.now() - 13 * 24 * 60 * 60_000 });
  state.root = generateKeyPairSync('ed25519').privateKey;
  await expect(ensureOfficialAgentNetClient('Unit device')).rejects.toThrow('UNTRUSTED_ENROLLMENT');
  expect(saved.agentNet.rootPublicKey).toBe(first.rootPublicKey);
  state.secrets.clear(); state.unreadable = true;
  await expect(ensureOfficialAgentNetClient('Unit device')).rejects.toThrow('AGENT_NET_IDENTITY_UNREADABLE');
});
it('does not persist a late certificate after the account changes', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  state.beforeIssue = async () => { started.resolve(); await release.promise; };
  const pending = ensureOfficialAgentNetClient('Unit device'); await started.promise;
  state.scope = 'scope-b'; state.subject = 'membership-b'; release.resolve();
  await expect(pending).rejects.toThrow('AGENT_NET_OWNER_CHANGED');
  expect(state.writes.every((entry) => entry.agentNet === undefined)).toBe(true);
});

// Offline restart during the final 24h was not covered by successful enrollment
// or root-pinning tests. Real certificates and vault boundary, no I/O or waits.
it.each([0, 503])('retains an unexpired identity on enrollment status %s and renews on the next attempt', async status => {
  const first = await ensureOfficialAgentNetClient('Unit device'), saved = state.secrets.get(officialAgentNetSlot());
  saved.agentNet.certificate = issueCertificate(state.root, { networkId: first.certificate.networkId, subject: first.certificate.subject,
    identity: first.identity, role: 'owner', now: Date.now() - 13.5 * 24 * 60 * 60_000 });
  const previous = saved.agentNet.certificate;
  state.writes = [];
  state.beforeIssue = async () => { throw Object.assign(new Error('enrollment unavailable'), { status, code: 'NETWORK_ERROR' }); };
  const retained = await ensureOfficialAgentNetClient('Unit device');
  expect(retained.certificate).toEqual(previous);
  expect(retained.identity.signingKey).toBe(first.identity.signingKey);
  expect(state.writes).toHaveLength(0);
  state.beforeIssue = null;
  expect((await ensureOfficialAgentNetClient('Unit device')).certificate.expiresAt).toBeGreaterThan(previous.expiresAt);
});

it('does not retain a certificate past expiry or after an authoritative renewal denial', async () => {
  const first = await ensureOfficialAgentNetClient('Unit device'), saved = state.secrets.get(officialAgentNetSlot());
  saved.agentNet.certificate = issueCertificate(state.root, { networkId: first.certificate.networkId, subject: first.certificate.subject,
    identity: first.identity, role: 'owner', now: Date.now() - 13.5 * 24 * 60 * 60_000 });
  state.beforeIssue = async () => { throw Object.assign(new Error('certificate rejected'), { status: 403, code: 'DEVICE_REENROLLMENT_REQUIRES_APPROVAL' }); };
  await expect(ensureOfficialAgentNetClient('Unit device')).rejects.toMatchObject({ status: 403 });
  vi.useFakeTimers(); vi.setSystemTime(saved.agentNet.certificate.expiresAt - 1);
  state.beforeIssue = async () => {
    vi.setSystemTime(saved.agentNet.certificate.expiresAt + 1);
    throw Object.assign(new Error('enrollment unavailable'), { status: 0, code: 'NETWORK_ERROR' });
  };
  await expect(ensureOfficialAgentNetClient('Unit device')).rejects.toMatchObject({ status: 0 });
});
