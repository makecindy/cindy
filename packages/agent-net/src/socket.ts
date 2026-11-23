import { sealNotification, type AgentNetClient } from '@cindy/agent-net-relay/client';
import { verifyCertificate, verifyDelegation } from '@cindy/agent-net-relay';
import { AgentNetSocket as PortableSocket } from './portableSocket.js';
import type { PortableSocketOptions } from './socketPorts.js';
import type { TransportOptions } from './types.js';
import { createCoreTransport } from './transport.js';
import { LanDiscovery } from './lan.js';
import { BonjourDiscovery } from './bonjour.js';
import os from 'node:os';
import type { KeyObject } from 'node:crypto';
import { NativeTransport } from './nativeTransport.js';
import { NodeNativeEngine, loadNodeNativeBinding, type NodeNativeBinding } from './nodeNativeEngine.js';
import { resolveUdpHost, splitHostPort } from './stun.js';

export interface AgentNetSocketOptions extends Omit<PortableSocketOptions, 'client' | 'bindings'> {
  client: AgentNetClient;
  module?: WebAssembly.Module;
  udp?: boolean;
  bindAddress?: string;
  stunServers?: string[];
  /** The relay's UDP address for relayed datagrams; see TransportOptions.relayUdpServer. */
  relayUdpServer?: string;
  /** Offer and accept only public direct-path candidates (tests and benchmarks force the relay path with it). */
  publicCandidatesOnly?: boolean;
  tap?: TransportOptions['tap'];
  udpTraffic?: TransportOptions['udpTraffic'];
  /**
   * The native engine (packages/agent-net-native/node): its module, given as the path to load it from. The engine gets the
   * client identity's own keys. Without it, or when it fails, the transport is the WASM core as before; `onFallback` says why.
   * Tests and benchmarks that tap datagrams or bind an address keep the WASM core, which has those.
   */
  native?: { binding: NodeNativeBinding | string; onFallback?(code: string): void };
}
/** Node bindings; device-link routing and framing are shared with mobile. */
export class AgentNetSocket extends PortableSocket {
  static async open(options: AgentNetSocketOptions): Promise<AgentNetSocket> {
    return this.openWithBindings({ ...options, bindings: {
      verifyCertificate,
      verifyDelegation,
      async notify(recipient, input, signal, activeClient) {
        const client = activeClient as AgentNetClient;
        options.assertCurrent?.();
        let ciphertext = '';
        const payload = { ...input, title: Array.from(input.title).slice(0, 128).join('') };
        for (const length of [640, 320, 160, 0]) {
          payload.body = Array.from(input.body ?? '').slice(0, length).join('');
          try { ciphertext = sealNotification(client.rootPublicKey, client.certificate.networkId, client.identity, recipient, payload); break; }
          catch (error) {
            if (!(error instanceof Error) || error.message !== 'NOTIFICATION_TOO_LARGE') throw error;
            if (payload.sender?.avatar) { payload.sender = { id: payload.sender.id }; }
          }
        }
        if (!ciphertext) throw new Error('NOTIFICATION_TOO_LARGE');
        options.assertCurrent?.();
        await client.request('POST', '/notify', { to: recipient.certificate.deviceId, ciphertext }, { signal });
        options.assertCurrent?.();
      },
      createTransport: async request => {
        const native = options.native && !options.tap && !options.bindAddress ? options.native : undefined;
        if (native) {
          try { return await createNativeTransport(options, native, request); }
          catch (error) { native.onFallback?.(error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'AGENT_NET_NATIVE_FAILED'); }
        }
        return createCoreTransport({ ...request,
          identity: options.client.identity.transportPrivateKey, module: options.module,
          bindAddress: options.bindAddress, udp: options.udp, stunServers: options.stunServers, tap: options.tap,
          udpTraffic: options.udpTraffic,
          relayUdpServer: options.relayUdpServer, publicCandidatesOnly: options.publicCandidatesOnly,
        });
      },
      createDiscovery: request => {
        const lan = new LanDiscovery({ ...request, identity: options.client.identity, interfaceAddress: options.bindAddress });
        const bonjour = new BonjourDiscovery(lan, request.port);
        return { start() { lan.start(); bonjour.start(); }, close() { lan.close(); bonjour.close(); } };
      },
    } }) as Promise<AgentNetSocket>;
  }
}

/** This computer's IPv4 addresses, as the WASM transport announces them (transport.ts `gatherCandidates`); read again on network changes. */
async function interfaceAddresses(): Promise<string[]> {
  const found: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
  }
  return [...new Set(found)];
}
/**
 * STUN and relay UDP servers for the native engine, resolved as the WASM transport resolves them (stun.ts `resolveUdpHost`):
 * behind a transparent proxy whose DNS answers with Fake-IPs (198.18.0.0/15), the real address from DoH. A name that does not
 * resolve now goes to the engine as it is, and the engine looks it up again itself.
 */
async function resolveUdpServer(server: string): Promise<string> {
  const [host, port] = splitHostPort(server);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return server;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The system lookup has no timeout of its own; past this the engine gets the name and looks it up itself.
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), UDP_SERVER_RESOLVE_TIMEOUT_MS); });
  try {
    const address = await Promise.race([resolveUdpHost(host), late]);
    if (!address) return server;
    return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
  } finally { clearTimeout(timer); }
}
const UDP_SERVER_RESOLVE_TIMEOUT_MS = 3_000;
/** A private key's raw bytes as base64url: the JWK `d` of an X25519 key is its secret, of an Ed25519 key its seed. */
const rawPrivateKey = (key: KeyObject): string => {
  const raw = key.export({ format: 'jwk' }).d;
  if (!raw) throw new Error('AGENT_NET_NATIVE_KEY_UNAVAILABLE');
  return raw;
};
/**
 * The transport on the native engine, with the client identity's own keys. Peers know this device by its transport key; one
 * that came out different would make every peer refuse the handshake, so the engine's is checked here and the WASM core is
 * used instead.
 */
async function createNativeTransport(options: AgentNetSocketOptions, native: NonNullable<AgentNetSocketOptions['native']>,
  request: TransportOptions): Promise<NativeTransport> {
  const binding = typeof native.binding === 'string' ? loadNodeNativeBinding(native.binding) : native.binding;
  const identity = options.client.identity;
  const engine = await NodeNativeEngine.create(binding, { deviceId: identity.deviceId, udp: options.udp !== false, enhancedTransport: true,
    keys: { transport: rawPrivateKey(identity.transportPrivateKey), signing: rawPrivateKey(identity.signingPrivateKey) } });
  try {
    const own = await engine.command<{ transportKey?: string }>({ op: 'identity' });
    if (own.transportKey !== identity.transportKey) throw new Error('AGENT_NET_NATIVE_IDENTITY_MISMATCH');
  } catch (error) { await engine.destroy(); throw error; }
  return NativeTransport.create(engine, { ...request, stunServers: options.stunServers, relayUdpServer: options.relayUdpServer,
    udpTraffic: options.udpTraffic, publicCandidatesOnly: options.publicCandidatesOnly, resolveUdpServer },
    interfaceAddresses, true);
}
