import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleWebhookPreset, type Schedule, type Scheduler, type ScheduleWebhookSource } from '@cindy/maker-scheduler';
import { WebSocketServer, type WebSocket } from 'ws';

// 测试价值
// - 生产入口与可观察结果：ScheduleWebhookHost 经真实 HTTP 与 WebSocket 连到合同相同的假服务器；
//   断言它发出的请求、ack 时机和任务收到的事件。
// - 规则依据：docs/product-rules/schedule-webhook-trigger.md 的账号要求，cindy-server docs/webhook-server.md。
// - 现有覆盖缺口：host.test.ts 只覆盖开发版的本机入口，服务器通道是新代码。
// - 最小失败输入：未登录、落盘失败、token 到期、账号封停、地址数超限、重发批次。
// - tier：unit，只用回环地址和临时目录。

const dirs = vi.hoisted(() => ({ root: '' }));

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: String },
}));
vi.mock('../../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(dirs.root, ...parts),
}));
vi.mock('../../../plugin-oauth/identityStore.js', () => ({ oauthSecureStorageAvailable: () => true }));

import { ScheduleWebhookHost } from '../index';
import { ScheduleWebhookRemote } from '../remote';

class FakeScheduler extends EventEmitter {
  schedules: Schedule[] = [];
  runNow = vi.fn(async () => ({ runId: 'r1' }));
  async list() { return this.schedules; }
  async get(id: string) { return this.schedules.find((s) => s.id === id) ?? null; }
  getInflightCount() { return 0; }
}

const schedule = (id: string, events?: string[], source?: ScheduleWebhookSource) =>
  ({
    id,
    name: id,
    status: 'active',
    webhookTrigger: { endpointId: `local-${id}`, ...(events ? { events } : {}), ...(source ? { source } : {}) },
  }) as Schedule;

const GITHUB_FORMAT = scheduleWebhookPreset('github')!.format;

interface FakeEndpoint {
  id: string;
  url: string;
  scheduleId: string;
  events: string[];
  format: unknown;
  hasSecret: boolean;
  /** 只在假服务器里记录，用来断言客户端提交了什么。 */
  secret?: string;
  status: 'active' | 'suspended';
  lastReceivedAt: string | null;
}

