/**
 * 测试价值
 * - 生产入口与结果：两到三个真实 startAgentNetRelay 副本共用 createMemoryRelayCluster，设备经真实
 *   HTTP / WebSocket 连到任意副本；断言跨副本转发、目录、状态、附件、防重放与分享撤销对设备可见的结果。
 * - Bug／规则依据：2026-11-13 官方 Agent-Net 服务只能单实例运行，无法扩容，也无法用两个副本轮流更新
 *   （同账号设备连到不同副本时数据静默丢弃，两个副本写同一状态文件会互相覆盖）。
 * - 现有覆盖缺口：relay.integration.test.ts 只启动一个进程，覆盖不到账号归属、副本间转交、
 *   副本加入／离开时的交接，以及在另一个副本上做出的撤销。
 * - 最小失败输入：同账号两台设备分别连两个副本后发一个包；负责副本离开后用已用过的签名请求重放；
 *   在非负责副本上暂停一个分享成员。
 * - 本次回归：暂停鉴权后扩容／下线；暂停附件提交后换负责副本并重试同一偏移，且延迟状态通知；
 *   负责副本接住 HTTP／升级却不响应，验证等待有界、已建立的 WebSocket 不被握手超时误关。
 *   延迟状态通知后立即用设备、访客、分享身份与主机证明鉴权，撤权仍拒绝，后端故障返回 503；
 *   使用真实 HTTP 流逐块上传并推进 fake clock 超过 10 秒，验证持续进展不会被响应头期限误切断。
 *   共享状态提交失败时，写请求返回可重试的 503 CLUSTER_STATE_UNAVAILABLE（而不是 500），后端恢复后同一写入成功。
 *   两个 ClusterStore 经每程 1 ms 的 fake-timer 后端争用同一文档：一方持续写入时另一方的单次写入仍能提交；
 *   去掉重试退避（或去掉抖动）后后者 16 次尝试全部落败并返回 STATE_CONTENDED。
 *   已加入的副本在成员名单里找不到负责者（后端自我隔离后名单为空）时以 1012 关闭会话，并对该网络的 HTTP／升级回 503；
 *   恢复为原来的「无名单即承载全部」时，该副本会继续承载新负责副本也在承载的网络。
 *   集群模式未显式配置共享附件目录时拒绝启动（CLUSTER_MEDIA_DIR_REQUIRED），避免各副本落到自己的数据目录；
 *   后端可从包入口取得 checkMemberUrl 校验名单 URL（合法地址通过，非 http(s)、带凭据／路径／查询的地址抛 INVALID_CLUSTER_URL）。
 * - tier：integration；需要真实 socket 和多个副本，单进程 fixture 与 handler mock 都替代不了。
 *   单独成文件是因为每个用例的副本组生命周期与 relay.integration 的单进程 fixture 不同。
 * - 实测耗时：2026-11-14 本机单独运行 `pnpm exec vitest run src/__tests__/cluster.integration.test.ts` 4.32 秒
 *   （测试体 3.71 秒，其中新增的 503 与写入争用两条合计约 50 ms；包含真实 HTTP／WS 资源的关闭确认，不增加真实 sleep）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { SignJWT, createLocalJWKSet } from 'jose';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { API, sharingIdentityPayload, type DelegationRequest, type DeviceCertificate } from '@cindy/agent-net-protocol';
import { AppError } from '@cindy/device-link-sharing/errors';
import { startAgentNetRelay, type RelayHandle, type RelayOptions } from '../server.js';
import { clusterOwner, type RelayClusterBackend, type RelayClusterMember } from '../cluster.js';
import { ClusterStore } from '../clusterStore.js';
import { createMemoryRelayCluster } from '../memoryCluster.js';
import { checkMemberUrl } from '../index.js';
import { generateIdentity, issueCertificate, publicBytes, createRequestProof, createDelegation, sha256, type Identity } from '../identity.js';
import { AgentNetClient, authorization, type AgentNetUplink } from '../client.js';
import { uploadEncryptedMedia, openEncryptedMedia } from '../media.js';
import { createAgentNetSharingAuth } from '../sharingAuth.js';

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const NETWORK = 'account:owner-account';

async function replicaSet(extra: Partial<RelayOptions> = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'cindy-agent-net-cluster-'));
  cleanups.push(async () => {
    if (!path.resolve(base).startsWith(path.join(tmpdir(), 'cindy-agent-net-cluster-'))) throw new Error('UNSAFE_TEST_CLEANUP');
    await rm(base, { recursive: true, force: true });
  });
  const backend = createMemoryRelayCluster();
  const secret = randomBytes(32).toString('base64url');
  const root = generateKeyPairSync('ed25519').privateKey, rootPublicKey = publicBytes(root);
  const identities: Record<string, Identity> = { owner: generateIdentity('owner'), member: generateIdentity('member') };
  const certificates: Record<string, DeviceCertificate> = Object.fromEntries(Object.entries(identities).map(([id, identity]) =>
    [id, issueCertificate(root, { networkId: NETWORK, subject: 'owner-account', identity, role: 'owner' })]));
  const replicas = new Map<string, RelayHandle>();
  const uplinks: AgentNetUplink[] = [];
  const set = {
    backend, identities, certificates, rootPublicKey, uplinks, mediaDir: path.join(base, 'media'),
    async start(replicaId: string) {
      const relay = await startAgentNetRelay({ dataDir: path.join(base, replicaId), mediaDir: set.mediaDir, mode: 'official',
        enroll: async (req) => {
          const c = certificates[String(req.headers['x-test-device'])];
          return { certificate: c, rootPublicKey, networkId: c.networkId, name: 'Account network', deviceName: c.deviceId };
        },
        cluster: { backend, replicaId, secret, drainMs: 0 }, ...extra });
      replicas.set(replicaId, relay);
      cleanups.push(async () => { for (const uplink of uplinks) uplink.close(); await relay.close(); });
      return relay;
    },
    async enroll(relay: RelayHandle, deviceId: string) {
      expect((await fetch(relay.url + API + '/enroll', { method: 'POST', headers: { 'x-test-device': deviceId }, body: '{}' })).status).toBe(200);
    },
    client(relay: RelayHandle, deviceId: string) { return new AgentNetClient(relay.url, identities[deviceId], certificates[deviceId], rootPublicKey); },
    /** The replica serving the account network now, and one that is not. */
    roles() {
      const owner = clusterOwner(NETWORK, backend.members())!;
      const other = backend.members().find(member => member.id !== owner.id)!;
      return { home: replicas.get(owner.id)!, entry: replicas.get(other.id)!, homeId: owner.id };
    },
    /** A replica ID that would own the account network once it joins. */
    joinerTakingOver(prefix: string): string {
      for (let i = 0; ; i++) {
        const id = prefix + i, members: RelayClusterMember[] = [...backend.members(), { id, url: 'http://127.0.0.1:1' }];
        if (clusterOwner(NETWORK, members)!.id === id) return id;
      }
    },
  };
  return set;
}
function nextPacket(uplink: AgentNetUplink): Promise<[string, Uint8Array]> {
  return new Promise((resolve) => uplink.onDatagram((source, packet) => resolve([source, packet])));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function exchange(a: AgentNetUplink, b: AgentNetUplink): Promise<void> {
  const packet = randomBytes(600);
  const received = nextPacket(b); a.send('member', packet);
  expect(await received).toEqual(['owner', packet]);
  const back = nextPacket(a); b.send('owner', packet);
  expect(await back).toEqual(['member', packet]);
}

describe('replicated official relay', () => {
  it('authenticates fresh membership and grants before delayed notifications, preserves revocation and reports outages as retryable', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }), issuer = 'https://identity.example.test';
    const auth = createAgentNetSharingAuth({ issuer }, createLocalJWKSet({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'cluster', alg: 'RS256' }] }));
    const set = await replicaSet({ sharing: auth });
    const pending: Array<() => void> = [];
    const subscribe = set.backend.onChange;
    vi.spyOn(set.backend, 'onChange').mockImplementation(listener => subscribe(entries => { pending.push(() => listener(entries)); }));
    await set.start('replica-a'); await set.start('replica-b');
    const { home, entry } = set.roles();
    await set.enroll(entry, 'owner');
    const identity = set.identities.owner;
    const card = await new SignJWT({ typ: 'identity-card', sub: 'owner-account', device: identity.deviceId,
      region: 'global', purpose: 'network-session', nonce: createHash('sha256')
        .update(sharingIdentityPayload(NETWORK, set.rootPublicKey, identity.deviceId, identity.signingKey)).digest('hex') })
      .setProtectedHeader({ alg: 'RS256', kid: 'cluster' }).setIssuer(issuer).setAudience('cindy-agent-net-sharing')
      .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + 300).sign(pair.privateKey);
    const sharingPath = API + '/sharing/provider-shares';
    const sharingCall = () => fetch(home.url + sharingPath, { headers: {
      authorization: 'AgentNetIdentity ' + Buffer.from(JSON.stringify({ networkId: NETWORK, deviceId: identity.deviceId,
        signingKey: identity.signingKey, card, proof: createRequestProof(identity, 'GET', sharingPath) })).toString('base64url'),
      'x-agent-net-authorization': set.client(home, 'owner').header('GET', sharingPath),
    } });
    // Both scoped identity verification and the certified-host proof read a previously cold network.
    expect((await sharingCall()).status).toBe(200);
    await set.enroll(entry, 'member');
    const owner = set.client(home, 'owner'), member = set.client(entry, 'member');
    const x = await owner.connect(), y = await member.connect(); set.uplinks.push(x, y);
    const commit = vi.spyOn(set.backend, 'commit');
    const beforePackets = commit.mock.calls.length;
    await exchange(x, y);
    expect(commit.mock.calls).toHaveLength(beforePackets);
    const visitor = generateIdentity('lag-visitor');
    const delegation = createDelegation(set.identities.owner, set.certificates.owner,
      { guest: visitor, kind: 'shared-task', resourceId: 'lag-resource' });
    await owner.request('POST', '/grants', { delegation });
    const guest = new AgentNetClient(entry.url, visitor, set.certificates.owner, set.rootPublicKey, delegation);
    await owner.request('DELETE', '/devices/member');
    await home.close();
    // The remaining replica has received neither the grant nor the device revocation event.
    const guestUplink = await guest.connect(); set.uplinks.push(guestUplink);
    expect(await guest.directory()).toHaveLength(1);
    await expect(member.connect()).rejects.toThrow('AGENT_NET_UPGRADE_401');
    const target = API + '/directory';
    commit.mockRejectedValueOnce(new Error('BACKEND_OFFLINE'));
    expect((await fetch(entry.url + target, { headers: { authorization: member.header('GET', target) } })).status).toBe(503);
    commit.mockRejectedValueOnce(new Error('BACKEND_OFFLINE'));
    await expect(set.client(entry, 'owner').connect()).rejects.toThrow('AGENT_NET_UPGRADE_503');
    const nonce = vi.spyOn(set.backend, 'claimNonce').mockRejectedValueOnce(new Error('BACKEND_OFFLINE'));
    await expect(set.client(entry, 'owner').connect()).rejects.toThrow('AGENT_NET_UPGRADE_503');
    nonce.mockRejectedValueOnce(new Error('BACKEND_OFFLINE'));
    const sharingResponse = await fetch(entry.url + sharingPath, { headers: {
      authorization: 'AgentNetIdentity ' + Buffer.from(JSON.stringify({ networkId: NETWORK, deviceId: identity.deviceId,
        signingKey: identity.signingKey, card, proof: createRequestProof(identity, 'GET', sharingPath) })).toString('base64url'),
      'x-agent-net-authorization': set.client(entry, 'owner').header('GET', sharingPath),
    } });
    expect(sharingResponse.status).toBe(503);
    nonce.mockRestore();
    // Late delivery must not roll back the fresher authorization view.
    for (const deliver of pending.splice(0)) deliver();
    await expect(member.directory()).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  it('forwards a continuously progressing binary upload beyond the response-header timeout', async () => {
    const set = await replicaSet();
    await set.start('replica-a'); await set.start('replica-b');
    const { entry } = set.roles();
    const progressed = deferred(), chunks: Buffer[] = [];
    let progress = progressed;
    const receiving = createServer((req, res) => {
      req.on('data', (chunk: Buffer) => { chunks.push(chunk); progress.resolve(); });
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: Buffer.concat(chunks).length })); });
    });
    await new Promise<void>(resolve => receiving.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>(resolve => { receiving.closeAllConnections(); receiving.close(() => resolve()); }));
    await set.backend.join({ id: set.joinerTakingOver('upload-owner-'), url: 'http://127.0.0.1:' + (receiving.address() as AddressInfo).port });
    await new Promise<void>(resolve => setImmediate(resolve));
    const client = set.client(entry, 'owner'), bytes = randomBytes(16_384), target = API + '/media/slow-upload?offset=0';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const request = httpRequest(entry.url + target, { method: 'PUT', headers: { authorization: client.header('PUT', target, bytes),
        'content-type': 'application/octet-stream', 'content-length': bytes.length, 'x-agent-net-content-sha256': sha256(bytes) } });
      cleanups.push(() => { request.destroy(); });
      const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        request.on('error', reject);
        request.on('response', res => { const body: Buffer[] = []; res.on('data', (chunk: Buffer) => body.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(body).toString() })); });
      });
      for (let offset = 0; offset < bytes.length; offset += 1024) {
        const received = progress.promise;
        request.write(bytes.subarray(offset, offset + 1024)); await received;
        progress = deferred();
        await vi.advanceTimersByTimeAsync(750);
      }
      request.end();
      expect(await response).toEqual({ status: 200, body: JSON.stringify({ received: bytes.length }) });
      expect(Buffer.concat(chunks)).toEqual(bytes);
    } finally { vi.useRealTimers(); }
  });

  it.each(['join', 'drain'] as const)('rejects an upgrade whose authentication finishes after ownership changes (%s)', async (change) => {
    const set = await replicaSet();
    const a = await set.start('replica-a'); await set.start('replica-b');
    await set.enroll(a, 'owner'); await set.enroll(a, 'member');
    const { home, entry } = set.roles();
    const authenticating = deferred(), authenticated = deferred(), leaving = deferred(), left = deferred();
    const claim = set.backend.claimNonce;
    const nonce = vi.spyOn(set.backend, 'claimNonce').mockImplementationOnce(async (id, expiresAt) => {
      const accepted = await claim(id, expiresAt);
      authenticating.resolve(); await authenticated.promise; return accepted;
    });
    const leave = set.backend.leave;
    if (change === 'drain') vi.spyOn(set.backend, 'leave').mockImplementationOnce(async (id) => {
      await leave(id); leaving.resolve(); await left.promise;
    });
    const rejected = expect(set.client(home, 'owner').connect()).rejects.toThrow();
    let stopped: Promise<void> | undefined;
    try {
      await authenticating.promise;
      if (change === 'join') {
        await set.start(set.joinerTakingOver('pending-upgrade-'));
        await new Promise<void>(resolve => setImmediate(resolve));
      } else {
        stopped = home.close(); await leaving.promise;
      }
      authenticated.resolve();
      await rejected;
    } finally { authenticated.resolve(); left.resolve(); await stopped; nonce.mockRestore(); }
    const x = await set.client(entry, 'owner').connect(), y = await set.client(entry, 'member').connect();
    set.uplinks.push(x, y); await exchange(x, y);
  });

  it('serializes attachment writes across a handoff and reads fresh offsets even when notifications lag', async () => {
    const set = await replicaSet();
    const a = await set.start('replica-a'); await set.start('replica-b');
    await set.enroll(a, 'owner'); await set.enroll(a, 'member');
    const { home, entry } = set.roles();
    const client = set.client(home, 'owner');
    const upload = await client.request('POST', '/media', { recipient: 'member', size: 4 }) as { id: string };
    const written = deferred(), release = deferred(), contender = deferred();
    const commit = set.backend.commit;
    vi.spyOn(set.backend, 'commit').mockImplementation(async input => {
      if (input.writes.some(write => (write.value as any)?.media?.[upload.id]?.received === 2)) {
        written.resolve(); await release.promise;
      }
      return commit(input);
    });
    const subscribe = set.backend.onChange;
    vi.spyOn(set.backend, 'onChange').mockImplementation(listener => subscribe(entries => {
      // The new owner's replica must not rely on receiving this event before granting its lock.
      if (!entries.some(item => (item.value as any)?.media?.[upload.id]?.received === 2)) listener(entries);
    }));
    const lock = set.backend.withMediaLock;
    let attempts = 0;
    vi.spyOn(set.backend, 'withMediaLock').mockImplementation((network, id, work) => {
      if (id === upload.id && ++attempts === 2) contender.resolve();
      return lock(network, id, work);
    });
    const first = client.request('PUT', '/media/' + upload.id, { offset: 0, data: Buffer.from('AB').toString('base64url') });
    try {
      await written.promise;
      await set.start(set.joinerTakingOver('media-handoff-'));
      await new Promise<void>(resolve => setImmediate(resolve));
      const conflict = expect(set.client(entry, 'owner').request('PUT', '/media/' + upload.id,
        { offset: 0, data: Buffer.from('XY').toString('base64url') })).rejects.toMatchObject({ code: 'MEDIA_OFFSET_MISMATCH' });
      await contender.promise;
      release.resolve();
      await expect(first).resolves.toMatchObject({ received: 2 }); await conflict;
      expect(await readFile(path.join(set.mediaDir, upload.id), 'utf8')).toBe('AB');
      await set.client(entry, 'owner').request('PUT', '/media/' + upload.id, { offset: 2, data: Buffer.from('CD').toString('base64url') });
      const recipient = set.client(entry, 'member'), target = API + '/media/' + upload.id;
      const downloaded = await fetch(entry.url + target, { headers: { authorization: recipient.header('GET', target) } });
      expect(downloaded.status).toBe(200); expect(await downloaded.text()).toBe('ABCD');
    } finally { release.resolve(); await first; }
  });

  it('bounds HTTP and WebSocket handshake waits when the owning replica stops answering', async () => {
    const set = await replicaSet();
    const a = await set.start('replica-a'); await set.start('replica-b');
    await set.enroll(a, 'owner'); await set.enroll(a, 'member');
    const { entry } = set.roles();
    const httpEntered = deferred(), upgradeEntered = deferred(), backendClosed = deferred();
    const sockets = new Set<Duplex>();
    const stalled = createServer(() => httpEntered.resolve());
    stalled.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    stalled.on('upgrade', (_req, socket) => {
      socket.once('close', backendClosed.resolve);
      // HTTP upgrade sockets are half-open: acknowledge EOF so the fixture closes its own side too.
      socket.once('end', () => { backendClosed.resolve(); socket.end(); });
      socket.resume(); upgradeEntered.resolve();
    });
    await new Promise<void>(resolve => stalled.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => stalled.close(() => resolve())); });
    const stalledId = set.joinerTakingOver('stalled-owner-');
    await set.backend.join({ id: stalledId, url: 'http://127.0.0.1:' + (stalled.address() as AddressInfo).port });
    await new Promise<void>(resolve => setImmediate(resolve));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const client = set.client(entry, 'owner'), target = API + '/directory';
      const response = fetch(entry.url + target, { headers: { authorization: client.header('GET', target) } });
      await httpEntered.promise; await vi.advanceTimersByTimeAsync(10_001);
      expect((await response).status).toBe(503);
      // AgentNetClient has its own 10 s timeout: using it here would mask a missing relay deadline.
      const wsPath = API + '/ws';
      const ws = new WebSocket(entry.url.replace(/^http/, 'ws') + wsPath, { headers: { authorization: client.header('GET', wsPath) } });
      ws.on('error', () => undefined);
      cleanups.push(() => ws.terminate());
      const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
      await upgradeEntered.promise; await vi.advanceTimersByTimeAsync(10_001);
      await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
      expect(await closed).toBe(1006);
      let backendEnded = false;
      void backendClosed.promise.then(() => { backendEnded = true; });
      await vi.waitFor(() => expect(backendEnded).toBe(true));
      await set.backend.leave(stalledId);
      await new Promise<void>(resolve => setImmediate(resolve));
      const x = await client.connect(), y = await set.client(entry, 'member').connect();
      set.uplinks.push(x, y);
      await vi.advanceTimersByTimeAsync(10_001);
      await exchange(x, y);
    } finally { vi.useRealTimers(); }
  });

  it('serves one account on one replica whichever replica each device reaches, and shares state', async () => {
    const set = await replicaSet();
    const a = await set.start('replica-a'), b = await set.start('replica-b');
    // Enrollment carries no network routing key: both replicas write the same network at once,
    // and neither device may be lost (one shared state file used to keep the last writer only).
    await Promise.all([set.enroll(a, 'owner'), set.enroll(b, 'member')]);
    const { home, entry } = set.roles();
    const owner = set.client(home, 'owner'), member = set.client(entry, 'member');
    const x = await owner.connect(), y = await member.connect(); set.uplinks.push(x, y);
    await exchange(x, y);
    y.presence(true, ['tasks'], { platform: 'ios' });
    await vi.waitFor(async () => expect((await set.client(entry, 'owner').directory()).map(d => [d.certificate.deviceId, d.online]))
      .toEqual([['owner', true], ['member', true]]));
    // A write through one replica is what the other serves next.
    await member.request('PATCH', '/devices/owner', { name: 'Desk' });
    expect((await owner.directory()).find(d => d.certificate.deviceId === 'owner')).toMatchObject({ name: 'Desk', online: true });
    // Signed requests stay single-use whichever replica they are replayed to.
    const signedPath = API + '/directory', header = authorization(set.identities.member, set.certificates.member, 'GET', signedPath);
    expect((await fetch(home.url + signedPath, { headers: { authorization: header } })).status).toBe(200);
    const replay = await fetch(entry.url + signedPath, { headers: { authorization: header } });
    expect(replay.status).toBe(401); expect(await replay.json()).toMatchObject({ error: { code: 'REQUEST_REPLAYED' } });
  });

  it('keeps an account working while replicas join and leave, without losing state, attachments or replay history', async () => {
    const set = await replicaSet();
    const a = await set.start('replica-a'); await set.start('replica-b');
    await set.enroll(a, 'owner'); await set.enroll(a, 'member');
    const { entry } = set.roles();
    // Devices keep the address they know; ownership moves underneath it.
    const owner = set.client(entry, 'owner'), member = set.client(entry, 'member');
    let x = await owner.connect(), y = await member.connect(); set.uplinks.push(x, y);
    await exchange(x, y);
    const plain = randomBytes(70_000);
    const uploaded = await uploadEncryptedMedia(owner, 'member', set.identities.member.transportKey, plain.length,
      async (offset, size) => plain.subarray(offset, offset + size));
    await member.request('PATCH', '/devices/owner', { name: 'Desk' });

    // Scale out: the joining replica takes the account over; its devices are told to reconnect.
    let closed = [once(x, 'close'), once(y, 'close')];
    const joinerId = set.joinerTakingOver('replica-new-');
    const joiner = await set.start(joinerId);
    expect((await Promise.all(closed)).map(([code]) => code)).toEqual([1012, 1012]);
    x = await owner.connect(); y = await member.connect(); set.uplinks.push(x, y);
    expect(set.roles().homeId).toBe(joinerId);
    await exchange(x, y);
    // Accepted by the joiner; after it leaves, a different replica must still refuse it.
    const signedPath = API + '/directory', header = authorization(set.identities.owner, set.certificates.owner, 'GET', signedPath);
    expect((await fetch(entry.url + signedPath, { headers: { authorization: header } })).status).toBe(200);

    // Rolling update: the owner leaves first, then its devices reconnect to a remaining replica.
    closed = [once(x, 'close'), once(y, 'close')];
    await joiner.close();
    expect((await Promise.all(closed)).map(([code]) => code)).toEqual([1012, 1012]);
    x = await owner.connect(); y = await member.connect(); set.uplinks.push(x, y);
    await exchange(x, y);
    expect((await member.directory()).find(d => d.certificate.deviceId === 'owner')).toMatchObject({ name: 'Desk', online: true });
    const opened = await openEncryptedMedia(member, uploaded.id, uploaded.headerSha256, undefined, 'application/octet-stream');
    expect(createHash('sha256').update(Buffer.from(await opened.arrayBuffer())).digest()).toEqual(createHash('sha256').update(plain).digest());
    const replay = await fetch(entry.url + signedPath, { headers: { authorization: header } });
    expect(replay.status).toBe(401); expect(await replay.json()).toMatchObject({ error: { code: 'REQUEST_REPLAYED' } });
  });

  // A sharing request authenticated by an account identity has no device routing key; a guest on the
  // host's replica must still lose access the moment another replica commits the revocation.
  it('applies a sharing revocation made on another replica to the live guest session and reports host presence', async () => {
    // CI #10446: independent requestedAt/expiresAt clock reads could exceed
    // the protocol's 30-minute maximum by 1ms and make the host reject its directory.
    // Advance on every read to expose that boundary without a real-time race.
    let at = Date.now();
    const actors = { 'Bearer unit-owner': { accountId: 'owner-account', deviceId: 'owner' },
      'Bearer unit-guest': { accountId: 'guest-account', deviceId: 'external-visitor' } };
    const set = await replicaSet({ now: () => at++, sharing: {
      async authenticate(req) { const actor = actors[req.headers.authorization as keyof typeof actors];
        if (!actor) throw new AppError('UNAUTHORIZED', 401, 'Unit auth rejected'); return { ...actor, networkId: NETWORK }; },
      providers: { hostCapability: 'provider-share-v1', identityCards: {
        async verify(card) { if (card !== 'unit-verified-card') throw new AppError('PROVIDER_SHARE_IDENTITY_INVALID', 400, 'Invalid fixture card');
          return { displayName: 'Unit verified person', avatarUrl: null, region: 'global' as const }; },
        async inspect() { throw new Error('No cross-region fixture'); },
      } },
    } });
    const a = await set.start('replica-a'); await set.start('replica-b');
    await set.enroll(a, 'owner');
    const { home, entry } = set.roles();
    const host = set.client(home, 'owner'), visitor = generateIdentity('external-visitor');
    const call = async (target: string, method: string, input: unknown, owner = false, proof = owner, applicant = false) => {
      const resource = API + '/sharing' + target, body = input === undefined ? '' : JSON.stringify(input);
      const response = await fetch(entry.url + resource, { method, headers: {
        authorization: owner ? 'Bearer unit-owner' : 'Bearer unit-guest', ...(body ? { 'content-type': 'application/json' } : {}),
        ...(proof ? { 'x-agent-net-authorization': host.header(method, resource, body) } : {}),
        ...(applicant ? { 'x-agent-net-applicant': Buffer.from(JSON.stringify(createRequestProof(visitor, method, resource, body))).toString('base64url') } : {}),
      }, ...(body ? { body } : {}) });
      return { status: response.status, body: await response.json() as any };
    };
    const hostUplink = await host.connect(); set.uplinks.push(hostUplink);
    hostUplink.presence(true, ['provider-share-v1']);
    const link = await call('/provider-shares/links', 'POST', { providerId: 'unit-provider', providerLabel: 'Provider', deviceName: 'Host', identityCard: 'unit-verified-card' }, true);
    expect(link.status).toBe(200);
    const asked = await call('/provider-shares/requests', 'POST', { invitation: link.body.invitation, identityCard: 'unit-verified-card' });
    const approved = await call('/provider-shares/requests/' + asked.body.requestId + '/approve', 'POST', {}, true);
    expect(approved.status).toBe(200);
    // Host presence lives on the host network's replica, not the one answering the guest.
    await vi.waitFor(async () => expect((await call('/provider-shares/received', 'GET', undefined)).body.shares[0])
      .toMatchObject({ hostOnline: true, hostCapable: true }));
    const submitted = await call('/transport', 'POST', { kind: 'provider-share', resourceId: link.body.shareId, memberId: approved.body.memberId,
      signingKey: visitor.signingKey, transportKey: visitor.transportKey }, false, false, true);
    expect(submitted.body.status).toBe('pending');
    // The request was committed elsewhere; the host's replica republishes the directory to the host.
    await vi.waitFor(() => expect(hostUplink.delegationRequests).toHaveLength(1));
    const requested: DelegationRequest = hostUplink.delegationRequests[0];
    const delegation = await host.acceptDelegationRequest(requested, () => undefined);
    const guest = new AgentNetClient(entry.url, visitor, set.certificates.owner, set.rootPublicKey, delegation);
    const guestUplink = await guest.connect(); set.uplinks.push(guestUplink);
    const closed = once(guestUplink, 'close');
    expect((await call('/provider-shares/members/' + approved.body.memberId + '/pause', 'POST', {}, true)).status).toBe(200);
    expect(await closed).toEqual([4410]);
    await expect(guest.directory()).rejects.toMatchObject({ code: 'GRANT_INVALID' });
  });
});

