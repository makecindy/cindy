/** V2 control-plane contract. Business payloads remain end-to-end encrypted datagrams. */
export const AGENT_NET_VERSION = 2;
export * from './sharingOrigins.js';
export const API = '/api/agent-net';
export const MAX_FRAME_BYTES = 64 * 1024;
/** A directory contains signed device certificates; it is larger than a datagram batch. */
export const MAX_CONTROL_BYTES = 1024 * 1024;
/** Preserve V1's 2 GiB attachment allowance, plus space for the encrypted envelope. */
export const MAX_MEDIA_OBJECT_BYTES = 2 * 1024 * 1024 * 1024 + MAX_FRAME_BYTES;
/** Binary HTTP uploads are bounded independently of small signed JSON controls. */
export const MAX_MEDIA_BINARY_CHUNK_BYTES = 8 * 1024 * 1024;
export const MEDIA_PLAINTEXT_CHUNK_BYTES = 1024 * 1024;
export const MEDIA_ENCRYPTED_HEADER_BYTES = 221;
/**
 * Direct media transfer: the relay authorizes every storage request and the ciphertext goes to the storage itself.
 * A client offers it when it creates an upload (`transfer` in the request body) and when it reads (request header);
 * a relay that stores the object where clients can reach it answers with presigned storage requests, any other
 * relay ignores both and moves the bytes itself, as before.
 */
export const MEDIA_TRANSFER_DIRECT = 'direct-v1';
export const MEDIA_TRANSFER_HEADER = 'x-agent-net-media-transfer';
/** One presigned storage request. `headers` are part of the signature and must be sent exactly as given. */
export interface DirectMediaRequest { method: 'GET' | 'PUT' | 'POST'; url: string; headers: Record<string, string>; expiresAt: number }
export function directMediaRequestValid(value: unknown): value is DirectMediaRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  if (!['GET', 'PUT', 'POST'].includes(request.method as string) || typeof request.url !== 'string' || request.url.length > 4096
    || !Number.isSafeInteger(request.expiresAt) || !request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers)) return false;
  const headers = Object.entries(request.headers as Record<string, unknown>);
  if (headers.length > 16 || !headers.every(([name, header]) => /^[A-Za-z0-9-]{1,64}$/.test(name) && typeof header === 'string' && header.length <= 1024
    && !/[\r\n]/.test(header) && !['authorization', 'cookie', 'host'].includes(name.toLowerCase()))) return false;
  try {
    const url = new URL(request.url);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !url.hash;
  } catch { return false; }
}
export interface AgentNetMediaKey { slot: string; networkId: string; grantId?: string; id: string; headerSha256: string; contentType: string;
  sharedTask?: { sharedTaskId: string; deviceId: string } }
