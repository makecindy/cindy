/**
 * 测试价值
 * - 生产入口与可观察结果:`initializeRelay` + `startRelayServer` 起真实的本机 HTTP/WebSocket 服务,
 *   用真实 ws 客户端与 fetch 断言设备能看到的协议结果(hello-ack、转发帧、relay-error、关闭码、
 *   REST 状态码与响应体、持久化后的凭证与名字)。
 * - Bug/规则依据:docs/self-hosted-relay-plan.md §5.2、§6(线协议必须与官方 relay 对齐,客户端才能
 *   不改协议直接连);§8 安全(凭证认证、加入码一次性、主人才能管理、媒体签名地址)。
 * - 现有覆盖缺口:新包,此前没有中转服务端实现;scripts/device-link/relayFixture.ts 只是测试用假中转。
 * - 最小失败输入:每条用例各对应一个结果分支,例如伪造 src、重复使用加入码、成员调用管理接口、
 *   篡改媒体签名、上传超过声明大小、同意时附的证书不是发给申请里那把公钥、加入链接里的主人公钥与中转不符。
 * - tier:unit。只用本机回环端口与临时目录,无外部服务;过期用注入时钟,不做真实等待。
 * - 实测耗时:见 PR 描述(单文件本机运行)。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect as connectTcp, Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  acceptRelayDeviceCert,
  buildRelayJoinLink,
  computeRelayPairProof,
  createRelayJoinIdentity,
  createRelayPairSecret,
  createRelaySigningKey,
  fetchRelayCertificates,
  fetchRelayInfo,
  issueRelayDeviceCert,
  parseRelayJoinLink,
  RelayJoinError,
  submitRelayPairRequest,
  waitForRelayApproval,
  type RelayFetch,
} from '@cindy/device-link';
import { nodeRelayAuthCrypto as crypto } from '@cindy/device-link/node-relay-crypto';
import type { Envelope } from '@cindy/device-link-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createDeviceCredential, initializeRelay, startRelayServer, type RelayServerHandle } from '../index';
import { startChallengeServer } from '../certificates';
import { DEFAULT_MEDIA_LIMITS, MediaStore } from '../media';

const OWNER_USER = 'user-owner';
const OWNER_DEVICE = 'owner-desktop';
const HOUR = 60 * 60 * 1000;

interface Harness {
  base: string;
  relayId: string;
  ownerCredential: string;
  ownerKey: { seed: string; publicKey: string };
  dataDir: string;
  clock: { now: number };
  handle: RelayServerHandle;
  restart(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: { publicUrl?: string; trustProxyHeaders?: boolean } = {}): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-relay-test-'));
  const owner = createDeviceCredential();
  const ownerKey = createRelaySigningKey(crypto);
  const relayId = randomUUID();
  await initializeRelay({
    dataDir,
    name: 'Test relay',
    ownerUserId: OWNER_USER,
    ownerDeviceId: OWNER_DEVICE,
    ownerDeviceName: 'Owner Mac',
    ownerCredentialHash: owner.credentialHash,
    relayId,
    ownerPublicKey: ownerKey.publicKey,
    ownerCert: issueRelayDeviceCert(crypto, ownerKey.seed, {
      relayId,
      deviceId: OWNER_DEVICE,
      publicKey: ownerKey.publicKey,
      role: 'owner',
      issuedAt: 1,
    }),
  });
  const clock = { now: Date.UTC(2026, 9, 28) };
  const start = () => startRelayServer({ ...options, dataDir, port: 0, now: () => clock.now });
  const harness: Harness = {
    base: '',
    relayId,
    ownerCredential: owner.credential,
    ownerKey,
    dataDir,
    clock,
    handle: await start(),
    async restart() {
      await harness.handle.close();
      harness.handle = await start();
      harness.base = harness.handle.localUrl;
    },
  };
  harness.base = harness.handle.localUrl;
  cleanups.push(async () => {
    await harness.handle.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return harness;
}

async function api(
  base: string,
  method: string,
  pathname: string,
  options: { credential?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.credential) headers.authorization = `CindyRelay ${options.credential}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** 新设备的签名公钥与配对证明(加入申请必带)。 */
