import { createSocket, type Socket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { signature, verifySignature, type Identity } from '@cindy/agent-net-relay';
import type { DeviceCertificate } from '@cindy/agent-net-protocol';

const GROUP = '239.255.97.2', PORT = 45479;
const PREFIX = 'cindy-agent-net-lan/2';
interface Beacon { v: 2; network: string; device: string; key: string; port: number; at: number; nonce: string; signature: string }
const payload = (b: Omit<Beacon, 'signature'>) => JSON.stringify([PREFIX, b.network, b.device, b.key, b.port, b.at, b.nonce]);
/** Discovery carries public addressing only; a certified Noise handshake still admits every connection. */
export class LanDiscovery {
  private socket: Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly seen = new Map<string, number>();
  private readonly answered = new Set<string>();
  private started = false;
  private closed = false;
  private readonly interfaces: string[] = [];
  constructor(private readonly options: {
    identity: Identity; networkId: string; port: number;
    /** Match an explicitly bound transport, including loopback-only integration runs. */
    interfaceAddress?: string;
    certificateFor(device: string): DeviceCertificate | undefined;
    onCandidate(device: string, address: { address: string; port: number }): void;
  }) {}
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    const socket = this.socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => { this.close(); });
    socket.on('message', (bytes, source) => this.receive(bytes, source.address));
    socket.bind(PORT, '0.0.0.0', () => {
      if (this.closed) return;
      socket.setMulticastTTL(1); socket.setMulticastLoopback(true);
      let joined = false;
      const addresses = this.options.interfaceAddress && this.options.interfaceAddress !== '0.0.0.0'
        ? [this.options.interfaceAddress]
        : Object.values(os.networkInterfaces()).flatMap(entries => (entries ?? [])
          .filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address));
      for (const address of new Set(addresses)) {
        try { socket.addMembership(GROUP, address); this.interfaces.push(address); joined = true; } catch { /* A disappearing interface is optional. */ }
      }
      if (!joined) { try { socket.addMembership(GROUP); } catch { this.close(); return; } }
      this.announce();
      this.timer = setInterval(() => this.announce(), 5000); this.timer.unref();
    });
    socket.unref();
  }
  beacon(): string {
    const { identity, networkId, port } = this.options;
    const body = { v: 2 as const, network: networkId, device: identity.deviceId, key: identity.transportKey, port, at: Date.now(), nonce: randomBytes(12).toString('base64url') };
    return JSON.stringify({ ...body, signature: signature(identity.signingPrivateKey, payload(body)) });
  }
  private announce(): void {
    if (this.closed || !this.socket) return;
    const bytes = Buffer.from(this.beacon());
    if (!this.interfaces.length) { this.socket.send(bytes, PORT, GROUP, () => undefined); return; }
    // Joining a group does not select the outgoing interface. A VPN/default
    // route can otherwise send every beacon away from the joined local LAN.
    for (const address of this.interfaces) {
      try {
        this.socket.setMulticastInterface(address);
        this.socket.send(bytes, PORT, GROUP, () => undefined);
      } catch { /* An interface may disappear after membership was established. */ }
    }
  }
  /** Bounded, signed and replay-limited; source addresses are observed, never supplied by a peer. */
  receive(bytes: Uint8Array, source: string): void {
    if (this.closed || bytes.length > 1024 || !/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(source)) return;
    try {
      const b = JSON.parse(Buffer.from(bytes).toString('utf8')) as Beacon;
      if (Object.keys(b).length !== 8 || b.v !== 2 || b.network !== this.options.networkId || b.device === this.options.identity.deviceId
        || typeof b.device !== 'string' || typeof b.key !== 'string' || typeof b.signature !== 'string'
        || typeof b.nonce !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(b.nonce)
        || !Number.isSafeInteger(b.at) || Math.abs(Date.now() - b.at) > 15_000
        || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535) return;
      const certificate = this.options.certificateFor(b.device);
      const seenKey = b.device + ':' + b.nonce;
      if (this.seen.has(seenKey)) return;
      if (!certificate || certificate.transportKey !== b.key || certificate.networkId !== b.network
        || !verifySignature(certificate.signingKey, payload(b), b.signature)) return;
      for (const [key, at] of this.seen) if (Date.now() - at > 15_000) this.seen.delete(key);
      if (this.seen.size >= 512) return;
      this.seen.set(seenKey, Date.now());
      this.options.onCandidate(b.device, { address: source, port: b.port });
      // Help a newly started peer find us immediately, without two responders echoing forever.
      if (!this.answered.has(b.device) && this.answered.size < 256) { this.answered.add(b.device); this.announce(); }
    } catch { /* A multicast packet cannot change trust or close another device's connection. */ }
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    try { this.socket?.close(); } catch { /* It may have failed before binding. */ }
    this.socket = null; this.seen.clear(); this.answered.clear();
  }
}