// A replica without an explicit shared attachment directory would default to its own data directory and lose
// attachments on every handover. Minimal failing input: cluster options without mediaDir.
describe('replicated official relay: configuration', () => {
  it('refuses to start a replica without an explicit shared attachment directory', async () => {
    const set = await replicaSet({ mediaDir: undefined });
    await expect(set.start('replica-a')).rejects.toThrow('CLUSTER_MEDIA_DIR_REQUIRED');
  });
  it('lets a backend check member URLs through the package entry before publishing them', () => {
    expect(checkMemberUrl('http://10.0.0.7:3348/').host).toBe('10.0.0.7:3348');
    for (const bad of ['not a url', 'ftp://10.0.0.7/', 'http://user:pass@10.0.0.7/', 'http://10.0.0.7/path', 'http://10.0.0.7/?q=1'])
      expect(() => checkMemberUrl(bad), bad).toThrow('INVALID_CLUSTER_URL');
  });
});

// A replica that fenced itself (its own lease lapsed) and found nobody else in the member list must stop serving,
// not fall back to single-process ownership while a new owner takes over.
// Minimal failing input: one joined replica whose backend member list becomes empty.
describe('replicated official relay: ownerless networks', () => {
  it('closes sessions and refuses the network once the joined replica finds no owner in its member list', async () => {
    const set = await replicaSet();
    const a = await set.start('replica-a');
    await set.enroll(a, 'owner');
    const uplink = await set.client(a, 'owner').connect(); set.uplinks.push(uplink);
    const closed = once(uplink, 'close');
    await set.backend.leave('replica-a');
    expect((await closed)[0]).toBe(1012);
    await expect(set.client(a, 'owner').connect()).rejects.toThrow('AGENT_NET_UPGRADE_503');
    await expect(set.client(a, 'owner').directory()).rejects.toMatchObject({ status: 503, code: 'REPLICA_UNAVAILABLE' });
    // Back in the list: it serves again.
    await set.backend.join({ id: 'replica-a', url: a.url });
    await vi.waitFor(async () => { const again = await set.client(a, 'owner').connect(); set.uplinks.push(again); });
  });
});