function deviceKeys(h: Harness, deviceId: string) {
  const key = createRelaySigningKey(crypto);
  const proof = computeRelayPairProof(crypto, createRelayPairSecret(crypto), { relayId: h.relayId, deviceId, publicKey: key.publicKey });
  return { publicKey: key.publicKey, proof };
}

/** 主人为申请里的公钥签发成员证书。 */
function memberCert(h: Harness, deviceId: string, publicKey: string) {
  return issueRelayDeviceCert(crypto, h.ownerKey.seed, { relayId: h.relayId, deviceId, publicKey, role: 'member', issuedAt: 2 });
}

/** 走完整加入流程,返回新设备的凭证。 */
async function pair(h: Harness, deviceId: string): Promise<string> {
  const code = await api(h.base, 'POST', '/api/device-link/relay/admin/join-codes', { credential: h.ownerCredential });
  const keys = deviceKeys(h, deviceId);
  const submitted = await api(h.base, 'POST', '/api/device-link/relay/pair', {
    body: { code: code.json.code, deviceId, deviceName: deviceId, platform: 'ios', appVersion: '1.0.0', accountUserId: OWNER_USER, ...keys },
  });
  expect(submitted.status).toBe(200);
  await api(h.base, 'POST', `/api/device-link/relay/admin/pair-requests/${submitted.json.requestId}/approve`, {
    credential: h.ownerCredential,
    body: { cert: memberCert(h, deviceId, keys.publicKey) },
  });
  const polled = await api(h.base, 'GET', `/api/device-link/relay/pair/${submitted.json.requestId}`, {
    headers: { 'x-cindy-relay-poll-token': submitted.json.pollToken },
  });
  expect(polled.json.status).toBe('approved');
  return polled.json.credential as string;
}

interface Peer {
  ws: WebSocket;
  frames: Envelope[];
  waitFor(match: (env: Envelope) => boolean): Promise<Envelope>;
  closed: Promise<{ code: number; reason: string }>;
  send(env: Record<string, unknown>): void;
}

function openSocket(base: string, authorization?: string): { ws: WebSocket; peer: Peer } {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/device-link/ws`, {
    headers: authorization ? { authorization } : {},
  });
  ws.on('error', () => undefined);
  const frames: Envelope[] = [];
  const waiters: Array<{ match: (env: Envelope) => boolean; resolve: (env: Envelope) => void }> = [];
  ws.on('message', (data) => {
    const env = JSON.parse(String(data)) as Envelope;
    frames.push(env);
    for (const waiter of [...waiters]) {
      if (!waiter.match(env)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(env);
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  cleanups.push(async () => {
    ws.terminate();
  });
  const peer: Peer = {
    ws,
    frames,
    closed,
    waitFor(match) {
      const existing = frames.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
    send(env) {
      ws.send(JSON.stringify(env));
    },
  };
  return { ws, peer };
}

async function connect(h: Harness, credential: string, remoteControlEnabled: boolean): Promise<Peer> {
  const { ws, peer } = openSocket(h.base, `CindyRelay ${credential}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected ${res.statusCode}`)));
  });
  peer.send({
    v: 1,
    kind: 'hello',
    payload: { deviceName: 'Device', platform: 'darwin', appVersion: '0.0.0-test', remoteControlEnabled, busy: false },
  });
  await peer.waitFor((env) => env.kind === 'hello-ack');
  return peer;
}

function upgradeStatus(base: string, authorization?: string): Promise<number> {
  const { ws } = openSocket(base, authorization);
  return new Promise((resolve) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('open', () => resolve(101));
  });
}

/** 原始请求目标不会被 fetch/URL 预先校验,复现 Node HTTP parser 会放行的坏绝对地址。 */
function rawRequest(port: number, upgrade = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: '127.0.0.1', port }, () => {
      socket.end(`GET http://[ HTTP/1.1\r\nHost: relay.invalid\r\nConnection: ${upgrade ? 'Upgrade' : 'close'}\r\n${upgrade ? 'Upgrade: websocket\r\n' : ''}\r\n`);
    });
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => resolve(response));
  });
}

