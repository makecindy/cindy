import type { DiscoveryOptions, SocketDiscovery } from '@cindy/agent-net/portable';
import { fromBase64Url, toBase64Url, utf8, decodeUtf8 } from '@cindy/agent-net/portable';
import { agentNetNative } from '../../modules/cindy-agent-net/src';
import type { MobileAgentNetEngine } from './agentNetNative';
import { mobileRelayAuthCrypto } from './relayAuthCrypto';

interface Beacon { v: 2; network: string; device: string; key: string; port: number; at: number; nonce: string; signature: string; }
const payload = (b: Omit<Beacon, 'signature'>) => JSON.stringify(['cindy-agent-net-lan/2', b.network, b.device, b.key, b.port, b.at, b.nonce]);
/** The native DNS-SD module resolves addresses. A signed, time-bounded beacon
 * supplies identity only; it can never add a device to the approved roster. */
export function mobileAgentNetDiscovery(options: DiscoveryOptions, signer: MobileAgentNetEngine, guard: () => void,
  currentSigner: () => MobileAgentNetEngine = () => signer): SocketDiscovery {
  let closed = false, started = false, id: string | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let subscription: { remove(): void } | undefined;
  const seen = new Map<string, number>();
  async function txt(): Promise<string> {
    guard();
    const active = currentSigner();
    if (active.identity.signingKey !== signer.identity.signingKey || active.identity.transportKey !== signer.identity.transportKey) throw new Error('AGENT_NET_IDENTITY_CHANGED');
    const body = { v: 2 as const, network: options.networkId, device: signer.identity.deviceId,
      key: signer.identity.transportKey, port: options.port, at: Date.now(), nonce: (await active.random()).slice(0, 16) };
    const record = { ...body, signature: await active.sign(payload(body)) }; guard();
    const encoded = toBase64Url(utf8(JSON.stringify(record))), result: Record<string, string> = {};
    if (encoded.length > 1600) throw new Error('AGENT_NET_DISCOVERY_RECORD_TOO_LARGE');
    for (let i = 0; i * 200 < encoded.length; i++) result['b' + i] = encoded.slice(i * 200, (i + 1) * 200);
    return JSON.stringify(result);
  }
  const close = () => {
    if (closed) return; closed = true;
    if (timer) clearInterval(timer); subscription?.remove(); seen.clear();
    if (id) void agentNetNative?.stopLan?.(id).catch(() => undefined);
  };
  const start = () => {
    if (started || closed || !agentNetNative?.startLan) return;
    started = true;
    subscription = agentNetNative.addListener('onLanService', event => {
      if (closed || event.id !== id) return;
      try {
        guard();
        if (!event.txt || Object.keys(event.txt).length > 8 || !Array.isArray(event.addresses)) return;
        const parts: string[] = [];
        for (let i = 0; i < 8 && event.txt['b' + i] !== undefined; i++) {
          const value = event.txt['b' + i]; if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) return;
          parts.push(value);
        }
        const bytes = fromBase64Url(parts.join('')); if (bytes.length > 1024) return;
        const b = JSON.parse(decodeUtf8(bytes)) as Beacon;
        if (Object.keys(b).length !== 8 || b.v !== 2 || b.network !== options.networkId || b.device === signer.identity.deviceId
          || typeof b.device !== 'string' || typeof b.key !== 'string' || typeof b.signature !== 'string'
          || typeof b.nonce !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(b.nonce) || !Number.isSafeInteger(b.at) || Math.abs(Date.now() - b.at) > 15_000
          || b.port !== event.port || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535) return;
        const certificate = options.certificateFor(b.device);
        if (!certificate || certificate.transportKey !== b.key || certificate.networkId !== b.network
          || !mobileRelayAuthCrypto.ed25519Verify(fromBase64Url(certificate.signingKey), utf8(payload(b)), fromBase64Url(b.signature))) return;
        const source = event.addresses.slice(0, 16).find(address => typeof address === 'string' && /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(address));
        if (!source) return;
        const replay = b.device + ':' + b.nonce;
        for (const [key, at] of seen) if (Date.now() - at > 15_000) seen.delete(key);
        if (seen.has(replay) || seen.size >= 512) return;
        seen.set(replay, Date.now()); options.onCandidate(b.device, { address: source, port: b.port });
      } catch { /* Untrusted service records cannot alter membership or another connection. */ }
    });
    void (async () => {
      const record = await txt(); if (closed) return;
      const startedId = await agentNetNative!.startLan!(options.port, record);
      if (closed) { await agentNetNative!.stopLan?.(startedId); return; }
      id = startedId; guard();
      let updating = false;
      timer = setInterval(() => { if (updating || closed) return; updating = true;
        void (async () => { const record = await txt(); if (!closed) await agentNetNative!.updateLan?.(id!, record); })()
          .catch(close).finally(() => { updating = false; });
      }, 5000);
    })().catch(close);
  };
  return { start, close };
}
