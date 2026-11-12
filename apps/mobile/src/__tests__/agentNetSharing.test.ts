/** Unit: production mobile sharing API, public root pins and secure seed store.
 * Agent-Net independent relay parity: the old official account-fence tests
 * never exercised a private invitation or native signer. Minimal failures:
 * a private service receives Bearer, a late join survives logout, a new root
 * replaces an existing pin, or re-admission reuses a retired transport key.
 * Only native OS/storage/HTTP boundaries are memory fakes; SDK signing, parsing
 * and routing are real. No real user data or network. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { identityFromSeed, signature, verifyRequestProof, generateIdentity, createPrivateNetwork } from '../../../../packages/agent-net-relay/src/index.js';
import { buildAgentNetSharingInvitation, parseAgentNetSharingInvitation } from '@cindy/agent-net/portable';
import { RoutedDeviceLinkClient, sharedTaskHostPeer } from '@cindy/device-link';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
const fake = vi.hoisted(() => ({ storage: new Map<string, string>(), secure: new Map<string, string>(), http: vi.fn(), card: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => fake.storage.get(key) ?? null, setItem: async (key: string, value: string) => { fake.storage.set(key, value); },
} }));
vi.mock('@/auth/secureStorage', () => ({ getSecureItem: async (key: string) => fake.secure.get(key) ?? null,
  setSecureItem: async (key: string, value: string) => { fake.secure.set(key, value); } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)) }));
vi.mock('@/config/env', () => ({ AUTH_API_BASE_URL: 'https://auth.example.test', getActiveMobileSessionRealm: () => 'global' }));
vi.mock('@/device-link/agentNetIdentity', () => ({ currentMobileAgentNetIdentity: () => null }));
vi.mock('@/device-link/agentNetPreferences', () => ({ getMobileAgentNetPreferences: () => ({ ready: true, enabled: true }),
  mobileAgentNetAllowsLegacy: () => false, subscribeMobileAgentNetPreferences: () => () => {} }));
vi.mock('@/device-link/agentNetNative', () => ({ MobileAgentNetEngine: class {
  identity: ReturnType<typeof identityFromSeed>; assertCurrent: () => void;
  constructor(options: { context: string; seed: string; deviceId: string }, guard: () => void) { this.identity = identityFromSeed(options.context, options.seed, options.deviceId); this.assertCurrent = guard; }
  static available() { return true; }
  static async create(options: any, guard: () => void) { guard(); return new this(options, guard); }
  async sign(text: string) { this.assertCurrent(); return signature(this.identity.signingPrivateKey, text); }
  async random() { this.assertCurrent(); return randomBytes(18).toString('base64url'); }
  async destroy() {}
} }));
import { bindMobileAgentNetSharing, joinMobileAgentNetSharedTask, requestMobileAgentNetSharedTask, stopMobileAgentNetSharing } from '@/device-link/agentNetSharing';
let receipt: NonNullable<ReturnType<typeof parseAgentNetSharingInvitation>>['receipt'];
const context = { deviceId: 'phone', apiFetch: fake.card };
beforeEach(() => {
  setMobileAuthOwner('guest'); fake.storage.clear(); fake.secure.clear(); fake.http.mockReset(); fake.card.mockReset();
  fake.card.mockResolvedValue({ card: 'unit-limited-card', expiresAt: new Date(Date.now() + 300_000).toISOString() });
  const { bootstrap } = createPrivateNetwork('Fixture', generateIdentity('host'));
  receipt = { v: 2, kind: 'shared-task', resourceId: 'private-task', invitation: 'A'.repeat(43), networkId: bootstrap.networkId,
    rootPublicKey: bootstrap.rootPublicKey, hostDeviceId: 'host', region: 'global' };
  vi.stubGlobal('fetch', fake.http);
});
afterEach(() => { stopMobileAgentNetSharing(); setMobileAuthOwner(null); vi.unstubAllGlobals(); });
const link = () => buildAgentNetSharingInvitation(receipt, 'https://friend.example.test');
const admitted = () => Response.json({ sharedTaskId: receipt.resourceId, memberId: 'guest-member', status: 'joined', created: true });
const book = () => JSON.parse([...fake.storage.values()][0]);
// Region/account is one identity. Equal raw IDs from different issuers cannot
// suppress Guest admission during list recovery. Existing join tests only use
// one region; public mobile list + real SDK signing, memory I/O; unit.
it('recovers a cross-region guest even when the remote owner has the same raw account ID', async () => {
  receipt.region = 'cn'; fake.http.mockResolvedValueOnce(admitted());
  await joinMobileAgentNetSharedTask(link(), 'Guest', context);
  fake.http.mockResolvedValueOnce(Response.json({ sharedTasks: [{ sharedTaskId: 'recovered-task', hostDeviceId: 'host', ownerAccountId: 'guest' }] }));
  fake.http.mockResolvedValueOnce(Response.json({ status: 'active', guests: [{ accountId: 'x:global:guest', memberId: 'recovered-member' }] }));
  const legacy = vi.fn();
  await expect(requestMobileAgentNetSharedTask('/api/device-link/shared-tasks', { method: 'GET' }, context, legacy))
    .resolves.toMatchObject({ sharedTasks: [{ sharedTaskId: 'recovered-task' }], unavailableSharedTaskIds: [] });
  expect(book().routes.find((r: any) => r.resourceId === 'recovered-task')).toMatchObject({ memberId: 'recovered-member', region: 'cn' });
  expect(legacy).not.toHaveBeenCalled();
});
it('joins and pins an invited private task without official enrollment or account token disclosure', async () => {
  fake.http.mockImplementation(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://friend.example.test/api/agent-net/sharing/shared-tasks/join');
    const authorization = new Headers(init.headers).get('authorization')!; expect(authorization).toMatch(/^AgentNetIdentity /);
    const value = JSON.parse(Buffer.from(authorization.slice('AgentNetIdentity '.length), 'base64url').toString());
    expect(value.card).toBe('unit-limited-card'); expect(verifyRequestProof(value.signingKey, value.proof, 'POST', new URL(url).pathname, String(init.body), Date.now())).toBe(true);
    return admitted();
  });
  await expect(joinMobileAgentNetSharedTask(link(), 'Guest', context)).resolves.toMatchObject({ memberId: 'guest-member' });
  expect(book().routes[0]).toMatchObject({ server: 'https://friend.example.test', rootPublicKey: receipt.rootPublicKey });
  expect(JSON.stringify(book())).not.toContain(receipt.invitation); expect(JSON.stringify(book())).not.toContain('unit-limited-card');
  expect([...fake.secure.values()].every(value => /^[A-Za-z0-9_-]{43}$/.test(value))).toBe(true);
  const options = { getWsUrl: () => 'wss://unavailable.example.test', getToken: async () => null,
    createWebSocket: () => { throw new Error('PRIMARY_MUST_NOT_BE_REQUIRED'); },
    getHello: () => ({ deviceName: 'Phone', platform: 'test', appVersion: '1', remoteControlEnabled: false, busy: false }) };
  const primary = new RoutedDeviceLinkClient(options), stop = bindMobileAgentNetSharing(primary, options, context);
  await vi.waitFor(() => expect(primary.connectionFor(sharedTaskHostPeer(receipt.resourceId, 'host'))).not.toBe(primary), { interval: 1 }); stop();
});
it('retires a departed scope and creates a new secure transport seed on re-admission', async () => {
  fake.http.mockImplementation(async (url: string) => url.endsWith('/join') ? admitted() : Response.json({}));
  await joinMobileAgentNetSharedTask(link(), 'Guest', context); const before = book().routes[0].seedId;
  await requestMobileAgentNetSharedTask('/api/device-link/shared-tasks/private-task/leave', { method: 'POST', body: {} }, context, async () => { throw new Error('NO_LEGACY'); });
  expect(book().routes[0].retired).toBe(true);
  await joinMobileAgentNetSharedTask(link(), 'Guest', context);
  expect(book().routes[0].seedId).not.toBe(before); expect(book().routes[0].retired).toBe(false);
});
it('rejects a conflicting root before contacting it and rejects a late success after an account switch', async () => {
  fake.http.mockImplementation(async () => admitted()); await joinMobileAgentNetSharedTask(link(), 'Guest', context);
  const old = receipt.rootPublicKey; receipt = { ...receipt, rootPublicKey: createPrivateNetwork('Other', generateIdentity('other')).bootstrap.rootPublicKey };
  await expect(joinMobileAgentNetSharedTask(link(), 'Guest', context)).rejects.toThrow('ROUTE_CONFLICT'); expect(fake.http).toHaveBeenCalledOnce();
  receipt = { ...receipt, rootPublicKey: old, resourceId: 'other-task' };
  let finish!: (response: Response) => void; fake.http.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = joinMobileAgentNetSharedTask(link(), 'Guest', context);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'), { interval: 1 });
  setMobileAuthOwner('different'); finish(admitted()); await expect(pending).rejects.toThrow();
  expect(book().routes.map((r: any) => r.resourceId)).toEqual(['private-task']);
});