describe('device-link relay wire contract', () => {
  // 上传开始时签名 URL 被消费,但流仍持有声明大小的配额;过期也不能让并发上传绕过总量。
  // 生产 MediaStore 入口 + 真实文件/流,仅响应对象为桩,无网络与真实等待。tier: unit。
  it('keeps in-flight uploads in the storage quota until completion or failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-relay-quota-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    let now = 1;
    const store = new MediaStore(dir, 'test-signing-key', { ...DEFAULT_MEDIA_LIMITS, maxTotalBytes: 100 }, () => now);
    await store.init();
    const input = { size: 100, ext: 'bin', contentType: 'application/octet-stream' };
    const target = store.presignPut(input, 'http://relay.invalid');
    const stream = Object.assign(new PassThrough(), { method: 'PUT', headers: { 'content-length': '100' } });
    const response = { writeHead: () => {}, end: () => {} } as unknown as ServerResponse;
    const uploading = store.handleBlobRequest(stream as unknown as IncomingMessage, response, new URL(target.putUrl));
    expect(store.stats).toEqual({ usedBytes: 0, reservedBytes: 100 });
    now += DEFAULT_MEDIA_LIMITS.urlTtlMs + 1;
    expect(() => store.presignPut(input, 'http://relay.invalid')).toThrow(expect.objectContaining({ code: 'QUOTA_EXCEEDED' }));
    stream.end(Buffer.alloc(100));
    await uploading;
    expect(store.stats).toEqual({ usedBytes: 100, reservedBytes: 0 });
    await store.delete(target.key);
    const retry = store.presignPut(input, 'http://relay.invalid');
    const failing = Object.assign(new PassThrough(), { method: 'PUT', headers: { 'content-length': '100' } });
    const failed = store.handleBlobRequest(failing as unknown as IncomingMessage, response, new URL(retry.putUrl));
    const rejected = expect(failed).rejects.toMatchObject({ code: 'INTERNAL' });
    failing.destroy(new Error('upload interrupted'));
    await rejected;
    expect(store.stats).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect(() => store.presignPut(input, 'http://relay.invalid')).not.toThrow();
  });
  // 同 key 并发 DELETE / sweep 不能重复释放额度；保留对象仍须计入总量。
  // 两个真实上传各100字节，总量200；并发删其中一个后，新的200字节上传必须拒绝。tier: unit。
  it('releases an object quota once when deletes overlap the expiry sweep', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-relay-delete-quota-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    let now = 1;
    const store = new MediaStore(dir, 'test-signing-key', { ...DEFAULT_MEDIA_LIMITS, maxTotalBytes: 200 }, () => now);
    await store.init();
    const base = 'http://relay.invalid';
    const upload = async () => {
      const target = store.presignPut({ size: 100, ext: 'bin', contentType: 'application/octet-stream' }, base);
      const stream = Object.assign(new PassThrough(), { method: 'PUT', headers: { 'content-length': '100' } });
      const response = { writeHead: () => {}, end: () => {} } as unknown as ServerResponse;
      const uploading = store.handleBlobRequest(stream as unknown as IncomingMessage, response, new URL(target.putUrl));
      stream.end(Buffer.alloc(100));
      await uploading;
      return target.key;
    };
    const expired = await upload();
    now += DEFAULT_MEDIA_LIMITS.objectTtlMs + 1;
    const retained = await upload();
    await Promise.all([...Array.from({ length: 16 }, () => store.delete(expired)), store.sweep()]);
    expect(store.stats).toEqual({ usedBytes: 100, reservedBytes: 0 });
    await expect(store.presignGet(retained, base)).resolves.toMatchObject({ getUrl: expect.any(String) });
    expect(() => store.presignPut({ size: 200, ext: 'bin', contentType: 'application/octet-stream' }, base))
      .toThrow(expect.objectContaining({ code: 'QUOTA_EXCEEDED' }));
    expect(() => store.presignPut({ size: 100, ext: 'bin', contentType: 'application/octet-stream' }, base)).not.toThrow();
  });

  // 公网入口的畸形 request-target 曾在鉴权前抛出未捕获异常；必须回400且仍能处理正常请求。
  // 覆盖生产 HTTP、WS upgrade 与 ACME HTTP 回调，复用现有回环fixture，tier: unit。
  it('rejects malformed HTTP targets on relay, WebSocket and ACME ports without stopping the servers', async () => {
    const h = await setup();
    expect(await rawRequest(h.handle.port)).toMatch(/^HTTP\/1\.1 400 /);
    expect(await rawRequest(h.handle.port, true)).toMatch(/^HTTP\/1\.1 400 /);
    expect((await fetch(h.base + '/api/device-link/relay/info')).status).toBe(200);
    const challenge = await startChallengeServer({ host: '127.0.0.1', port: 0, challenges: new Map([['test-token', 'test-answer']]) });
    cleanups.push(() => challenge.close());
    expect(await rawRequest(challenge.port)).toMatch(/^HTTP\/1\.1 400 /);
    const response = await fetch(`http://127.0.0.1:${challenge.port}/.well-known/acme-challenge/test-token`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('test-answer');
  });
  it('authenticates with CindyRelay credentials only and binds identity to the credential', async () => {
    const h = await setup();
    // 没有凭证、凭证错误、用 Bearer 方案(可能是误发的账号 token)都在升级阶段 401。
    expect(await upgradeStatus(h.base)).toBe(401);
    expect(await upgradeStatus(h.base, `CindyRelay ${'x'.repeat(43)}`)).toBe(401);
    expect(await upgradeStatus(h.base, `Bearer ${h.ownerCredential}`)).toBe(401);

    const owner = await connect(h, h.ownerCredential, true);
    const ack = owner.frames.find((env) => env.kind === 'hello-ack')!;
    expect(ack.payload).toEqual({
      serverProtocolVersion: 1,
      deviceId: OWNER_DEVICE,
      userId: OWNER_USER,
      capabilities: [],
    });
    // REST 401 用专属错误码,不能是会触发 Desktop 刷新/登出 Cindy 账号的 UNAUTHORIZED 等。
    const rest = await api(h.base, 'GET', '/api/device-link/devices', { credential: 'y'.repeat(43) });
    expect(rest.status).toBe(401);
    expect(rest.json.error.code).toBe('RELAY_CREDENTIAL_INVALID');
  });

  it('routes tunnel frames with a relay-assigned src and reports routing failures', async () => {
    const h = await setup();
    const phoneCredential = await pair(h, 'phone-1');
    const host = await connect(h, h.ownerCredential, true);
    const phone = await connect(h, phoneCredential, false);

    const auth = { t: 1, b: 'boot-id-0123456789', c: 1, s: 'sig' };
    phone.send({ v: 1, kind: 'invoke', id: 'req-1', src: 'forged-device', dst: OWNER_DEVICE, payload: { channel: 'x', args: [] }, auth });
    const delivered = await host.waitFor((env) => env.kind === 'invoke' && env.id === 'req-1');
    expect(delivered.src).toBe('phone-1');
    expect(delivered.payload).toEqual({ channel: 'x', args: [] });
    // 设备签名原样交给收件设备核对。
    expect((delivered as Envelope & { auth?: unknown }).auth).toEqual(auth);

    const cases: Array<{ frame: Record<string, unknown>; code: string }> = [
      { frame: { v: 1, kind: 'invoke', id: 'req-2', dst: 'nobody', payload: {} }, code: 'DEVICE_OFFLINE' },
      // 手机没开「允许被控」:控制类帧被拒,回程帧照常送达。
      { frame: { v: 1, kind: 'link-open', id: 'req-3', dst: 'phone-1', payload: {} }, code: 'REMOTE_DISABLED' },
      {
        frame: { v: 1, kind: 'invoke', id: 'req-4', dst: OWNER_DEVICE, sharedTask: { taskId: 't' }, payload: {} },
        code: 'BAD_REQUEST',
      },
      { frame: { v: 1, kind: 'invoke', id: 'req-5', dst: OWNER_DEVICE, payload: {}, auth: 'not-an-object' }, code: 'BAD_REQUEST' },
    ];
    for (const { frame, code } of cases) {
      const sender = frame.dst === 'phone-1' ? host : phone;
      sender.send(frame);
      const error = await sender.waitFor((env) => env.kind === 'relay-error' && env.id === frame.id);
      expect((error.payload as { code: string }).code).toBe(code);
    }
    host.send({ v: 1, kind: 'push', id: 'push-1', dst: 'phone-1', payload: { channel: 'evt' } });
    expect((await phone.waitFor((env) => env.kind === 'push' && env.id === 'push-1')).src).toBe(OWNER_DEVICE);
    expect(host.frames.some((env) => env.kind === 'invoke' && env.id === 'req-4')).toBe(false);
  });

  it('closes on protocol version mismatch with a reason clients classify as version', async () => {
    const h = await setup();
    const { ws, peer } = openSocket(h.base, `CindyRelay ${h.ownerCredential}`);
    await new Promise((resolve) => ws.once('open', resolve));
    peer.send({ v: 2, kind: 'hello', payload: {} });
    const closed = await peer.closed;
    expect(closed.code).toBe(4400);
    expect(closed.reason).toContain('version');
  });
});