export function agentNetMediaBinding(slot: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(slot)) throw new Error('INVALID_MEDIA_SCOPE');
  return 'cindy-agent-net/media-scope/3/' + slot;
}
export function isAgentNetMediaReference(key: string): boolean {
  return key.startsWith('agent-net-v3/') || /^cindy\/device-link\/shared-task\/[^/]+\/[^/]+\/an3-/.test(key);
}
export function buildAgentNetMediaKey(value: AgentNetMediaKey): string {
  let key = `agent-net-v3/${value.slot}/${encodeURIComponent(value.networkId)}/${value.grantId ?? '-'}/${value.id}/${value.headerSha256}/${encodeURIComponent(value.contentType)}`;
  if (value.sharedTask) {
    const { sharedTaskId, deviceId } = value.sharedTask;
    if (![sharedTaskId, deviceId].every(id => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) throw new Error('INVALID_MEDIA_SCOPE');
    // Reuse the existing task-owned attachment namespace. The opaque ASCII
    // receipt is hex, so a path segment needs no codec/polyfill on Hermes.
    const receipt = Array.from(key, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    key = `cindy/device-link/shared-task/${sharedTaskId}/${deviceId}/an3-${receipt}`;
  }
  if (!parseAgentNetMediaKey(key)) throw new Error('INVALID_MEDIA_KEY'); return key;
}
export function parseAgentNetMediaKey(key: string): AgentNetMediaKey | null {
  if (key.length > 4096) return null;
  let sharedTask: AgentNetMediaKey['sharedTask'];
  const scoped = /^cindy\/device-link\/shared-task\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/an3-((?:[0-9a-f]{2})+)$/.exec(key);
  if (scoped) {
    const bytes = scoped[3].match(/../g)!.map(pair => parseInt(pair, 16));
    if (bytes.some(value => value < 0x21 || value > 0x7e)) return null;
    key = String.fromCharCode(...bytes); sharedTask = { sharedTaskId: scoped[1], deviceId: scoped[2] };
  }
  const match = /^agent-net-v3\/([0-9a-f-]{36})\/([^/]{1,384})\/(-|[0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f]{64})\/([^/]{1,512})$/.exec(key);
  if (!match) return null;
  try {
    const contentType = decodeURIComponent(match[6]), networkId = decodeURIComponent(match[2]);
    if (!ID_PATTERN.test(networkId)) return null;
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/.test(contentType) || contentType.length > 128) return null;
    return { slot: match[1], networkId, ...(match[3] !== '-' ? { grantId: match[3] } : {}), id: match[4], headerSha256: match[5], contentType,
      ...(sharedTask ? { sharedTask } : {}) };
  } catch { return null; }
}
export const MEDIA_NETWORK_QUOTA_BYTES = 8 * 1024 * 1024 * 1024;
export const CERT_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
/** Owner-paired private networks retain V1 membership until explicit revocation. */
export const PRIVATE_MEMBERSHIP_EXPIRES_AT = Number.MAX_SAFE_INTEGER;
export const MAX_GRANT_LIFETIME_MS = 30 * 60 * 1000;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
export const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export type Role = 'owner' | 'member';
export type GrantKind = 'provider-share' | 'shared-task';

export interface DeviceCertificate {
  v: 2;
  networkId: string;
  subject: string;
  deviceId: string;
  signingKey: string;
  transportKey: string;
  role: Role;
  issuedAt: number;
  expiresAt: number;
  serial: string;
  signature: string;
}
export interface RequestProof {
  at: number;
  nonce: string;
  signature: string;
}
export interface MemberAuthorization {
  certificate: DeviceCertificate;
  proof: RequestProof;
}
export interface GuestAuthorization {
  delegation: Delegation;
  proof: RequestProof;
}
/** A provider/task host delegates only its own endpoint to the holder of this signing key. */
export interface Delegation {
  v: 2;
  id: string;
  kind: GrantKind;
  networkId: string;
  hostDeviceId: string;
  resourceId: string;
  guestDeviceId: string;
  guestSigningKey: string;
  guestTransportKey: string;
  issuedAt: number;
  expiresAt: number;
  issuerCertificate: DeviceCertificate;
  /** App-scoped authorization, signed by the host. Absence keeps the original datagram-only contract. */
  scope?: DelegationScope;
  /** O endorses exact same-account executor certificates for this guest only. */
  executors?: DelegatedExecutor[];
  signature: string;
}
export interface DelegatedExecutor { generation: string; certificate: DeviceCertificate; expiresAt: number; }
export function delegationPrincipalMatches(a: Delegation, b: Delegation): boolean {
  return a.id === b.id && a.kind === b.kind && a.networkId === b.networkId && a.resourceId === b.resourceId
    && a.hostDeviceId === b.hostDeviceId && a.guestDeviceId === b.guestDeviceId && a.guestSigningKey === b.guestSigningKey
    && a.guestTransportKey === b.guestTransportKey && a.issuerCertificate.signingKey === b.issuerCertificate.signingKey
    && a.issuerCertificate.transportKey === b.issuerCertificate.transportKey && a.scope?.memberId === b.scope?.memberId
    && a.scope?.guestSubject === b.scope?.guestSubject && a.scope?.memberVersion === b.scope?.memberVersion;
}
export function delegationEndpointCertificate(d: Delegation, deviceId: string, now = Date.now()): DeviceCertificate | undefined {
  if (deviceId === d.hostDeviceId) return d.issuerCertificate;
  return d.executors?.find(e => e.certificate.deviceId === deviceId && e.expiresAt > now)?.certificate;
}
export function delegationVisibleTo(d: Delegation, identity: { deviceId: string; signingKey: string; transportKey: string }, own?: Delegation): boolean {
  if (own) return delegationPrincipalMatches(d, own) && d.guestDeviceId === identity.deviceId
    && d.guestSigningKey === identity.signingKey && d.guestTransportKey === identity.transportKey;
  const endpoint = delegationEndpointCertificate(d, identity.deviceId);
  return endpoint?.signingKey === identity.signingKey && endpoint.transportKey === identity.transportKey;
}
export interface DelegationScope {
  memberId: string;
  guestSubject: string;
  memberVersion: number;
}
/** Public CSR admitted by the resource's account membership. Only the physical
 * resource host may turn it into a signed transport delegation. */
export interface DelegationRequest {
  id: string;
  kind: GrantKind;
  networkId: string;
  hostDeviceId: string;
  resourceId: string;
  guestDeviceId: string;
  guestSigningKey: string;
  guestTransportKey: string;
  scope: DelegationScope;
  requestedAt: number;
  expiresAt: number;
}
export function delegationRequestPolicyValid(value: unknown, host: Pick<DeviceCertificate, 'deviceId' | 'networkId'>, now = Date.now()): value is DelegationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as DelegationRequest;
  const id = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);
  const key = (v: unknown): v is string => typeof v === 'string' && KEY_PATTERN.test(v) && /[AEIMQUYcgkosw048]$/.test(v);
  return Object.keys(r).length === 11 && id(r.id) && (r.kind === 'shared-task' || r.kind === 'provider-share')
    && r.hostDeviceId === host.deviceId && r.networkId === host.networkId && id(r.resourceId) && id(r.guestDeviceId)
    && key(r.guestSigningKey) && key(r.guestTransportKey) && delegationScopeValid(r.scope)
    && Number.isSafeInteger(r.requestedAt) && r.requestedAt >= 0 && r.requestedAt <= now + 30_000
    && Number.isSafeInteger(r.expiresAt) && r.expiresAt > now && r.expiresAt > r.requestedAt
    && r.expiresAt - r.requestedAt <= MAX_GRANT_LIFETIME_MS;
}
export function delegationScopeValid(value: unknown): value is DelegationScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as DelegationScope;
  return Object.keys(s).length === 3 && typeof s.memberId === 'string' && ID_PATTERN.test(s.memberId)
    && typeof s.guestSubject === 'string' && ID_PATTERN.test(s.guestSubject)
    && Number.isSafeInteger(s.memberVersion) && s.memberVersion >= 1;
}
export interface JoinRequest {
  requestId: string;
  joinCode: string;
  networkId: string;
  deviceId: string;
  name: string;
  signingKey: string;
  transportKey: string;
  signature: string;
  /** HMAC made with the out-of-band pairing secret. The owner verifies it before approving. */
  pairingProof: string;
}
export interface EnrollmentRequest {
  deviceId: string;
  signingKey: string;
  transportKey: string;
  name: string;
  signature: string;
}
export function enrollmentPayload(r: Omit<EnrollmentRequest, 'signature'>): string {
  return JSON.stringify(['cindy-agent-net/enroll/2', r.deviceId, r.signingKey, r.transportKey, r.name]);
}
export interface TransportModeProof {
  v: 2; deviceId: string; to: string; requestId: string; enabled: boolean; at: number; signature: string;
}
export function transportModePayload(p: Omit<TransportModeProof, 'signature'>): string {
  return JSON.stringify(['cindy-agent-net/transport-mode/2', p.v, p.deviceId, p.to, p.requestId, p.enabled, p.at]);
}
/** Self-reported App/platform labels are for presentation and routing, never authorization. */
export interface DeviceMetadata { platform?: string; app?: string; appVersion?: string; busy?: boolean; deviceName?: string; }
export interface DeviceView extends DeviceMetadata {
  certificate: DeviceCertificate;
  name: string;
  selfName?: string;
  online: boolean;
  remoteControlEnabled: boolean;
  capabilities: string[];
  lastSeenAt?: number;
  /** Device-signed independent notification key; never the Noise identity key. */
  notificationKey?: NotificationKeyBinding;
}
export interface RelayInfo {
  protocolVersion: 2;
  mode: 'official' | 'self-hosted';
  /** STUN port of the relay's UDP listener; null when UDP is disabled. */
  udpPort: number | null;
  /** Host that serves `udpPort` when UDP is published apart from the HTTPS host (for example a separate L4 load balancer). */
  stunHost?: string;
  features: string[];
}
const STUN_HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** A DNS name or IPv4 literal only: no port, path, userinfo or IPv6 literal (clients resolve STUN over IPv4). */
export function isAgentNetStunHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  const labels = value.split('.');
  if (!labels.every(label => STUN_HOST_LABEL.test(label))) return false;
  if (!labels.every(label => /^\d+$/.test(label))) return true;
  return labels.length === 4 && labels.every(label => Number(label) <= 255 && (label === '0' || !label.startsWith('0')));
}
/** `host:port` to query for STUN from an `/info` body: its `stunHost`, else the API host (relays without one). */
export function agentNetStunServer(apiBase: string, info: unknown): string | null {
  if (!info || typeof info !== 'object') return null;
  const { udpPort, stunHost } = info as { udpPort?: unknown; stunHost?: unknown };
  if (typeof udpPort !== 'number' || !Number.isInteger(udpPort) || udpPort < 1 || udpPort > 65_535) return null;
  if (isAgentNetStunHost(stunHost)) return stunHost + ':' + udpPort;
  try { return new URL(apiBase).hostname + ':' + udpPort; } catch { return null; }
}
export interface PushRegistration {
  token: string;
  provider: 'apns' | 'fcm' | 'bridge';
  appVariant: 'cn' | 'global';
  apnsEnv: 'prod' | 'sandbox' | null;
  notificationKey?: NotificationKeyBinding;
}
export interface NotificationKeyBinding {
  v: 2;
  networkId: string;
  deviceId: string;
  encryptionKey: string;
  signature: string;
}
export function notificationKeyPayload(k: Omit<NotificationKeyBinding, 'signature'>): string {
  return JSON.stringify(['cindy-agent-net/notification-key/2', k.v, k.networkId, k.deviceId, k.encryptionKey]);
}
/** Signed bytes are carried verbatim, avoiding platform-dependent JSON canonicalization. */
export function notificationPayload(networkId: string, from: string, to: string, id: string, at: number, payload: unknown): string {
  return JSON.stringify(['cindy-agent-net/notification/2', 2, networkId, from, to, id, at, at + 5 * 60_000, payload]);
}
export function certificatePayload(c: Omit<DeviceCertificate, 'signature'>): string {
  return JSON.stringify(['cindy-agent-net/certificate/2', c.v, c.networkId, c.subject,
    c.deviceId, c.signingKey, c.transportKey, c.role, c.issuedAt, c.expiresAt, c.serial]);
}
/** Shared shape/lifetime policy; hosts supply their platform's Ed25519 verifier. */
export function certificatePolicyValid(value: unknown, now = Date.now()): value is DeviceCertificate {
  if (!value || typeof value !== 'object') return false;
  const c = value as DeviceCertificate;
  const id = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);
  const key = (v: unknown): v is string => typeof v === 'string' && KEY_PATTERN.test(v) && /[AEIMQUYcgkosw048]$/.test(v);
  const time = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
  return Object.keys(c).length === 11 && c.v === 2 && id(c.networkId) && id(c.subject) && id(c.deviceId) && id(c.serial)
    && key(c.signingKey) && key(c.transportKey) && ['owner', 'member'].includes(c.role)
    && time(c.issuedAt) && time(c.expiresAt) && c.issuedAt <= now + 30_000 && c.expiresAt > now
    && c.expiresAt > c.issuedAt && (c.networkId.startsWith('private:') || c.expiresAt - c.issuedAt <= CERT_LIFETIME_MS)
    && typeof c.signature === 'string';
}
export function delegationPayload(d: Omit<Delegation, 'signature'>): string {
  return JSON.stringify(['cindy-agent-net/delegation/2', d.v, d.id, d.kind, d.networkId,
    d.hostDeviceId, d.resourceId, d.guestDeviceId, d.guestSigningKey, d.guestTransportKey,
    d.issuedAt, d.expiresAt, d.issuerCertificate, ...(d.scope === undefined ? [] : [[d.scope.memberId, d.scope.guestSubject, d.scope.memberVersion]]),
    ...(d.executors === undefined ? [] : [d.executors.map(e => [e.generation, e.certificate, e.expiresAt])])]);
}
export function sharingIdentityPayload(networkId: string, rootPublicKey: string, deviceId: string, signingKey: string): string {
  return JSON.stringify(['cindy-agent-net/sharing-identity/2', networkId, rootPublicKey, deviceId, signingKey]);
}
/** Compact guest proof is still bound to its exact network/grant, including
 * media bytes. The signed delegation is read from the pinned relay directory. */
