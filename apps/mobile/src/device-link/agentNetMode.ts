import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { transportModePayload, type DeviceCertificate, type TransportModeProof } from '@cindy/agent-net-protocol';
import { fromBase64Url, toBase64Url, utf8 } from '@cindy/agent-net/portable';
import { getActiveSelfHostedRelay } from './selfHostedRelayRouting';
import { currentMobileAgentNetIdentity, currentMobileAgentNetModeIdentity } from './agentNetIdentity';
import { getMobileAgentNetPreferences } from './agentNetPreferences';
import { MobileAgentNetEngine } from './agentNetNative';
import { mobileRelayAuthCrypto } from './relayAuthCrypto';
import { getOfficialAgentNetApiBaseUrl } from '@/config/env';

export function mobileAgentNetTransportProof(peer: string, requestId: string): unknown {
  const preferences = getMobileAgentNetPreferences(), route = getActiveSelfHostedRelay();
  const cached = currentMobileAgentNetIdentity();
  let key: Uint8Array | null = null;
  try {
    let deviceId: string;
    if (route?.signing?.agentNet) {
      key = fromBase64Url(route.signing.seed); deviceId = route.signing.deviceId;
    } else if (!route && (cached || currentMobileAgentNetModeIdentity())) {
      const existing = currentMobileAgentNetModeIdentity();
      const seed = cached?.seed ?? existing!.seed, context = cached?.context ?? existing!.context;
      key = hkdf(sha256, fromBase64Url(seed), utf8(context), utf8('cindy-agent-net/device-signing/2'), 32);
      deviceId = cached?.api.identity.deviceId ?? existing!.deviceId;
    } else return undefined;
    const plain = { v: 2 as const, deviceId, to: peer, requestId,
      enabled: preferences.ready && preferences.enabled && MobileAgentNetEngine.available()
        && (route ? !!route.signing?.agentNet : !!getOfficialAgentNetApiBaseUrl()), at: Date.now() };
    return { ...plain, signature: toBase64Url(mobileRelayAuthCrypto.ed25519Sign(key, utf8(transportModePayload(plain)))) };
  } catch { return undefined; } finally { key?.fill(0); }
}
export function verifyMobileAgentNetModeProof(certificate: DeviceCertificate, localDeviceId: string,
  requestId: string, value: unknown): value is TransportModeProof {
  if (!value || typeof value !== 'object') return false;
  const proof = value as TransportModeProof;
  if (Object.keys(proof).length !== 7 || proof.v !== 2 || proof.deviceId !== certificate.deviceId
    || proof.to !== localDeviceId || proof.requestId !== requestId || typeof proof.enabled !== 'boolean'
    || !Number.isSafeInteger(proof.at) || Math.abs(Date.now() - proof.at) > 90_000 || typeof proof.signature !== 'string') return false;
  try { return mobileRelayAuthCrypto.ed25519Verify(fromBase64Url(certificate.signingKey),
    utf8(transportModePayload(proof)), fromBase64Url(proof.signature)); } catch { return false; }
}