describe('pairing and administration', () => {
  // PR #7776：Nginx 后的来源必须按真实客户端隔离；默认不信任代理头，非法链不能绕过限流。
  // 真实 startRelayServer + HTTP 入口，20 次无效申请后另一来源用合法加入码，旧实现会误拦为 429。
  it.each([
    [true, '203.0.113.20', '203.0.113.21', 200, undefined],
    [false, '203.0.113.20', '203.0.113.21', 429, undefined],
    [true, '203.0.113.20, 127.0.0.1', '203.0.113.21, 127.0.0.1', 429, undefined],
    [true, '203.0.113.20', '203.0.113.21', 429, '198.51.100.2'],
  ] as const)('isolates pairing sources only for explicit trusted proxies (%s, %s, %s, %s, peer=%s)', async (trustProxyHeaders, attacker, visitor, expected, peer) => {
    const h = await setup({ trustProxyHeaders });
    // 保留真实 HTTP 处理，仅替换传输层报告的 peer，证明非回环来源不能自报代理头。
    if (peer) {
      const transport = Socket.prototype as unknown as { _getpeername(): { address: string } };
      vi.spyOn(transport, '_getpeername').mockReturnValue({ address: peer });
    }
    for (let i = 0; i < 20; i++) {
      expect((await api(h.base, 'POST', '/api/device-link/relay/pair', {
        body: {}, headers: { 'x-forwarded-for': attacker },
      })).status).toBe(400);
    }
    const code = (await api(h.base, 'POST', '/api/device-link/relay/admin/join-codes', { credential: h.ownerCredential })).json.code;
    const result = await api(h.base, 'POST', '/api/device-link/relay/pair', {
      headers: { 'x-forwarded-for': visitor },
      body: { code, deviceId: 'source-check', deviceName: 'Phone', accountUserId: OWNER_USER, ...deviceKeys(h, 'source-check') },
    });
    expect(result.status).toBe(expected);
  });

  it('admits a device only through a one-time join code and the owner approval', async () => {
    const h = await setup();
    const code = (await api(h.base, 'POST', '/api/device-link/relay/admin/join-codes', { credential: h.ownerCredential })).json.code;
    const keys = deviceKeys(h, 'laptop-2');
    const request = { code, deviceId: 'laptop-2', deviceName: 'Laptop', platform: 'win32', appVersion: '1.0.0', ...keys };

    // 账号不一致被拒,但加入码保留给正确的设备。
    const wrongAccount = await api(h.base, 'POST', '/api/device-link/relay/pair', { body: { ...request, accountUserId: 'someone-else' } });
    expect(wrongAccount.json.error.code).toBe('ACCOUNT_MISMATCH');
    const submitted = await api(h.base, 'POST', '/api/device-link/relay/pair', { body: { ...request, accountUserId: OWNER_USER } });
    expect(submitted.status).toBe(200);
    expect(submitted.json.verifyCode).toMatch(/^\d{4}$/);
    const reused = await api(h.base, 'POST', '/api/device-link/relay/pair', { body: { ...request, accountUserId: OWNER_USER } });
    expect(reused.status).toBe(403);

    const pollPath = `/api/device-link/relay/pair/${submitted.json.requestId}`;
    const pollHeaders = { 'x-cindy-relay-poll-token': submitted.json.pollToken };
    expect((await api(h.base, 'GET', pollPath, { headers: pollHeaders })).json).toEqual({ status: 'pending' });
    expect((await api(h.base, 'GET', pollPath, { headers: { 'x-cindy-relay-poll-token': 'wrong' } })).status).toBe(403);

    const pending = await api(h.base, 'GET', '/api/device-link/relay/admin/pair-requests', { credential: h.ownerCredential });
    expect(pending.json.requests).toMatchObject([{ deviceId: 'laptop-2', verifyCode: submitted.json.verifyCode, ...keys }]);
    // 同意必须附主人为申请里这把公钥签发的证书:没有证书、证书发给别的公钥都不算同意。
    const approvePath = `/api/device-link/relay/admin/pair-requests/${submitted.json.requestId}/approve`;
    expect((await api(h.base, 'POST', approvePath, { credential: h.ownerCredential, body: {} })).status).toBe(400);
    const otherKey = createRelaySigningKey(crypto).publicKey;
    expect(
      (await api(h.base, 'POST', approvePath, { credential: h.ownerCredential, body: { cert: memberCert(h, 'laptop-2', otherKey) } })).status,
    ).toBe(400);
    expect((await api(h.base, 'GET', pollPath, { headers: pollHeaders })).json).toEqual({ status: 'pending' });
    await api(h.base, 'POST', approvePath, { credential: h.ownerCredential, body: { cert: memberCert(h, 'laptop-2', keys.publicKey) } });
    const approved = await api(h.base, 'GET', pollPath, { headers: pollHeaders });
    expect(approved.json.status).toBe('approved');
    expect(approved.json.cert).toMatchObject({ deviceId: 'laptop-2', publicKey: keys.publicKey, role: 'member' });
    // 凭证只给一次。
    expect((await api(h.base, 'GET', pollPath, { headers: pollHeaders })).json).toEqual({ status: 'expired' });
    const devices = await api(h.base, 'GET', '/api/device-link/devices', { credential: approved.json.credential });
    expect(devices.json.devices.map((d: { deviceId: string; isSelf: boolean }) => [d.deviceId, d.isSelf])).toEqual([
      [OWNER_DEVICE, false],
      ['laptop-2', true],
    ]);
  });

  it('gives nothing for rejected requests and expired join codes', async () => {
    const h = await setup();
    const codes = [];
    for (let i = 0; i < 2; i++) {
      codes.push((await api(h.base, 'POST', '/api/device-link/relay/admin/join-codes', { credential: h.ownerCredential })).json.code);
    }
    const body = { deviceId: 'phone-x', deviceName: 'Phone', accountUserId: OWNER_USER, ...deviceKeys(h, 'phone-x') };
    const submitted = await api(h.base, 'POST', '/api/device-link/relay/pair', { body: { ...body, code: codes[0] } });
    await api(h.base, 'POST', `/api/device-link/relay/admin/pair-requests/${submitted.json.requestId}/reject`, {
      credential: h.ownerCredential,
    });
    const polled = await api(h.base, 'GET', `/api/device-link/relay/pair/${submitted.json.requestId}`, {
      headers: { 'x-cindy-relay-poll-token': submitted.json.pollToken },
    });
    expect(polled.json).toEqual({ status: 'rejected' });

    h.clock.now += 11 * 60 * 1000;
    const expired = await api(h.base, 'POST', '/api/device-link/relay/pair', { body: { ...body, code: codes[1] } });
    expect(expired.status).toBe(403);
    const devices = await api(h.base, 'GET', '/api/device-link/devices', { credential: h.ownerCredential });
    expect(devices.json.devices).toHaveLength(1);
  });

  it('lets only the owner manage the relay and disconnects removed devices for good', async () => {
    const h = await setup();
    const memberA = await pair(h, 'member-a');
    const memberB = await pair(h, 'member-b');
    for (const [method, pathname] of [
      ['POST', '/api/device-link/relay/admin/join-codes'],
      ['GET', '/api/device-link/relay/admin/pair-requests'],
      ['GET', '/api/device-link/relay/admin/status'],
      ['DELETE', '/api/device-link/devices/member-b'],
      ['DELETE', `/api/device-link/devices/${OWNER_DEVICE}`],
    ]) {
      expect((await api(h.base, method, pathname, { credential: memberA })).status).toBe(403);
    }

    const socketB = await connect(h, memberB, false);
    const removed = await api(h.base, 'DELETE', '/api/device-link/devices/member-b', { credential: h.ownerCredential });
    expect(removed.json).toEqual({ deviceId: 'member-b', deleted: true });
    expect((await socketB.closed).code).toBe(4410);
    expect(await upgradeStatus(h.base, `CindyRelay ${memberB}`)).toBe(401);
    // 成员可以让自己退出。
    expect((await api(h.base, 'DELETE', '/api/device-link/devices/member-a', { credential: memberA })).status).toBe(200);
  });

  it('keeps credentials and device names across a restart', async () => {
    const h = await setup();
    const member = await pair(h, 'member-p');
    await api(h.base, 'PATCH', '/api/device-link/devices/member-p', { credential: h.ownerCredential, body: { name: 'Work phone' } });
    await h.restart();
    const devices = await api(h.base, 'GET', '/api/device-link/devices', { credential: member });
    expect(devices.status).toBe(200);
    expect(devices.json.devices.find((d: { deviceId: string }) => d.deviceId === 'member-p').name).toBe('Work phone');
  });
});

