/**
 * 测试价值
 * - 生产入口与可观察结果：手机核对 Agent-Net 证书、授权和自建中转签名都经 `mobileRelayAuthCrypto.ed25519Verify`。
 *   同一份公钥、消息、签名第二次核对直接通过，不再跑纯 JS 的 Ed25519；消息改过一个字节、换了公钥，照样被拒；
 *   没通过的不记，下次仍然真的核对。
 * - Bug 依据：2026-11-20 真机，手机每收到一次设备目录都把几十台设备的证书用纯 JS 重新核一遍，Wi-Fi 换 5G 重连时
 *   JS 线程被占满约 8 秒，这期间收不到任何电脑的消息。
 * - 现有覆盖缺口：selfHostedRelaySignatures.test.ts 只测跨实现兼容，不测重复核对和核对结果的复用边界。
 * - 最小失败输入：一条由 node:crypto 签名的消息，核对两次；再拿同一签名配改过的消息、配别的公钥各核对两次。
 * - tier：unit(纯计算,node 环境;expo-crypto 的随机数换成 node:crypto)。
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)) }));

import { mobileRelayAuthCrypto } from '@/device-link/relayAuthCrypto';

afterEach(() => { vi.restoreAllMocks(); });

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { publicKey: raw, sign: (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey)) };
}

it('verifies the same signature once and still rejects altered messages, other keys and failures', () => {
  const verify = vi.spyOn(ed25519, 'verify');
  const signer = keyPair(), other = keyPair();
  const message = new TextEncoder().encode('cindy-agent-net certificate ' + randomBytes(8).toString('hex'));
  const signature = signer.sign(message);

  expect(mobileRelayAuthCrypto.ed25519Verify(signer.publicKey, message, signature)).toBe(true);
  expect(mobileRelayAuthCrypto.ed25519Verify(signer.publicKey, message, signature)).toBe(true);
  expect(verify).toHaveBeenCalledTimes(1);

  const altered = message.slice(); altered[altered.length - 1] ^= 1;
  expect(mobileRelayAuthCrypto.ed25519Verify(signer.publicKey, altered, signature)).toBe(false);
  expect(mobileRelayAuthCrypto.ed25519Verify(signer.publicKey, altered, signature)).toBe(false);
  expect(mobileRelayAuthCrypto.ed25519Verify(other.publicKey, message, signature)).toBe(false);
  expect(mobileRelayAuthCrypto.ed25519Verify(other.publicKey, message, signature)).toBe(false);
  expect(verify).toHaveBeenCalledTimes(5);
});
