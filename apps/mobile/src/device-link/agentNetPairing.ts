import { randomUUID } from 'expo-crypto';
import { joinPayload, type JoinRequest } from '@cindy/agent-net-protocol';
import type { RelayJoinLink } from '@cindy/device-link';
import { toBase64Url, utf8 } from '@cindy/agent-net/portable';
import { isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import { MobileAgentNetEngine } from './agentNetNative';
import type { MobileAgentNetMembership } from './agentNetMembership';
import { mobileRelayAuthCrypto } from './relayAuthCrypto';

/** Native-capable phones submit the same additional CSR as Desktop. The
 * public certificate can be fetched later; the one-shot V1 credential is saved
 * without waiting for an additional network request after owner approval. */
export async function prepareMobileAgentNetPairing(input: {
  owner: MobileAuthOwnerGeneration; link: RelayJoinLink; relayId: string; deviceId: string;
  seed: string; signingKey: string; name: string; signal: AbortSignal;
}): Promise<MobileAgentNetMembership | undefined> {
  if (!input.link.agentNetCode || !MobileAgentNetEngine.available()) return undefined;
  const guard = () => {
    if (!isMobileAuthOwnerCurrent(input.owner)) throw new Error('AGENT_NET_OWNER_CHANGED');
    if (input.signal.aborted) throw new Error('AGENT_NET_PAIRING_CANCELLED');
  };
  guard();
  const engine = await MobileAgentNetEngine.create({ seed: input.seed, context: input.relayId,
    deviceId: input.deviceId, legacySigning: true, udp: false }, guard);
  try {
    if (engine.identity.signingKey !== input.signingKey) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
    const plain = { requestId: randomUUID(), joinCode: input.link.agentNetCode, networkId: 'private:' + input.relayId,
      deviceId: input.deviceId, name: input.name.trim().slice(0, 64), signingKey: engine.identity.signingKey,
      transportKey: engine.identity.transportKey };
    const payload = joinPayload(plain);
    const request: JoinRequest = { ...plain, signature: await engine.sign(payload),
      pairingProof: toBase64Url(mobileRelayAuthCrypto.hmacSha256(utf8(input.link.pairSecret), utf8(payload))) };
    guard();
    const controller = new AbortController(), abort = () => controller.abort();
    const timer = setTimeout(abort, 12_000);
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      guard();
      const response = await fetch(input.link.baseUrl + '/api/agent-net/join', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
        redirect: 'error', signal: controller.signal,
      });
      guard();
      const result = await response.json() as { requestId?: unknown; pollToken?: unknown };
      guard();
      if (!response.ok || result.requestId !== plain.requestId || typeof result.pollToken !== 'string'
        || !/^[A-Za-z0-9_-]{32,128}$/.test(result.pollToken)) throw new Error('AGENT_NET_PAIRING_FAILED');
      return { version: 2, networkId: plain.networkId, rootPublicKey: input.link.ownerPublicKey,
        pending: { requestId: plain.requestId, pollToken: result.pollToken } };
    } finally { clearTimeout(timer); input.signal.removeEventListener('abort', abort); }
  } finally { await engine.destroy(); }
}