describe('joining through the shared client helpers (Desktop / Mobile path)', () => {
  const relayFetch: RelayFetch = (url, init) => fetch(url, init);
  const device = { deviceId: 'phone-j', deviceName: 'Phone', platform: 'ios', appVersion: '1.0.0', accountUserId: OWNER_USER };

  async function joinLink(h: Harness, ownerPublicKey = h.ownerKey.publicKey) {
    const code = (await api(h.base, 'POST', '/api/device-link/relay/admin/join-codes', { credential: h.ownerCredential })).json.code;
    const pairSecret = createRelayPairSecret(crypto);
    return parseRelayJoinLink(buildRelayJoinLink({ baseUrl: h.base, code, ownerPublicKey, pairSecret, app: 'cindycn' }))!;
  }

  /** 主人电脑的同意动作:签发证书并同意。 */
  async function approveAsOwner(h: Harness, requestId: string, deviceId: string) {
    const pending = await api(h.base, 'GET', '/api/device-link/relay/admin/pair-requests', { credential: h.ownerCredential });
    const request = pending.json.requests.find((r: { requestId: string }) => r.requestId === requestId);
    await api(h.base, 'POST', `/api/device-link/relay/admin/pair-requests/${requestId}/approve`, {
      credential: h.ownerCredential,
      body: { cert: memberCert(h, deviceId, request.publicKey) },
    });
  }

  it('joins after approval, reports typed errors, and tells members when the relay is retired', async () => {
    const h = await setup();
    const info = await fetchRelayInfo(relayFetch, h.base);
    expect(info.name).toBe('Test relay');

    const link = await joinLink(h);
    const identity = createRelayJoinIdentity(crypto, link, info.relayId, device.deviceId);
    const signed = { ...device, publicKey: identity.publicKey, proof: identity.proof };
    await expect(submitRelayPairRequest(relayFetch, link, { ...signed, accountUserId: 'other' })).rejects.toMatchObject({
      code: 'ACCOUNT_MISMATCH',
    });
    const request = await submitRelayPairRequest(relayFetch, link, signed);
    const approval = waitForRelayApproval(relayFetch, link, request);
    await approveAsOwner(h, request.requestId, device.deviceId);
    const result = await approval;
    expect(result.deviceId).toBe('phone-j');
    const cert = acceptRelayDeviceCert(crypto, link, { relayId: info.relayId, deviceId: 'phone-j', publicKey: identity.publicKey, cert: result.cert });
    const certs = await fetchRelayCertificates(relayFetch, h.base, result.credential);
    expect(certs).toContainEqual(cert);
    await expect(submitRelayPairRequest(relayFetch, link, signed)).rejects.toMatchObject({ code: 'CODE_INVALID' });

    const declinedLink = await joinLink(h);
    const declined = await submitRelayPairRequest(relayFetch, declinedLink, { ...signed, deviceId: 'phone-k' });
    const declinedWait = waitForRelayApproval(relayFetch, declinedLink, declined);
    await api(h.base, 'POST', `/api/device-link/relay/admin/pair-requests/${declined.requestId}/reject`, { credential: h.ownerCredential });
    await expect(declinedWait).rejects.toBeInstanceOf(RelayJoinError);
    await expect(declinedWait).rejects.toMatchObject({ code: 'REJECTED' });

    // 主人停用中转:成员收到 4410(客户端据此停止重连并提示「中转已停用」)。
    const member = await connect(h, result.credential, false);
    await h.handle.close({ retire: true });
    expect((await member.closed).code).toBe(4410);
  });

  it('refuses a certificate from an owner other than the one in the join link', async () => {
    // 链接里的主人公钥与中转实际的主人不符(例如中转被换成别人的):证书核对失败,不能加入。
    const h = await setup();
    const info = await fetchRelayInfo(relayFetch, h.base);
    const link = await joinLink(h, createRelaySigningKey(crypto).publicKey);
    const identity = createRelayJoinIdentity(crypto, link, info.relayId, device.deviceId);
    const request = await submitRelayPairRequest(relayFetch, link, { ...device, publicKey: identity.publicKey, proof: identity.proof });
    const approval = waitForRelayApproval(relayFetch, link, request);
    await approveAsOwner(h, request.requestId, device.deviceId);
    const result = await approval;
    expect(() =>
      acceptRelayDeviceCert(crypto, link, { relayId: info.relayId, deviceId: device.deviceId, publicKey: identity.publicKey, cert: result.cert }),
    ).toThrow(expect.objectContaining({ code: 'OWNER_MISMATCH' }));
  });

  it('reports an unreachable address without hanging', async () => {
    const h = await setup();
    const port = h.handle.port;
    await h.handle.close();
    await expect(fetchRelayInfo(relayFetch, `http://127.0.0.1:${port}`)).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });
});

