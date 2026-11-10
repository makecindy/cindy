/**
 * Chromium OSCrypt v11 payloads, compatible with Electron `safeStorage` on Linux.
 *
 * The format is fixed by the existing Desktop ciphertext; this module only
 * encodes/decodes it. Storage layout and permissions stay the caller's job so
 * the host reuses the Desktop `safe-storage` directory instead of a second one.
 */

import crypto from 'node:crypto';

export const OSCryptPrefix = 'v11';

const PREFIX_LENGTH = 3;
const IV = Buffer.alloc(16, ' ');
const SALT = 'saltysalt';

export function deriveLinuxOsCryptKey(secret) {
  // Chromium Linux: one PBKDF2 round over the keyring password.
  return crypto.pbkdf2Sync(secret, SALT, 1, 16, 'sha1');
}

export function decryptOsCryptPayload(base64Payload, key) {
  const blob = Buffer.from(base64Payload.trim(), 'base64');
  if (blob.subarray(0, PREFIX_LENGTH).toString('latin1') !== OSCryptPrefix) {
    throw new Error('unsupported safeStorage payload prefix');
  }
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([decipher.update(blob.subarray(PREFIX_LENGTH)), decipher.final()]).toString('utf8');
}

export function encryptOsCryptPayload(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from(OSCryptPrefix, 'latin1'), body]).toString('base64');
}