/** 与 webhook-server 合同相同的最小实现。 */
class FakeServer {
  readonly releases = new Map<string, string>();
  accountManagement = false;
  readonly requests: string[] = [];
  readonly endpoints = new Map<string, FakeEndpoint>();
  readonly frames: Record<string, unknown>[] = [];
  readonly sockets: WebSocket[] = [];
  upgrades = 0;
  rejectUpgrades = 0;
  endpointLimit = Infinity;
  suspended = false;
  unavailable = false;
  rejectDeletes = false;
  dropNextUpsertResponse = false;
  private readonly created = new Map<string, number>();
  validToken = 'token-1';
  private readonly http: Server;
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor() {
    this.http = createServer((req, res) => this.handle(req, res));
    this.http.on('upgrade', (req, socket, head) => {
      this.upgrades += 1;
      if (this.rejectUpgrades > 0 || req.headers.authorization !== `Bearer ${this.validToken}`) {
        this.rejectUpgrades = Math.max(this.rejectUpgrades - 1, 0);
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.push(ws);
        ws.on('message', (raw) => this.frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
        ws.send(JSON.stringify({ type: 'welcome', version: 1 }));
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.wss.clients) socket.terminate();
    this.http.closeAllConnections();
    await new Promise((resolve) => this.http.close(resolve));
  }

  push(batch: Record<string, unknown>): void {
    this.sockets.at(-1)?.send(JSON.stringify({ type: 'events', ...batch }));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const route = `${req.method} ${req.url}`;
      this.requests.push(route);
      const reply = (status: number, body?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? undefined : JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${this.validToken}`) return reply(401, { error: { code: 'UNAUTHORIZED' } });
      if (this.unavailable) return reply(503);
      if (this.suspended) return reply(403, { error: { code: 'WEBHOOK_ACCOUNT_SUSPENDED' } });
      const upsert = route.match(/^PUT \/api\/v1\/endpoints\/by-schedule\/(.+)$/);
      const secret = route.match(/^PUT \/api\/v1\/endpoints\/(.+)\/secret$/);
      const rotate = route.match(/^POST \/api\/v1\/endpoints\/(.+)\/rotate$/);
      const body = () => JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
      const byId = (id: string) => [...this.endpoints.values()].find((row) => row.id === id);
      const remove = route.match(/^DELETE \/api\/v1\/endpoints\/(.+)$/);
      if (this.accountManagement) {
        if (route === 'GET /api/v1/account/endpoints') return reply(200, { limit: 10, used: this.endpoints.size, endpoints: [...this.endpoints.values()] });
        if (route === 'GET /api/v1/endpoints/released') return reply(200, { released: [...this.releases].map(([scheduleId, releaseId]) => ({ scheduleId, releaseId })) });
        const release = route.match(/^DELETE \/api\/v1\/account\/endpoints\/(.+)$/);
        if (release) {
          const endpoint = byId(release[1]);
          if (endpoint) { this.endpoints.delete(endpoint.scheduleId); this.releases.set(endpoint.scheduleId, 'release-1'); }
          return reply(204);
        }
        const restore = route.match(/^POST \/api\/v1\/endpoints\/by-schedule\/(.+)\/restore$/);
        if (restore) {
          const scheduleId = restore[1];
          if (body().releaseId !== this.releases.get(scheduleId)) return reply(409, { error: { code: 'WEBHOOK_ENDPOINT_RELEASED' } });
          this.releases.delete(scheduleId);
          const endpoint: FakeEndpoint = { id: 'whk_restored', url: 'https://webhook.test/hooks/whk_restored', scheduleId,
            events: body().events as string[], format: body().format, hasSecret: false, status: 'active', lastReceivedAt: null };
          this.endpoints.set(scheduleId, endpoint);
          return reply(201, endpoint);
        }
      }
      if (route === 'GET /api/v1/endpoints') return reply(200, { endpoints: [...this.endpoints.values()] });
      if (upsert?.[1]) {
        const scheduleId = upsert[1];
        if (this.releases.has(scheduleId)) return reply(409, { error: { code: 'WEBHOOK_ENDPOINT_RELEASED' } });
        const { events, format } = body() as { events: string[]; format: unknown };
        const existing = this.endpoints.get(scheduleId);
        if (!existing && this.endpoints.size >= this.endpointLimit) return reply(409, { error: { code: 'WEBHOOK_ENDPOINT_LIMIT' } });
        const serial = this.created.get(scheduleId) ?? 0;
        const id = `whk-${scheduleId}${serial ? `-${serial}` : ''}`;
        const endpoint = existing ?? {
          id,
          url: `https://webhook.test/hooks/${id}`,
          scheduleId,
          events,
          format,
          hasSecret: false,
          status: 'active' as const,
          lastReceivedAt: null,
        };
        endpoint.events = events;
        endpoint.format = format;
        this.endpoints.set(scheduleId, endpoint);
        if (!existing) this.created.set(scheduleId, serial + 1);
        if (this.dropNextUpsertResponse) {
          this.dropNextUpsertResponse = false;
          res.destroy();
          return;
        }
        return reply(existing ? 200 : 201, endpoint);
      }
      if (secret?.[1]) {
        const endpoint = byId(secret[1]);
        if (!endpoint) return reply(404, { error: { code: 'NOT_FOUND' } });
        endpoint.secret = body().secret as string;
        endpoint.hasSecret = true;
        return reply(200, endpoint);
      }
      if (rotate?.[1]) {
        const endpoint = byId(rotate[1]);
        if (!endpoint) return reply(404, { error: { code: 'NOT_FOUND' } });
        endpoint.id = `${endpoint.id}-r`;
        endpoint.url = `https://webhook.test/hooks/${endpoint.id}`;
        return reply(200, endpoint);
      }
      if (remove) {
        if (this.rejectDeletes) return reply(503);
        for (const [key, row] of this.endpoints) if (row.id === remove[1]) this.endpoints.delete(key);
        return reply(204);
      }
      return reply(404, { error: { code: 'NOT_FOUND' } });
    });
  }
}

