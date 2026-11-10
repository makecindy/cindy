import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { CERT_LIFETIME_MS, notificationKeyPayload, notificationPayload, type DeviceView } from '@cindy/agent-net-protocol';
import { utf8, fromBase64Url } from '@cindy/agent-net/portable';
import type { NotifyPayload } from '@cindy/device-link';
import { mobileRelayAuthCrypto } from './relayAuthCrypto';
import { agentNetNative } from '../../modules/cindy-agent-net/src';
import { getMobileAuthOwner } from '@/auth/authOwnerGeneration';
import Notifications from '@/notifications/nativeNotifications';
import { readIosPushEnvironment } from '@/notifications/nativePushEnvironment';
import { buildPushTokenRegistrationBody } from '@/notifications/pushRegistrationModel';
import { AUTH_REGION } from '@/config/env';
import { Platform } from 'react-native';
import type { PreparedMobileAgentNetIdentity } from './agentNetIdentity';
import { getMobileAgentNetPreferences } from './agentNetPreferences';
import { publishMobileAgentNetPushScope } from './agentNetPushRegistry';
import { verifyMobileAgentNetCertificate } from './agentNetProtocol';

interface Active {
  identity: PreparedMobileAgentNetIdentity;
  devices: DeviceView[];
  guard(): void;
  scope: string;
  ticket: string;
  expiresAt: number;
  revision: number;
  persisted?: { peers: string; preview: boolean; onlyEncrypted: boolean; at: number };
  registered?: string;
}
let active: Active | null = null, registeringFor: Active | null = null, deliveryEpoch = 0;
let deliveryAbort = new AbortController();
export async function sendMobileAgentNetNotification(
  identity: PreparedMobileAgentNetIdentity, recipient: DeviceView, input: NotifyPayload, signal: AbortSignal, guard: () => void,
): Promise<void> {
  guard();
  const c = recipient.certificate, binding = recipient.notificationKey, api = identity.api;
  if (!verifyMobileAgentNetCertificate(api.rootPublicKey, c) || c.networkId !== api.certificate.networkId
    || c.subject !== api.certificate.subject || !binding || binding.v !== 2 || binding.networkId !== c.networkId
    || binding.deviceId !== c.deviceId || !mobileRelayAuthCrypto.ed25519Verify(fromBase64Url(c.signingKey),
      utf8(notificationKeyPayload(binding)), fromBase64Url(binding.signature))) throw new Error('UNTRUSTED_NOTIFICATION_KEY');
  const payload = { ...input, title: Array.from(input.title).slice(0, 128).join('') };
  const id = (await identity.signer.random()).slice(0, 24); guard();
  let ciphertext = '';
  for (const length of [640, 320, 160, 0]) {
    payload.body = Array.from(input.body ?? '').slice(0, length).join('');
    try {
      ciphertext = await identity.signer.command<string>({ op: 'notificationSeal', recipientKey: binding.encryptionKey,
        text: notificationPayload(c.networkId, api.identity.deviceId, c.deviceId, id, Date.now(), payload) }); break;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'NOTIFICATION_TOO_LARGE') throw error;
      if (payload.sender?.avatar) payload.sender = { id: payload.sender.id };
    }
  }
  if (!ciphertext) throw new Error('NOTIFICATION_TOO_LARGE');
  guard();
  await api.request('POST', '/notify', { to: c.deviceId, ciphertext }, { signal }); guard();
}
function assertCurrent(value: Active) { value.guard(); if (active !== value) throw new Error('AGENT_NET_OWNER_CHANGED'); }
export function clearMobileAgentNetNotifications(): void {
  clearMobileAgentNetNotificationDelivery(); active = null;
  publishMobileAgentNetPushScope();
}
export function clearMobileAgentNetNotificationDelivery(): void {
  deliveryEpoch++; deliveryAbort.abort(); deliveryAbort = new AbortController();
  const ticket = agentNetNative?.beginNotificationScope?.() ?? '';
  if (active) { active.ticket = ticket; active.persisted = undefined; active.registered = undefined; }
}
export async function refreshMobileAgentNetNotificationPreferences(): Promise<void> {
  if (!active) return;
  clearMobileAgentNetNotificationDelivery();
  const value = active, epoch = deliveryEpoch;
  try { await persist(value); } catch (error) {
    if (active === value && epoch === deliveryEpoch) clearMobileAgentNetNotificationDelivery();
    throw error;
  }
}
export function mobileAgentNetNotificationScope(): string | null {
  try { if (active) { assertCurrent(active); return active.scope; } } catch { /* Old owner/route. */ }
  return null;
}
export function updateMobileAgentNetNotificationTrust(
  identity: PreparedMobileAgentNetIdentity, devices: DeviceView[], guard: () => void, expiresAt = Date.now() + CERT_LIFETIME_MS,
): void {
  guard();
  if (!agentNetNative?.beginNotificationScope || !agentNetNative.configureNotifications) return;
  if (!active || active.guard !== guard) {
    clearMobileAgentNetNotifications();
    const owner = getMobileAuthOwner(), api = identity.api;
    const scope = bytesToHex(sha256(utf8(JSON.stringify(['cindy-agent-net/push-scope/2', owner.accountKey,
      api.base, api.rootPublicKey, api.certificate.networkId, api.identity.deviceId]))));
    active = { identity, devices, guard, scope, expiresAt, revision: 0, ticket: agentNetNative.beginNotificationScope() };
    publishMobileAgentNetPushScope();
  } else { active.identity = identity; active.devices = devices; active.expiresAt = expiresAt; active.revision++; }
  const value = active;
  void (async () => {
    const { readPushEnabled } = await import('@/notifications/pushNotifications');
    if (!await readPushEnabled()) return;
    assertCurrent(value);
    await persist(value);
    // No permission prompt on reconnect. The Settings workflow owns first-time permission.
    if (registeringFor === value || value.registered) return;
    registeringFor = value;
    try {
      if ((await Notifications.getPermissionsAsync()).status !== 'granted') return;
      assertCurrent(value);
      const token = await Notifications.getDevicePushTokenAsync(); assertCurrent(value);
      const apnsEnvironment = Platform.OS === 'ios' ? await readIosPushEnvironment() : undefined; assertCurrent(value);
      const body = buildPushTokenRegistrationBody({ token: typeof token.data === 'string' ? token.data : '',
        platform: Platform.OS === 'android' ? 'android' : 'ios', region: AUTH_REGION, apnsEnvironment });
      if (body) await mutateMobileAgentNetNotificationRegistration('PUT', body);
    } finally { if (registeringFor === value) registeringFor = null; }
  })().catch(() => undefined);
}
async function persist(value: Active): Promise<void> {
  assertCurrent(value);
  const epoch = deliveryEpoch, revision = value.revision, ticket = value.ticket;
  const guard = () => {
    assertCurrent(value);
    if (epoch !== deliveryEpoch || revision !== value.revision) throw new Error('AGENT_NET_PUSH_STATE_CHANGED');
  };
  if (!agentNetNative?.configureNotifications) throw new Error('AGENT_NET_NATIVE_BINARY_REQUIRED');
  const { readPushPreviewEnabled } = await import('@/notifications/pushNotifications');
  const preview = await readPushPreviewEnabled(); guard();
  const peers: Record<string, string> = Object.create(null);
  const peerExpiresAt: Record<string, number> = Object.create(null);
  const expiresAt = Math.min(value.expiresAt, value.identity.api.certificate.expiresAt);
  for (const view of value.devices) {
    const c = view.certificate;
    if (verifyMobileAgentNetCertificate(value.identity.api.rootPublicKey, c)
      && c.networkId === value.identity.api.certificate.networkId && c.subject === value.identity.api.certificate.subject) {
      peers[c.deviceId] = c.signingKey; peerExpiresAt[c.deviceId] = c.expiresAt;
    }
  }
  const snapshot = JSON.stringify([peers, peerExpiresAt, expiresAt]), previous = value.persisted;
  const onlyEncrypted = getMobileAgentNetPreferences().onlyEncrypted;
  if (previous && previous.peers === snapshot && previous.preview === preview && previous.onlyEncrypted === onlyEncrypted
    && Date.now() - previous.at < 60 * 60_000) return;
  const key = await value.identity.signer.command<{ secret: string; encryptionKey: string }>({ op: 'notificationKey' });
  guard();
  // Local trust format 3 requires native per-sender expiry support. An older
  // binary rejects it instead of trusting an expired peer until the global bound.
  await agentNetNative.configureNotifications(ticket, JSON.stringify({ version: 3,
    networkId: value.identity.api.certificate.networkId, deviceId: value.identity.api.identity.deviceId,
    scope: value.scope, expiresAt, peers, peerExpiresAt, secret: key.secret, preview, onlyEncrypted }));
  guard();
  value.persisted = { peers: snapshot, preview, onlyEncrypted, at: Date.now() };
}
export async function mutateMobileAgentNetNotificationRegistration(method: 'PUT' | 'DELETE', input?: unknown): Promise<void> {
  const value = active;
  if (!value) throw new Error('AGENT_NET_NOT_READY');
  assertCurrent(value);
  if (method === 'DELETE') {
    clearMobileAgentNetNotificationDelivery();
    await value.identity.api.request('DELETE', '/push-token'); return;
  }
  const body = input as { token?: unknown; provider?: unknown; appVariant?: unknown; apnsEnv?: unknown } | null;
  if (!body || typeof body.token !== 'string') throw new Error('INVALID_PUSH_REGISTRATION');
  const epoch = deliveryEpoch, signal = deliveryAbort.signal;
  const guard = () => { assertCurrent(value); if (epoch !== deliveryEpoch) throw new Error('AGENT_NET_PUSH_STATE_CHANGED'); };
  await persist(value); guard();
  const key = await value.identity.signer.command<{ encryptionKey: string }>({ op: 'notificationKey' }); guard();
  const plain = { v: 2 as const, networkId: value.identity.api.certificate.networkId,
    deviceId: value.identity.api.identity.deviceId, encryptionKey: key.encryptionKey };
  const signature = await value.identity.signer.sign(notificationKeyPayload(plain)); guard();
  const registration = { token: body.token, provider: body.provider, appVariant: body.appVariant,
    apnsEnv: body.apnsEnv ?? null, notificationKey: { ...plain, signature } };
  const fingerprint = JSON.stringify(registration);
  if (value.registered === fingerprint) return;
  const result = await value.identity.api.request<{ deliveryConfigured: boolean; notificationKeys: boolean }>('PUT', '/push-token', registration, { signal });
  guard();
  if (!result.notificationKeys) throw new Error('AGENT_NET_NOTIFICATION_SERVER_UPDATE_REQUIRED');
  if (!result.deliveryConfigured) throw new Error('NOTIFICATION_PROVIDER_NOT_CONFIGURED');
  value.registered = fingerprint;
}
