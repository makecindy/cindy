import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schedule, Scheduler } from '@cindy/maker-scheduler';
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

class FakeScheduler extends EventEmitter {
  schedules: Schedule[] = [];
  runNow = vi.fn(async () => ({ runId: 'r1' }));
  async list() { return this.schedules; }
  async get(id: string) { return this.schedules.find((s) => s.id === id) ?? null; }
  getInflightCount() { return 0; }
}

const schedule = (id: string, events?: string[]) =>
  ({ id, status: 'active', webhookTrigger: { endpointId: `local-${id}`, ...(events ? { events } : {}) } }) as Schedule;

interface FakeEndpoint {
  id: string;
  url: string;
  scheduleId: string;
  events: string[];
  hasSecret: boolean;
  status: 'active' | 'suspended';
  lastReceivedAt: string | null;
}

/** 与 webhook-server 合同相同的最小实现。 */
class FakeServer {
  readonly requests: string[] = [];
  readonly endpoints = new Map<string, FakeEndpoint>();
  readonly frames: Record<string, unknown>[] = [];
  readonly sockets: WebSocket[] = [];
  upgrades = 0;
  rejectUpgrades = 0;
  endpointLimit = Infinity;
  suspended = false;
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
      if (this.suspended) return reply(403, { error: { code: 'WEBHOOK_ACCOUNT_SUSPENDED' } });
      const upsert = route.match(/^PUT \/api\/v1\/endpoints\/by-schedule\/(.+)$/);
      const secret = route.match(/^POST \/api\/v1\/endpoints\/(.+)\/secret$/);
      const remove = route.match(/^DELETE \/api\/v1\/endpoints\/(.+)$/);
      if (route === 'GET /api/v1/endpoints') return reply(200, { endpoints: [...this.endpoints.values()] });
      if (upsert?.[1]) {
        const scheduleId = upsert[1];
        const { events } = JSON.parse(Buffer.concat(chunks).toString()) as { events: string[] };
        const existing = this.endpoints.get(scheduleId);
        if (!existing && this.endpoints.size >= this.endpointLimit) return reply(409, { error: { code: 'WEBHOOK_ENDPOINT_LIMIT' } });
        const endpoint = existing ?? {
          id: `whk-${scheduleId}`,
          url: `https://webhook.test/hooks/whk-${scheduleId}`,
          scheduleId,
          events,
          hasSecret: false,
          status: 'active' as const,
          lastReceivedAt: null,
        };
        endpoint.events = events;
        this.endpoints.set(scheduleId, endpoint);
        return reply(existing ? 200 : 201, endpoint);
      }
      if (secret) {
        const endpoint = [...this.endpoints.values()].find((row) => row.id === secret[1]);
        if (!endpoint) return reply(404, { error: { code: 'NOT_FOUND' } });
        endpoint.hasSecret = true;
        return reply(200, { secret: 'server-secret', endpoint });
      }
      if (remove) {
        for (const [key, row] of this.endpoints) if (row.id === remove[1]) this.endpoints.delete(key);
        return reply(204);
      }
      return reply(404, { error: { code: 'NOT_FOUND' } });
    });
  }
}

const event = (deliveryId: string, name = 'pull_request') => ({ deliveryId, event: name, receivedAt: 1 });

describe('ScheduleWebhookHost 服务器通道', () => {
  let scheduler: FakeScheduler;
  let server: FakeServer;
  let host: ScheduleWebhookHost;
  let signedIn: boolean;
  let token: string;
  let refresh: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

  async function start(
    schedules: Schedule[],
    baseUrlOverride?: string,
    onQuotaExhausted?: (quota: { limit: number; resetAt: number }) => void,
  ): Promise<void> {
    scheduler.schedules = schedules;
    const baseUrl = baseUrlOverride ?? (await server.listen());
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

  it('正式模式不开本机端口，地址和密钥来自服务器', async () => {
    await start([schedule('s1', ['check_suite'])]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));

    const status = host.status(schedule('s1'));
    expect(status).toMatchObject({ receiver: 'cloud', url: 'https://webhook.test/hooks/whk-s1', hasSecret: false });
    expect(server.endpoints.get('s1')?.events).toEqual(['check_suite']);

    expect(await host.rotateSecret(schedule('s1'))).toEqual({ secret: 'server-secret', url: 'https://webhook.test/hooks/whk-s1' });
    expect(host.status(schedule('s1'))?.hasSecret).toBe(true);
    expect(fs.existsSync(path.join(dirs.root, 'schedule-webhooks', 'secrets'))).toBe(false);
  });

  it('未登录时不发任何请求也不连接，配置保留；登录后恢复', async () => {
    signedIn = false;
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.receiver()).toBe('signed-out'));
    expect(host.status(schedule('s1'))).toMatchObject({ receiver: 'signed-out', hasSecret: false });
    expect(host.status(schedule('s1'))?.url).toBeUndefined();
    await expect(host.rotateSecret(schedule('s1'))).rejects.toThrow('WEBHOOK_ACCOUNT_REQUIRED');
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
    server.endpoints.set('gone', { id: 'whk-gone', url: 'u', scheduleId: 'gone', events: [], hasSecret: true, status: 'active', lastReceivedAt: null });
    server.endpoints.set('s1', { id: 'whk-s1', url: 'u', scheduleId: 's1', events: ['a', 'b'], hasSecret: true, status: 'active', lastReceivedAt: null });
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
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.upgrades).toBe(1);
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

  it('没有任务需要接收时不保持连接', async () => {
    await start([schedule('s1')]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    scheduler.schedules = [];
    scheduler.emit('changed');
    await vi.waitFor(() => expect(server.endpoints.size).toBe(0));
    await vi.waitFor(() => expect(server.sockets[0]?.readyState).toBe(server.sockets[0]?.CLOSED));
  });
});