export function guestRequestPath(path: string, networkId: string, delegationId: string): string {
  return JSON.stringify(['cindy-agent-net/guest-request/2', path, networkId, delegationId]);
}
/** Shared delegation policy; hosts authenticate the root and host signatures. */
export function delegationPolicyValid(value: unknown, now = Date.now()): value is Delegation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Delegation;
  const id = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);
  const key = (v: unknown): v is string => typeof v === 'string' && KEY_PATTERN.test(v) && /[AEIMQUYcgkosw048]$/.test(v);
  return d.v === 2 && id(d.id) && (d.kind === 'provider-share' || d.kind === 'shared-task')
    && id(d.resourceId) && id(d.guestDeviceId) && key(d.guestSigningKey) && key(d.guestTransportKey)
    && (d.scope === undefined || delegationScopeValid(d.scope))
    && (d.executors === undefined || d.kind === 'provider-share' && !!d.scope && Array.isArray(d.executors) && d.executors.length <= 32
      && new Set(d.executors.map(e => e?.certificate?.deviceId)).size === d.executors.length
      && d.executors.every(e => e && id(e.generation) && certificatePolicyValid(e.certificate, d.issuedAt)
        && e.certificate.networkId === d.networkId && e.certificate.subject === d.issuerCertificate?.subject
        && e.certificate.deviceId !== d.hostDeviceId && Number.isSafeInteger(e.expiresAt) && e.expiresAt > d.issuedAt
        && e.expiresAt <= d.expiresAt && e.expiresAt <= e.certificate.expiresAt))
    && Number.isSafeInteger(d.issuedAt) && d.issuedAt >= 0 && Number.isSafeInteger(d.expiresAt)
    && d.issuedAt <= now + 30_000 && d.expiresAt > now && d.expiresAt > d.issuedAt
    && d.expiresAt - d.issuedAt <= MAX_GRANT_LIFETIME_MS
    && certificatePolicyValid(d.issuerCertificate, now) && d.issuerCertificate.networkId === d.networkId
    && d.issuerCertificate.deviceId === d.hostDeviceId && typeof d.signature === 'string';
}
export function joinPayload(r: Omit<JoinRequest, 'signature' | 'pairingProof'>): string {
  return JSON.stringify(['cindy-agent-net/join/2', r.requestId, r.joinCode, r.networkId,
    r.deviceId, r.name, r.signingKey, r.transportKey]);
}
export function requestPayload(method: string, path: string, bodyHash: string, p: Omit<RequestProof, 'signature'>): string {
  return JSON.stringify(['cindy-agent-net/request/2', method.toUpperCase(), path, bodyHash, p.at, p.nonce]);
}

