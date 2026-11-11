import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { notificationKeyPayload, notificationPayload, type DeviceView } from '@cindy/agent-net-protocol';
import { signature, verifyCertificate, verifySignature, type Identity } from './identity.js';

/** Only root-certified devices can bind notification keys. A relay cannot substitute its own key. */
export function sealNotification(root: string, networkId: string, sender: Identity, recipient: DeviceView, payload: unknown): string {
  const c = recipient.certificate, binding = recipient.notificationKey;
  if (!verifyCertificate(root, c) || c.networkId !== networkId || !binding || binding.v !== 2
    || binding.deviceId !== c.deviceId || binding.networkId !== networkId
    || !verifySignature(c.signingKey, notificationKeyPayload(binding), binding.signature)) throw new Error('UNTRUSTED_NOTIFICATION_KEY');
  const text = notificationPayload(networkId, sender.deviceId, c.deviceId, randomUUID(), Date.now(), payload);
  const clear = Buffer.concat([Buffer.from(text), Buffer.from(signature(sender.signingPrivateKey, text), 'base64url')]);
  // Leave room for provider routing and metadata under APNs/FCM's 4 KiB limit.
  if (clear.length > 1_889) throw new Error('NOTIFICATION_TOO_LARGE');
  const ephemeral = generateKeyPairSync('x25519'), nonce = randomBytes(12);
  const header = Buffer.concat([Buffer.from([4]), Buffer.from(ephemeral.publicKey.export({ format: 'jwk' }).x!, 'base64url'), nonce]);
  const peer = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: binding.encryptionKey }, format: 'jwk' });
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: peer });
  const key = Buffer.from(hkdfSync('sha256', shared, nonce, 'cindy-agent-net/notification/2', 32));
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(clear), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  } finally { clear.fill(0); shared.fill(0); key.fill(0); }
}
