import { getRandomBytes } from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha256';
import { md5 } from '@noble/hashes/legacy';
import { bytesToHex } from '@noble/hashes/utils';
import { enrollmentPayload, type DeviceCertificate } from '@cindy/agent-net-protocol';
import { PortableAgentNetClient, fromBase64Url, toBase64Url, utf8, type BinarySocket } from '@cindy/agent-net/portable';
import { getSecureItem, setSecureItem } from '@/auth/secureStorage';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import { getOfficialAgentNetApiBaseUrl } from '@/config/env';
import { MobileAgentNetEngine, type NativeAgentNetOptions } from './agentNetNative';
import { verifyMobileAgentNetCertificate, verifyMobileAgentNetDelegation } from './agentNetProtocol';
import { completeSelfHostedAgentNetMembership } from './selfHostedRelay';
import { getActiveSelfHostedRelay, getSelfHostedRelayRouteGeneration } from './selfHostedRelayRouting';

export interface MobileAgentNetEnrollmentOptions {
  deviceId: string;
  deviceName: string;
  getAccessToken(): Promise<string | null>;
}
export interface PreparedMobileAgentNetIdentity {
  scope: string;
  api: PortableAgentNetClient;
  signer: MobileAgentNetEngine;
  /** Trusted app memory only, for a synchronous V1 transport-mode assertion. */
  seed: string;
  context: string;
  legacySigning: boolean;
  newTransportEngine(extraGuard: () => void): Promise<MobileAgentNetEngine>;
  newCryptoEngine(extraGuard: () => void): Promise<MobileAgentNetEngine>;
  dispose(): Promise<void>;
}
interface OfficialRecord { version: 2; seed: string; rootPublicKey?: string; certificate?: DeviceCertificate; }
const inflight = new Map<string, Promise<PreparedMobileAgentNetIdentity>>();
let cached: PreparedMobileAgentNetIdentity | null = null;
let modeIdentity: { seed: string; context: string; deviceId: string; guard(): void } | null = null;

export function mobileAgentNetIdentityScope(deviceId: string): string {
  const owner = getMobileAuthOwner(), route = getActiveSelfHostedRelay();
  return JSON.stringify([owner.accountKey, owner.generation, getSelfHostedRelayRouteGeneration(),
    route?.relayId ?? null, route?.baseUrl ?? getOfficialAgentNetApiBaseUrl(), deviceId]);
}
export function currentMobileAgentNetIdentity(): PreparedMobileAgentNetIdentity | null {
  try { cached?.signer.assertCurrent(); return cached; } catch { return null; }
}
export function currentMobileAgentNetModeIdentity(): typeof modeIdentity {
  try { modeIdentity?.guard(); return modeIdentity; } catch { return null; }
}
export async function clearMobileAgentNetIdentity(): Promise<void> {
  const previous = cached; cached = null; modeIdentity = null;
  await previous?.dispose();
}
function officialSlot(owner: MobileAuthOwnerGeneration, base: string): string {
  return bytesToHex(sha256(utf8(JSON.stringify(['cindy-agent-net/mobile-official-vault/2', owner.accountKey, base]))));
}
/** Loading an existing V2 key for an explicit V1 mode proof does not enroll a
 * device, enable V2, contact a service or require a new native binary. */
