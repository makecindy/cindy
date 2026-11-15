/**
 * 测试价值
 * - 生产入口与可观察结果：手机加入流程用的 `mobileRelayAuthCrypto`(@noble)经 `createRelayJoinIdentity` /
 *   `acceptRelayDeviceCert` 加入,DeviceLinkClient 的 `currentSelfHostedRelayFrameAuth()` 给对端帧签名;
 *   电脑端(node:crypto)核对配对证明、签发证书,并用 `RelayFrameAuthenticator` 判定手机签名的帧为 'ok'、
 *   篡改内容的帧为 'bad-signature';不是链接里主人签发的证书在手机上被拒(OWNER_MISMATCH);官方中转不签名。
 * - Bug／规则依据：docs/self-hosted-relay-plan.md §16 设备签名。手机与电脑是两套 Ed25519 / SHA-256 / HMAC /
 *   UTF-8 实现,任何一处字节差异都会让电脑丢弃手机发出的全部消息(自建中转下手机整体不可用)或让手机加入失败。
 * - 现有覆盖缺口：packages/device-link 的签名测试两端都用 node:crypto,不覆盖 @noble 实现与跨实现兼容。
 * - 最小失败输入：一条内容含中文与 emoji 的 invoke 帧(纯 JS UTF-8 编码 vs node Buffer 编码)。
 * - tier：unit(纯计算,node 环境;expo-crypto 的随机数换成 node:crypto)。
 * - 实测耗时：单独运行 1.8 秒,用例本身 38ms(apps/mobile 下 npx vitest run src/__tests__/selfHostedRelaySignatures.test.ts)。
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  acceptRelayDeviceCert,
  createRelayJoinIdentity,
  createRelayPairSecret,
  createRelaySigningKey,
  DeviceLinkClient,
  issueRelayDeviceCert,
  PROTOCOL_VERSION,
  RELAY_AUTH_CHANNEL,
  RelayFrameAuthenticator,
  verifyRelayPairProof,
  type Envelope,
  type RelayJoinLink,
  type WsLike,
} from '@cindy/device-link';
import { nodeRelayAuthCrypto } from '@cindy/device-link/node-relay-crypto';

vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)) }));

import { mobileRelayAuthCrypto } from '@/device-link/relayAuthCrypto';
import { currentSelfHostedRelayFrameAuth } from '@/device-link/selfHostedRelayFrameAuth';
import { __testing as relayRouting, setActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ certs: [] }), { status: 200 })));
});
afterEach(() => {
  relayRouting.reset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('phone (@noble) and computer (node:crypto) accept each other’s pairing proof, certificate and frame signatures', async () => {
  const relayId = 'relay-7f3c';
  const phoneId = 'phone-1';
  const computerId = 'computer-1';
  const owner = createRelaySigningKey(nodeRelayAuthCrypto);
  const link: RelayJoinLink = {
    baseUrl: 'https://relay.home.example',
    code: 'C'.repeat(32),
    ownerPublicKey: owner.publicKey,
    pairSecret: createRelayPairSecret(nodeRelayAuthCrypto),
  };

  // 加入:手机生成密钥与配对证明,主人电脑核对后签发证书,手机用链接里的主人公钥核对。
  const identity = createRelayJoinIdentity(mobileRelayAuthCrypto, link, relayId, phoneId);
  expect(verifyRelayPairProof(nodeRelayAuthCrypto, link.pairSecret, {
    relayId, deviceId: phoneId, publicKey: identity.publicKey, proof: identity.proof,
  })).toBe(true);
  const certFields = { relayId, deviceId: phoneId, publicKey: identity.publicKey, role: 'member' as const, issuedAt: 1 };
  const cert = issueRelayDeviceCert(nodeRelayAuthCrypto, owner.seed, certFields);
  const accept = { relayId, deviceId: phoneId, publicKey: identity.publicKey };
  expect(acceptRelayDeviceCert(mobileRelayAuthCrypto, link, { ...accept, cert })).toEqual(cert);
  // 被替换的中转自己签的证书:手机不加入。
  const forged = issueRelayDeviceCert(nodeRelayAuthCrypto, createRelaySigningKey(nodeRelayAuthCrypto).seed, certFields);
  expect(() => acceptRelayDeviceCert(mobileRelayAuthCrypto, link, { ...accept, cert: forged }))
    .toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));

  // 官方中转:不签名。
  expect(currentSelfHostedRelayFrameAuth()).toBeNull();

  // 自建中转:手机签名,电脑(node:crypto)核对。
  setActiveSelfHostedRelay({
    relayId,
    name: 'Home',
    baseUrl: link.baseUrl,
    credential: 'relay-credential',
    signing: { deviceId: phoneId, ownerPublicKey: owner.publicKey, seed: identity.seed },
  });
  const computerKey = createRelaySigningKey(nodeRelayAuthCrypto);
  const computerCert = issueRelayDeviceCert(nodeRelayAuthCrypto, owner.seed, {
    relayId, deviceId: computerId, publicKey: computerKey.publicKey, role: 'member', issuedAt: 1,
  });
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ certs: [computerCert] }), { status: 200 }));
  const phone = currentSelfHostedRelayFrameAuth()!;
  const computer = new RelayFrameAuthenticator({
    crypto: nodeRelayAuthCrypto,
    relayId,
    deviceId: computerId,
    seed: computerKey.seed,
    ownerPublicKey: owner.publicKey,
  });
  expect(computer.setCertificates([cert])).toEqual({ accepted: 1, rejected: 0 });
  const challenge: Envelope = { v: PROTOCOL_VERSION, kind: 'push', id: 'auth-1', src: phoneId, dst: computerId,
    payload: { channel: RELAY_AUTH_CHANNEL, payload: { type: 'request' } } };
  expect(computer.verify({ ...challenge, auth: phone.sign(challenge) })).toBe('ok');
  const response: Envelope = { ...challenge, src: computerId, dst: phoneId,
    payload: { channel: RELAY_AUTH_CHANNEL, payload: { type: 'response' } } };
  await vi.waitFor(() => expect(phone.verify({ ...response, auth: computer.sign(response) })).toBe(true));

  // 手机发出时没有 src,中转转发时填上。
  const invoke = (args: unknown[]): Envelope => ({
    v: PROTOCOL_VERSION, kind: 'invoke', id: 'req-1', dst: computerId, payload: { channel: 'maker:send', args },
  });
  const delivered = (frame: Envelope) => ({ ...frame, src: phoneId, auth: phone.sign(frame) });
  expect(computer.verify(delivered(invoke(['继续 👋'])))).toBe('ok');
  const tampered = delivered(invoke(['继续 👋']));
  expect(computer.verify({ ...tampered, payload: { channel: 'maker:send', args: ['tampered'] } })).toBe('bad-signature');
});

class RelaySocket implements WsLike {
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  send(): void {}
  close(): void {}
  on(event: string, callback: (...args: never[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback as (...args: unknown[]) => void]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const callback of this.handlers.get(event) ?? []) callback(...args);
  }
  push(frame: unknown): void { this.emit('message', { toString: () => JSON.stringify(frame) }); }
}

function incomingFixture() {
  const owner = createRelaySigningKey(nodeRelayAuthCrypto);
  const peer = createRelaySigningKey(nodeRelayAuthCrypto);
  const phone = createRelaySigningKey(mobileRelayAuthCrypto);
  const route = {
    relayId: 'relay-consent', name: 'Home', baseUrl: 'https://relay.home.example', credential: 'relay-credential',
    signing: { deviceId: 'phone-1', ownerPublicKey: owner.publicKey, seed: phone.seed },
  };
  const cert = (publicKey: string, signerSeed = owner.seed) => issueRelayDeviceCert(nodeRelayAuthCrypto, signerSeed, {
    relayId: route.relayId, deviceId: 'computer-1', publicKey, role: 'member', issuedAt: 1,
  });
  const sender = (seed = peer.seed) => {
    const auth = new RelayFrameAuthenticator({
      crypto: nodeRelayAuthCrypto, relayId: route.relayId, deviceId: 'computer-1', seed, ownerPublicKey: owner.publicKey,
    });
    auth.setCertificates([issueRelayDeviceCert(nodeRelayAuthCrypto, owner.seed, {
      relayId: route.relayId, deviceId: 'phone-1', publicKey: phone.publicKey, role: 'member', issuedAt: 1,
    })]);
    const challenge: Envelope = { v: PROTOCOL_VERSION, kind: 'push', id: 'auth-1', src: 'phone-1', dst: 'computer-1',
      payload: { channel: RELAY_AUTH_CHANNEL, payload: { type: 'request' } } };
    auth.verify({ ...challenge, auth: currentSelfHostedRelayFrameAuth()!.sign(challenge) });
    return auth;
  };
  const signed = (auth: RelayFrameAuthenticator, payload: unknown): Envelope => {
    const frame = { v: PROTOCOL_VERSION, kind: 'push' as const, src: 'computer-1', dst: 'phone-1', payload };
    return { ...frame, auth: auth.sign(frame) } as Envelope;
  };
  return { route, peer, cert, sender, signed };
}

// #7722 discussion_r4402815051:中转保留真实请求 ID 却替换审批文案，手机不得把它分发给 UI。
// 真实 DeviceLinkClient + 手机 frameAuth；现有跨实现用例仅验证出站。最小输入为一条篡改权限 push，tier: unit。
it('dispatches only owner-certified, untampered permission frames and rejects replays', async () => {
  const f = incomingFixture();
  const attacker = createRelaySigningKey(nodeRelayAuthCrypto);
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
    certs: [f.cert(f.peer.publicKey), f.cert(attacker.publicKey, attacker.seed)],
  }), { status: 200 }));
  setActiveSelfHostedRelay(f.route);
  const auth = currentSelfHostedRelayFrameAuth()!;
  const peer = f.sender();
  await vi.waitFor(() => expect(auth.verify(f.signed(peer, { probe: true }) as unknown as Record<string, unknown>)).toBe(true));
  const ws = new RelaySocket();
  const client = new DeviceLinkClient({
    getWsUrl: () => 'wss://relay.home.example/api/device-link/ws',
    getToken: async () => 'relay-credential',
    authorizationScheme: 'CindyRelay',
    getHello: () => ({ deviceName: 'Phone', platform: 'ios', appVersion: '1', remoteControlEnabled: false, busy: false }),
    createWebSocket: () => ws,
    frameAuth: currentSelfHostedRelayFrameAuth,
  });
  const received: unknown[] = [];
  client.onFrame(frame => { if (frame.kind === 'push') received.push(frame.payload); });
  try {
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    ws.emit('open');
    ws.push({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: { serverProtocolVersion: PROTOCOL_VERSION, deviceId: 'phone-1', userId: 'u1', capabilities: [] } });
    const real = { channel: 'maker:interaction-request', payload: { request: { id: 'request-1', kind: 'permission', command: 'dangerous command' } } };
    const genuine = f.signed(peer, real);
    ws.push({ ...genuine, auth: undefined });
    ws.push(f.signed(f.sender(attacker.seed), real));
    ws.push({ ...genuine, payload: { ...real, payload: { request: { ...real.payload.request, command: 'harmless command' } } } });
    ws.push(genuine);
    ws.push(genuine);
    expect(received).toEqual([real]);
    expect(fetch).toHaveBeenCalledWith('https://relay.home.example/api/device-link/relay/certs', expect.objectContaining({
      headers: { Authorization: 'CindyRelay relay-credential' },
    }));
  } finally {
    client.stop();
  }
});

// 同一设备重新加入换密钥时刷新证书；无证书/刷新失败都保持拒绝，不重启共享连接。
it('refreshes rotated signer certificates with throttling and fails closed on fetch errors', async () => {
  const f = incomingFixture();
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ certs: [f.cert(f.peer.publicKey)] }), { status: 200 }));
  setActiveSelfHostedRelay(f.route);
  const auth = currentSelfHostedRelayFrameAuth()!;
  await vi.waitFor(() => expect(auth.verify(f.signed(f.sender(), {}) as unknown as Record<string, unknown>)).toBe(true));
  const replacement = createRelaySigningKey(nodeRelayAuthCrypto);
  const sender = f.sender(replacement.seed);
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(auth.verify(f.signed(sender, {}) as unknown as Record<string, unknown>)).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 3; i++) expect(auth.verify(f.signed(sender, {}) as unknown as Record<string, unknown>)).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ certs: [f.cert(replacement.publicKey)] }), { status: 200 }));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(auth.verify(f.signed(sender, {}) as unknown as Record<string, unknown>)).toBe(false);
  await vi.waitFor(() => expect(auth.verify(f.signed(sender, {}) as unknown as Record<string, unknown>)).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(3);
});

// 切账号/中转后，旧请求的证书不能写入新路由，也不能恢复已失效的验签实例。
it('discards late certificate replies after credentials or the selected relay change', async () => {
  const f = incomingFixture();
  let reply!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  setActiveSelfHostedRelay(f.route);
  const old = currentSelfHostedRelayFrameAuth()!;
  setActiveSelfHostedRelay({ ...f.route, credential: 'new-relay-credential' });
  const current = currentSelfHostedRelayFrameAuth()!;
  expect(current).not.toBe(old);
  reply(new Response(JSON.stringify({ certs: [f.cert(f.peer.publicKey)] }), { status: 200 }));
  await vi.advanceTimersByTimeAsync(0);
  const frame = f.signed(f.sender(), {}) as unknown as Record<string, unknown>;
  expect(old.verify(frame)).toBe(false);
  expect(current.verify(frame)).toBe(false);
  setActiveSelfHostedRelay(null);
  expect(currentSelfHostedRelayFrameAuth()).toBeNull();
});