const event = (deliveryId: string, name = 'pull_request') => ({ deliveryId, event: name, receivedAt: 1 });

// Unit: late reads and queued mutations must remain bound to the original account.
// This race is not exercised by the ordinary connected-server lifecycle tests.
it('换账号后拒绝迟到清单和未发送的旧释放操作', async () => {
  let finish!: (response: Response) => void;
  const request = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const remote = new ScheduleWebhookRemote({ baseUrl: () => 'https://webhook.test',
    getAccessToken: async () => 'test-token', refreshAccessToken: async () => false,
    fetch: request, socketOptions: async () => ({}), onBatch: async () => {}, logger: {} });
  const read = remote.accountOverview();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const release = remote.releaseEndpoint('whk_old');
  const rejectedRelease = expect(release).rejects.toThrow('WEBHOOK_ACCOUNT_CHANGED');
  const rejectedRead = expect(read).rejects.toThrow('WEBHOOK_ACCOUNT_CHANGED');
  remote.pause();
  finish(new Response(JSON.stringify({ used: 1, limit: 10, endpoints: [] })));
  await rejectedRead;
  await rejectedRelease;
  expect(request).toHaveBeenCalledOnce();
});

describe('ScheduleWebhookHost 服务器通道', () => {
  let scheduler: FakeScheduler;
  let server: FakeServer;
  let host: ScheduleWebhookHost;
  let signedIn: boolean;
  let token: string;
  let serverUrl: string;
  let refresh: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

  async function start(
    schedules: Schedule[],
    baseUrlOverride?: string,
    onQuotaExhausted?: (quota: { limit: number; resetAt: number }) => void,
  ): Promise<void> {
    scheduler.schedules = schedules;
    const baseUrl = baseUrlOverride ?? (await server.listen());
    serverUrl = baseUrl;
    host = new ScheduleWebhookHost(scheduler as unknown as Scheduler, {}, {
      ...(onQuotaExhausted ? { onQuotaExhausted } : {}),
      remote: {
        isSignedIn: () => signedIn,
        baseUrl: () => baseUrl,
        getAccessToken: async () => (signedIn ? token : null),
        refreshAccessToken: refresh,
        fetch,
        socketOptions: async () => ({}),
        logger: {},
      },
    });
    await host.start();
  }

  beforeEach(() => {
    dirs.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-schedule-webhook-remote-'));
    scheduler = new FakeScheduler();
    server = new FakeServer();
    signedIn = true;
    token = 'token-1';
    refresh = vi.fn(async () => true);
  });

  afterEach(async () => {
    await host.stop();
    await server.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  });

  // PR #8470: disabling while disconnected, then enabling with a new trigger
  // identity must revoke the previous URL/key even across a process restart.
  // Existing lifecycle tests only disabled while the server was reachable.
  it.each(['signed-out', 'offline'])('replaces the old address after %s disable/re-enable and restart', async (mode) => {
    const original = schedule('s1');
    await start([original]);
    await host.setSecret(original);
    const previous = await host.rotateUrl(original);
    const baseUrl = serverUrl;
    signedIn = mode !== 'signed-out';
    server.unavailable = mode === 'offline';
    await host.stop();
    await start([], baseUrl);
    expect(server.endpoints.get('s1')?.url).toBe(previous.url);
    await host.stop();
    signedIn = true;
    server.unavailable = false;
    const enabled = { ...original, webhookTrigger: { ...original.webhookTrigger!, endpointId: 'new-local-s1' } };
    await start([enabled], baseUrl);
    expect(host.status(enabled)).toMatchObject({ hasSecret: false });
    expect(host.status(enabled)?.url).not.toBe(previous.url);
    expect(server.requests).toContain('DELETE /api/v1/endpoints/whk-s1-r');
    const currentUrl = host.status(enabled)?.url;
    await host.stop();
    await start([enabled], baseUrl);
    expect(host.status(enabled)?.url).toBe(currentUrl);
    expect(server.requests.filter((r) => r === 'DELETE /api/v1/endpoints/whk-s1-r')).toHaveLength(1);
  });

  // Unit: a successful server mutation with a lost reply must still be revoked
  // after the next local identity change; normal offline tests never create it.
  it('remembers an address created by a PUT whose response was lost', async () => {
    server.dropNextUpsertResponse = true;
    await start([schedule('s1')]);
    const oldUrl = server.endpoints.get('s1')?.url;
    expect(oldUrl).toBeTruthy();
    expect(host.status(schedule('s1'))?.url).toBeUndefined();
    await host.stop();
    const enabled = schedule('s1');
    enabled.webhookTrigger!.endpointId = 'new-local-s1';
    await start([enabled], serverUrl);
    expect(server.requests).toContain('DELETE /api/v1/endpoints/whk-s1');
    expect(host.status(enabled)?.url).toBeTruthy();
    expect(host.status(enabled)?.url).not.toBe(oldUrl);
  });

  // Unit: failed revocation must not expose the old connection or accept its
  // queued events. Once recovered, only batches for the replacement can queue.
  it('withholds the old connection until revocation succeeds and ignores its late batches', async () => {
    const original = schedule('s1');
    await start([original]);
    await host.setSecret(original);
    await vi.waitFor(() => expect(host.status(original)?.connected).toBe(true));
    server.push({ batchId: 'before-disable', endpointId: 'whk-s1', scheduleId: 's1', events: [event('before-disable')], omitted: 0 });
    await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'before-disable' }));
    await host.stop();
    server.rejectDeletes = true;
    const enabled = schedule('s1');
    enabled.webhookTrigger!.endpointId = 'new-local-s1';
    await start([enabled], serverUrl);
    expect(host.status(enabled)?.url).toBeUndefined();
    await expect(host.setSecret(enabled)).rejects.toThrow('Webhook endpoint is not available');
    expect(server.endpoints.get('s1')?.hasSecret).toBe(true);
    expect(server.requests.filter((route) => route.endsWith('/secret'))).toHaveLength(1);
    server.rejectDeletes = false;
    await host.refreshStatus();
    expect(host.status(enabled)).toMatchObject({ hasSecret: false });
    await vi.waitFor(() => expect(host.status(enabled)?.connected).toBe(true));
    server.push({ batchId: 'old', endpointId: 'whk-s1', scheduleId: 's1', events: [event('old')], omitted: 0 });
    server.push({ batchId: 'new', endpointId: server.endpoints.get('s1')!.id, scheduleId: 's1', events: [event('new')], omitted: 0 });
    await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'new' }));
    expect(server.frames).toContainEqual({ type: 'ack', batchId: 'old' });
    const saved = JSON.parse(fs.readFileSync(path.join(dirs.root, 'schedule-webhooks', 'state.json'), 'utf8'));
    expect(saved.endpoints.s1.pending.map((row: { deliveryId: string }) => row.deliveryId)).toEqual(['new']);
  });

  it('正式模式不开本机端口，地址和密钥来自服务器', async () => {
    await start([schedule('s1', ['check_suite'])]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));

    const status = host.status(schedule('s1'));
    expect(status).toMatchObject({ receiver: 'cloud', url: 'https://webhook.test/hooks/whk-s1', hasSecret: false });
    expect(server.endpoints.get('s1')).toMatchObject({ events: ['check_suite'], format: GITHUB_FORMAT });

    const { secret } = await host.setSecret(schedule('s1'));
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(server.endpoints.get('s1')?.secret).toBe(secret);
    expect(host.status(schedule('s1'))?.hasSecret).toBe(true);
    expect(fs.existsSync(path.join(dirs.root, 'schedule-webhooks', 'secrets'))).toBe(false);
  });

  // Account release is authoritative even while the local schedule stays enabled.
  // A normal reconnect must not recreate it; only explicit restore receives a new URL.
  it('账号释放后刷新清单并阻止重建，明确重新连接才生成新地址', async () => {
    server.accountManagement = true;
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    expect(await host.accountOverview()).toMatchObject({ used: 1, limit: 10 });
    server.push({ batchId: 'release-batch', endpointId: 'whk-s1', scheduleId: 's1', events: [event('pending')], omitted: 0 });
    await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'release-batch' }));
    await host.releaseEndpoint('whk-s1');
    const saved = JSON.parse(fs.readFileSync(path.join(dirs.root, 'schedule-webhooks', 'state.json'), 'utf8'));
    expect(saved.endpoints.s1).toBeUndefined();
    expect(host.status(schedule('s1'))).toMatchObject({ problem: 'released', hasSecret: false });
    expect(host.status(schedule('s1'))?.url).toBeUndefined();
    await host.refreshStatus();
    expect(server.endpoints.size).toBe(0);
    expect(await host.accountOverview()).toMatchObject({ used: 0 });
    await host.restoreEndpoint(schedule('s1'));
    expect(host.status(schedule('s1'))).toMatchObject({ url: 'https://webhook.test/hooks/whk_restored', hasSecret: false });
    expect(host.status(schedule('s1'))?.problem).toBeUndefined();
  });

  it('旧服务明确提示账号管理未部署，原接收能力继续工作', async () => {
    await start([schedule('s1')]);
    await expect(host.accountOverview()).rejects.toThrow('WEBHOOK_MANAGEMENT_UNAVAILABLE');
    expect(host.status(schedule('s1'))?.url).toBeTruthy();
  });

  it('未登录时不发任何请求也不连接，配置保留；登录后恢复', async () => {
    signedIn = false;
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.receiver()).toBe('signed-out'));
    expect(host.status(schedule('s1'))).toMatchObject({ receiver: 'signed-out', hasSecret: false });
    expect(host.status(schedule('s1'))?.url).toBeUndefined();
    await expect(host.setSecret(schedule('s1'))).rejects.toThrow('WEBHOOK_ACCOUNT_REQUIRED');
    expect(server.requests).toEqual([]);
    expect(server.upgrades).toBe(0);

    signedIn = true;
    host.authChanged();
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    expect(server.endpoints.has('s1')).toBe(true);
  });

  it('退出登录时断开连接', async () => {
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    signedIn = false;
    host.authChanged();
    await vi.waitFor(() => expect(server.sockets[0]?.readyState).toBe(server.sockets[0]?.CLOSED));
    expect(host.status(schedule('s1'))).toMatchObject({ receiver: 'signed-out' });
  });

  it('没有部署服务时不可用，也不发请求', async () => {
    await start([schedule('s1')], '');
    await vi.waitFor(() => expect(host.receiver()).toBe('unavailable'));
    expect(server.requests).toEqual([]);
  });

  it('清掉服务器上已不存在任务的地址；筛选没变时不重复写入', async () => {
    const stored = { url: 'u', format: GITHUB_FORMAT, hasSecret: true, status: 'active' as const, lastReceivedAt: null };
    server.endpoints.set('gone', { ...stored, id: 'whk-gone', scheduleId: 'gone', events: [] });
    // 服务器返回的键顺序与本机预设不同，也不应判为有变化。
    server.endpoints.set('s1', { ...stored, id: 'whk-s1', scheduleId: 's1', events: ['a', 'b'], format: { fields: GITHUB_FORMAT.fields, ping: GITHUB_FORMAT.ping, signature: GITHUB_FORMAT.signature, version: 1 } });
    await start([schedule('s1', ['b', 'a'])]);
    await vi.waitFor(() => expect(server.endpoints.has('gone')).toBe(false));
    expect(server.requests.filter((route) => route.startsWith('PUT'))).toEqual([]);
    expect(host.status(schedule('s1'))?.hasSecret).toBe(true);
  });

  it('事件落盘后才确认；重发的批次不重复累加计数', async () => {
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));

    const batch = { batchId: 'b1', endpointId: 'whk-s1', scheduleId: 's1', events: [event('d1')], omitted: 2 };
    server.push(batch);
    await vi.waitFor(() => expect(server.frames).toEqual([{ type: 'ack', batchId: 'b1' }]));
    const saved = JSON.parse(fs.readFileSync(path.join(dirs.root, 'schedule-webhooks', 'state.json'), 'utf8')) as {
      endpoints: Record<string, { pending: { deliveryId: string }[]; omitted: number }>;
    };
    expect(saved.endpoints.s1?.pending.map((row) => row.deliveryId)).toEqual(['d1']);
    expect(saved.endpoints.s1?.omitted).toBe(2);

    server.push({ ...batch, batchId: 'b2' });
    await vi.waitFor(() => expect(server.frames).toHaveLength(2));
    const again = JSON.parse(fs.readFileSync(path.join(dirs.root, 'schedule-webhooks', 'state.json'), 'utf8')) as typeof saved;
    expect(again.endpoints.s1?.pending).toHaveLength(1);
    expect(again.endpoints.s1?.omitted).toBe(2);
  });

  it('落盘失败时不确认，让服务器保留事件', async () => {
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    fs.rmSync(path.join(dirs.root, 'schedule-webhooks'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dirs.root, 'schedule-webhooks'), 'not a directory');

    server.push({ batchId: 'b1', endpointId: 'whk-s1', scheduleId: 's1', events: [event('d1')], omitted: 0 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.frames).toEqual([]);
  });

  it('确认已删除任务的批次，避免服务器反复重发；丢弃格式不对的帧', async () => {
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    server.push({ batchId: 'bad', endpointId: 'x', scheduleId: 's1', events: [{ event: 'no-delivery-id' }], omitted: 0 });
    server.push({ batchId: 'b1', endpointId: 'x', scheduleId: 'deleted', events: [event('d1')], omitted: 0 });
    await vi.waitFor(() => expect(server.frames).toEqual([{ type: 'ack', batchId: 'b1' }]));
  });

  it('token 到期后刷新并重连', async () => {
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    server.validToken = 'token-2';
    refresh.mockImplementation(async () => {
      token = 'token-2';
      return true;
    });

    server.sockets[0]?.close(4401, 'token expired');
    await vi.waitFor(() => expect(server.sockets).toHaveLength(2));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('升级被 401 拒绝时只强制刷新一次，不形成刷新风暴', async () => {
    server.rejectUpgrades = 100;
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(server.upgrades).toBeGreaterThanOrEqual(2));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('接收次数用完时告知用户一次，到恢复时刻自动解除，重连不重复提醒', async () => {
    const onQuotaExhausted = vi.fn();
    await start([schedule('s1')], undefined, onQuotaExhausted);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));

    const resetAt = Date.now() + 60_000;
    server.sockets[0]?.send(JSON.stringify({ type: 'quota', limit: 3000, resetAt }));
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.problem).toBe('quota'));
    expect(host.status(schedule('s1'))).toMatchObject({ quotaLimit: 3000, quotaResetAt: resetAt, connected: true });
    expect(onQuotaExhausted).toHaveBeenCalledExactlyOnceWith({ limit: 3000, resetAt });

    server.sockets[0]?.send(JSON.stringify({ type: 'quota', limit: 3000, resetAt }));
    server.sockets[0]?.send(JSON.stringify({ type: 'quota', limit: 'bad' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onQuotaExhausted).toHaveBeenCalledTimes(1);

    server.sockets[0]?.send(JSON.stringify({ type: 'quota', limit: 3000, resetAt: Date.now() + 15 }));
    await vi.waitFor(() => expect(onQuotaExhausted).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const status = host.status(schedule('s1'));
      expect(status?.problem).toBeUndefined();
      expect(status?.quotaResetAt).toBeUndefined();
    });
  });

  it('账号被封停优先于接收次数提示', async () => {
    await start([schedule('s1')], undefined);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    server.sockets[0]?.send(JSON.stringify({ type: 'quota', limit: 3000, resetAt: Date.now() + 60_000 }));
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.problem).toBe('quota'));
    server.sockets[0]?.close(4403, 'account suspended');
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.problem).toBe('suspended'));
  });

  it('账号被封停后不再重连，界面能看到原因', async () => {
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    server.sockets[0]?.close(4403, 'account suspended');
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.problem).toBe('suspended'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.upgrades).toBe(1);
  });

  it('被同一设备的新连接替换后不抢回来', async () => {
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    server.sockets[0]?.close(4409, 'replaced');
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(false));
    // PR #8470: the old test only waited; normal status/scheduler refreshes
    // must also leave the replacement connection alone (real HTTP/WS fixture).
    await host.refreshStatus();
    scheduler.emit('changed');
    await host.refreshStatus();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.upgrades).toBe(1);
    signedIn = false;
    host.authChanged(true);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.receiver).toBe('signed-out'));
    signedIn = true;
    host.authChanged(true);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    expect(server.upgrades).toBe(2);
  });

  it('地址数超限只影响超出的任务', async () => {
    server.endpointLimit = 1;
    await start([schedule('s1'), schedule('s2')]);
    await vi.waitFor(() => expect(host.status(schedule('s2'))?.problem).toBe('limit'));
    expect(host.status(schedule('s1'))?.url).toBeDefined();
    expect(host.status(schedule('s2'))?.url).toBeUndefined();
  });

  it('REST 收到 401 时刷新一次再重试', async () => {
    server.validToken = 'token-2';
    refresh.mockImplementation(async () => {
      token = 'token-2';
      return true;
    });
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(server.endpoints.has('s1')).toBe(true));
  });

  it('发送方随任务同步：粘贴的密钥原样提交，关闭签名后不能设置密钥，地址可以更换', async () => {
    const stripe = schedule('s1', [], { preset: 'stripe' });
    await start([stripe]);
    await vi.waitFor(() => expect(host.status(stripe)?.connected).toBe(true));
    expect(server.endpoints.get('s1')?.format).toMatchObject({ signature: { header: 'stripe-signature', key: 'v1' } });

    const requests = server.requests.length;
    await expect(host.setSecret(stripe, 'short')).rejects.toThrow('WEBHOOK_SECRET_INVALID');
    expect(server.requests).toHaveLength(requests);
    expect(await host.setSecret(stripe, 'whsec_from_stripe_dashboard')).toEqual({});
    expect(server.endpoints.get('s1')?.secret).toBe('whsec_from_stripe_dashboard');

    const gitlab = schedule('s1', [], { preset: 'gitlab' });
    scheduler.schedules = [gitlab];
    scheduler.emit('changed');
    await vi.waitFor(() => expect(server.endpoints.get('s1')?.format).toMatchObject({ signature: { header: 'webhook-signature' } }));
    expect((await host.setSecret(gitlab)).secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);

    const unsigned = schedule('s1', [], { preset: 'gitlab', signed: false });
    scheduler.schedules = [unsigned];
    scheduler.emit('changed');
    await vi.waitFor(() => expect(server.endpoints.get('s1')?.format).toMatchObject({ signature: null }));
    await expect(host.setSecret(unsigned)).rejects.toThrow('WEBHOOK_UNSIGNED');

    expect(await host.rotateUrl(unsigned)).toEqual({ url: 'https://webhook.test/hooks/whk-s1-r' });
    expect(host.status(unsigned)?.url).toBe('https://webhook.test/hooks/whk-s1-r');
  });

  it('本机认不出的发送方沿用服务器上的格式，新地址则报错而不是按 GitHub 创建', async () => {
    const custom = { ...GITHUB_FORMAT, signature: null };
    server.endpoints.set('s1', { id: 'whk-s1', url: 'u', scheduleId: 's1', events: [], format: custom, hasSecret: false, status: 'active', lastReceivedAt: null });
    const future = { preset: 'from-a-newer-version' } as unknown as ScheduleWebhookSource;
    await start([schedule('s1', ['push'], future), schedule('s2', [], future)]);
    await vi.waitFor(() => expect(server.endpoints.get('s1')?.events).toEqual(['push']));
    expect(server.endpoints.get('s1')?.format).toEqual(custom);
    await vi.waitFor(() => expect(host.status(schedule('s2'))?.problem).toBe('failed'));
    expect(server.endpoints.has('s2')).toBe(false);
  });

  it('没有任务需要接收时不保持连接', async () => {
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    scheduler.schedules = [];
    scheduler.emit('changed');
    await vi.waitFor(() => expect(server.endpoints.size).toBe(0));
    await vi.waitFor(() => expect(server.sockets[0]?.readyState).toBe(server.sockets[0]?.CLOSED));
  });
});