export async function loadExistingMobileAgentNetModeIdentity(deviceId: string): Promise<void> {
  if (getActiveSelfHostedRelay()) return;
  const base = getOfficialAgentNetApiBaseUrl();
  if (!base) return;
  const owner = getMobileAuthOwner(), scope = mobileAgentNetIdentityScope(deviceId), guard = ownerGuard(owner, scope, deviceId);
  guard();
  const context = officialSlot(owner, base), raw = await getSecureItem('cindy.agent-net.official.v2.' + context);
  guard();
  if (!raw) return;
  const record = JSON.parse(raw) as OfficialRecord;
  if (record.version !== 2 || typeof record.seed !== 'string' || fromBase64Url(record.seed).length !== 32
    || !record.rootPublicKey || !record.certificate
    || !verifyMobileAgentNetCertificate(record.rootPublicKey, record.certificate, record.certificate.issuedAt)
    || record.certificate.deviceId !== deviceId || record.certificate.subject !== owner.accountId) {
    throw new Error('AGENT_NET_IDENTITY_UNREADABLE');
  }
  modeIdentity = { seed: record.seed, context, deviceId, guard };
}
function ownerGuard(owner: MobileAuthOwnerGeneration, scope: string, deviceId: string): () => void {
  return () => {
    if (!owner.accountId || !isMobileAuthOwnerCurrent(owner) || mobileAgentNetIdentityScope(deviceId) !== scope) {
      throw new Error('AGENT_NET_OWNER_CHANGED');
    }
  };
}
async function post(base: string, resource: string, body: unknown, guard: () => void, authorization?: string): Promise<unknown> {
  guard();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
  const readTransport = async <T>(read: () => Promise<T>, status?: number): Promise<T> => {
    try { return await read(); }
    catch (error) {
      guard();
      if (status && status >= 400) {
        const code = 'AGENT_NET_REQUEST_' + status;
        throw Object.assign(new Error(code), { status, code });
      }
      if (controller.signal.aborted || error instanceof TypeError || (error as { name?: unknown } | null)?.name === 'AbortError') {
        const code = controller.signal.aborted ? 'AGENT_NET_REQUEST_TIMEOUT' : 'AGENT_NET_NETWORK_ERROR';
        throw Object.assign(new Error(code), { status: 0, code });
      }
      throw error;
    }
  };
  try {
    const response = await readTransport(() => fetch(base + '/api/agent-net' + resource, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
    }));
    guard();
    const value = await readTransport(() => response.json(), response.status);
    guard();
    if (!response.ok) {
      const serverCode = (value as { error?: { code?: unknown } } | null)?.error?.code;
      const code = typeof serverCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(serverCode) ? serverCode : 'AGENT_NET_REQUEST_' + response.status;
      throw Object.assign(new Error(code), { status: response.status, code });
    }
    return value;
  } finally { clearTimeout(timer); }
}
function enrollmentUnavailable(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown } | null;
  if (typeof value?.code === 'string' && /INVALID|DENIED|REVOKED|UNAUTHORIZED|FORBIDDEN|SCOPE_CHANGED|OWNER_CHANGED/.test(value.code)) return false;
  return value?.status === 0 || value?.status === 429
    || typeof value?.status === 'number' && value.status >= 500 && value.status < 600;
}
function binarySocket(url: string, headers: Record<string, string>): BinarySocket {
  const Constructor = globalThis.WebSocket as unknown as new (url: string, protocols?: string[] | null,
    options?: { headers: Record<string, string> }) => BinarySocket;
  return new Constructor(url, undefined, { headers });
}
function prepared(scope: string, base: string, signer: MobileAgentNetEngine, native: NativeAgentNetOptions,
  certificate: DeviceCertificate, root: string, guard: () => void, privateHttp: boolean): PreparedMobileAgentNetIdentity {
  if (!verifyMobileAgentNetCertificate(root, certificate) || certificate.subject !== getMobileAuthOwner().accountId
    || certificate.deviceId !== native.deviceId) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
  const existing = cached?.scope === scope && cached.api.base === base && cached.api.rootPublicKey === root ? cached.api : null;
  const api = existing ?? new PortableAgentNetClient(base, signer, certificate, root, {
    assertCurrent: guard, verifyCertificate: verifyMobileAgentNetCertificate, verifyDelegation: verifyMobileAgentNetDelegation,
    sha256: value => toBase64Url(sha256(value)), md5: value => md5(value), createWebSocket: binarySocket, ownerPinnedHttp: privateHttp,
  });
  if (existing) existing.replaceCredentials(signer, certificate);
  return { scope, api, signer, seed: native.seed, context: native.context, legacySigning: native.legacySigning === true,
    newTransportEngine(extraGuard) { return MobileAgentNetEngine.create({ ...native, udp: true }, () => { guard(); extraGuard(); }); },
    newCryptoEngine(extraGuard) { return MobileAgentNetEngine.create({ ...native, udp: false }, () => { guard(); extraGuard(); }); },
    dispose: () => signer.destroy() };
}

