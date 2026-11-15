/**
 * `RelayAuthCrypto` 的 node:crypto 实现(Desktop 主进程、自建中转与测试使用)。
 * 只经子路径 `@cindy/device-link/node-relay-crypto` 导出,Mobile 不会打包它。
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import type { RelayAuthCrypto } from './selfHostedRelayAuth.js';

// Ed25519 原始 32 字节密钥外面的固定 DER 头(PKCS#8 私钥 / SPKI 公钥)。
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_CACHED_KEYS = 256;

const privateKeys = new Map<string, KeyObject>();
const publicKeys = new Map<string, KeyObject>();

function remember(cache: Map<string, KeyObject>, id: string, key: KeyObject): KeyObject {
  if (cache.size >= MAX_CACHED_KEYS) cache.delete(cache.keys().next().value!);
  cache.set(id, key);
  return key;
}

function privateKeyOf(seed: Uint8Array): KeyObject {
  const id = Buffer.from(seed).toString('base64');
  return privateKeys.get(id)
    ?? remember(privateKeys, id, createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' }));
}

function publicKeyOf(raw: Uint8Array): KeyObject {
  const id = Buffer.from(raw).toString('base64');
  return publicKeys.get(id)
    ?? remember(publicKeys, id, createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' }));
}

export const nodeRelayAuthCrypto: RelayAuthCrypto = {
  sha256: (data) => createHash('sha256').update(data).digest(),
  hmacSha256: (key, data) => createHmac('sha256', key).update(data).digest(),
  ed25519PublicKey(seed) {
    const der = createPublicKey(privateKeyOf(seed)).export({ format: 'der', type: 'spki' });
    return new Uint8Array(der.subarray(der.length - 32));
  },
  ed25519Sign: (seed, message) => sign(null, message, privateKeyOf(seed)),
  ed25519Verify(publicKey, message, signature) {
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    return verify(null, message, publicKeyOf(publicKey), signature);
  },
  randomBytes: (size) => randomBytes(size),
  utf8: (text) => Buffer.from(text, 'utf8'),
};
