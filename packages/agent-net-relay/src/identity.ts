import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import {
  CERT_LIFETIME_MS, PRIVATE_MEMBERSHIP_EXPIRES_AT, ID_PATTERN, KEY_PATTERN, MAX_GRANT_LIFETIME_MS,
  certificatePayload, certificatePolicyValid, delegationPayload, delegationPolicyValid, delegationScopeValid, joinPayload, requestPayload,
  type Delegation, type DeviceCertificate, type JoinRequest, type RequestProof,
} from '@cindy/agent-net-protocol';

export interface Identity {
  deviceId: string;
  signingPrivateKey: KeyObject;
  transportPrivateKey: KeyObject;
  signingKey: string;
  transportKey: string;
}
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('base64url');
export const publicBytes = (key: KeyObject): string => createPublicKey(key).export({ format: 'jwk' }).x!;
/** Stable keys across shared-vault readers; the input is a random secret, never a password. */
export function identityFromSeed(context: string, seed: string, deviceId: string): Identity {
  const bytes = Buffer.from(seed, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== seed || !ID_PATTERN.test(deviceId)) throw new Error('INVALID_IDENTITY_SEED');
  const derive = (label: string, prefix: string) => {
    const key = Buffer.from(hkdfSync('sha256', bytes, context, label, 32));
    try { return createPrivateKey({ key: Buffer.concat([Buffer.from(prefix, 'hex'), key]), format: 'der', type: 'pkcs8' }); }
    finally { key.fill(0); }
  };
  try {
    const signingPrivateKey = derive('cindy-agent-net/device-signing/2', '302e020100300506032b657004220420');
    const transportPrivateKey = derive('cindy-agent-net/device-transport/2', '302e020100300506032b656e04220420');
    return { deviceId, signingPrivateKey, transportPrivateKey, signingKey: publicBytes(signingPrivateKey), transportKey: publicBytes(transportPrivateKey) };
  } finally { bytes.fill(0); }
}
export function generateIdentity(deviceId: string = randomUUID()): Identity {
  if (!ID_PATTERN.test(deviceId)) throw new Error('INVALID_DEVICE_ID');
  const signingPrivateKey = generateKeyPairSync('ed25519').privateKey;
  const transportPrivateKey = generateKeyPairSync('x25519').privateKey;
  return { deviceId, signingPrivateKey, transportPrivateKey, signingKey: publicBytes(signingPrivateKey), transportKey: publicBytes(transportPrivateKey) };
}
export const signature = (key: KeyObject, text: string) => sign(null, Buffer.from(text), key).toString('base64url');
export function verifySignature(publicKey: string, text: string, value: string): boolean {
  if (!KEY_PATTERN.test(publicKey) || !/^[A-Za-z0-9_-]{86}$/.test(value)) return false;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    return verify(null, Buffer.from(text), key, Buffer.from(value, 'base64url'));
  } catch { return false; }
}
const id = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);
const key = (value: unknown): value is string => typeof value === 'string' && KEY_PATTERN.test(value) && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function issueCertificate(
  root: KeyObject, input: { networkId: string; subject: string; identity: Pick<Identity, 'deviceId' | 'signingKey' | 'transportKey'>; role: 'owner' | 'member'; now?: number; lifetimeMs?: number },
): DeviceCertificate {
  const issuedAt = input.now ?? Date.now();
  const maximum = input.networkId.startsWith('private:') ? PRIVATE_MEMBERSHIP_EXPIRES_AT - issuedAt : CERT_LIFETIME_MS;
  const lifetime = input.lifetimeMs ?? maximum;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > maximum) throw new Error('INVALID_CERTIFICATE_LIFETIME');
  const unsigned: Omit<DeviceCertificate, 'signature'> = {
    v: 2, networkId: input.networkId, subject: input.subject, deviceId: input.identity.deviceId,
    signingKey: input.identity.signingKey, transportKey: input.identity.transportKey, role: input.role,
    issuedAt, expiresAt: issuedAt + lifetime, serial: randomUUID(),
  };
  const result = { ...unsigned, signature: signature(root, certificatePayload(unsigned)) };
  if (!verifyCertificate(publicBytes(root), result, issuedAt)) throw new Error('INVALID_CERTIFICATE');
  return result;
}
export function verifyCertificate(root: string, value: unknown, now = Date.now()): value is DeviceCertificate {
  return certificatePolicyValid(value, now) && verifySignature(root, certificatePayload(value), value.signature);
}
export function createRequestProof(identity: Pick<Identity, 'signingPrivateKey'>, method: string, path: string, body: string | Uint8Array = '', now = Date.now()): RequestProof {
  const plain = { at: now, nonce: randomBytes(18).toString('base64url') };
  return { ...plain, signature: signature(identity.signingPrivateKey, requestPayload(method, path, sha256(body), plain)) };
}
export function verifyRequestProof(signingKey: string, value: unknown, method: string, path: string, body: string | Uint8Array, now: number): value is RequestProof {
  return verifyRequestDigestProof(signingKey, value, method, path, sha256(body), now);
}
/** Authenticates a declared digest before buffering a bounded binary upload. The receiver must then compare the actual bytes. */
export function verifyRequestDigestProof(signingKey: string, value: unknown, method: string, path: string, digest: string, now: number): value is RequestProof {
  if (!value || typeof value !== 'object') return false;
  const p = value as RequestProof;
  return KEY_PATTERN.test(digest) && time(p.at) && Math.abs(now - p.at) <= 90_000 && typeof p.nonce === 'string' && /^[A-Za-z0-9_-]{24}$/.test(p.nonce)
    && typeof p.signature === 'string' && verifySignature(signingKey, requestPayload(method, path, digest, p), p.signature);
}
export function createJoinRequest(
  identity: Identity, networkId: string, joinCode: string, name: string, pairingSecret: string,
): JoinRequest {
  const plain = { requestId: randomUUID(), networkId, joinCode, name, deviceId: identity.deviceId, signingKey: identity.signingKey, transportKey: identity.transportKey };
  return { ...plain, signature: signature(identity.signingPrivateKey, joinPayload(plain)), pairingProof: createHmac('sha256', pairingSecret).update(joinPayload(plain)).digest('base64url') };
}
export function verifyJoinRequest(value: unknown): value is JoinRequest {
  if (!value || typeof value !== 'object') return false;
  const r = value as JoinRequest;
  return id(r.requestId) && id(r.networkId) && typeof r.joinCode === 'string' && /^[A-Za-z0-9_-]{32}$/.test(r.joinCode)
    && id(r.deviceId) && key(r.signingKey) && key(r.transportKey)
    && typeof r.name === 'string' && r.name.trim().length > 0 && r.name.length <= 64
    && typeof r.pairingProof === 'string' && KEY_PATTERN.test(r.pairingProof)
    && typeof r.signature === 'string' && verifySignature(r.signingKey, joinPayload(r), r.signature);
}
export function approveJoin(root: KeyObject, request: JoinRequest, secret: string, subject: string): DeviceCertificate {
  if (!verifyJoinPairingProof(request, secret)) throw new Error('PAIRING_PROOF_INVALID');
  return issueCertificate(root, { networkId: request.networkId, subject, identity: {
    deviceId: request.deviceId, signingKey: request.signingKey, transportKey: request.transportKey,
  }, role: 'member' });
}
export function verifyJoinPairingProof(request: JoinRequest, secret: string): boolean {
  if (!verifyJoinRequest(request)) return false;
  const expected = createHmac('sha256', secret).update(joinPayload(request)).digest();
  const received = Buffer.from(request.pairingProof, 'base64url');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
export function createDelegation(
  identity: Identity, issuerCertificate: DeviceCertificate,
  input: { kind: Delegation['kind']; resourceId: string; guest: Pick<Identity, 'deviceId' | 'signingKey' | 'transportKey'>;
    scope?: Delegation['scope']; id?: string; lifetimeMs?: number; now?: number },
): Delegation {
  if (input.id !== undefined && !/^[a-f0-9-]{36}$/.test(input.id)) throw new Error('INVALID_DELEGATION_ID');
  const issuedAt = input.now ?? Date.now();
  const unsigned: Omit<Delegation, 'signature'> = {
    v: 2, id: input.id ?? randomUUID(), kind: input.kind, resourceId: input.resourceId, networkId: issuerCertificate.networkId,
    hostDeviceId: issuerCertificate.deviceId, guestDeviceId: input.guest.deviceId,
    guestSigningKey: input.guest.signingKey, guestTransportKey: input.guest.transportKey,
    issuedAt, expiresAt: issuedAt + Math.min(input.lifetimeMs ?? MAX_GRANT_LIFETIME_MS, MAX_GRANT_LIFETIME_MS),
    issuerCertificate,
    ...(input.scope ? { scope: input.scope } : {}),
  };
  if (input.scope && !delegationScopeValid(input.scope)) throw new Error('INVALID_DELEGATION_SCOPE');
  return { ...unsigned, signature: signature(identity.signingPrivateKey, delegationPayload(unsigned)) };
}
export function verifyDelegation(root: string, value: unknown, now = Date.now()): value is Delegation {
  return delegationPolicyValid(value, now) && verifyCertificate(root, value.issuerCertificate, now)
    && (value.executors?.every(e => verifyCertificate(root, e.certificate, value.issuedAt)) ?? true)
    && verifySignature(value.issuerCertificate.signingKey, delegationPayload(value), value.signature);
}
