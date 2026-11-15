/**
 * 测试价值
 * - 生产入口与结果：真实 HTTP / WebSocket / UDP 上启动 startAgentNetRelay，验证自主配对、隔离、加密附件与重启。
 * - 规则依据：agent-net 产品规则「V2 自建与本机中转的完整能力」；官方服务不可成为自建模式的依赖。
 * - 覆盖缺口：旧 relay 只覆盖 V1；Rust 仿真不包含身份目录、分享授权或服务端存储。
 * - 最小失败输入：重启后下载一个附件；访客向非授权主机发一个包；重复发送同一签名请求。
 * - 附件直传（2026-11-14）：中转注入可直传的对象存储（本地 HTTP 内存对象库，按位置追加、校验 Content-MD5 与签名、
 *   支持 Range）时，新客户端上传和下载的密文都不经中转；新旧客户端交叉上传/下载均可用；只有所有者能取得上传地址，
 *   偏移、MD5 与超长对象被拒；存储写成功但回复丢失时由中转按存储长度确认；缓存的下载地址失效后重新向中转申请；
 *   中转给出的不安全存储请求被客户端拒绝；存储不可达时（含经中转下载）返回可重试的 503 MEDIA_STORAGE_UNAVAILABLE；
 *   删除前签发、删除后才到达的写入由过期清理在授权失效后删除；客户端连不上存储时上传下载回退到中转。
 *   最小失败输入：1 MiB + 5311 字节附件，跨 AEAD 块边界 seek；删除后再用旧地址写入第一块。
 * - tier：integration，必须经真实本地 socket 与临时磁盘，禁止用 handler mock 代替。
 * - 实测耗时：2026-11-14 本机整文件约 13 秒（真实 socket 与磁盘的集成用例；附件直传部分约 2 秒）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { MEDIA_TRANSFER_DIRECT, MEDIA_TRANSFER_HEADER } from '@cindy/agent-net-protocol';
import { DIRECT_GRANT_MAX_MS, RelayMediaStorageError, type RelayMediaStorage } from '../mediaStorage.js';
import WebSocket from 'ws';
import { API, encodeDatagrams, sharingOriginsPayload, delegationPayload, MAX_CONTROL_BYTES } from '@cindy/agent-net-protocol';
import { startAgentNetRelay, type Bootstrap, type RelayHandle, type RelayOptions } from '../server.js';
import { generateIdentity, issueCertificate, publicBytes, createJoinRequest, approveJoin, createDelegation, createRequestProof, signature, type Identity,
  createTenantJoinRequest, verifyTenantPairingProof, tenantVerifyCode } from '../identity.js';
import { AppError } from '@cindy/device-link-sharing/errors';
import { AgentNetClient, authorization, submitJoin, pollJoin, submitTenantJoin, pollTenantJoin, encryptMedia, decryptMedia, type AgentNetUplink } from '../client.js';
import { uploadEncryptedMedia, openEncryptedMedia } from '../media.js';
import { createHash } from 'node:crypto';

// Integration: HTTPS and UDP can sit behind different load balancers. /info must
// name the UDP host only when configured, and a malformed host must stop startup.
it('advertises a configured STUN host next to the bound UDP port', async () => {
  const plain = await fixture();
  const plainInfo = await (await fetch(plain.relay.url + API + '/info')).json() as Record<string, unknown>;
  expect(plainInfo.udpPort).toBe(plain.relay.udpAddress?.port); expect(plainInfo).not.toHaveProperty('stunHost');
  const split = await fixture({ stunHost: 'agent-net-stun.example.test' });
  expect(await (await fetch(split.relay.url + API + '/info')).json())
    .toMatchObject({ udpPort: split.relay.udpAddress?.port, stunHost: 'agent-net-stun.example.test' });
  await expect(startAgentNetRelay({ dataDir: split.dataDir, udpPort: 0, stunHost: 'agent-net-stun.example.test:3479' })).rejects.toThrow('INVALID_STUN_HOST');
});

// Bug: opaque media storage alone did not protect App attachments or authenticated video seeks.
// Minimal input crosses an AEAD block boundary; this uses the real production HTTP and disk path.
it('streams authenticated attachments to both endpoints, supports seeks and rejects relay substitutions', async () => {
  const f = await fixture(), member = await f.join();
  const plain = randomBytes(1024 * 1024 + 5311);
  const uploaded = await uploadEncryptedMedia(f.client, 'member', member.identity.transportKey, plain.length,
    async (offset, size) => plain.subarray(offset, offset + size));
  expect(uploaded.sha256).toBe(createHash('sha256').update(plain).digest('hex'));
  const stored = await readFile(path.join(f.dataDir, 'media', uploaded.id));
  expect(stored.includes(plain.subarray(100, 200))).toBe(false);
  for (const client of [f.client, member.client]) {
    const whole = await openEncryptedMedia(client, uploaded.id, uploaded.headerSha256, undefined, 'video/mp4');
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(plain);
    const start = 1024 * 1024 - 13, end = start + 35;
    const seek = await openEncryptedMedia(client, uploaded.id, uploaded.headerSha256, `bytes=${start}-${end}`, 'video/mp4');
    expect(seek.status).toBe(206); expect(seek.headers.get('content-range')).toBe(`bytes ${start}-${end}/${plain.length}`);
    expect(Buffer.from(await seek.arrayBuffer())).toEqual(plain.subarray(start, end + 1));
    expect((await openEncryptedMedia(client, uploaded.id, uploaded.headerSha256, 'bytes=-7', 'video/mp4')).status).toBe(206);
    expect((await openEncryptedMedia(client, uploaded.id, uploaded.headerSha256, 'bytes=99999999-', 'video/mp4')).status).toBe(416);
  }
  await expect(openEncryptedMedia(member.client, uploaded.id, '0'.repeat(64), undefined, 'video/mp4')).rejects.toThrow('INVALID_MEDIA_HEADER');
  stored[stored.length - 1] ^= 1;
  await writeFile(path.join(f.dataDir, 'media', uploaded.id), stored);
  const corrupted = await openEncryptedMedia(member.client, uploaded.id, uploaded.headerSha256, undefined, 'video/mp4');
  await expect(corrupted.arrayBuffer()).rejects.toThrow();
});

it('authenticates binary uploads before accepting bytes and cleans up a changing source', async () => {
  const f = await fixture(), member = await f.join();
  const created = await f.client.request<{ id: string }>('POST', '/media', { recipient: 'member', size: 5, chunkFormat: 'binary-v1' });
  const resource = f.client.path('/media/' + created.id + '?offset=0');
  const signed = Buffer.from('hello');
  const response = await fetch(f.relay.url + resource, { method: 'PUT', headers: {
    authorization: f.client.header('PUT', resource, signed), 'content-type': 'application/octet-stream',
    'x-agent-net-content-sha256': createHash('sha256').update(signed).digest('base64url'),
  }, body: Buffer.from('other') });
  expect(response.status).toBe(401);
  await expect(uploadEncryptedMedia(f.client, 'member', member.identity.transportKey, 4,
    async () => Buffer.from('bad'))).rejects.toThrow('MEDIA_SOURCE_CHANGED');
  const state = JSON.parse(await readFile(path.join(f.dataDir, 'agent-net-state.json'), 'utf8'));
  expect(Object.keys(state.networks['private-net'].media)).toEqual([created.id]);
});

// Direct media transfer. Production stores the ciphertext in an object store clients reach with presigned
// requests; this stand-in enforces the same contract (position, Content-MD5, signature, expiry, ranges) over real
// HTTP and counts which bytes passed through the relay. Integration through the real relay and clients.
describe('direct media transfer', () => {
  it('moves ciphertext between clients and storage without the relay, and still serves clients that cannot', async () => {
    const direct = await directStorage();
    const f = await fixture({ mediaStorage: direct.storage }), member = await f.join();
    expect((await (await fetch(f.relay.url + API + '/info')).json() as { features: string[] }).features).toContain('media-direct-v1');
    const plain = randomBytes(1024 * 1024 + 5311);
    const uploaded = await uploadEncryptedMedia(f.client, 'member', member.identity.transportKey, plain.length,
      async (offset, size) => plain.subarray(offset, offset + size));
    expect(direct.counts).toMatchObject({ relayAppends: 0 });
    expect(direct.counts.storageAppends).toBeGreaterThan(0);
    expect(direct.objects.get(uploaded.id)!.includes(plain.subarray(100, 200))).toBe(false);
    const whole = await openEncryptedMedia(member.client, uploaded.id, uploaded.headerSha256, undefined, 'video/mp4');
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(plain);
    const start = 1024 * 1024 - 13, end = start + 35;
    const seek = await openEncryptedMedia(member.client, uploaded.id, uploaded.headerSha256, `bytes=${start}-${end}`, 'video/mp4');
    expect(seek.status).toBe(206);
    expect(Buffer.from(await seek.arrayBuffer())).toEqual(plain.subarray(start, end + 1));
    expect(direct.counts.relayReads).toBe(0);
    // A client without direct transfer (no header) is served by the relay from the same storage.
    const resource = member.client.path('/media/' + uploaded.id);
    const legacy = await fetch(f.relay.url + resource, { headers: { authorization: member.client.header('GET', resource), range: 'bytes=0-9' } });
    expect(legacy.status).toBe(206); expect(legacy.headers.get(MEDIA_TRANSFER_HEADER)).toBeNull();
    expect(Buffer.from(await legacy.arrayBuffer())).toEqual(direct.objects.get(uploaded.id)!.subarray(0, 10));
    expect(direct.counts.relayReads).toBe(1);
    // An upload that does not offer direct transfer (an older client) goes through the relay; new clients read it directly.
    const created = await f.client.request<{ id: string; transfer?: string }>('POST', '/media', { recipient: 'member', size: 3, chunkFormat: 'binary-v1' });
    expect(created.transfer).toBeUndefined();
    await expect(f.client.putMediaChunk(created.id, 0, Buffer.from('abc'))).resolves.toEqual({ received: 3, complete: true });
    expect(direct.counts.relayAppends).toBe(1);
    expect(Buffer.from(await (await member.client.mediaResponse(created.id)).arrayBuffer()).toString()).toBe('abc');
    expect(direct.counts.relayReads).toBe(1);
    // Removal reaches the storage.
    await f.client.request('DELETE', '/media/' + uploaded.id);
    expect(direct.objects.has(uploaded.id)).toBe(false);
  });

  it('authorizes every direct request and confirms progress from the storage, not from the client', async () => {
    const direct = await directStorage();
    const f = await fixture({ mediaStorage: direct.storage }), member = await f.join();
    const created = await f.client.createMedia('member', 10);
    const resource = '/media/' + created.id;
    const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('base64');
    await expect(member.client.request('POST', resource + '/upload', { offset: 0, size: 5, md5: md5(Buffer.from('hello')) })).rejects.toThrow('FORBIDDEN');
    await expect(f.client.request('POST', resource + '/upload', { offset: 5, size: 5, md5: md5(Buffer.from('hello')) })).rejects.toThrow('MEDIA_OFFSET_MISMATCH');
    await expect(f.client.request('POST', resource + '/upload', { offset: 0, size: 5, md5: 'not-md5' })).rejects.toThrow('MEDIA_CHUNK_INVALID');
    // Claiming progress without writing anything changes nothing.
    await expect(f.client.request('POST', resource + '/commit')).resolves.toEqual({ received: 0, complete: false });
    // The storage keeps a write whose reply never arrives; the relay confirms it from the stored length.
    let dropReply = true;
    const lossy = new AgentNetClient(f.relay.url, f.owner, f.certificate, f.rootPublicKey, undefined, { fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).startsWith(direct.base) && init?.method === 'POST' && dropReply) { dropReply = false; throw new TypeError('fetch failed'); }
      return response;
    } });
    const recreated = await lossy.createMedia('member', 10);
    await expect(lossy.putMediaChunk(recreated.id, 0, Buffer.from('hello'))).resolves.toEqual({ received: 5, complete: false });
    await expect(lossy.putMediaChunk(recreated.id, 5, Buffer.from('world'))).resolves.toEqual({ received: 10, complete: true });
    await expect(member.client.downloadMedia(recreated.id)).resolves.toEqual(new Uint8Array(Buffer.from('helloworld')));
    // A storage outage is a retryable 503, never an internal error or a refusal.
    direct.flags.broken = true;
    await expect(f.client.request('POST', resource + '/commit')).rejects.toMatchObject({ status: 503, code: 'MEDIA_STORAGE_UNAVAILABLE' });
    // Also for a download through the relay (older clients, and clients that fell back): an answer, not a cut connection.
    const relayed = member.client.path('/media/' + recreated.id);
    const failed = await fetch(f.relay.url + relayed, { headers: { authorization: member.client.header('GET', relayed) } });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: { code: 'MEDIA_STORAGE_UNAVAILABLE' } });
    direct.flags.broken = false;
    // More bytes than declared are never accepted: the object goes.
    direct.objects.set(created.id, Buffer.alloc(11));
    await expect(f.client.request('POST', resource + '/commit')).rejects.toThrow('MEDIA_SIZE_MISMATCH');
    expect(direct.objects.has(created.id)).toBe(false);
    await expect(f.client.request('POST', resource + '/commit')).rejects.toThrow('NOT_FOUND');
  });

  it('asks the relay again when a cached storage read is refused, and rejects unsafe storage requests', async () => {
    const direct = await directStorage();
    const f = await fixture({ mediaStorage: direct.storage }), member = await f.join();
    const plain = randomBytes(4096);
    const uploaded = await uploadEncryptedMedia(f.client, 'member', member.identity.transportKey, plain.length, async (offset, size) => plain.subarray(offset, offset + size));
    const read = async () => Buffer.from(await (await openEncryptedMedia(member.client, uploaded.id, uploaded.headerSha256, undefined, 'image/png')).arrayBuffer());
    expect(await read()).toEqual(plain);
    direct.rotate();
    expect(await read()).toEqual(plain);
    const resource = member.client.path('/media/' + uploaded.id);
    const granted = await fetch(f.relay.url + resource, { headers: { authorization: member.client.header('GET', resource), [MEDIA_TRANSFER_HEADER]: MEDIA_TRANSFER_DIRECT } });
    expect(granted.headers.get(MEDIA_TRANSFER_HEADER)).toBe(MEDIA_TRANSFER_DIRECT);
    expect(await granted.json()).toMatchObject({ transfer: MEDIA_TRANSFER_DIRECT, size: direct.objects.get(uploaded.id)!.length });
    // A grant the storage refuses right away is an error, not media.
    direct.flags.refuseReads = true;
    const refused = new AgentNetClient(f.relay.url, member.identity, member.certificate, f.rootPublicKey);
    await expect(refused.mediaResponse(uploaded.id)).rejects.toMatchObject({ status: 403, code: 'MEDIA_STORAGE_READ_FAILED' });
    direct.flags.refuseReads = false;
    direct.flags.unsafeReads = true;
    const fresh = new AgentNetClient(f.relay.url, member.identity, member.certificate, f.rootPublicKey);
    await expect(fresh.mediaResponse(uploaded.id)).rejects.toThrow('INVALID_DIRECT_MEDIA_REQUEST');
  });

  it('removes an object again when a write granted before its deletion lands afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let at = Date.now();
      const direct = await directStorage();
      const f = await fixture({ mediaStorage: direct.storage, now: () => at }), member = await f.join();
      const body = Buffer.from('hello'), created = await f.client.createMedia('member', body.length);
      const { request } = await f.client.request<{ request: { method: string; url: string; headers: Record<string, string> } }>('POST',
        '/media/' + created.id + '/upload', { offset: 0, size: body.length, md5: createHash('md5').update(body).digest('base64') });
      await f.client.request('DELETE', '/media/' + created.id);
      expect(direct.objects.has(created.id)).toBe(false);
      expect((await fetch(request.url, { method: request.method, headers: request.headers, body: new Uint8Array(body) })).status).toBe(200);
      expect(direct.objects.has(created.id)).toBe(true);
      // Gone for both devices, and no new grant for it.
      await expect(member.client.downloadMedia(created.id)).rejects.toThrow('NOT_FOUND');
      await expect(f.client.request('POST', '/media/' + created.id + '/upload', { offset: 5, size: 1, md5: request.headers['content-md5'] })).rejects.toThrow('NOT_FOUND');
      // The sweep waits until every grant has lapsed, then removes the late object too.
      at += DIRECT_GRANT_MAX_MS - 60_000;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(direct.objects.has(created.id)).toBe(true);
      at += 2 * 60_000;
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(direct.objects.has(created.id)).toBe(false));
    } finally { vi.useRealTimers(); }
  });

  it('keeps a network that reaches the relay but not the storage working through the relay', async () => {
    const direct = await directStorage();
    const f = await fixture({ mediaStorage: direct.storage }), member = await f.join();
    // A firewall that lets the relay through but not the storage.
    let blocked = 0;
    const transport = { fetch: (async (input, init) => {
      if (String(input).startsWith(direct.base)) { blocked++; throw new TypeError('fetch failed'); }
      return fetch(input, init);
    }) as typeof fetch };
    const owner = new AgentNetClient(f.relay.url, f.owner, f.certificate, f.rootPublicKey, undefined, transport);
    const plain = randomBytes(1024 * 1024 + 99);
    const uploaded = await uploadEncryptedMedia(owner, 'member', member.identity.transportKey, plain.length, async (offset, size) => plain.subarray(offset, offset + size));
    expect(blocked).toBe(1);
    expect(direct.counts.storageAppends).toBe(0); expect(direct.counts.relayAppends).toBe(1);
    // Later uploads from this client go straight to the relay for a while.
    await uploadEncryptedMedia(owner, 'member', member.identity.transportKey, 3, async (offset, size) => Buffer.from('abc').subarray(offset, offset + size));
    expect(blocked).toBe(1);
    const reader = new AgentNetClient(f.relay.url, member.identity, member.certificate, f.rootPublicKey, undefined, transport);
    const read = async () => Buffer.from(await (await openEncryptedMedia(reader, uploaded.id, uploaded.headerSha256, undefined, 'video/mp4')).arrayBuffer());
    expect(await read()).toEqual(plain);
    expect(await read()).toEqual(plain);
    expect(blocked).toBe(2);
    expect(direct.counts.storageReads).toBe(0); expect(direct.counts.relayReads).toBeGreaterThan(0);
  });
});

/** In-memory object storage over local HTTP standing in for an object store such as OSS. */
async function directStorage() {
  const objects = new Map<string, Buffer>();
  const secret = randomBytes(16); let generation = 0;
  const counts = { relayAppends: 0, relayReads: 0, storageAppends: 0, storageReads: 0 };
  const sign = (parts: string[]) => createHmac('sha256', secret).update([generation, ...parts].join('\0')).digest('base64url');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://storage'), id = url.pathname.slice('/objects/'.length);
    const expires = url.searchParams.get('expires') ?? '';
    const done = (status: number, headers: Record<string, string | number> = {}, body?: Buffer) => { res.writeHead(status, headers); res.end(body); };
    if (!(Number(expires) > Date.now())) return done(403);
    if (req.method === 'POST') {
      const position = url.searchParams.get('position') ?? '', md5 = String(req.headers['content-md5'] ?? '');
      const length = url.searchParams.get('length') ?? '';
      if (url.searchParams.get('sig') !== sign(['append', id, position, length, md5, expires])) return done(403);
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks), current = objects.get(id) ?? Buffer.alloc(0);
        if (body.length !== Number(length)) return done(403);
        if (createHash('md5').update(body).digest('base64') !== md5) return done(400);
        if (current.length !== Number(position)) return done(409);
        objects.set(id, Buffer.concat([current, body])); counts.storageAppends++; done(200);
      });
      return;
    }
    if (req.method !== 'GET') return done(405);
    if (url.searchParams.get('sig') !== sign(['read', id, expires]) || flags.refuseReads) return done(403);
    const object = objects.get(id);
    if (!object) return done(404);
    counts.storageReads++;
    const match = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (!match) return done(200, { 'content-length': object.length }, object);
    const start = Number(match[1]), end = Math.min(object.length - 1, match[2] ? Number(match[2]) : object.length - 1);
    if (start >= object.length) return done(416);
    done(206, { 'content-range': `bytes ${start}-${end}/${object.length}`, 'content-length': end - start + 1 }, object.subarray(start, end + 1));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/objects/`;
  const flags = { unsafeReads: false, broken: false, refuseReads: false };
  return {
    objects, counts, base, flags,
    rotate() { generation++; },
    storage: {
      async length(id) { if (flags.broken) throw new Error('storage unreachable'); return objects.get(id)?.length ?? 0; },
      async append(id, offset, data) {
        counts.relayAppends++;
        const current = objects.get(id) ?? Buffer.alloc(0);
        if (current.length === offset + data.length) return current.length;
        if (current.length !== offset) throw new RelayMediaStorageError('MEDIA_OFFSET_MISMATCH');
        objects.set(id, Buffer.concat([current, Buffer.from(data)])); return offset + data.length;
      },
      async read(id, start, end) {
        if (flags.broken) throw new Error('storage unreachable');
        counts.relayReads++; return Readable.from([objects.get(id)!.subarray(start, end + 1)]);
      },
      async remove(id) { objects.delete(id); },
      direct: {
        async append(id, offset, size, contentMd5) {
          const expiresAt = Date.now() + 60_000;
          return { method: 'POST' as const, url: `${base}${id}?position=${offset}&length=${size}&expires=${expiresAt}&sig=${sign(['append', id, String(offset), String(size), contentMd5, String(expiresAt)])}`,
            headers: { 'content-md5': contentMd5, 'content-type': 'application/octet-stream' }, expiresAt };
        },
        async read(id) {
          const expiresAt = Date.now() + 60_000;
          return { method: 'GET' as const, url: `${base}${id}?expires=${expiresAt}&sig=${sign(['read', id, String(expiresAt)])}`,
            headers: (flags.unsafeReads ? { authorization: 'Bearer stolen' } : {}) as Record<string, string>, expiresAt };
        },
      },
    } satisfies RelayMediaStorage,
  };
}

const cleanups: Array<() => Promise<unknown> | void> = [];
// A second same-account device must recover public sharing origins without an
// official service. A relay cannot forge the endpoint/root document; revoked
// devices lose publication and their old documents disappear. Integration.
it('persists signed public sharing origins for paired devices and fences substituted or revoked publishers', async () => {
  const f = await fixture(), member = await f.join();
  const plain = { v: 2 as const, networkId: f.certificate.networkId, certificate: member.certificate, issuedAt: Date.now(),
    origins: [{ server: 'https://friend.example.test', networkId: 'private:friend', rootPublicKey: f.rootPublicKey, region: 'global' as const }] };
  const doc = { ...plain, signature: signature(member.identity.signingPrivateKey, sharingOriginsPayload(plain)) };
  await member.client.request('POST', '/sharing-origins', doc);
  await expect(f.client.request('GET', '/sharing-origins')).resolves.toEqual({ origins: [doc] });
  await expect(member.client.request('POST', '/sharing-origins', { ...doc, origins: [{ ...doc.origins[0], server: 'https://substitution.example.test' }] })).rejects.toThrow('INVALID_SHARING_ORIGINS');
  await f.restart();
  await expect(f.client.request('GET', '/sharing-origins')).resolves.toEqual({ origins: [doc] });
  await f.client.request('DELETE', '/devices/member');
  await expect(f.client.request('GET', '/sharing-origins')).resolves.toEqual({ origins: [] });
  await expect(member.client.request('POST', '/sharing-origins', doc)).rejects.toThrow();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
async function fixture(extra: Partial<RelayOptions> = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cindy-agent-net-test-'));
  cleanups.push(async () => {
    if (!path.resolve(dataDir).startsWith(path.join(tmpdir(), 'cindy-agent-net-test-'))) throw new Error('UNSAFE_TEST_CLEANUP');
    await rm(dataDir, { recursive: true, force: true });
  });
  const root = generateKeyPairSync('ed25519').privateKey;
  const owner = generateIdentity('owner');
  const rootPublicKey = publicBytes(root);
  const certificate = issueCertificate(root, { networkId: 'private-net', subject: extra.sharing ? 'owner-account' : 'household', identity: owner, role: 'owner' });
  const bootstrap: Bootstrap = { networkId: certificate.networkId, name: 'Private network', rootPublicKey, ownerCertificate: certificate };
  let relay: RelayHandle = await startAgentNetRelay({ dataDir, bootstrap, udpPort: 0, ...extra });
  cleanups.push(() => relay.close());
  let client = new AgentNetClient(relay.url, owner, certificate, rootPublicKey);
  const uplinks: AgentNetUplink[] = [];
  cleanups.push(() => { for (const u of uplinks) u.close(); });
  return {
    root, owner, certificate, bootstrap, dataDir, rootPublicKey, uplinks,
    get relay() { return relay; }, get client() { return client; },
    async restart() {
      await relay.close();
      relay = await startAgentNetRelay({ dataDir, udpPort: 0, ...extra });
      client = new AgentNetClient(relay.url, owner, certificate, rootPublicKey);
    },
    async join(deviceId = 'member') {
      const identity = generateIdentity(deviceId);
      const { joinCode } = await client.request<{ joinCode: string }>('POST', '/join-codes');
      const secret = randomBytes(32).toString('base64url');
      const request = createJoinRequest(identity, certificate.networkId, joinCode, deviceId, secret);
      const submitted = await submitJoin(relay.url, request);
      const approved = approveJoin(root, request, secret, certificate.subject);
      await client.request('POST', '/join-requests/' + request.requestId + '/approve', { certificate: approved });
      const polled = await pollJoin(relay.url, rootPublicKey, certificate.networkId, request.requestId, submitted.pollToken);
      expect(polled.certificate).toEqual(approved);
      return { identity, certificate: approved, client: new AgentNetClient(relay.url, identity, approved, rootPublicKey), request, submitted };
    },
  };
}
function nextPacket(uplink: AgentNetUplink): Promise<[string, Uint8Array]> {
  return new Promise((resolve) => uplink.onDatagram((source, packet) => resolve([source, packet])));
}

describe('independent V2 relay', () => {
  // App metadata is deliberately not certificate authority. Real WS/HTTP/store:
  // reject malformed labels, allow future labels and retain them after restart.
  // Existing presence integration only sent platform/appVersion. Tier: integration.
  it('validates self-reported App labels without restricting unknown Apps or old clients', async () => {
    const f = await fixture();
    for (const app of [null, 42, {}, '', '-bad', 'bad app', 'a'.repeat(65)]) {
      const uplink = await f.client.connect(); f.uplinks.push(uplink);
      const closed = once(uplink, 'close');
      uplink.presence(false, [], { app: app as string });
      expect((await closed)[0]).toBe(1008);
      expect((await f.client.directory())[0].app).toBeUndefined();
    }
    const app = 'A'.repeat(55) + '._:@/-001'; // 64 chars; same alphabet as ID_PATTERN.
    const uplink = await f.client.connect(); f.uplinks.push(uplink);
    uplink.presence(false, [], { platform: 'darwin', app });
    await vi.waitFor(async () => expect((await f.client.directory())[0].app).toBe(app));
    await f.restart();
    expect((await f.client.directory())[0]).toMatchObject({ online: false, app });
    const legacy = await f.client.connect(); f.uplinks.push(legacy);
    legacy.presence(false, [], { platform: 'darwin' });
    await vi.waitFor(async () => expect((await f.client.directory())[0]).toMatchObject({ online: true, platform: 'darwin', app }));
  });
  // Executor endorsements carry certificates. The old fixed grant-count limit
  // could publish a >1 MiB directory and disconnect every existing Host peer.
  // Real admission/storage/HTTP integration; unit signature tests lack this budget.
  it('rejects an oversized executor directory before persisting it and preserves existing grants', async () => {
    const f = await fixture(), executors = [];
    for (let i = 0; i < 32; i++) executors.push((await f.join('executor-' + i)).certificate);
    const guest = generateIdentity('external-person'); let accepted = 0, limited = false;
    for (let i = 0; i < 128; i++) {
      const original = createDelegation(f.owner, f.certificate, { kind: 'provider-share', resourceId: 'share-' + i, guest,
        scope: { memberId: 'unit-member-' + i, memberVersion: 1, guestSubject: 'unit-guest' } });
      const plain = { ...original, executors: executors.map(certificate => ({ certificate, generation: 'generation-' + i, expiresAt: original.expiresAt })) };
      const delegation = { ...plain, signature: signature(f.owner.signingPrivateKey, delegationPayload(plain)) };
      try { await f.client.request('POST', '/grants', { delegation }); accepted++; }
      catch (error) { expect(error).toMatchObject({ status: 429, code: 'GRANT_DIRECTORY_LIMIT' }); limited = true; break; }
    }
    expect(limited).toBe(true); expect(accepted).toBeGreaterThan(0);
    const directory = await f.client.request<{ delegations: unknown[] }>('GET', '/directory');
    expect(directory.delegations).toHaveLength(accepted);
    expect(Buffer.byteLength(JSON.stringify(directory))).toBeLessThan(MAX_CONTROL_BYTES);
    await f.restart();
    expect((await f.client.request<{ delegations: unknown[] }>('GET', '/directory')).delegations).toHaveLength(accepted);
  });
  // Integration: the transport-only guest fixture did not exercise the real
  // invitation/approval authority. A persisted pause/removal must invalidate
  // an existing guest socket and reject the old signed lease after restart.
  it.each(['shared-task', 'provider-share'] as const)('persists %s membership and immediately fences revoked transport credentials', async kind => {
    // Exercise the request lifetime boundary for both sharing kinds: separate
    // clock reads must not accidentally mint a lease longer than the protocol allows.
    let at = Date.now();
    const actors = { 'Bearer unit-owner': { accountId: 'owner-account', deviceId: 'owner' },
      'Bearer unit-guest': { accountId: 'guest-account', deviceId: 'external-visitor' } };
    let identityNetwork = '';
    const f = await fixture({ now: () => at++, sharing: {
      async authenticate(req) { const actor = actors[req.headers.authorization as keyof typeof actors];
        if (!actor) throw new AppError('UNAUTHORIZED', 401, 'Unit auth rejected'); return { ...actor, networkId: identityNetwork }; },
      providers: { hostCapability: 'provider-share-v1', identityCards: {
        async verify(card) { if (card !== 'unit-verified-card') throw new AppError('PROVIDER_SHARE_IDENTITY_INVALID', 400, 'Invalid fixture card');
          return { displayName: 'Unit verified person', avatarUrl: null, region: 'global' as const }; },
        async inspect() { throw new Error('No cross-region fixture'); },
      } },
    } });
    const visitor = generateIdentity('external-visitor');
    identityNetwork = f.certificate.networkId;
    const call = async (path: string, method: string, input: unknown, owner = false, proof = owner, applicant = false) => {
      const target = API + '/sharing' + path, body = input === undefined ? '' : JSON.stringify(input);
      const response = await fetch(f.relay.url + target, { method, headers: {
        authorization: owner ? 'Bearer unit-owner' : 'Bearer unit-guest', ...(body ? { 'content-type': 'application/json' } : {}),
        ...(proof ? { 'x-agent-net-authorization': f.client.header(method, target, body) } : {}),
        ...(applicant ? { 'x-agent-net-applicant': Buffer.from(JSON.stringify(createRequestProof(visitor, method, target, body))).toString('base64url') } : {}),
      }, ...(body ? { body } : {}) });
      return { status: response.status, body: await response.json() as any };
    };
    expect((await call('/shared-tasks', 'POST', { sessionId: 'private-task', title: 'Private task' }, true, false)).status).toBe(401);
    let resourceId: string, memberId: string;
    if (kind === 'shared-task') {
      const created = await call('/shared-tasks', 'POST', { sessionId: 'private-task', title: 'Private task' }, true);
      expect(created.status).toBe(200); resourceId = created.body.sharedTaskId;
      const invite = await call('/shared-tasks/' + resourceId + '/invites', 'POST', {}, true);
      const joined = await call('/shared-tasks/join', 'POST', { invitation: invite.body.invitation, displayName: 'Unit guest' });
      expect(joined.body.status).toBe('joined'); memberId = joined.body.memberId;
    } else {
      const link = await call('/provider-shares/links', 'POST', { providerId: 'unit-provider', providerLabel: 'Provider',
        deviceName: 'Host', identityCard: 'unit-verified-card' }, true);
      expect(link.status).toBe(200); resourceId = link.body.shareId;
      const request = await call('/provider-shares/requests', 'POST', { invitation: link.body.invitation, identityCard: 'unit-verified-card' });
      expect(request.body.status).toBe('pending');
      const approved = await call('/provider-shares/requests/' + request.body.requestId + '/approve', 'POST', {}, true);
      expect(approved.status).toBe(200); expect(approved.body.shareId).toBe(resourceId); memberId = approved.body.memberId;
    }
    const csr = { kind, resourceId, memberId, signingKey: visitor.signingKey, transportKey: visitor.transportKey };
    identityNetwork = 'private:another-network';
    expect((await call('/transport', 'POST', csr, false, false, true)).status).toBe(404);
    expect((await call('/shared-tasks', 'POST', { sessionId: 'other-scope', title: 'Other scope' }, true)).status).toBe(403);
    identityNetwork = f.certificate.networkId;
    expect((await call('/transport', 'POST', csr)).status).toBe(403);
    const submitted = await call('/transport', 'POST', csr, false, false, true);
    expect(submitted.body.status).toBe('pending');
    const directory = await f.client.request<{ delegationRequests: import('@cindy/agent-net-protocol').DelegationRequest[] }>('GET', '/directory');
    const requested = directory.delegationRequests[0];
    expect(requested).toMatchObject({ kind, resourceId, scope: { memberId, guestSubject: 'guest-account' } });
    const hostUplink = await f.client.connect(); f.uplinks.push(hostUplink);
    expect(hostUplink.delegationRequests).toEqual([requested]);
    const delegation = await f.client.acceptDelegationRequest(requested, () => undefined);
    expect((await call('/transport/status', 'POST', { id: requested.id, signingKey: visitor.signingKey, transportKey: visitor.transportKey }, false, false, true)).body)
      .toMatchObject({ status: 'ready', delegation: { signature: delegation.signature } });
    const guest = new AgentNetClient(f.relay.url, visitor, f.certificate, f.rootPublicKey, delegation);
    const uplink = await guest.connect(); f.uplinks.push(uplink);
    const closed = once(uplink, 'close');
    const revoked = kind === 'shared-task' ? await call('/shared-tasks/' + resourceId + '/members/' + memberId + '/remove', 'POST', {}, true)
      : await call('/provider-shares/members/' + memberId + '/pause', 'POST', {}, true);
    expect(revoked.status).toBe(200); expect(await closed).toEqual([4410]);
    await expect(guest.directory()).rejects.toMatchObject({ code: 'GRANT_INVALID' });
    expect((await f.client.directory()).some(view => view.certificate.deviceId === 'owner')).toBe(true);
    await f.restart();
    const rows = kind === 'shared-task' ? await call('/shared-tasks/' + resourceId, 'GET', undefined, true)
      : await call('/provider-shares/received', 'GET', undefined);
    expect(rows.status).toBe(200);
    if (kind === 'shared-task') expect(rows.body.guests).toHaveLength(0);
    else expect(rows.body.shares[0].status).toBe('paused');
    await expect(f.client.request('POST', '/grants', { delegation })).rejects.toMatchObject({ code: 'GRANT_INVALID' });
  });
  it('drops in-flight datagrams for a removed member without disconnecting healthy peers on the same uplink', async () => {
    const f = await fixture(), removed = await f.join('removed'), healthy = await f.join('healthy');
    const a = await f.client.connect(), c = await healthy.client.connect(); f.uplinks.push(a, c);
    await f.client.request('DELETE', '/devices/' + removed.identity.deviceId);
    const packet = randomBytes(96), received = nextPacket(c);
    a.send(removed.identity.deviceId, packet); a.send(healthy.identity.deviceId, packet);
    expect(await received).toEqual(['owner', packet]);
  });
  it('requires a fresh owner approval to replace a member and invalidates the earlier identity', async () => {
    const f = await fixture(); const old = await f.join('replaceable');
    await f.client.request('DELETE', '/devices/replaceable');
    await expect(old.client.directory()).rejects.toMatchObject({ status: 401 });
    const replacement = await f.join('replaceable');
    expect((await replacement.client.directory()).some((d) => d.certificate.deviceId === 'replaceable')).toBe(true);
    await expect(old.client.directory()).rejects.toMatchObject({ status: 401 });
  });
  it('drains an accepted notification before shutdown completes and makes close idempotent', async () => {
    let release!: () => void, started!: () => void, delivered = false;
    const pendingDelivery = new Promise<void>((resolve) => { release = resolve; });
    const deliveryStarted = new Promise<void>((resolve) => { started = resolve; });
    const f = await fixture({ notify: async () => { started(); await pendingDelivery; delivered = true; } });
    const m = await f.join();
    await m.client.request('PUT', '/push-token', { provider: 'bridge', token: 'test-token', appVariant: 'global', apnsEnv: null });
    const notify = f.client.request('POST', '/notify', { to: 'member', ciphertext: 'test-ciphertext' }).catch(() => undefined);
    await deliveryStarted;
    let finished = false;
    const close = f.relay.close(); close.then(() => { finished = true; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
    } finally { release(); await close; await notify; }
    expect(delivered).toBe(true); expect(f.relay.close()).toBe(close);
  });
  it('isolates account networks and allows removing an old owner device while retaining an active owner', async () => {
    const root = generateKeyPairSync('ed25519').privateKey;
    const first = generateIdentity('first'), second = generateIdentity('second'), other = generateIdentity('other');
    const certificate = (identity: Identity, networkId: string) => issueCertificate(root, { networkId, subject: networkId, identity, role: 'owner' });
    const certificates = [certificate(first, 'account:first'), certificate(second, 'account:first'), certificate(other, 'account:other')];
    const f = await fixture({ mode: 'official', bootstrap: undefined, enroll: async (req) => {
      const index = Number(req.headers['x-test-account']);
      const c = certificates[index];
      return { certificate: c, rootPublicKey: publicBytes(root), networkId: c.networkId, name: 'Account network', deviceName: c.deviceId };
    } });
    for (let i = 0; i < certificates.length; i++) {
      expect((await fetch(f.relay.url + API + '/enroll', { method: 'POST', headers: { 'x-test-account': String(i) }, body: '{}' })).status).toBe(200);
    }
    const a = new AgentNetClient(f.relay.url, first, certificates[0], publicBytes(root));
    const b = new AgentNetClient(f.relay.url, other, certificates[2], publicBytes(root));
    expect((await a.directory()).map((d) => d.certificate.deviceId)).toEqual(['first', 'second']);
    expect((await b.directory()).map((d) => d.certificate.deviceId)).toEqual(['other']);
    await expect(a.request('POST', '/media', { recipient: 'other', size: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await a.request('DELETE', '/devices/second');
    await expect(a.request('DELETE', '/devices/first')).rejects.toMatchObject({ code: 'OWNER_CANNOT_BE_REMOVED' });
  });
  // §5.5: another account gets its own network on a shared relay. Only the relay owner admits or revokes it,
  // and neither side reaches the other's devices. Minimal input: one invite, one approval, one revocation.
  it('admits another account into an isolated network only after relay-owner approval and revokes it', async () => {
    const f = await fixture(), m = await f.join();
    expect((await (await fetch(f.relay.url + API + '/info')).json()).features).toContain('tenants-v1');
    await expect(m.client.request('POST', '/tenant-invites')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const guestRoot = generateKeyPairSync('ed25519').privateKey, guestRootKey = publicBytes(guestRoot);
    const guest = generateIdentity('guest-pc'), networkId = 'private:' + randomUUID(), secret = randomBytes(32).toString('base64url');
    const ask = async (requestNetwork = networkId) => {
      const { inviteCode } = await f.client.request<{ inviteCode: string }>('POST', '/tenant-invites');
      const request = createTenantJoinRequest({ root: guestRoot, identity: guest, networkId: requestNetwork, subject: 'owner:guest', name: 'Bob',
        accountName: 'Bob', deviceName: 'Bob PC', inviteCode, pairingSecret: secret });
      return { request, submitted: await submitTenantJoin(f.relay.url, request) };
    };
    const rejected = await ask('private:' + randomUUID());
    await f.client.request('POST', '/tenant-requests/' + rejected.request.requestId + '/reject');
    expect(await pollTenantJoin(f.relay.url, rejected.request.requestId, rejected.submitted.pollToken)).toEqual({ status: 'rejected' });
    const { request, submitted } = await ask();
    // An invite admits one request; the relay cannot check the pairing proof, the relay owner's computer does.
    await expect(submitTenantJoin(f.relay.url, { ...request, requestId: randomUUID() })).rejects.toMatchObject({ code: 'TENANT_INVITE_INVALID' });
    expect(await pollTenantJoin(f.relay.url, request.requestId, submitted.pollToken)).toEqual({ status: 'pending' });
    const pending = (await f.client.request<{ requests: { request: typeof request }[] }>('GET', '/tenant-requests')).requests;
    expect(pending.map(p => p.request.requestId)).toEqual([request.requestId]);
    expect(verifyTenantPairingProof(pending[0].request, secret)).toBe(true);
    expect(verifyTenantPairingProof(pending[0].request, randomBytes(32).toString('base64url'))).toBe(false);
    expect(tenantVerifyCode(pending[0].request)).toBe(tenantVerifyCode(request));
    const guestClient = new AgentNetClient(f.relay.url, guest, request.bootstrap.ownerCertificate, guestRootKey);
    await expect(guestClient.directory()).rejects.toMatchObject({ code: 'NETWORK_UNKNOWN' });
    await expect(m.client.request('POST', '/tenant-requests/' + request.requestId + '/approve')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.client.request('POST', '/tenant-requests/' + request.requestId + '/approve');
    expect(await pollTenantJoin(f.relay.url, request.requestId, submitted.pollToken)).toEqual({ status: 'approved' });
    // The guest administers its own network (its phone joins) but nothing relay-wide.
    const phone = generateIdentity('guest-phone'), phoneSecret = randomBytes(32).toString('base64url');
    const { joinCode } = await guestClient.request<{ joinCode: string }>('POST', '/join-codes');
    const phoneRequest = createJoinRequest(phone, networkId, joinCode, 'guest-phone', phoneSecret);
    const phoneSubmitted = await submitJoin(f.relay.url, phoneRequest);
    const phoneCertificate = approveJoin(guestRoot, phoneRequest, phoneSecret, 'owner:guest');
    await guestClient.request('POST', '/join-requests/' + phoneRequest.requestId + '/approve', { certificate: phoneCertificate });
    expect((await pollJoin(f.relay.url, guestRootKey, networkId, phoneRequest.requestId, phoneSubmitted.pollToken)).certificate).toEqual(phoneCertificate);
    await expect(guestClient.request('POST', '/tenant-invites')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(guestClient.request('GET', '/tenants')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await guestClient.directory()).map(d => d.certificate.deviceId)).toEqual(['guest-pc', 'guest-phone']);
    expect((await f.client.directory()).map(d => d.certificate.deviceId)).toEqual(['owner', 'member']);
    await expect(guestClient.request('POST', '/media', { recipient: 'member', size: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.client.request('POST', '/media', { recipient: 'guest-pc', size: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Tenants survive a restart; state written before tenants existed infers the owner's network.
    const file = path.join(f.dataDir, 'agent-net-state.json');
    await f.relay.close();
    const saved = JSON.parse(await readFile(file, 'utf8')); delete saved.primaryNetworkId; await writeFile(file, JSON.stringify(saved));
    await f.restart();
    expect((await f.client.request<{ tenants: unknown[] }>('GET', '/tenants')).tenants).toEqual([
      expect.objectContaining({ networkId, accountName: 'Bob', devices: 2 })]);
    const revived = new AgentNetClient(f.relay.url, guest, request.bootstrap.ownerCertificate, guestRootKey);
    const uplink = await revived.connect(); f.uplinks.push(uplink);
    const closed = once(uplink, 'close');
    await f.client.request('DELETE', '/tenants/' + encodeURIComponent(networkId));
    expect(await closed).toEqual([4410]);
    await expect(revived.directory()).rejects.toMatchObject({ code: 'NETWORK_UNKNOWN' });
    expect((await f.client.request<{ tenants: unknown[] }>('GET', '/tenants')).tenants).toEqual([]);
    await expect(f.client.request('DELETE', '/tenants/' + encodeURIComponent(f.certificate.networkId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('pairs through owner approval, pins identities, rejects replays and never contacts an official service', async () => {
    const realFetch = globalThis.fetch;
    const hosts: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(String(input)); hosts.push(url.hostname);
      if (!['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('OFFICIAL_NETWORK_DISABLED');
      return realFetch(input, init);
    });
    const f = await fixture();
    const m = await f.join();
    expect((await m.client.directory()).map((d) => d.certificate.deviceId)).toEqual(['owner', 'member']);
    const signedPath = API + '/directory';
    const header = authorization(m.identity, m.certificate, 'GET', signedPath);
    expect((await fetch(f.relay.url + signedPath, { headers: { authorization: header } })).status).toBe(200);
    const replay = await fetch(f.relay.url + signedPath, { headers: { authorization: header } });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: 'REQUEST_REPLAYED' } });
    await expect(m.client.request('POST', '/join-codes')).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    await expect(pollJoin(f.relay.url, f.rootPublicKey, 'private-net', m.request.requestId, 'wrong')).rejects.toMatchObject({ code: 'POLL_TOKEN_INVALID' });
    const forged = { ...m.certificate, signingKey: f.owner.signingKey };
    const forgedHeader = authorization(f.owner, forged, 'GET', signedPath);
    expect((await fetch(f.relay.url + signedPath, { headers: { authorization: forgedHeader } })).status).toBe(401);
    const state = await readFile(path.join(f.dataDir, 'agent-net-state.json'), 'utf8');
    expect(state).not.toContain('PRIVATE KEY'); expect(state).not.toContain('signingPrivateKey');
    const renamePath = API + '/devices/member', validBody = '{"name":"�"}';
    const signedRename = authorization(m.identity, m.certificate, 'PATCH', renamePath, validBody);
    const invalidUtf8 = Buffer.concat([Buffer.from('{"name":"'), Buffer.from([255]), Buffer.from('"}')]);
    expect((await fetch(f.relay.url + renamePath, { method: 'PATCH', headers: { authorization: signedRename }, body: invalidUtf8 })).status).toBe(401);
    expect(hosts.length).toBeGreaterThan(8); expect(new Set(hosts)).toEqual(new Set(['127.0.0.1']));
  });

  it('forwards opaque datagrams with authenticated source, supports presence and recovers after restart', async () => {
    const f = await fixture();
    const m = await f.join();
    const a = await f.client.connect(); const b = await m.client.connect(); f.uplinks.push(a, b);
    const received = nextPacket(b);
    const opaque = randomBytes(1200);
    a.send('member', opaque);
    expect(await received).toEqual(['owner', opaque]);
    a.presence(false, [], { platform: 'win32', deviceName: 'My workstation' });
    b.presence(true, ['remote-control', 'files', 'tasks'], { platform: 'ios', app: 'cindy-friend', appVersion: 'unit', busy: true, deviceName: 'My phone' });
    await vi.waitFor(async () => expect((await f.client.directory()).find((d) => d.certificate.deviceId === 'member')).toMatchObject({
      online: true, remoteControlEnabled: true, platform: 'ios', app: 'cindy-friend', appVersion: 'unit', busy: true }));
    // App identity is metadata, independent of capabilities and certificate fields.
    // Integration: both SDK uplink serialization and durable relay storage are real.
    b.close();
    await vi.waitFor(async () => expect((await f.client.directory()).find(d => d.certificate.deviceId === 'member'))
      .toMatchObject({ online: false, app: 'cindy-friend', capabilities: [] }));
    // V1 lets a paired member edit aliases, while removal remains owner-only.
    await m.client.request('PATCH', '/devices/owner', { name: 'Work desk' });
    expect((await f.client.directory()).find(d => d.certificate.deviceId === 'owner')).toMatchObject({ name: 'Work desk', selfName: 'My workstation' });
    await expect(m.client.request('DELETE', '/devices/owner')).rejects.toThrow('OWNER_REQUIRED');
    await expect(f.client.request('DELETE', '/devices/owner')).rejects.toThrow('OWNER_CANNOT_BE_REMOVED');
    await f.restart();
    const client = new AgentNetClient(f.relay.url, m.identity, m.certificate, f.rootPublicKey);
    expect((await client.directory()).map((d) => d.online)).toEqual([false, false]);
    expect((await client.directory()).find(d => d.certificate.deviceId === 'member')).toMatchObject({ platform: 'ios', app: 'cindy-friend', appVersion: 'unit', busy: false });
    expect((await client.directory()).find(d => d.certificate.deviceId === 'owner')).toMatchObject({ name: 'Work desk', selfName: 'My workstation' });
    expect(await client.request('PATCH', '/devices/owner', { name: null })).toMatchObject({ name: 'My workstation' });
    const recoveredOwner = await f.client.connect(); const recoveredMember = await client.connect(); f.uplinks.push(recoveredOwner, recoveredMember);
    const after = nextPacket(recoveredOwner); recoveredMember.send('owner', opaque);
    expect(await after).toEqual(['member', opaque]);
  });

  // 2026-11-13: TCP toward a slow device only queues, so forwarded datagrams arrived minutes late.
  // Real relay sockets: the member stops reading; once the relay's oldest write to it is older than the
  // limit, newer datagrams are dropped (never delivered after it resumes) and its session stays open.
  // Previously only a 1 MiB byte cap applied; each round below stays under it. Tier: integration.
  it('drops datagrams toward a device whose connection stopped moving, without disconnecting it', async () => {
    const warnings: string[] = [];
    let movedAgain!: () => void;
    const moved = new Promise<void>((resolve) => { movedAgain = resolve; });
    const f = await fixture({ datagramQueueDelayMs: 30, logger: { error() {}, warn: (_fields, message) => { warnings.push(message); },
      info: (_fields, message) => { if (message.includes('moving again')) movedAgain(); } } });
    const m = await f.join();
    let memberSocket!: Socket;
    const member = new AgentNetClient(f.relay.url, m.identity, m.certificate, f.rootPublicKey, undefined, {
      createWebSocket: (url, options) => {
        const ws = new WebSocket(url, options);
        ws.once('upgrade', (response) => { memberSocket = response.socket as Socket; });
        return ws;
      } });
    const a = await f.client.connect(); const b = await member.connect(); f.uplinks.push(a, b);
    const tags = new Map<number, number>();
    b.onDatagram((_source, packet) => { tags.set(packet[0], (tags.get(packet[0]) ?? 0) + 1); });
    const send = (tag: number, count: number, size: number) => {
      for (let i = 0; i < count; i++) { const packet = new Uint8Array(size); packet[0] = tag; a.send('member', packet); }
    };
    const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

    memberSocket.pause();
    for (let i = 0; i < 80 && warnings.length === 0; i++) { send(1, 4, 60_000); await sleep(35); }
    expect(warnings).toEqual(['agent-net session send queue has not moved; dropping datagrams to it until it does']);
    send(2, 8, 1_000);
    await sleep(20);
    memberSocket.resume();
    await moved;
    send(3, 1, 1_000);
    await vi.waitFor(() => expect(tags.has(3)).toBe(true));
    expect(tags.has(2)).toBe(false);
  });

  it.each(['provider-share', 'shared-task'] as const)('keeps %s independent and prevents a guest from accessing other devices', async (kind) => {
    const f = await fixture(); const m = await f.join();
    const guest = generateIdentity('external-person');
    const delegation = createDelegation(f.owner, f.certificate, { kind, resourceId: 'resource-1', guest });
    const registered = await f.client.request<{ guestRelayId: string }>('POST', '/grants', { delegation });
    const guestClient = new AgentNetClient(f.relay.url, guest, f.certificate, f.rootPublicKey, delegation);
    expect((await guestClient.directory()).map((d) => d.certificate.deviceId)).toEqual(['owner']);
    await expect(guestClient.request('POST', '/join-codes')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const a = await f.client.connect(); const g = await guestClient.connect(); f.uplinks.push(a, g);
    expect(a.delegations).toEqual([delegation]);
    const opaque = randomBytes(96); const received = nextPacket(a); g.send('owner', opaque);
    expect(await received).toEqual([registered.guestRelayId, opaque]);
    const reply = nextPacket(g); a.send(registered.guestRelayId, opaque); expect(await reply).toEqual(['owner', opaque]);
    await expect(m.client.request('POST', '/media', { recipient: registered.guestRelayId, size: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ciphertext = encryptMedia(guest.transportKey, Buffer.from('private shared attachment'));
    const mediaId = await f.client.uploadMedia(registered.guestRelayId, ciphertext);
    expect(Buffer.from(decryptMedia(guest.transportPrivateKey, await guestClient.downloadMedia(mediaId))).toString()).toBe('private shared attachment');
    const closed = once(g, 'close');
    await f.client.request('DELETE', '/grants/' + delegation.id); expect(await closed).toEqual([4410]);
    await expect(guestClient.directory()).rejects.toMatchObject({ code: 'GRANT_INVALID' });
    await expect(guestClient.downloadMedia(mediaId)).rejects.toMatchObject({ code: 'GRANT_INVALID' });
  });

  // A delayed, already signed renewal must not revive a revoked resource after
  // the original lease expired or after a process restart. Real storage/API tier.
  it('renews only the same scoped lease and retains revocation against delayed renewal after restart', async () => {
    let at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => at);
    try {
      const f = await fixture({ now: () => at }), guest = generateIdentity('external-person');
      const scope = { memberId: 'unit-member', guestSubject: 'global:unit-guest', memberVersion: 1 };
      const initial = createDelegation(f.owner, f.certificate, { kind: 'shared-task', resourceId: 'unit-task', guest,
        scope, now: at, lifetimeMs: 60_000 });
      await f.client.request('POST', '/grants', { delegation: initial });
      at += 20_000;
      const renewed = createDelegation(f.owner, f.certificate, { kind: initial.kind, resourceId: initial.resourceId,
        guest, scope, id: initial.id, now: at, lifetimeMs: 120_000 });
      await f.client.request('POST', '/grants', { delegation: renewed });
      const api = new AgentNetClient(f.relay.url, guest, f.certificate, f.rootPublicKey, renewed);
      expect((await api.directory()).map(view => view.certificate.deviceId)).toEqual(['owner']);
      const changed = createDelegation(f.owner, f.certificate, { kind: initial.kind, resourceId: initial.resourceId,
        guest, scope: { ...scope, memberVersion: 2 }, id: initial.id, now: at, lifetimeMs: 120_000 });
      await expect(f.client.request('POST', '/grants', { delegation: changed })).rejects.toMatchObject({ code: 'GRANT_EXISTS' });
      const delayed = createDelegation(f.owner, f.certificate, { kind: initial.kind, resourceId: initial.resourceId,
        guest, scope, id: initial.id, now: at, lifetimeMs: 25 * 60_000 });
      await f.client.request('DELETE', '/grants/' + initial.id);
      at += 121_000;
      await f.restart();
      await expect(f.client.request('POST', '/grants', { delegation: delayed })).rejects.toMatchObject({ code: 'GRANT_EXISTS' });
    } finally { clock.mockRestore(); }
  });

  it('persists encrypted uploads and push registrations, rejects overlapping chunks and revoked devices', async () => {
    const delivered: unknown[] = [];
    const f = await fixture({ notify: async (event) => { delivered.push(event); } });
    const m = await f.join();
    const plaintext = Buffer.from('confidential attachment '.repeat(4000));
    const ciphertext = encryptMedia(m.identity.transportKey, plaintext);
    const created = await f.client.request<{ id: string }>('POST', '/media', { recipient: 'member', size: ciphertext.length });
    const chunk = { offset: 0, data: Buffer.from(ciphertext.subarray(0, 32768)).toString('base64url') };
    const results = await Promise.allSettled([f.client.request('PUT', '/media/' + created.id, chunk), f.client.request('PUT', '/media/' + created.id, chunk)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((x) => x.status === 'rejected')).toMatchObject({ reason: { code: 'MEDIA_OFFSET_MISMATCH' } });
    // Simulate a crash after bytes reached disk but before the committed offset advanced.
    await writeFile(path.join(f.dataDir, 'media', created.id), Buffer.concat([ciphertext.subarray(0, 32768), Buffer.from('uncommitted')]));
    await m.client.request('PUT', '/push-token', { provider: 'bridge', token: 'test-token', appVariant: 'global', apnsEnv: null });
    await f.restart();
    for (let offset = 32768; offset < ciphertext.length; offset += 32768) {
      await f.client.request('PUT', '/media/' + created.id, { offset, data: Buffer.from(ciphertext.subarray(offset, offset + 32768)).toString('base64url') });
    }
    const member = new AgentNetClient(f.relay.url, m.identity, m.certificate, f.rootPublicKey);
    expect(decryptMedia(m.identity.transportPrivateKey, await member.downloadMedia(created.id))).toEqual(plaintext);
    const range = await member.mediaResponse(created.id, 'bytes=123-400');
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 123-400/' + ciphertext.length);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(Buffer.from(ciphertext.subarray(123, 401)));
    await expect(member.mediaResponse(created.id, 'bytes=999999-')).rejects.toMatchObject({ code: 'INVALID_MEDIA_RANGE' });
    expect((await readFile(path.join(f.dataDir, 'media', created.id))).includes(Buffer.from('confidential'))).toBe(false);
    await f.client.request('POST', '/notify', { to: 'member', ciphertext: 'encrypted-notification' });
    expect(delivered).toEqual([expect.objectContaining({ to: 'member', registration: expect.objectContaining({ token: 'test-token' }), ciphertext: 'encrypted-notification' })]);
    const uplink = await member.connect(); f.uplinks.push(uplink);
    const closed = once(uplink, 'close'); await f.client.request('DELETE', '/devices/member'); expect(await closed).toEqual([4410]);
    await expect(member.directory()).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    await f.restart(); await expect(new AgentNetClient(f.relay.url, m.identity, m.certificate, f.rootPublicKey).directory()).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  it('rejects malformed datagrams before forwarding and limits guests on the WebSocket as well', async () => {
    const f = await fixture(); await f.join();
    const ws = new WebSocket(f.relay.url.replace(/^http/, 'ws') + API + '/ws', { headers: { authorization: authorization(f.owner, f.certificate, 'GET', API + '/ws') } });
    await once(ws, 'open'); const closed = once(ws, 'close');
    const valid = Buffer.from(encodeDatagrams('member', [Buffer.from([1, 2, 3])]));
    ws.send(Buffer.concat([valid, Buffer.from([0xff])])); expect((await closed)[0]).toBe(1008);
    const guest = generateIdentity('guest');
    const delegation = createDelegation(f.owner, f.certificate, { kind: 'shared-task', resourceId: 'task', guest });
    await f.client.request('POST', '/grants', { delegation });
    const g = await new AgentNetClient(f.relay.url, guest, f.certificate, f.rootPublicKey, delegation).connect(); f.uplinks.push(g);
    const guestClosed = once(g, 'close'); g.send('member', Buffer.from([1])); expect(await guestClosed).toEqual([1008]);
  });

  it('serves STUN from its own UDP listener without an official traversal server', async () => {
    const f = await fixture(); const socket = createSocket('udp4'); cleanups.push(() => { socket.close(); });
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    const request = Buffer.alloc(20); request.writeUInt16BE(1, 0); request.writeUInt32BE(0x2112a442, 4); randomBytes(12).copy(request, 8);
    const response = once(socket, 'message'); socket.send(request, f.relay.udpAddress!.port, '127.0.0.1');
    const [bytes] = await response as [Buffer, unknown];
    expect(bytes.readUInt16BE(0)).toBe(0x0101); expect(bytes.subarray(8, 20)).toEqual(request.subarray(8, 20));
    expect(bytes.readUInt16BE(26) ^ 0x2112).toBe((socket.address() as { port: number }).port);
    expect([...bytes.subarray(28)].map((x, i) => x ^ request[4 + i]).join('.')).toBe('127.0.0.1');
  });
  it('uses an IPv6 UDP socket when an embedded host binds IPv6', async () => {
    const f = await fixture({ host: '::1' }), socket = createSocket('udp6');
    cleanups.push(() => { socket.close(); });
    await new Promise<void>((resolve) => socket.bind(0, '::1', resolve));
    const request = Buffer.alloc(20); request.writeUInt16BE(1); request.writeUInt32BE(0x2112a442, 4); randomBytes(12).copy(request, 8);
    const response = once(socket, 'message', { signal: AbortSignal.timeout(2_000) });
    socket.send(request, f.relay.udpAddress!.port, '::1');
    const [bytes] = await response as [Buffer];
    expect(bytes[25]).toBe(2); expect(bytes.readUInt16BE(26) ^ 0x2112).toBe((socket.address() as { port: number }).port);
    const mask = Buffer.concat([request.subarray(4, 8), request.subarray(8, 20)]);
    expect([...bytes.subarray(28)].map((x, i) => x ^ mask[i])).toEqual([...Buffer.alloc(15), 1]);
  });
});
