/** Additive HTTPS identity directory contract, mirrored in device-link-server.
 * These parsers validate structure/scope only. Native code must fetch from the
 * trusted directory, verify JWK thumbprints and private-key possession itself.
 */
export const DEVICE_IDENTITY_PATH = "/api/device-link/identities";
export interface DeviceIdentityPublicKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}
export interface RegisteredDeviceIdentity {
  id: string;
  userId: string;
  thumbprint: string;
  publicKey: DeviceIdentityPublicKey;
  createdAt: string;
  revokedAt: string | null;
}
export interface DeviceIdentityChallenge {
  version: 1;
  challengeId: string;
  membershipId: string;
  thumbprint: string;
  expiresAt: number;
  /** Sign decoded bytes in Native; never reserialize the transcript in JS. */
  message: string;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Exactly 32 decoded bytes, canonical unpadded base64url (last two bits zero).
const digest = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_DEVICE_IDENTITY");
  return value as Record<string, unknown>;
};
function date(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
export function parseDeviceIdentityPublicKey(
  value: unknown,
): DeviceIdentityPublicKey {
  const v = object(value);
  if (
    Object.keys(v).some((key) => !["kty", "crv", "x", "y"].includes(key)) ||
    v.kty !== "EC" ||
    v.crv !== "P-256" ||
    typeof v.x !== "string" ||
    typeof v.y !== "string" ||
    !digest.test(v.x) ||
    !digest.test(v.y)
  )
    throw new Error("INVALID_DEVICE_IDENTITY");
  return { kty: "EC", crv: "P-256", x: v.x, y: v.y };
}
export function parseRegisteredDeviceIdentity(
  value: unknown,
  membershipId: string,
  targetId: string,
): RegisteredDeviceIdentity {
  const v = object(value);
  if (
    !membershipId ||
    typeof v.id !== "string" ||
    !uuid.test(v.id) ||
    v.id !== targetId ||
    v.userId !== membershipId ||
    typeof v.thumbprint !== "string" ||
    !digest.test(v.thumbprint) ||
    !date(v.createdAt) ||
    (v.revokedAt !== null && !date(v.revokedAt))
  )
    throw new Error("INVALID_DEVICE_IDENTITY");
  return {
    id: v.id,
    userId: membershipId,
    thumbprint: v.thumbprint,
    publicKey: parseDeviceIdentityPublicKey(v.publicKey),
    createdAt: v.createdAt,
    revokedAt: v.revokedAt,
  };
}
export function parseDeviceIdentityChallenge(
  value: unknown,
  membershipId: string,
  thumbprint: string,
  now: number,
): DeviceIdentityChallenge {
  const v = object(value);
  if (
    !membershipId ||
    !Number.isFinite(now) ||
    v.version !== 1 ||
    typeof v.challengeId !== "string" ||
    !uuid.test(v.challengeId) ||
    v.membershipId !== membershipId ||
    !digest.test(thumbprint) ||
    v.thumbprint !== thumbprint ||
    typeof v.expiresAt !== "number" ||
    !Number.isSafeInteger(v.expiresAt) ||
    v.expiresAt <= now ||
    v.expiresAt > now + 120_000 ||
    typeof v.message !== "string" ||
    v.message.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/.test(v.message)
  )
    throw new Error("INVALID_DEVICE_IDENTITY_CHALLENGE");
  return {
    version: 1,
    challengeId: v.challengeId,
    membershipId,
    thumbprint,
    expiresAt: v.expiresAt,
    message: v.message,
  };
}