export async function ensureMobileAgentNetIdentity(options: MobileAgentNetEnrollmentOptions): Promise<PreparedMobileAgentNetIdentity> {
  const scope = mobileAgentNetIdentityScope(options.deviceId), owner = getMobileAuthOwner();
  const guard = ownerGuard(owner, scope, options.deviceId);
  guard();
  if (cached?.scope === scope && cached.api.certificate.expiresAt - Date.now() > 24 * 60 * 60_000) return cached;
  const existing = inflight.get(scope); if (existing) return existing;
  const work = (async () => {
    const route = getActiveSelfHostedRelay();
    if (route) {
      const signing = route.signing, membership = signing?.agentNet;
      if (!signing || !membership || membership.networkId !== 'private:' + route.relayId || membership.rootPublicKey !== signing.ownerPublicKey) {
        throw new Error('AGENT_NET_PAIRING_REQUIRED');
      }
      const native = { seed: signing.seed, context: route.relayId, deviceId: options.deviceId, legacySigning: true, udp: false };
      const signer = await MobileAgentNetEngine.create(native, guard);
      let retained = false;
      try {
        if (membership.pending) {
          const result = await post(route.baseUrl, '/join/status', { networkId: membership.networkId,
            requestId: membership.pending.requestId, pollToken: membership.pending.pollToken }, guard) as {
              status?: string; rootPublicKey?: string; certificate?: DeviceCertificate;
            };
          if (result.status !== 'approved' || result.rootPublicKey !== membership.rootPublicKey
            || !verifyMobileAgentNetCertificate(membership.rootPublicKey, result.certificate)
            || result.certificate.signingKey !== signer.identity.signingKey || result.certificate.transportKey !== signer.identity.transportKey) {
            throw new Error('AGENT_NET_PAIRING_NOT_APPROVED');
          }
          await completeSelfHostedAgentNetMembership({ owner, relayId: route.relayId, seed: signing.seed,
            expectedTransportKey: signer.identity.transportKey, expectedSigningKey: signer.identity.signingKey, membership: { version: 2,
              networkId: membership.networkId, rootPublicKey: membership.rootPublicKey, certificate: result.certificate } });
          // Persisting the new certificate publishes a new route generation.
          // Recreate its guard instead of keeping the superseded route's signer.
          await signer.destroy();
          return ensureMobileAgentNetIdentity(options);
        }
        if (!membership.certificate) throw new Error('AGENT_NET_PAIRING_REQUIRED');
        const value = prepared(scope, route.baseUrl, signer, native, membership.certificate, membership.rootPublicKey, guard, true);
        guard(); const previous = cached; cached = value; retained = true;
        if (previous && previous !== value) void previous.dispose();
        return value;
      } finally { if (!retained) await signer.destroy(); }
    }
    const base = getOfficialAgentNetApiBaseUrl();
    if (!base || !base.startsWith('https://')) throw new Error('AGENT_NET_NOT_CONFIGURED');
    const slot = officialSlot(owner, base);
    const key = 'cindy.agent-net.official.v2.' + slot;
    const raw = await getSecureItem(key); guard();
    let record: OfficialRecord;
    if (raw) {
      try { record = JSON.parse(raw); } catch { throw new Error('AGENT_NET_IDENTITY_UNREADABLE'); }
      if (record.version !== 2 || typeof record.seed !== 'string' || fromBase64Url(record.seed).length !== 32
        || (!!record.rootPublicKey !== !!record.certificate)) throw new Error('AGENT_NET_IDENTITY_UNREADABLE');
    } else {
      record = { version: 2, seed: toBase64Url(getRandomBytes(32)) };
      await setSecureItem(key, JSON.stringify(record), { thisDeviceOnly: true }); guard();
    }
    const native = { seed: record.seed, context: slot, deviceId: options.deviceId, udp: false };
    const signer = await MobileAgentNetEngine.create(native, guard);
    let retained = false;
    try {
      const old = record.certificate;
      if (old && (!record.rootPublicKey || !verifyMobileAgentNetCertificate(record.rootPublicKey, old, old.issuedAt)
        || old.subject !== owner.accountId || old.deviceId !== options.deviceId || !old.networkId.startsWith('account:')
        || old.signingKey !== signer.identity.signingKey || old.transportKey !== signer.identity.transportKey)) {
        throw new Error('AGENT_NET_IDENTITY_MISMATCH');
      }
      if (!old || old.expiresAt - Date.now() <= 24 * 60 * 60_000) {
        try {
          const request = { deviceId: options.deviceId, name: options.deviceName.trim().slice(0, 64),
            signingKey: signer.identity.signingKey, transportKey: signer.identity.transportKey };
          const signature = await signer.sign(enrollmentPayload(request));
          const token = await options.getAccessToken(); guard();
          if (!token) throw new Error('AGENT_NET_ACCOUNT_AUTH_REQUIRED');
          const result = await post(base, '/enroll', { ...request, signature }, guard, 'Bearer ' + token) as {
            rootPublicKey?: string; certificate?: DeviceCertificate;
          };
          if (typeof result.rootPublicKey !== 'string' || (record.rootPublicKey && record.rootPublicKey !== result.rootPublicKey)
            || !verifyMobileAgentNetCertificate(result.rootPublicKey, result.certificate)
            || !result.certificate.networkId.startsWith('account:') || result.certificate.subject !== owner.accountId
            || result.certificate.deviceId !== options.deviceId || result.certificate.signingKey !== signer.identity.signingKey
            || result.certificate.transportKey !== signer.identity.transportKey) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
          record = { ...record, rootPublicKey: result.rootPublicKey, certificate: result.certificate };
          await setSecureItem(key, JSON.stringify(record), { thisDeviceOnly: true }); guard();
        } catch (error) {
          guard();
          // Keep the exact stored certificate only while it remains valid;
          // the runtime already retries early renewal on its existing timer.
          if (!old || old.expiresAt <= Date.now() || !enrollmentUnavailable(error)) throw error;
          if (cached?.scope === scope && cached.api.certificate.signature === old.signature) {
            cached.signer.assertCurrent();
            return cached;
          }
        }
      }
      const value = prepared(scope, base, signer, native, record.certificate!, record.rootPublicKey!, guard, false);
      guard(); const previous = cached; cached = value; retained = true;
      modeIdentity = { seed: record.seed, context: slot, deviceId: options.deviceId, guard };
      if (previous && previous !== value) void previous.dispose();
      return value;
    } finally { if (!retained) await signer.destroy(); }
  })();
  inflight.set(scope, work);
  try { return await work; } finally { if (inflight.get(scope) === work) inflight.delete(scope); }
}
