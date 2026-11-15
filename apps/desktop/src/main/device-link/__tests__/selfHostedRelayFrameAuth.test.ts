/**
 * 测试价值
 * - 生产入口：currentRelayFrameAuth 返回的 verify；设备重加入换密钥后有界刷新证书，恢复接收后续帧。
 * - Bug/规则依据：已知设备 bad-signature 曾不触发刷新，非主人电脑会丢消息十分钟。
 * - 缺口/最小输入：先缓存旧公钥，同一设备以新私钥签一帧；伪造流量不能绕过验签或连续拉证书。
 * - tier：unit；真实 Ed25519/生产认证模块，只有 fetch 与时钟为桩，无真实等待。
 *   与运行时测试的认证模块 mock 不兼容，单独加载一次。
 * - 单文件实测：1.04 秒（1 例，测试体 9ms，Windows）。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createRelaySigningKey, issueRelayDeviceCert, RELAY_AUTH_CHANNEL, RelayFrameAuthenticator, type Envelope } from '@cindy/device-link';
import { nodeRelayAuthCrypto as crypto } from '@cindy/device-link/node-relay-crypto';
import { setSelfHostedRelaySource } from '../selfHostedRelayRouting';

vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
import { currentRelayFrameAuth } from '../selfHostedRelayFrameAuth';

afterEach(() => {
  setSelfHostedRelaySource(null);
  currentRelayFrameAuth();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('refreshes a rejoined device key with throttling while rejecting its first unverified frame', async () => {
  vi.useFakeTimers();
  const owner = createRelaySigningKey(crypto);
  const self = createRelaySigningKey(crypto);
  const oldPeer = createRelaySigningKey(crypto);
  const peer = createRelaySigningKey(crypto);
  const relayId = 'test-relay';
  const cert = (publicKey: string) => issueRelayDeviceCert(crypto, owner.seed, {
    relayId, deviceId: 'peer', publicKey, role: 'member', issuedAt: Date.now(),
  });
  let certs = [cert(oldPeer.publicKey)];
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ certs })));
  vi.stubGlobal('fetch', fetchMock);
  setSelfHostedRelaySource(() => ({
    relayId, name: 'Test', baseUrl: 'https://relay.invalid', role: 'member', credential: 'fake',
    deviceId: 'self', signingSeed: self.seed, ownerPublicKey: owner.publicKey,
  }));
  const auth = currentRelayFrameAuth()!;
  await vi.advanceTimersByTimeAsync(0);
  const signer = new RelayFrameAuthenticator({ crypto, relayId, deviceId: 'peer', seed: peer.seed, ownerPublicKey: owner.publicKey });
  signer.setCertificates([issueRelayDeviceCert(crypto, owner.seed, {
    relayId, deviceId: 'self', publicKey: self.publicKey, role: 'member', issuedAt: 1,
  })]);
  const challenge: Envelope = { v: 1, kind: 'push', id: 'auth-1', src: 'self', dst: 'peer',
    payload: { channel: RELAY_AUTH_CHANNEL, payload: { type: 'request' } } };
  expect(signer.verify({ ...challenge, auth: auth.sign(challenge) })).toBe('ok');
  const frame = { kind: 'push', src: 'peer', dst: 'self', payload: { value: 1 } };
  const signed = () => ({ ...frame, auth: signer.sign(frame) });
  const pending = signed();
  expect(auth.verify(pending)).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  certs = [cert(peer.publicKey)];
  await vi.advanceTimersByTimeAsync(5001);
  expect(auth.verify(pending)).toBe(false);
  expect(auth.verify(pending)).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(0);
  expect(auth.verify(signed())).toBe(true);
  const forged = { ...signed(), payload: { value: 2 } };
  expect(auth.verify(forged)).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