/** Same framing on official, user-deployed and embedded relays; source is rewritten by the relay. */
export function encodeDatagrams(deviceId: string, datagrams: readonly Uint8Array[]): Uint8Array {
  // IDs are ASCII by contract; Hermes does not require a text-codec polyfill.
  if (!ID_PATTERN.test(deviceId)) throw new Error('INVALID_DATAGRAM_FRAME');
  const id = Uint8Array.from(deviceId, character => character.charCodeAt(0));
  if (!ID_PATTERN.test(deviceId) || id.length > 255 || datagrams.length === 0) throw new Error('INVALID_DATAGRAM_FRAME');
  let size = 2 + id.length;
  for (const packet of datagrams) {
    if (packet.length === 0 || packet.length > 65507) throw new Error('INVALID_DATAGRAM_FRAME');
    size += 2 + packet.length;
  }
  if (size > MAX_FRAME_BYTES) throw new Error('INVALID_DATAGRAM_FRAME');
  const frame = new Uint8Array(size);
  frame[0] = 1;
  frame[1] = id.length;
  frame.set(id, 2);
  let at = 2 + id.length;
  for (const packet of datagrams) {
    frame[at++] = packet.length >>> 8;
    frame[at++] = packet.length & 255;
    frame.set(packet, at);
    at += packet.length;
  }
  return frame;
}
export function decodeDatagrams(frame: Uint8Array): { deviceId: string; datagrams: Uint8Array[] } | null {
  if (frame.length < 5 || frame.length > MAX_FRAME_BYTES || frame[0] !== 1 || frame[1] === 0) return null;
  let at = 2 + frame[1];
  if (at >= frame.length) return null;
  const encodedId = frame.subarray(2, at);
  if (encodedId.some(byte => byte > 127)) return null;
  const deviceId = String.fromCharCode(...encodedId);
  if (!ID_PATTERN.test(deviceId)) return null;
  const datagrams: Uint8Array[] = [];
  while (at < frame.length) {
    if (at + 2 > frame.length) return null;
    const length = frame[at] * 256 + frame[at + 1];
    at += 2;
    if (length === 0 || length > 65507 || at + length > frame.length) return null;
    datagrams.push(frame.subarray(at, at + length));
    at += length;
  }
  return datagrams.length ? { deviceId, datagrams } : null;
}
