/**
 * 自建中转设备签名的 `RelayAuthCrypto` 手机实现(docs/self-hosted-relay-plan.md §16)。
 *
 * 纯 JS 的 @noble 做 Ed25519 / SHA-256 / HMAC,随机数取系统安全随机源(expo-crypto)。
 * 不提供 `utf8`:Hermes 上没有可靠的 TextEncoder,由共享包的纯 JS 编码器处理。
 * 与电脑端的 node:crypto 实现逐字节兼容(Ed25519 签名是确定性的)。
 */
import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { getRandomBytes } from 'expo-crypto';
import type { RelayAuthCrypto } from '@cindy/device-link';

export const mobileRelayAuthCrypto: RelayAuthCrypto = {
  sha256: (data) => sha256(data),
  hmacSha256: (key, data) => hmac(sha256, key, data),
  ed25519PublicKey: (seed) => ed25519.getPublicKey(seed),
  ed25519Sign: (seed, message) => ed25519.sign(message, seed),
  ed25519Verify(publicKey, message, signature) {
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    try {
      // 严格按 RFC 8032 核对(与 node:crypto 一致),不接受 ZIP-215 放宽的写法。
      return ed25519.verify(signature, message, publicKey, { zip215: false });
    } catch {
      return false;
    }
  },
  randomBytes: (size) => getRandomBytes(size),
};
