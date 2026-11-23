import { certificatePayload, certificatePolicyValid, delegationPayload, delegationPolicyValid, type Delegation, type DeviceCertificate } from '@cindy/agent-net-protocol';
import { fromBase64Url, utf8 } from '@cindy/agent-net/portable';
import { mobileRelayAuthCrypto, rememberVerifiedSignature } from './relayAuthCrypto';
export function verifyMobileAgentNetSignature(key: string, payload: string, signature: string): boolean {
  try { return mobileRelayAuthCrypto.ed25519Verify(fromBase64Url(key), utf8(payload), fromBase64Url(signature)); }
  catch { return false; }
}

/** Shares the exact shape/lifetime policy and canonical payload with the server. */
export function verifyMobileAgentNetCertificate(root: string, value: unknown, now = Date.now()): value is DeviceCertificate {
  if (!certificatePolicyValid(value, now)) return false;
  try {
    return mobileRelayAuthCrypto.ed25519Verify(fromBase64Url(root), utf8(certificatePayload(value)), fromBase64Url(value.signature));
  } catch { return false; }
}
/**
 * A certificate from this device's own roster cache, whose record just proved intact (agentNetDirectoryCache.ts): the same
 * shape and lifetime policy as above, and its signature, verified before the record was written, is recorded as verified
 * instead of being verified again. See `rememberVerifiedSignature` for when that is allowed.
 */
export function restoreVerifiedMobileAgentNetCertificate(root: string, value: unknown, now = Date.now()): value is DeviceCertificate {
  if (!certificatePolicyValid(value, now)) return false;
  try { return rememberVerifiedSignature(fromBase64Url(root), utf8(certificatePayload(value)), fromBase64Url(value.signature)); }
  catch { return false; }
}
export function verifyMobileAgentNetDelegation(root: string, value: unknown, now = Date.now()): value is Delegation {
  if (!delegationPolicyValid(value, now) || !verifyMobileAgentNetCertificate(root, value.issuerCertificate, now)
    || value.executors?.some(e => !verifyMobileAgentNetCertificate(root, e.certificate, value.issuedAt))) return false;
  try {
    return mobileRelayAuthCrypto.ed25519Verify(fromBase64Url(value.issuerCertificate.signingKey),
      utf8(delegationPayload(value)), fromBase64Url(value.signature));
  } catch { return false; }
}
