import { createHmac, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { REMOTE_DESKTOP_ICE_SERVERS } from '@cindy/device-link';

// TURN REST credentials are separate from relay authentication and media URLs.
// The signing key changes when the relay is replaced. No credential cache.
export function turnSecret(mediaKey: string): string {
  return createHmac('sha256', mediaKey).update('cindy/paired-turn/v1').digest('hex');
}

export function turnIceConfig(url: string, mediaKey: string, deviceId: string, now: number) {
  const secret = turnSecret(mediaKey);
  // Bucketing gives a device the same ticket on repeated retries. Its opaque
  // suffix distinguishes devices without sending their IDs to the media service.
  const expires = (Math.floor(now / 300_000) + 12) * 300;
  const tag = createHmac('sha256', secret).update(deviceId).digest('hex').slice(0, 24);
  const username = expires + ':' + tag;
  // eturnal 1.12.3 derive_password/2 verifies the TURN REST password as
  // Base64(HMAC-SHA1(secret, username)); it has no SHA-256 wire option.
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return {
    iceServers: [{ urls: [...REMOTE_DESKTOP_ICE_SERVERS.map(s => s.urls), url], username, credential }],
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

// Run only inside the unit's private network namespace. It contains the TURN
// listener on .1 and only its allocated UDP sockets on .2. Even a valid ticket
// cannot send a datagram to the deployment host, a LAN or an Internet endpoint.
export function pairedTurnConfig(mediaKey: string): string {
  return `eturnal:
  secret: "${turnSecret(mediaKey)}"
  realm: "cindy-relay"
  listen:
    - ip: "127.0.0.1"
      port: 3478
      transport: tcp
  relay_ipv4_addr: "127.0.0.2"
  relay_min_port: 52000
  relay_max_port: 52063
  whitelist_peers: ["127.0.0.2"]
  blacklist_peers: ["0.0.0.0/0", "::/0"]
  strict_expiry: true
  run_dir: /run/cindy-relay-turn
  max_bps: 4194304
  max_permissions: 8
  log_dir: stdout
  log_level: critical
  modules: {}
`;
}

/** One bounded STUN binding transaction through the socket-activated media
 * service. Installation has no reason to start periodic readiness polling. */
export async function checkPairedTurn(socketPath: string): Promise<void> {
  const request = Buffer.alloc(20);
  request.writeUInt16BE(1);
  request.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(request, 8);
  const socket = connect(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error('TURN_NOT_READY'));
      socket.once('error', fail);
      socket.once('close', fail);
      socket.setTimeout(10_000, fail);
      socket.once('connect', () => socket.write(request));
      let header = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        header = Buffer.concat([header, chunk.subarray(0, 20 - header.length)]);
        if (header.length === 20) {
          if (header.readUInt16BE() === 0x101 && header.subarray(4).equals(request.subarray(4))) resolve();
          else fail();
        }
      });
    });
  } finally { socket.destroy(); }
}
