import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import net from 'node:net';
import type { SystemScreenSharingProbe } from '@cindy/device-link';

const PROBE_LIFETIME_MS = 10_000;
const SOCKET_TIMEOUT_MS = 1600;
const MAX_FRAME_BYTES = 512;
const MAX_PENDING_PROBES = 16;
const ID = /^[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{64}$/;

export function isPrivateScreenSharingAddress(address: string): boolean {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function transcript(id: string, nonce: string, address: string): Buffer {
  return Buffer.from(JSON.stringify(['cindy-screen-sharing-address', 1, id, nonce, address]));
}

/** A bounded, single-line exchange; no arbitrary requests or user data. */
function readFrame(socket: net.Socket, receive: (value: unknown) => void): void {
  let bytes = Buffer.alloc(0);
  socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
  socket.on('error', () => socket.destroy());
  const data = (chunk: Buffer) => {
    if (bytes.length + chunk.length > MAX_FRAME_BYTES) return void socket.destroy();
    bytes = Buffer.concat([bytes, chunk]);
    const end = bytes.indexOf(10);
    if (end < 0) return;
    socket.off('data', data);
    try {
      receive(JSON.parse(bytes.subarray(0, end).toString('utf8')));
    } catch {
      socket.destroy();
    }
  };
  socket.on('data', data);
}

/** No persistent listener/key: one short lease per authenticated controller. */
export class SystemScreenSharingProbeHost {
  private entries = new Map<string, { id: string; stop: () => void }>();

  stop(peer?: string, id?: string): void {
    for (const [key, entry] of this.entries) {
      if (peer !== undefined && peer !== key) continue;
      if (id !== undefined && id !== entry.id) continue;
      entry.stop();
    }
  }

  async begin(
    peer: string,
    id: string,
    current: () => boolean,
  ): Promise<SystemScreenSharingProbe | null> {
    if (!ID.test(id) || !current()) return null;
    this.stop(peer);
    // Socket/listener budget, not a limit on devices or ordinary remote control.
    if (this.entries.size >= MAX_PENDING_PROBES) return null;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const sockets = new Set<net.Socket>();
    let closed = false;
    let finish: (result: SystemScreenSharingProbe | null) => void = () => {};
    const server = net.createServer((socket) => {
      if (closed || !current()) {
        stop();
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      readFrame(socket, (raw) => {
        const value = raw as { id?: unknown; nonce?: unknown; address?: unknown } | null;
        const address = socket.localAddress?.replace(/^::ffff:/, '');
        if (closed || !current()) {
          stop();
          return;
        }
        if (
          !value ||
          value.id !== id ||
          typeof value.nonce !== 'string' ||
          !NONCE.test(value.nonce) ||
          typeof value.address !== 'string' ||
          value.address !== address ||
          !isPrivateScreenSharingAddress(address)
        ) {
          socket.destroy();
          return;
        }
        socket.end(
          JSON.stringify({
            signature: sign(null, transcript(id, value.nonce, address), privateKey).toString(
              'base64',
            ),
          }) + '\n',
        );
      });
    });
    server.maxConnections = 16;
    const stop = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (this.entries.get(peer)?.id === id) this.entries.delete(peer);
      for (const socket of sockets) socket.destroy();
      if (server.listening) server.close();
      finish(null);
    };
    const timer = setTimeout(stop, PROBE_LIFETIME_MS);
    timer.unref();
    this.entries.set(peer, { id, stop });
    return new Promise((resolve) => {
      finish = resolve;
      server.on('error', stop);
      server.listen(0, '0.0.0.0', () => {
        if (closed || !current()) {
          if (server.listening) server.close();
          stop();
          resolve(null);
          return;
        }
        server.unref();
        const address = server.address();
        if (!address || typeof address === 'string') {
          stop();
          return;
        }
        resolve({
          version: 1,
          id,
          port: address.port,
          publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        });
      });
    });
  }
}

/** Verifies the Cindy endpoint at this exact IPv4, not Apple's VNC authentication. */
export async function verifySystemScreenSharingHost(
  address: string,
  raw: unknown,
  expectedId: string,
  current: () => boolean,
): Promise<boolean> {
  const proof = raw as Partial<SystemScreenSharingProbe> | null;
  if (
    !current() ||
    !isPrivateScreenSharingAddress(address) ||
    !proof ||
    proof.version !== 1 ||
    proof.id !== expectedId ||
    !ID.test(expectedId) ||
    !Number.isInteger(proof.port) ||
    proof.port! < 1024 ||
    proof.port! > 65535 ||
    typeof proof.publicKey !== 'string' ||
    proof.publicKey.length > 128
  )
    return false;
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey({
      key: Buffer.from(proof.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    if (key.asymmetricKeyType !== 'ed25519') return false;
  } catch {
    return false;
  }
  const nonce = randomBytes(32).toString('hex');
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: address, port: proof.port! });
    const done = (valid: boolean) => {
      socket.destroy();
      resolve(valid && current());
    };
    // Absolute deadline as well as idle timeout: a trickling peer cannot keep it alive.
    const timer = setTimeout(() => done(false), SOCKET_TIMEOUT_MS);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(false);
    });
    readFrame(socket, (rawReply) => {
      const signature = (rawReply as { signature?: unknown } | null)?.signature;
      if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature))
        return done(false);
      done(
        verify(null, transcript(expectedId, nonce, address), key, Buffer.from(signature, 'base64')),
      );
    });
    socket.once('connect', () => {
      if (!current()) return done(false);
      socket.write(JSON.stringify({ id: expectedId, nonce, address }) + '\n');
    });
  });
}
