import { randomUUID } from 'expo-crypto';
import { joinPayload, type DeviceCertificate, type JoinRequest } from '@cindy/agent-net-protocol';
import { RelayJoinError, relayPairingVerifyCode, type RelayJoinLink } from '@cindy/device-link';
import { toBase64Url, utf8 } from '@cindy/agent-net/portable';
import { isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import { MobileAgentNetEngine } from './agentNetNative';
import type { MobileAgentNetMembership } from './agentNetMembership';
import { verifyMobileAgentNetCertificate } from './agentNetProtocol';
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

const JOIN_POLL_MS = 2_000;
const JOIN_WAIT_MS = 10 * 60_000;

async function postAgentNet(base: string, resource: string, body: unknown, signal: AbortSignal): Promise<{ status: number; value: unknown }> {
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, 12_000);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(base + '/api/agent-net' + resource, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: controller.signal,
    });
    return { status: response.status, value: await response.json().catch(() => null) };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

function errorCode(value: unknown): string | null {
  const code = (value as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * 加入只走 V2 的网络(别人分享给本账号、由本账号电脑建的那个,self-hosted-relay-plan.md §5.5):
 * 没有旧版凭证,只提交 V2 申请;等那台电脑放行后直接拿到证书。证书必须出自链接里的根公钥、签给本账号
 * 和本机这两把密钥,否则中转可能被人替换,不加入。
 */
export async function joinMobileAgentNetNetwork(input: {
  owner: MobileAuthOwnerGeneration; link: RelayJoinLink; deviceId: string; seed: string; name: string; signal: AbortSignal;
  onWaiting(verifyCode: string): void;
}): Promise<MobileAgentNetMembership & { certificate: DeviceCertificate }> {
  const { link, signal } = input;
  if (!link.relayId || !link.agentNetCode) throw new RelayJoinError('INCOMPATIBLE', 'not an Agent-Net link');
  if (!MobileAgentNetEngine.available()) throw new RelayJoinError('INCOMPATIBLE', 'Agent-Net is unavailable in this build');
  const guard = () => {
    if (!isMobileAuthOwnerCurrent(input.owner)) throw new Error('AGENT_NET_OWNER_CHANGED');
    if (signal.aborted) throw new RelayJoinError('CANCELLED', 'cancelled');
  };
  guard();
  const networkId = 'private:' + link.relayId;
  const engine = await MobileAgentNetEngine.create({ seed: input.seed, context: link.relayId,
    deviceId: input.deviceId, legacySigning: true, udp: false }, guard);
  try {
    const plain = { requestId: randomUUID(), joinCode: link.agentNetCode, networkId, deviceId: input.deviceId,
      name: input.name.trim().slice(0, 64) || 'Cindy', signingKey: engine.identity.signingKey, transportKey: engine.identity.transportKey };
    const payload = joinPayload(plain);
    const request: JoinRequest = { ...plain, signature: await engine.sign(payload),
      pairingProof: toBase64Url(mobileRelayAuthCrypto.hmacSha256(utf8(link.pairSecret), utf8(payload))) };
    guard();
    let submitted: { status: number; value: unknown };
    try { submitted = await postAgentNet(link.baseUrl, '/join', request, signal); }
    catch { guard(); throw new RelayJoinError('UNREACHABLE', 'relay unreachable'); }
    guard();
    const pollToken = (submitted.value as { pollToken?: unknown } | null)?.pollToken;
    if (submitted.status === 403 || errorCode(submitted.value) === 'JOIN_CODE_INVALID') throw new RelayJoinError('CODE_INVALID', 'join code invalid');
    if (submitted.status === 429) throw new RelayJoinError('RATE_LIMITED', 'rate limited');
    if (submitted.status >= 300 || typeof pollToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(pollToken)) {
      throw new RelayJoinError('FAILED', 'join request rejected');
    }
    input.onWaiting(relayPairingVerifyCode(mobileRelayAuthCrypto, request.pairingProof));
    const deadline = Date.now() + JOIN_WAIT_MS;
    for (;;) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, JOIN_POLL_MS);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      guard();
      let polled: { status: number; value: unknown } | null = null;
      try { polled = await postAgentNet(link.baseUrl, '/join/status', { networkId, requestId: plain.requestId, pollToken }, signal); }
      catch { /* 暂时连不上:接着等。 */ }
      guard();
      if (polled?.status === 403) throw new RelayJoinError('EXPIRED', 'request expired');
      const result = polled?.status === 200 ? polled.value as { status?: unknown; rootPublicKey?: unknown; certificate?: DeviceCertificate } : null;
      if (result?.status === 'rejected') throw new RelayJoinError('REJECTED', 'owner rejected');
      if (result?.status === 'approved') {
        const certificate = result.certificate;
        if (result.rootPublicKey !== link.ownerPublicKey || !certificate || !verifyMobileAgentNetCertificate(link.ownerPublicKey, certificate)
          || certificate.networkId !== networkId || certificate.deviceId !== input.deviceId || certificate.role !== 'member'
          || certificate.subject !== input.owner.accountId || certificate.signingKey !== engine.identity.signingKey
          || certificate.transportKey !== engine.identity.transportKey) throw new RelayJoinError('OWNER_MISMATCH', 'untrusted certificate');
        return { version: 2, networkId, rootPublicKey: link.ownerPublicKey, certificate };
      }
      if (Date.now() > deadline) throw new RelayJoinError('EXPIRED', 'owner did not respond');
    }
  } finally { await engine.destroy(); }
}
