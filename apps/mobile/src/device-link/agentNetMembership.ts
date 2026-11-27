import { ID_PATTERN, KEY_PATTERN, type DeviceCertificate } from '@cindy/agent-net-protocol';
import { verifyMobileAgentNetCertificate } from './agentNetProtocol';
/** Stored beside the existing V1 seed in THIS_DEVICE_ONLY secure storage. */
export interface MobileAgentNetMembership {
  version: 2;
  networkId: string;
  rootPublicKey: string;
  certificate?: DeviceCertificate;
  pending?: { requestId: string; pollToken: string };
}
export function parseMobileAgentNetMembership(value: unknown): MobileAgentNetMembership | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as MobileAgentNetMembership;
  if (entry.version !== 2 || typeof entry.networkId !== 'string' || !ID_PATTERN.test(entry.networkId)
    || !entry.networkId.startsWith('private:') || typeof entry.rootPublicKey !== 'string' || !KEY_PATTERN.test(entry.rootPublicKey)) return undefined;
  if (entry.certificate) {
    if (!verifyMobileAgentNetCertificate(entry.rootPublicKey, entry.certificate) || entry.certificate.networkId !== entry.networkId
      || entry.certificate.role !== 'member') return undefined;
    return { version: 2, networkId: entry.networkId, rootPublicKey: entry.rootPublicKey, certificate: entry.certificate };
  }
  if (entry.pending && typeof entry.pending.requestId === 'string' && ID_PATTERN.test(entry.pending.requestId)
    && typeof entry.pending.pollToken === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(entry.pending.pollToken)) {
    return { version: 2, networkId: entry.networkId, rootPublicKey: entry.rootPublicKey,
      pending: { requestId: entry.pending.requestId, pollToken: entry.pending.pollToken } };
  }
  return undefined;
}
