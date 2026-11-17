/**
 * Unit: production notification registration/trust lifecycle, native IO injected.
 * Rule: credentials-and-local-storage + Agent-Net owner/route/privacy fences.
 * Gap: native C ABI crypto tests cannot cover a pending JS registration after
 * notifications are disabled, or an older trust write after device revocation.
 * Minimum inputs: one valid device certificate + a paused key/sign operation.
 * Native OS stores/crypto have separate native smoke coverage. No real waits/IO.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { certificatePayload, type DeviceView } from '@cindy/agent-net-protocol';
import { toBase64Url, utf8 } from '@cindy/agent-net/portable';
import { mobileRelayAuthCrypto as crypto } from '@/device-link/relayAuthCrypto';
import type { PreparedMobileAgentNetIdentity } from '@/device-link/agentNetIdentity';
import { clearMobileAgentNetNotifications, clearMobileAgentNetNotificationDelivery,
  updateMobileAgentNetNotificationTrust, mutateMobileAgentNetNotificationRegistration } from '@/device-link/agentNetNotifications';

const native = vi.hoisted(() => ({ ticket: 0, config: null as any,
  configure: vi.fn(async (ticket: string, raw: string) => {
    if (ticket !== String(native.ticket)) throw new Error('OLD_TICKET');
    native.config = JSON.parse(raw);
  }) }));
vi.mock('../../modules/cindy-agent-net/src', () => ({ agentNetNative: {
  beginNotificationScope() { native.config = null; return String(++native.ticket); },
  configureNotifications: native.configure,
} }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)) }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-notifications', () => ({ getPermissionsAsync: vi.fn(async () => ({ status: 'denied' })) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => key === 'cindy.push.preview' ? '0' : null,
} }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => ({ accountKey: 'global:unit-owner' }) }));
vi.mock('@/config/env', () => ({ AUTH_REGION: 'global' }));
vi.mock('@/notifications/nativePushEnvironment', () => ({ readIosPushEnvironment: vi.fn(async () => 'development') }));
vi.mock('@/device-link/agentNetPreferences', () => ({ getMobileAgentNetPreferences: () => ({ onlyEncrypted: true }) }));

const rootSeed = new Uint8Array(32).fill(21), signerSeed = new Uint8Array(32).fill(22);
const root = toBase64Url(crypto.ed25519PublicKey(rootSeed));
function fixture(deviceId: string, expiresAt = Date.now() + 86_400_000): DeviceView {
  const plain = { v: 2 as const, networkId: 'private:notification-unit', subject: 'unit-owner', deviceId,
    signingKey: toBase64Url(crypto.ed25519PublicKey(signerSeed)), transportKey: toBase64Url(new Uint8Array(32).fill(23)),
    role: 'member' as const, issuedAt: Date.now() - 1000, expiresAt, serial: 'serial-' + deviceId };
  return { certificate: { ...plain, signature: toBase64Url(crypto.ed25519Sign(rootSeed, utf8(certificatePayload(plain)))) },
    name: deviceId, online: false, capabilities: [], remoteControlEnabled: false };
}
const key = { secret: toBase64Url(new Uint8Array(32).fill(24)), encryptionKey: toBase64Url(new Uint8Array(32).fill(25)) };
const body = { token: 'a'.repeat(64), provider: 'apns', appVariant: 'global', apnsEnv: 'sandbox' };
function start() {
  const self = fixture('phone'), remote = fixture('host'), guard = () => undefined;
  const sign = vi.fn(async (text: string) => toBase64Url(crypto.ed25519Sign(signerSeed, utf8(text))));
  const command = vi.fn(async (_value: unknown) => key);
  const request = vi.fn(async () => ({ deliveryConfigured: true, notificationKeys: true }));
  const identity = { api: { base: 'https://relay.example.test', rootPublicKey: root, certificate: self.certificate,
    identity: { deviceId: 'phone' }, request }, signer: { sign, command } } as unknown as PreparedMobileAgentNetIdentity;
  updateMobileAgentNetNotificationTrust(identity, [self, remote], guard);
  return { identity, self, remote, sign, command, request, guard };
}
beforeEach(() => { clearMobileAgentNetNotifications(); vi.clearAllMocks(); });

it('registers only a signed independent public key and keeps notification-only background trust', async () => {
  const { request } = start();
  await mutateMobileAgentNetNotificationRegistration('PUT', body);
  expect(request).toHaveBeenCalledWith('PUT', '/push-token', expect.objectContaining({
    token: body.token, notificationKey: expect.objectContaining({ deviceId: 'phone', encryptionKey: key.encryptionKey }),
  }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(native.config).toMatchObject({ preview: false, onlyEncrypted: true, deviceId: 'phone',
    peers: { host: fixture('host').certificate.signingKey }, secret: key.secret });
});

it('does not re-register or reinstall background keys after notification delivery is disabled', async () => {
  const { sign, request } = start();
  let release!: (signature: string) => void;
  sign.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const registration = mutateMobileAgentNetNotificationRegistration('PUT', body);
  const outcome = registration.catch(error => error);
  await vi.waitFor(() => expect(sign).toHaveBeenCalledOnce());
  clearMobileAgentNetNotificationDelivery();
  release('unit-late-signature');
  expect((await outcome).message).toBe('AGENT_NET_PUSH_STATE_CHANGED');
  expect(request).not.toHaveBeenCalled();
  expect(native.config).toBeNull();
});

it('keeps each sender expiry separate from the directory and local certificate deadline', async () => {
  const { identity, self, remote, guard } = start();
  const expiring = fixture('old-offline-host', Date.now() + 1000);
  const directoryExpiresAt = Date.now() + 60_000;
  updateMobileAgentNetNotificationTrust(identity, [self, remote, expiring], guard, directoryExpiresAt);
  await mutateMobileAgentNetNotificationRegistration('PUT', body);
  expect(native.config).toMatchObject({ version: 3, expiresAt: directoryExpiresAt,
    peers: { host: remote.certificate.signingKey, 'old-offline-host': expiring.certificate.signingKey },
    peerExpiresAt: { host: remote.certificate.expiresAt, 'old-offline-host': expiring.certificate.expiresAt } });
});

it('does not overwrite a newer revocation snapshot with a delayed older trust write', async () => {
  const { identity, self, command, request, guard } = start();
  let release!: (value: typeof key) => void;
  command.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const old = mutateMobileAgentNetNotificationRegistration('PUT', body);
  const outcome = old.catch(error => error);
  await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
  updateMobileAgentNetNotificationTrust(identity, [self], guard);
  await mutateMobileAgentNetNotificationRegistration('PUT', body);
  release(key);
  expect((await outcome).message).toBe('AGENT_NET_PUSH_STATE_CHANGED');
  expect(native.config.peers).not.toHaveProperty('host');
  expect(request).toHaveBeenCalledOnce();
});
