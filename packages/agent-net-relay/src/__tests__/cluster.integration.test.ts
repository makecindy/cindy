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
 * - tier：integration；需要真实 socket 和多个副本，单进程 fixture 与 handler mock 都替代不了。
 *   单独成文件是因为每个用例的副本组生命周期与 relay.integration 的单进程 fixture 不同。
 * - 实测耗时：2026-11-13 本机单独运行 `pnpm exec vitest run src/__tests__/cluster.integration.test.ts` 约 0.9 秒。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { API, type DelegationRequest, type DeviceCertificate } from '@cindy/agent-net-protocol';
import { AppError } from '@cindy/device-link-sharing/errors';
import { startAgentNetRelay, type RelayHandle, type RelayOptions } from '../server.js';
import { clusterOwner, type RelayClusterMember } from '../cluster.js';
import { createMemoryRelayCluster } from '../memoryCluster.js';
import { generateIdentity, issueCertificate, publicBytes, createRequestProof, type Identity } from '../identity.js';
import { AgentNetClient, authorization, type AgentNetUplink } from '../client.js';
import { uploadEncryptedMedia, openEncryptedMedia } from '../media.js';

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
  cleanups.push(() => { for (const uplink of uplinks) uplink.close(); });
  const set = {
    backend, identities, certificates, rootPublicKey, uplinks, mediaDir: path.join(base, 'media'),
    async start(replicaId: string) {
      const relay = await startAgentNetRelay({ dataDir: path.join(base, replicaId), mediaDir: set.mediaDir, mode: 'official',
        enroll: async (req) => {
          const c = certificates[String(req.headers['x-test-device'])];
          return { certificate: c, rootPublicKey, networkId: c.networkId, name: 'Account network', deviceName: c.deviceId };
        },
        cluster: { backend, replicaId, secret, drainMs: 0 }, ...extra });
      replicas.set(replicaId, relay); cleanups.push(() => relay.close());
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
async function exchange(a: AgentNetUplink, b: AgentNetUplink): Promise<void> {
  const packet = randomBytes(600);
  const received = nextPacket(b); a.send('member', packet);
  expect(await received).toEqual(['owner', packet]);
  const back = nextPacket(a); b.send('owner', packet);
  expect(await back).toEqual(['member', packet]);
}

describe('replicated official relay', () => {
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
    const actors = { 'Bearer unit-owner': { accountId: 'owner-account', deviceId: 'owner' },
      'Bearer unit-guest': { accountId: 'guest-account', deviceId: 'external-visitor' } };
    const set = await replicaSet({ sharing: {
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
