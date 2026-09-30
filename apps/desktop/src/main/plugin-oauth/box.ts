import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/** Ephemeral X25519 + HKDF/AES-GCM. Relay identity routing remains a trust root. */
export class OauthBox {
  private readonly privateKey: KeyObject;
  readonly publicKey: string;
  constructor() {
    const pair = generateKeyPairSync('x25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  }
  private key(peer: string, id: string, direction: 'offer' | 'callback'): Buffer {
    if (!/^[A-Za-z0-9_-]{59}$/.test(peer)) throw new Error('OAUTH_BRIDGE_INVALID');
    const key = createPublicKey({
      key: Buffer.from(peer, 'base64url'),
      type: 'spki',
      format: 'der',
    });
    if (key.asymmetricKeyType !== 'x25519') throw new Error('OAUTH_BRIDGE_INVALID');
    const shared = diffieHellman({ privateKey: this.privateKey, publicKey: key });
    try {
      return Buffer.from(hkdfSync('sha256', shared, id, `cindy-plugin-oauth-v1:${direction}`, 32));
    } finally {
      shared.fill(0);
    }
  }
  seal(peer: string, id: string, direction: 'offer' | 'callback', value: unknown): string {
    const key = this.key(peer, id, direction);
    const iv = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`cindy-plugin-oauth-v1:${id}:${direction}`));
      const body = Buffer.from(JSON.stringify(value));
      if (body.length > 32_000) throw new Error('OAUTH_BRIDGE_INVALID');
      return Buffer.concat([iv, cipher.update(body), cipher.final(), cipher.getAuthTag()]).toString(
        'base64url',
      );
    } finally {
      key.fill(0);
    }
  }
  open(peer: string, id: string, direction: 'offer' | 'callback', box: string): unknown {
    try {
      if (!/^[A-Za-z0-9_-]{40,48000}$/.test(box)) throw 0;
      const data = Buffer.from(box, 'base64url');
      const key = this.key(peer, id, direction);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
        decipher.setAAD(Buffer.from(`cindy-plugin-oauth-v1:${id}:${direction}`));
        decipher.setAuthTag(data.subarray(-16));
        return JSON.parse(
          Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString(
            'utf8',
          ),
        );
      } finally {
        key.fill(0);
      }
    } catch {
      throw new Error('OAUTH_BRIDGE_INVALID');
    }
  }
}