describe('media relay', () => {
  // #7722：反向代理内部 Host 是回环地址，对外 HTTPS 地址必须用于上传和下载签名链接。
  // 真实服务及媒体读写，代理仅将签名 URL 的路径/查询转发至回环端口，不信任客户端代理头。
  it('uses the configured public address for signed uploads, downloads and byte ranges', async () => {
    const publicUrl = 'https://relay.home.example/relay';
    const h = await setup({ publicUrl });
    const proxyFetch = (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(url);
      return fetch(h.base + parsed.pathname.slice('/relay'.length) + parsed.search, init);
    };
    const bytes = Buffer.from('hello self-hosted relay');
    const put = await api(h.base, 'POST', '/api/device-link/media/presign-put', {
      credential: h.ownerCredential,
      body: { size: bytes.length, ext: 'txt', contentType: 'text/plain' },
      headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'untrusted.example' },
    });
    expect(put.status).toBe(200);
    expect(put.json.putUrl.startsWith(publicUrl + '/api/device-link/relay/blob/')).toBe(true);
    const uploaded = await proxyFetch(put.json.putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', 'x-oss-object-acl': 'private' },
      body: bytes,
    });
    expect(uploaded.status).toBe(200);
    // 签名地址只能上传一次。
    expect((await proxyFetch(put.json.putUrl, { method: 'PUT', body: bytes })).status).toBe(409);

    const get = await api(h.base, 'POST', '/api/device-link/media/presign-get', {
      credential: h.ownerCredential, body: { key: put.json.key },
      headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'untrusted.example' },
    });
    expect(get.json.getUrl.startsWith(publicUrl + '/api/device-link/relay/blob/')).toBe(true);
    const full = await proxyFetch(get.json.getUrl);
    expect(full.headers.get('content-type')).toBe('text/plain');
    expect(await full.text()).toBe('hello self-hosted relay');
    const ranged = await proxyFetch(get.json.getUrl, { headers: { Range: 'bytes=6-9' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 6-9/${bytes.length}`);
    expect(await ranged.text()).toBe('self');

    const tampered = new URL(get.json.getUrl);
    tampered.searchParams.set('sig', '0'.repeat(64));
    expect((await proxyFetch(tampered)).status).toBe(403);
    h.clock.now += 2 * HOUR;
    expect((await proxyFetch(get.json.getUrl)).status).toBe(403);
  });

  it('rejects uploads larger than the presigned size without keeping a partial object', async () => {
    const h = await setup();
    const put = await api(h.base, 'POST', '/api/device-link/media/presign-put', {
      credential: h.ownerCredential,
      body: { size: 4, ext: 'bin', contentType: 'application/octet-stream' },
    });
    const res = await fetch(put.json.putUrl, { method: 'PUT', body: Buffer.alloc(16) });
    expect(res.status).toBe(413);
    const stored = (await readdir(path.join(h.dataDir, 'media'))).filter((name) => !name.startsWith('.'));
    expect(stored).toEqual([]);
    const get = await api(h.base, 'POST', '/api/device-link/media/presign-get', { credential: h.ownerCredential, body: { key: put.json.key } });
    expect(get.status).toBe(404);
  });
});
