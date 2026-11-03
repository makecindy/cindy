import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  OauthIdentityStore,
  oauthIdentityScopeKey,
  type OauthSigningKey,
} from '../identityStore.js';

/** Synthetic, process-local keys. Product wiring must always use its secure identity store. */
export async function testOauthSigningKey(): Promise<OauthSigningKey> {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}

/** OS secure storage stand-in for unit tests; callers own and clean their temporary directory. */
export function testOauthIdentityStore(directory: string) {
  const encryptionKey = randomBytes(32);
  const deps = {
    filePath: (scope: Parameters<typeof oauthIdentityScopeKey>[0]) =>
      path.join(directory, `${oauthIdentityScopeKey(scope)}.enc`),
    available: () => true,
    encrypt: (plaintext: string) => {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt: (value: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    },
  };
  return { store: new OauthIdentityStore(deps), restart: () => new OauthIdentityStore(deps), deps };
}
