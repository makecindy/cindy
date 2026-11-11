/** Production ensureMobileAgentNetIdentity: offline restart with an unexpired
 * certificate must retain LAN admission and retry early renewal without extending
 * expiry. Pairing tests never load an official identity in its last 24 hours.
 * Unit: real signed enrollment/certificate checks; native engine, secure vault
 * and Fetch are memory boundaries. No network, disk, module resets or real waits.
 */
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { identityFromSeed, issueCertificate, publicBytes, signature } from '../../../../packages/agent-net-relay/src/index.js';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';

const state = vi.hoisted(() => ({ vault: new Map<string, string>(), writes: vi.fn(), destroy: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => randomUUID(), getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)) }));
vi.mock('@/config/env', () => ({ getOfficialAgentNetApiBaseUrl: () => 'https://agent-net.example.test' }));
vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: async (key: string) => state.vault.get(key) ?? null,
  setSecureItem: async (key: string, value: string) => { state.writes(); state.vault.set(key, value); },
}));
vi.mock('@/device-link/selfHostedRelay', () => ({ completeSelfHostedAgentNetMembership: vi.fn() }));
vi.mock('@/device-link/selfHostedRelayRouting', () => ({ getActiveSelfHostedRelay: () => null, getSelfHostedRelayRouteGeneration: () => 0 }));
vi.mock('@/device-link/agentNetNative', () => ({ MobileAgentNetEngine: class {
  identity: ReturnType<typeof identityFromSeed>; assertCurrent: () => void;
  constructor(options: { context: string; seed: string; deviceId: string }, guard: () => void) {
    this.identity = identityFromSeed(options.context, options.seed, options.deviceId); this.assertCurrent = guard;
  }
  static async create(options: { context: string; seed: string; deviceId: string }, guard: () => void) { guard(); return new this(options, guard); }
  async sign(text: string) { this.assertCurrent(); return signature(this.identity.signingPrivateKey, text); }
  async random() { return randomBytes(32).toString('base64url'); }
  async destroy() { state.destroy(); }
} }));
import { clearMobileAgentNetIdentity, ensureMobileAgentNetIdentity } from '@/device-link/agentNetIdentity';

const options = { deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => 'unit-test-not-a-real-token' };
let root = generateKeyPairSync('ed25519').privateKey;
let issuedAt = Date.now(), status = 200, failure: Error | null = null, changeOwner = false;
beforeEach(async () => {
  await clearMobileAgentNetIdentity(); state.vault.clear(); state.writes.mockClear(); state.destroy.mockClear();
  setMobileAuthOwner('member'); root = generateKeyPairSync('ed25519').privateKey;
  issuedAt = Date.now() - 13.5 * 24 * 60 * 60_000; status = 200; failure = null; changeOwner = false;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    if (changeOwner) setMobileAuthOwner('other-member');
    if (failure) throw failure;
    if (status !== 200) return Response.json({ error: { code: status === 403 ? 'DEVICE_REENROLLMENT_REQUIRES_APPROVAL' : 'SERVICE_UNAVAILABLE' } }, { status });
    const request = JSON.parse(String(init.body));
    const certificate = issueCertificate(root, { networkId: 'account:unit-network', subject: getMobileAuthOwner().accountId,
      identity: request, role: 'owner', now: issuedAt });
    return Response.json({ rootPublicKey: publicBytes(root), certificate });
  }));
});
afterEach(async () => { await clearMobileAgentNetIdentity(); vi.useRealTimers(); vi.unstubAllGlobals(); setMobileAuthOwner(null); });

it.each(['network', 'service'] as const)('retains the stored certificate on a %s outage and renews on the next attempt', async kind => {
  const first = await ensureMobileAgentNetIdentity(options), previous = first.api.certificate;
  await clearMobileAgentNetIdentity(); state.writes.mockClear();
  const stored = [...state.vault.values()];
  if (kind === 'network') failure = new TypeError('Network request failed');
  else vi.mocked(fetch).mockResolvedValueOnce(new Response('Service unavailable', { status: 503 }));
  const retained = await ensureMobileAgentNetIdentity(options);
  expect(retained.api.certificate).toEqual(previous);
  expect([...state.vault.values()]).toEqual(stored); expect(state.writes).not.toHaveBeenCalled();
  failure = null; status = 200; issuedAt = Date.now();
  expect((await ensureMobileAgentNetIdentity(options)).api.certificate.expiresAt).toBeGreaterThan(previous.expiresAt);
});

it('keeps an existing signer and socket identity when early renewal is temporarily offline', async () => {
  const first = await ensureMobileAgentNetIdentity(options);
  failure = new TypeError('Network request failed');
  const retained = await ensureMobileAgentNetIdentity(options);
  expect(retained).toBe(first);
  expect(state.destroy).toHaveBeenCalledTimes(1); // Only the failed attempt's unused signer.
  expect(() => first.signer.assertCurrent()).not.toThrow();
});

it('does not use an old certificate after an authoritative denial or pinned-root change', async () => {
  await ensureMobileAgentNetIdentity(options); await clearMobileAgentNetIdentity(); state.writes.mockClear();
  status = 403;
  await expect(ensureMobileAgentNetIdentity(options)).rejects.toThrow('DEVICE_REENROLLMENT_REQUIRES_APPROVAL');
  vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
    controller.error(new TypeError('Network request failed'));
  } }), { status: 403 }));
  await expect(ensureMobileAgentNetIdentity(options)).rejects.toMatchObject({ status: 403 });
  status = 200; root = generateKeyPairSync('ed25519').privateKey;
  await expect(ensureMobileAgentNetIdentity(options)).rejects.toThrow('AGENT_NET_IDENTITY_MISMATCH');
  expect(state.writes).not.toHaveBeenCalled();
});

it('does not reuse an expired identity or complete renewal for a changed account', async () => {
  const first = await ensureMobileAgentNetIdentity(options), expiration = first.api.certificate.expiresAt;
  await clearMobileAgentNetIdentity(); state.writes.mockClear();
  failure = new TypeError('Network request failed');
  vi.useFakeTimers(); vi.setSystemTime(expiration + 1);
  await expect(ensureMobileAgentNetIdentity(options)).rejects.toMatchObject({ status: 0 });
  vi.setSystemTime(expiration - 1); changeOwner = true;
  await expect(ensureMobileAgentNetIdentity(options)).rejects.toThrow('AGENT_NET_OWNER_CHANGED');
  expect(state.writes).not.toHaveBeenCalled();
});

it('cannot invent an identity when initial enrollment is offline', async () => {
  failure = new TypeError('Network request failed');
  await expect(ensureMobileAgentNetIdentity(options)).rejects.toMatchObject({ status: 0 });
  expect([...state.vault.values()].every(raw => !JSON.parse(raw).certificate)).toBe(true);
});
