/** Unit: the native resolver is untrusted input, not device admission. Public
 * fixture keys exercise the production verifier and late native-handle cleanup. */
import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { certificatePayload, delegationPayload, type Delegation, type DeviceCertificate } from '@cindy/agent-net-protocol';
import { toBase64Url, utf8 } from '@cindy/agent-net/portable';
import { mobileRelayAuthCrypto as crypto } from '@/device-link/relayAuthCrypto';
import { mobileAgentNetDiscovery } from '@/device-link/agentNetLan';
import { verifyMobileAgentNetDelegation } from '@/device-link/agentNetProtocol';
import type { MobileAgentNetEngine } from '@/device-link/agentNetNative';
vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)) }));

const bridge = vi.hoisted(() => ({
  listener: undefined as ((event: any) => void) | undefined,
  startLan: vi.fn<(...args: any[]) => Promise<string>>(), updateLan: vi.fn(async () => undefined),
  stopLan: vi.fn(async () => undefined), remove: vi.fn(),
}));
vi.mock('../../modules/cindy-agent-net/src', () => ({ agentNetNative: {
  startLan: bridge.startLan, updateLan: bridge.updateLan, stopLan: bridge.stopLan,
  addListener: (_event: string, listener: (event: any) => void) => { bridge.listener = listener; return { remove: bridge.remove }; },
} }));
const close: (() => void)[] = [];
afterEach(() => { close.splice(0).forEach(off => off()); vi.clearAllMocks(); bridge.listener = undefined; });
const seed = new Uint8Array(32).fill(17), root = new Uint8Array(32).fill(18);
const signingKey = toBase64Url(crypto.ed25519PublicKey(seed));
const plain = { v: 2 as const, networkId: 'unit-native-lan', subject: 'unit-member', deviceId: 'remote', signingKey,
  transportKey: toBase64Url(new Uint8Array(32).fill(19)), role: 'member' as const, issuedAt: Date.now() - 1000,
  expiresAt: Date.now() + 86_400_000, serial: 'unit-certificate' };
const certificate: DeviceCertificate = { ...plain, signature: toBase64Url(crypto.ed25519Sign(root, utf8(certificatePayload(plain)))) };
// Unit: the portable host uses Noble rather than Node's crypto. A host-signed
// resource grant must have the same scope/lifetime policy on both platforms.
it('verifies the host delegation and rejects changed membership, expiry and an unrelated root', () => {
  const unsigned: Omit<Delegation, 'signature'> = { v: 2, id: 'unit-grant', kind: 'shared-task',
    networkId: plain.networkId, hostDeviceId: plain.deviceId, resourceId: 'unit-task', guestDeviceId: 'unit-guest',
    guestSigningKey: toBase64Url(crypto.ed25519PublicKey(new Uint8Array(32).fill(21))),
    guestTransportKey: toBase64Url(new Uint8Array(32).fill(22)), issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    issuerCertificate: certificate, scope: { memberId: 'unit-member', guestSubject: 'global:unit-guest', memberVersion: 1 } };
  const grant = { ...unsigned, signature: toBase64Url(crypto.ed25519Sign(seed, utf8(delegationPayload(unsigned)))) };
  const trusted = toBase64Url(crypto.ed25519PublicKey(root));
  expect(verifyMobileAgentNetDelegation(trusted, grant)).toBe(true);
  expect(verifyMobileAgentNetDelegation(trusted, { ...grant, scope: { ...grant.scope!, memberVersion: 2 } })).toBe(false);
  expect(verifyMobileAgentNetDelegation(trusted, grant, grant.expiresAt)).toBe(false);
  expect(verifyMobileAgentNetDelegation(plain.signingKey, grant)).toBe(false);
});
function start(guard = () => undefined) {
  const onCandidate = vi.fn();
  const signer = { identity: { deviceId: 'local', signingKey, transportKey: toBase64Url(new Uint8Array(32).fill(20)) },
    random: async () => 'A'.repeat(43), sign: async (text: string) => toBase64Url(crypto.ed25519Sign(seed, utf8(text))) } as unknown as MobileAgentNetEngine;
  const discovery = mobileAgentNetDiscovery({ networkId: plain.networkId, port: 3333,
    certificateFor: device => device === 'remote' ? certificate : undefined, onCandidate }, signer, guard);
  close.push(discovery.close); discovery.start(); return { discovery, onCandidate };
}
function event(patch: object = {}) {
  const b = { v: 2, network: plain.networkId, device: 'remote', key: plain.transportKey, port: 4444,
    at: Date.now(), nonce: 'B'.repeat(16), ...patch };
  const payload = JSON.stringify(['cindy-agent-net-lan/2', b.network, b.device, b.key, b.port, b.at, b.nonce]);
  const raw = toBase64Url(utf8(JSON.stringify({ ...b, signature: toBase64Url(crypto.ed25519Sign(seed, utf8(payload))) })));
  const txt: Record<string, string> = {};
  for (let i = 0; i * 200 < raw.length; i++) txt['b' + i] = raw.slice(i * 200, (i + 1) * 200);
  return { id: 'unit-lan-handle', port: 4444, addresses: ['198.51.100.1', '192.168.20.3'], txt };
}
it('accepts a signed paired device once and rejects unknown, expired and wrong-key beacons', async () => {
  bridge.startLan.mockResolvedValue('unit-lan-handle');
  const fixture = start();
  await vi.waitFor(() => expect(bridge.startLan).toHaveBeenCalled(), { interval: 1, timeout: 80 });
  await Promise.resolve();
  for (const patch of [{ device: 'unknown' }, { at: Date.now() - 16_000 }, { key: 'A'.repeat(43) }]) bridge.listener!(event(patch));
  expect(fixture.onCandidate).not.toHaveBeenCalled();
  bridge.listener!(event()); bridge.listener!(event());
  expect(fixture.onCandidate).toHaveBeenCalledTimes(1);
  expect(fixture.onCandidate).toHaveBeenCalledWith('remote', { address: '192.168.20.3', port: 4444 });
});
it.each(['closed', 'owner-changed'] as const)('stops a native handle which finishes starting after %s', async reason => {
  let finish!: (id: string) => void, current = true;
  bridge.startLan.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const fixture = start(() => { if (!current) throw new Error('OWNER_CHANGED'); });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'), { interval: 1, timeout: 80 });
  if (reason === 'closed') fixture.discovery.close(); else current = false;
  finish('late-native-handle');
  await vi.waitFor(() => expect(bridge.stopLan).toHaveBeenCalledWith('late-native-handle'), { interval: 1, timeout: 80 });
});
