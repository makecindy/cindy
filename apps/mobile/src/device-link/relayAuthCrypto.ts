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
import { bytesToHex } from '@noble/hashes/utils';
import { getRandomBytes } from 'expo-crypto';
import type { RelayAuthCrypto } from '@cindy/device-link';

/**
 * 验证通过过的签名(公钥、消息、签名三者的 SHA-256)。纯 JS 的 Ed25519 在 Hermes 上一次几十毫秒,而 Agent-Net
 * 每收到一次设备目录(连上中转、任何一台设备上下线或忙闲变化)都把全部证书再核一遍:几十台设备时一次就占住
 * JS 线程好几秒,换网重连的那几次目录让收发停了约 8 秒(2026-11-20 真机)。同样的三者核对结果永远一样,
 * 所以只记通过的;证书有效期等随时间变化的检查在调用方,每次照做。
 */
const verifiedSignatures = new Map<string, true>();
const VERIFIED_SIGNATURES_LIMIT = 512;

export const mobileRelayAuthCrypto: RelayAuthCrypto = {
  sha256: (data) => sha256(data),
  hmacSha256: (key, data) => hmac(sha256, key, data),
  ed25519PublicKey: (seed) => ed25519.getPublicKey(seed),
  ed25519Sign: (seed, message) => ed25519.sign(message, seed),
  ed25519Verify(publicKey, message, signature) {
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    const all = new Uint8Array(publicKey.length + signature.length + message.length);
    all.set(publicKey); all.set(signature, publicKey.length); all.set(message, publicKey.length + signature.length);
    const key = bytesToHex(sha256(all));
    if (verifiedSignatures.delete(key)) { verifiedSignatures.set(key, true); return true; }
    try {
      // 严格按 RFC 8032 核对(与 node:crypto 一致),不接受 ZIP-215 放宽的写法。
      const valid = ed25519.verify(signature, message, publicKey, { zip215: false });
      if (valid) {
        if (verifiedSignatures.size >= VERIFIED_SIGNATURES_LIMIT) verifiedSignatures.delete(verifiedSignatures.keys().next().value!);
        verifiedSignatures.set(key, true);
      }
      return valid;
    } catch {
      return false;
    }
  },
  randomBytes: (size) => getRandomBytes(size),
};
