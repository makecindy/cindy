/**
 * 智能通讯录设备同步的纯加密原语。
 *
 * - 每台设备持久化一对 X25519 密钥；
 * - 两台设备用 ECDH 得到共享秘密，再经 HKDF 派生本功能专用 AES-256-GCM 密钥；
 * - AAD 绑定源/目标 deviceId 与本次 transfer，密文被挪给别的设备或分片元数据
 *   被篡改时都会认证失败。
 *
 * 本文件没有 Electron / 文件系统依赖，便于做确定性单测。
 */

import {
  createPrivateKey,
  createPublicKey,
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

const KEY_INFO_PREFIX = 'cindy:contacts-device-sync:v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface ContactsSyncExportedIdentity {
  publicKey: string;
  privateKey: string;
}

export interface ContactsSyncEncryptedBytes {
  iv: string;
  tag: string;
  ciphertext: Buffer;
}

export interface ContactsSyncEncryptionContext {
  srcDeviceId: string;
  dstDeviceId: string;
  transferId: string;
  totalChunks: number;
}

export function generateContactsSyncIdentity(): ContactsSyncExportedIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: exportPublicKey(publicKey),
    privateKey: exportPrivateKey(privateKey),
  };
}

export function publicKeyFromPrivate(privateKey: string): string {
  return exportPublicKey(createPublicKey(importPrivateKey(privateKey)));
}

export function isValidContactsSyncPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 256) return false;
  try {
    const key = importPublicKey(value);
    return key.asymmetricKeyType === 'x25519' && exportPublicKey(key) === value;
  } catch {
    return false;
  }
}

export function encryptContactsSyncBytes(
  plaintext: Buffer,
  ownPrivateKey: string,
  peerPublicKey: string,
  context: ContactsSyncEncryptionContext,
): ContactsSyncEncryptedBytes {
  const key = deriveEncryptionKey(ownPrivateKey, peerPublicKey, context);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(buildAad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext,
  };
}

export function decryptContactsSyncBytes(
  encrypted: ContactsSyncEncryptedBytes,
  ownPrivateKey: string,
  peerPublicKey: string,
  context: ContactsSyncEncryptionContext,
): Buffer {
  const iv = decodeExactBase64(encrypted.iv, IV_BYTES, 'iv');
  const tag = decodeExactBase64(encrypted.tag, TAG_BYTES, 'tag');
  const key = deriveEncryptionKey(ownPrivateKey, peerPublicKey, context);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(buildAad(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}

function deriveEncryptionKey(
  ownPrivateKey: string,
  peerPublicKey: string,
  context: ContactsSyncEncryptionContext,
): Buffer {
  const shared = diffieHellman({
    privateKey: importPrivateKey(ownPrivateKey),
    publicKey: importPublicKey(peerPublicKey),
  });
  const orderedDeviceIds = [context.srcDeviceId, context.dstDeviceId].sort().join('\u0000');
  return Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.alloc(0),
      Buffer.from(`${KEY_INFO_PREFIX}\u0000${orderedDeviceIds}`, 'utf8'),
      32,
    ),
  );
}

function buildAad(context: ContactsSyncEncryptionContext): Buffer {
  return Buffer.from(
    [
      KEY_INFO_PREFIX,
      context.srcDeviceId,
      context.dstDeviceId,
      context.transferId,
      String(context.totalChunks),
    ].join('\u0000'),
    'utf8',
  );
}

function importPublicKey(value: string): KeyObject {
  return createPublicKey({
    key: decodeBase64(value, 'public key'),
    format: 'der',
    type: 'spki',
  });
}

function importPrivateKey(value: string): KeyObject {
  const key = createPrivateKey({
    key: decodeBase64(value, 'private key'),
    format: 'der',
    type: 'pkcs8',
  });
  if (key.asymmetricKeyType !== 'x25519') throw new Error('private key is not X25519');
  return key;
}

function exportPublicKey(key: KeyObject): string {
  return (key.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
}

function exportPrivateKey(key: KeyObject): string {
  return (key.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64');
}

function decodeBase64(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`invalid ${label}`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new Error(`invalid ${label}`);
  }
  return decoded;
}

function decodeExactBase64(value: string, bytes: number, label: string): Buffer {
  const decoded = decodeBase64(value, label);
  if (decoded.length !== bytes) throw new Error(`invalid ${label} length`);
  return decoded;
}