// A write whose shared-state commit cannot complete is a retryable outage (503), not an internal error (500).
// Minimal failing input: the backend rejects the commit of an authenticated rename.
describe('replicated official relay: retryable write outages', () => {
  it('answers 503 CLUSTER_STATE_UNAVAILABLE, not 500, when a write cannot be committed, and recovers', async () => {
    const set = await replicaSet();
    const a = await set.start('replica-a');
    await set.enroll(a, 'owner');
    const commit = set.backend.commit.bind(set.backend);
    const spy = vi.spyOn(set.backend, 'commit').mockImplementation(async input => {
      if (input.writes.length) throw new Error('unit backend down');
      return commit(input);
    });
    await expect(set.client(a, 'owner').request('PATCH', '/devices/owner', { name: 'Desk' }))
      .rejects.toMatchObject({ status: 503, code: 'CLUSTER_STATE_UNAVAILABLE' });
    spy.mockRestore();
    expect(await set.client(a, 'owner').request('PATCH', '/devices/owner', { name: 'Desk' })).toMatchObject({ name: 'Desk' });
  });
});

// Optimistic retries alone starve a replica: the one that just committed starts its next commit a round
// trip ahead of the one that lost. Minimal failing input: one store rewrites a document continuously over
// a backend with 1 ms per leg; without a growing, jittered pause the other store's single write loses all
// 16 attempts. Fixed backoff without jitter stays in phase with the writer and still loses.
describe('replicated official relay: write contention', () => {
  it('commits a single write while another replica keeps writing the same document', async () => {
    vi.useFakeTimers();
    // Deterministic jitter, so the outcome does not depend on the run.
    let seed = 1;
    vi.spyOn(Math, 'random').mockImplementation(() => (seed = seed * 16_807 % 2_147_483_647) / 2_147_483_647);
    const base = createMemoryRelayCluster();
    const leg = () => new Promise(resolve => setTimeout(resolve, 1));
    const backend: RelayClusterBackend = { ...base, async commit(input) { await leg(); const result = await base.commit(input); await leg(); return result; } };
    const [busy, single] = await Promise.all([ClusterStore.open(backend, 'busy'), ClusterStore.open(backend, 'single')]);
    let stop = false;
    const writer = (async () => {
      for (let n = 0; !stop; n++) await busy.transaction((state) => { state.primaryNetworkId = 'busy-' + n; });
    })();
    await vi.advanceTimersByTimeAsync(7);
    const outcome = single.transaction((state) => { state.primaryNetworkId = 'single'; })
      .then(() => 'committed', (error: Error) => error.message).finally(() => { stop = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toBe('committed');
    await writer;
    busy.close(); single.close();
  });
});
