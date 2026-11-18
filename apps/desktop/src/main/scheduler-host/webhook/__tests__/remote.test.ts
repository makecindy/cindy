import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
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
import { beginGithubConnect } from '../githubConnect';
import { matchingGithubPrs, type GithubPrRefresh } from '../github';

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
  github: { available: boolean; login: string; endpointId: string; repositories: string[]; unavailable?: string[];
    installUrl?: string; prSubscriptions?: boolean; dailyQuotaExempt?: boolean; automationSubscriptions?: boolean; deliveryHealthy?: boolean } | null = null;
  githubAllowedRepositories: string[] | undefined;
  githubConnect: { state: string; redirectUri: string } | undefined;
  githubUnavailable = false;
  githubSubscriptionBodies: Record<string, unknown>[] = [];
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
  rejectUpsert = false;
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
      if (this.github && route === 'GET /api/v1/github') return reply(this.githubUnavailable ? 500 : 200, this.githubUnavailable ? {} : this.github);
      if (this.github && route === 'POST /api/v1/github/connect') {
        this.githubConnect = body() as { state: string; redirectUri: string };
        return reply(200, { url: `https://github.com/login/oauth/authorize?state=${this.githubConnect.state}&code_challenge_method=S256` });
      }
      if (this.github && route === 'POST /api/v1/github/connect/complete') return reply(200, { url: this.github.installUrl });
      if (this.github && route === 'PUT /api/v1/github/repositories') {
        this.githubSubscriptionBodies.push(body());
        const requested = body().repositories as string[];
        const accepted = requested.filter(repo => !this.githubAllowedRepositories || this.githubAllowedRepositories.includes(repo));
        this.github.repositories = accepted;
        this.github.unavailable = requested.filter(repo => !accepted.includes(repo));
        return reply(200, this.github);
      }
      if (route === 'GET /api/v1/endpoints') return reply(200, { endpoints: [...this.endpoints.values()] });
      if (upsert?.[1]) {
        const scheduleId = upsert[1];
        if (this.releases.has(scheduleId)) return reply(409, { error: { code: 'WEBHOOK_ENDPOINT_RELEASED' } });
        const { events, format } = body() as { events: string[]; format: unknown };
        if (this.rejectUpsert) return reply(400, { error: { code: 'BAD_REQUEST' } });
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
  const batchWarning = vi.fn();
  let refresh: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

  async function start(
    schedules: Schedule[],
    baseUrlOverride?: string,
    onQuotaExhausted?: (quota: { limit: number; resetAt: number }) => void,
  ): Promise<void> {
    scheduler.schedules = schedules;
    const baseUrl = baseUrlOverride ?? (await server.listen());
    serverUrl = baseUrl;
    host = new ScheduleWebhookHost(scheduler as unknown as Scheduler, { warn: batchWarning }, {
      ...(onQuotaExhausted ? { onQuotaExhausted } : {}),
      remote: {
        isSignedIn: () => signedIn,
        baseUrl: () => baseUrl,
        getAccessToken: async () => (signedIn ? token : null),
        refreshAccessToken: refresh,
        fetch,
        socketOptions: async () => ({}),
        logger: { warn: batchWarning },
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

  // Real HTTP/WS and durable Host queue: repository selection, event filtering, dedup,
  // task invocation and pause use the same path as ordinary automatic tasks.
  it('runs a selected repository automation from App events without creating a task Webhook address', async () => {
    server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [],
      prSubscriptions: true, dailyQuotaExempt: true, automationSubscriptions: true };
    const task = { ...schedule('app-script', ['issue_comment.created'], { preset: 'github-app', repositories: ['example/project'] }),
      executionMode: 'script', scriptConfig: { command: 'node report.mjs', capabilities: [] } } as Schedule;
    await start([task]);
    await vi.waitFor(() => expect(host.status(task)?.connected).toBe(true));
    expect(server.githubSubscriptionBodies.at(-1)).toEqual({ repositories: ['example/project'], pullRequests: [], repositorySubscriptions: ['example/project'] });
    expect(server.endpoints.size).toBe(0);
    await expect(host.setSecret(task)).rejects.toThrow('GITHUB_APP_MANAGED_CONNECTION');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const comment = { deliveryId: 'app-comment', event: 'issue_comment', action: 'created', repository: 'example/project', number: 10, receivedAt: Date.now() };
      const batch = { batchId: 'app-batch', endpointId: 'whk-github', scheduleId: '__github_pr_watch__', omitted: 0,
        events: [comment, { ...comment, deliveryId: 'other', repository: 'private/other' },
          { ...comment, deliveryId: 'ci', event: 'check_run', action: 'completed' }] };
      server.push(batch);
      await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'app-batch' }));
      expect(host.status(task)?.received).toBe(1);
      server.push({ ...batch, batchId: 'duplicate-batch' });
      await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'duplicate-batch' }));
      expect(host.status(task)?.received).toBe(1);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(scheduler.runNow).toHaveBeenCalledTimes(1));
      expect(scheduler.runNow.mock.calls[0]).toEqual(['app-script', expect.objectContaining({
        webhook: { events: [comment], omitted: 0 }, onRunCreated: expect.any(Function),
      })]);
      scheduler.schedules = [{ ...task, status: 'paused' }];
      scheduler.emit('changed');
      await vi.waitFor(() => expect(server.githubSubscriptionBodies.at(-1)?.repositorySubscriptions).toEqual([]));
      server.push({ ...batch, batchId: 'paused-batch', events: [{ ...comment, deliveryId: 'paused-comment' }] });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(scheduler.runNow).toHaveBeenCalledTimes(1);
    } finally { await host.stop(); vi.clearAllTimers(); vi.useRealTimers(); }
  });

  // PR #9378: a transient status failure cannot ACK an automation event
  // that was never persisted. Real Host + HTTP/WS + disk queue, unit tier.
  it('retries App automation batches after a transient status failure without ACKing lost events', async () => {
    server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [], automationSubscriptions: true };
    const task = schedule('app-retry', ['issue_comment.created'], { preset: 'github-app', repositories: ['example/project'] });
    await start([task]);
    await vi.waitFor(() => expect(host.status(task)?.connected).toBe(true));
    server.githubUnavailable = true;
    await expect(host.githubStatus()).rejects.toThrow();
    batchWarning.mockClear();
    const batch = { batchId: 'retry-app', endpointId: 'whk-github', scheduleId: '__github_pr_watch__', omitted: 0,
      events: [{ deliveryId: 'retry-comment', event: 'issue_comment', action: 'created', repository: 'example/project', receivedAt: Date.now() }] };
    server.push(batch);
    await vi.waitFor(() => expect(batchWarning).toHaveBeenCalledWith('[schedule-webhook] batch not stored', expect.anything()));
    expect(server.frames).not.toContainEqual({ type: 'ack', batchId: batch.batchId });
    expect(host.status(task)?.received).toBe(0);
    server.githubUnavailable = false;
    await host.githubStatus();
    server.push(batch);
    await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: batch.batchId }));
    expect(host.status(task)?.received).toBe(1);
  });

  // Overflow has no repository/event provenance. It must not wake scripts or
  // agents outside their selected filters; known matching details still persist.
  it('does not widen App task filters for shared overflow metadata', async () => {
    server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [], automationSubscriptions: true };
    const release = schedule('release', ['release.published'], { preset: 'github-app', repositories: ['example/project'] });
    const other = schedule('other', ['issue_comment'], { preset: 'github-app', repositories: ['other/project'] });
    const matching = schedule('matching', ['issue_comment.created'], { preset: 'github-app', repositories: ['example/project'] });
    await start([release, other, matching]);
    await vi.waitFor(() => expect(host.status(matching)?.connected).toBe(true));
    server.push({ batchId: 'unscoped-overflow', endpointId: 'whk-github', scheduleId: '__github_pr_watch__', omitted: 100,
      events: [{ deliveryId: 'overflow-comment', event: 'issue_comment', action: 'created', repository: 'example/project', receivedAt: Date.now() }] });
    await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'unscoped-overflow' }));
    expect(host.status(release)?.received).toBe(0);
    expect(host.status(other)?.received).toBe(0);
    expect(host.status(matching)?.received).toBe(1);
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
    // Welcome starts an asynchronous reconcile; connected alone is not a ready
    // baseline for the revocation scenario below.
    await host.refreshStatus();
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
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.connected).toBe(true));
    await host.refreshStatus();
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
    await vi.waitFor(() => expect(host.status(schedule('s2'))?.problem).toBe('unsupported'));
    expect(server.endpoints.has('s2')).toBe(false);
  });

  // 服务器版本落后于客户端时，它拒绝的是格式本身：这不是暂时性的，不能显示成“暂时不可用”。
  it('服务器不认发送方格式时不显示成暂时不可用', async () => {
    server.rejectUpsert = true;
    await start([schedule('s1', ['push'])]);
    await vi.waitFor(() => expect(host.status(schedule('s1'))?.problem).toBe('unsupported'));
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

// New protocol outcome: managed GitHub events reach only active PR follow-up gates,
// through the production remote receiver; stale account deliveries cannot cross owners.
it('returns the completed GitHub snapshot even when another refresh is queued', async () => {
  const server = new FakeServer();
  server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [] };
  const baseUrl = await server.listen();
  const remote = new ScheduleWebhookRemote({ baseUrl: () => baseUrl, getAccessToken: async () => 'token-1',
    refreshAccessToken: async () => false, fetch, socketOptions: async () => ({}), logger: {}, onBatch: async () => {} });
  try {
    await remote.sync([]);
    // Opening settings and regaining focus can ask for the same state together.
    const results = await Promise.allSettled([remote.githubStatus(), remote.githubStatus()]);
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') expect(result.value.login).toBe('example-user');
    }
    // A genuine failed refresh must still reject instead of claiming stale success.
    server.unavailable = true;
    await expect(remote.githubStatus()).rejects.toThrow('GITHUB_CONNECTION_UNAVAILABLE');
    server.unavailable = false;
    await expect(remote.githubStatus()).resolves.toMatchObject({ login: 'example-user' });
  } finally { remote.stop(); await server.close(); }
});

it('discards a GitHub reconciliation response after the account is paused', async () => {
  const server = new FakeServer();
  server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [] };
  const baseUrl = await server.listen();
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  let waiting = false;
  const onChanged = vi.fn();
  const remote = new ScheduleWebhookRemote({ baseUrl: () => baseUrl, getAccessToken: async () => 'token-1',
    refreshAccessToken: async () => false, fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith('/github')) { waiting = true; await pending; }
      return response;
    }, socketOptions: async () => ({}), logger: {}, onBatch: async () => {}, onChanged });
  try {
    const sync = remote.sync([]);
    await vi.waitFor(() => expect(waiting).toBe(true));
    remote.pause();
    onChanged.mockClear();
    complete();
    await sync;
    expect(onChanged).not.toHaveBeenCalled();
    expect(remote.isConnected()).toBe(false);
    expect(server.requests).not.toContain('PUT /api/v1/github/repositories');
  } finally { complete(); remote.stop(); await server.close(); }
});

it('routes managed GitHub events to matching active follow-ups and acknowledges after processing', async () => {
  const server = new FakeServer();
  server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [] };
  const baseUrl = await server.listen();
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  const onGithubPrs = vi.fn<(urls: string[], isCurrent: () => boolean, refresh: GithubPrRefresh) => Promise<void>>(
    (_urls, _isCurrent, refresh) => refresh.reason === 'reconnect' ? Promise.resolve() : pending);
  const onBatch = vi.fn(async () => {});
  const remote = new ScheduleWebhookRemote({ baseUrl: () => baseUrl, getAccessToken: async () => 'token-1',
    refreshAccessToken: async () => false, fetch, socketOptions: async () => ({}), logger: {}, onBatch, onGithubPrs });
  const follow = (number: number, status = 'active') => ({ id: `follow-${number}`, name: 'Follow PR', status,
    recurring: true, manual: false, preRunHook: { command: `node gate.mjs https://github.com/example/project/pull/${number}` } }) as Schedule;
  try {
    await remote.sync([follow(12), follow(123), follow(9, 'paused')]);
    await vi.waitFor(() => expect(remote.githubEventsHealthy('https://github.com/example/project/pull/12')).toBe(true));
    expect(onGithubPrs.mock.calls[0]?.[0]).toEqual(['https://github.com/example/project/pull/12', 'https://github.com/example/project/pull/123']);
    onGithubPrs.mockClear();
    server.push({ batchId: 'github-batch', endpointId: 'whk-github', scheduleId: '__github_pr_watch__', omitted: 0,
      events: [{ deliveryId: 'g-1', event: 'pull_request_review', repository: 'example/project', number: 12, receivedAt: 1 }] });
    await vi.waitFor(() => expect(onGithubPrs).toHaveBeenCalledOnce());
    expect(onGithubPrs.mock.calls[0]?.[0]).toEqual(['https://github.com/example/project/pull/12']);
    expect(onBatch).not.toHaveBeenCalled();
    expect(server.frames).not.toContainEqual({ type: 'ack', batchId: 'github-batch' });
    expect(server.github.repositories).toEqual(['example/project']);
    complete();
    await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'github-batch' }));
    const stillCurrent = onGithubPrs.mock.calls[0]?.[1];
    expect(stillCurrent?.()).toBe(true);
    remote.pause();
    expect(stillCurrent?.()).toBe(false);
  } finally { complete(); remote.stop(); await server.close(); }
});

// Production routing/ACK entry, real loopback WS with a fake server. Missing CI
// numbers used to fan out to every PR; omitted batches used to be silently ACKed.
it('matches CI by current commit, without matching unrelated or ambiguous unknown commits', () => {
  const urls = [12, 13, 14].map(n => `https://github.com/example/project/pull/${n}`);
  const heads = { [urls[0]!]: 'a'.repeat(40), [urls[1]!]: 'b'.repeat(40), [urls[2]!]: 'a'.repeat(40) };
  const ci = { deliveryId: 'ci', event: 'check_run', receivedAt: 1, repository: 'EXAMPLE/PROJECT', headSha: 'a'.repeat(40) };
  expect(matchingGithubPrs(urls, [ci], heads)).toEqual([urls[0], urls[2]]);
  expect(matchingGithubPrs(urls, [{ ...ci, headSha: 'c'.repeat(40) }], heads)).toEqual([]);
  expect(matchingGithubPrs(urls, [{ ...ci, headSha: undefined }], heads)).toEqual([]);
  expect(matchingGithubPrs(urls, [{ ...ci, number: 13 }], heads)).toEqual([urls[1]]);
  expect(matchingGithubPrs(urls, [{ ...ci, repository: 'other/project' }], heads)).toEqual([]);
});

it('recovers omissions before ACK, retries failed recovery, and reduces polling only while delivery is healthy', async () => {
  const server = new FakeServer();
  server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [] };
  const baseUrl = await server.listen();
  const urls = [12, 13].map(n => `https://github.com/example/project/pull/${n}`);
  const heads = { [urls[0]!]: 'a'.repeat(40), [urls[1]!]: 'b'.repeat(40) };
  const onGithubPrs = vi.fn<(urls: string[], current: () => boolean, refresh: GithubPrRefresh) => Promise<void>>(async () => {});
  const remote = new ScheduleWebhookRemote({ baseUrl: () => baseUrl, getAccessToken: async () => 'token-1',
    refreshAccessToken: async () => false, fetch, socketOptions: async () => ({}), logger: {}, onBatch: async () => {},
    onGithubPrs, githubPrHeads: async () => heads });
  const follows = urls.map(url => ({ id: url, name: 'Follow', status: 'active', recurring: true,
    preRunHook: { command: `node gate ${url}` } }) as Schedule);
  const batch = (batchId: string, omitted: number, headSha = heads[urls[0]!]!) => ({ batchId, omitted,
    endpointId: 'whk-github', scheduleId: '__github_pr_watch__',
    events: [{ deliveryId: batchId, event: 'check_run', repository: 'example/project', headSha, receivedAt: 1 }] });
  try {
    await remote.sync(follows);
    await vi.waitFor(() => expect(remote.githubEventsHealthy(urls[0]!)).toBe(true));
    expect(remote.githubEventsHealthy('https://github.com/example/project/pull/99')).toBe(false);
    onGithubPrs.mockClear();
    server.push(batch('ci', 0));
    await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'ci' }));
    expect(onGithubPrs.mock.calls[0]?.[0]).toEqual([urls[0]]);
    expect(onGithubPrs.mock.calls[0]?.[2]).toEqual({ reason: 'event', notify: [] });

    onGithubPrs.mockRejectedValueOnce(new Error('offline'));
    server.push(batch('lost', 30));
    await vi.waitFor(() => expect(remote.githubEventsHealthy(urls[0]!)).toBe(false));
    expect(onGithubPrs.mock.calls.at(-1)?.[0]).toEqual(urls);
    expect(server.frames).not.toContainEqual({ type: 'ack', batchId: 'lost' });
    server.push(batch('lost', 30));
    await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'lost' }));
    expect(onGithubPrs.mock.calls.at(-1)?.[2]).toEqual({ reason: 'overflow', notify: urls });
    expect(remote.githubEventsHealthy(urls[0]!)).toBe(true);

    const date = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 71_000);
    expect(remote.githubEventsHealthy(urls[0]!)).toBe(false);
    date.mockRestore();
    server.sockets.at(-1)!.send(JSON.stringify({ type: 'quota', limit: 3000, resetAt: Date.now() + 60_000 }));
    await vi.waitFor(() => expect(remote.githubEventsHealthy(urls[0]!)).toBe(false));
    remote.pause();
    expect(remote.githubEventsHealthy(urls[0]!)).toBe(false);
    await remote.sync(follows);
    await vi.waitFor(() => expect(remote.githubEventsHealthy(urls[0]!)).toBe(true));
    expect(onGithubPrs.mock.calls.at(-1)?.[2].reason).toBe('reconnect');
    await remote.sync([follows[0]!]);
    expect(remote.githubEventsHealthy(urls[1]!)).toBe(false);
  } finally { remote.stop(); await server.close(); }
});

it('keeps the App connection visible when baseline reads fail, and excludes unavailable repositories', async () => {
  const server = new FakeServer();
  server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [] };
  const baseUrl = await server.listen();
  const url = 'https://github.com/example/project/pull/12';
  const onGithubPrs = vi.fn<() => Promise<void>>(async () => { throw new Error('PR_VERIFICATION_FAILED'); });
  const time = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(time);
  const remote = new ScheduleWebhookRemote({ baseUrl: () => baseUrl, getAccessToken: async () => 'token-1',
    refreshAccessToken: async () => false, fetch, socketOptions: async () => ({}), logger: {}, onBatch: async () => {}, onGithubPrs });
  try {
    await remote.sync([{ id: 'follow', name: 'Follow', status: 'active', recurring: true, preRunHook: { command: `node gate ${url}` } } as Schedule]);
    await vi.waitFor(() => expect(onGithubPrs).toHaveBeenCalled());
    expect(remote.githubEventsHealthy(url)).toBe(false);
    await expect(remote.githubStatus()).resolves.toMatchObject({ login: 'example-user', repositories: ['example/project'] });
    onGithubPrs.mockImplementation(async () => {});
    await remote.refresh();
    await vi.waitFor(() => expect(remote.githubEventsHealthy(url)).toBe(true));
    const registrations = server.requests.filter(route => route === 'PUT /api/v1/github/repositories').length;
    server.github.deliveryHealthy = false;
    clock.mockReturnValue(time + 60_001);
    server.sockets.at(-1)!.ping();
    await vi.waitFor(() => expect(remote.githubEventsHealthy(url)).toBe(false));
    server.github.deliveryHealthy = true;
    clock.mockReturnValue(time + 120_002);
    server.sockets.at(-1)!.ping();
    await vi.waitFor(() => expect(remote.githubEventsHealthy(url)).toBe(true));
    clock.mockReturnValue(time + 220_003);
    expect(remote.githubEventsHealthy(url)).toBe(false); // A stale status cannot hide a failed drain.
    server.sockets.at(-1)!.ping();
    await vi.waitFor(() => expect(remote.githubEventsHealthy(url)).toBe(true));
    expect(server.requests.filter(route => route === 'PUT /api/v1/github/repositories')).toHaveLength(registrations);
    server.github.unavailable = ['example/project'];
    await remote.refresh();
    expect(remote.githubEventsHealthy(url)).toBe(false);
  } finally { clock.mockRestore(); remote.stop(); await server.close(); }
});

// Real HTTP wire: narrowing/changing PRs in the same repository must reach the
// server; legacy servers must receive the original body and keep quota behavior.
it('negotiates precise PR subscriptions and separates custom Webhook quota from built-in GitHub delivery', async () => {
  const onQuotaExhausted = vi.fn();
  const server = new FakeServer();
  server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [],
    prSubscriptions: true, dailyQuotaExempt: true };
  const baseUrl = await server.listen();
  const follow = (number: number) => ({ id: String(number), name: 'Follow', status: 'active', recurring: true,
    preRunHook: { command: `node gate https://github.com/example/project/pull/${number}` } }) as Schedule;
  const remote = new ScheduleWebhookRemote({ baseUrl: () => baseUrl, getAccessToken: async () => 'token-1',
    refreshAccessToken: async () => false, fetch, socketOptions: async () => ({}), logger: {},
    onBatch: async () => {}, onGithubPrs: async () => {}, onQuotaExhausted });
  try {
    await remote.sync([follow(12), { ...follow(99), webhookTrigger: {
      endpointId: 'explicit-app', source: { preset: 'github-app', repositories: ['example/project'] },
    } }]);
    await vi.waitFor(() => expect(remote.githubEventsHealthy('https://github.com/example/project/pull/12')).toBe(true));
    expect(server.githubSubscriptionBodies.at(-1)).toEqual({ repositories: ['example/project'],
      pullRequests: [{ repository: 'example/project', number: 12 }] });
    await remote.sync([follow(13)]);
    expect(server.githubSubscriptionBodies.at(-1)?.pullRequests).toEqual([{ repository: 'example/project', number: 13 }]);
    server.sockets.at(-1)!.send(JSON.stringify({ type: 'quota', limit: 3000, resetAt: Date.now() + 60_000 }));
    await vi.waitFor(() => expect(remote.quota()).not.toBeNull());
    expect(onQuotaExhausted).not.toHaveBeenCalled();
    expect(remote.githubEventsHealthy('https://github.com/example/project/pull/13')).toBe(true);
    delete server.github.prSubscriptions;
    delete server.github.dailyQuotaExempt;
    await remote.refresh();
    expect(server.githubSubscriptionBodies.at(-1)).toEqual({ repositories: ['example/project'] });
    expect(remote.githubEventsHealthy('https://github.com/example/project/pull/13')).toBe(false);
  } finally { remote.stop(); await server.close(); }
});

// Native callback uses a real ephemeral loopback listener; only the authenticated
// server requests are substituted. No OAuth credential is needed by this regression.
it('returns OAuth through the initiating Desktop once, with a matching private verifier', async () => {
  let input!: { state: string; codeChallenge: string; redirectUri: string };
  const onConnected = vi.fn();
  const complete = vi.fn<(input: { state: string; code: string; verifier: string }) => Promise<{ url: string }>>(
    async () => ({ url: 'https://github.com/apps/example-app/installations/new' }));
  const attempt = await beginGithubConnect({ start: async value => {
    input = value; return { url: `https://github.com/login/oauth/authorize?state=${value.state}&code_challenge_method=S256` };
  },
    complete, onConnected, isCurrent: () => true });
  try {
    expect(new URL(input.redirectUri).hostname).toBe('127.0.0.1');
    expect((await fetch(`${input.redirectUri}?state=wrong&code=synthetic`, { redirect: 'manual' })).status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
    const response = await fetch(`${input.redirectUri}?state=${input.state}&code=synthetic`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://github.com/apps/example-app/installations/new');
    expect(complete).toHaveBeenCalledTimes(1);
    const redemption = complete.mock.calls[0]![0];
    expect(redemption.state).toBe(input.state);
    expect(createHash('sha256').update(redemption.verifier).digest('base64url')).toBe(input.codeChallenge);
    expect(onConnected).toHaveBeenCalledTimes(1);
  } finally { attempt.close(); }
});

it('rejects the legacy unbound OAuth flow before opening the browser and closes its listener', async () => {
  let redirect = '';
  const complete = vi.fn();
  await expect(beginGithubConnect({
    start: async input => {
      redirect = input.redirectUri;
      return { url: 'https://github.com/login/oauth/authorize?state=legacy-server-state&code_challenge_method=S256' };
    },
    complete, onConnected: vi.fn(), isCurrent: () => true,
  })).rejects.toThrow('GITHUB_CLIENT_BINDING_UNSUPPORTED');
  await expect(fetch(redirect)).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
});

// A slow GitHub API must not hold the ordinary Webhook ACK lane or account controls.
// Unit HTTP boundary: repeated UI/task refreshes must read status without rewriting
// an unchanged subscription; changing the watched PR must still register once.
it('keeps the acknowledged subscription across refresh and connection checks', async () => {
  const server = new FakeServer();
  server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [], prSubscriptions: true };
  const baseUrl = await server.listen();
  const remote = new ScheduleWebhookRemote({ baseUrl: () => baseUrl, getAccessToken: async () => 'token-1',
    refreshAccessToken: async () => false, fetch, socketOptions: async () => ({}), logger: {},
    onBatch: async () => {}, onGithubPrs: async () => {} });
  const follow = (number: number) => ({ ...schedule('follow'), webhookTrigger: undefined, recurring: true,
    preRunHook: { command: `node gate.mjs https://github.com/example/project/pull/${number}` } }) as Schedule;
  try {
    await remote.sync([follow(1)]);
    await vi.waitFor(() => expect(remote.githubEventsHealthy('https://github.com/example/project/pull/1')).toBe(true));
    const count = server.githubSubscriptionBodies.length;
    await remote.refresh();
    await remote.githubStatus();
    await remote.refresh();
    expect(server.githubSubscriptionBodies).toHaveLength(count);
    await remote.sync([follow(2)]);
    expect(server.githubSubscriptionBodies).toHaveLength(count + 1);
  } finally { remote.stop(); await server.close(); }
});

// Installing the App changes permissions without changing the followed PRs.
// Only the explicit browser round trip may bypass subscription deduplication.
it.each(['installation', 'oauth', 'retry', 'early-installation', 'early-oauth'])('rechecks repositories after installation (%s) without repeated background writes', async (outcome) => {
  const server = new FakeServer();
  const installUrl = 'https://github.com/apps/example-app/installations/new';
  server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [], installUrl };
  server.githubAllowedRepositories = [];
  const baseUrl = await server.listen();
  const remote = new ScheduleWebhookRemote({ baseUrl: () => baseUrl, getAccessToken: async () => 'token-1',
    refreshAccessToken: async () => false, fetch, socketOptions: async () => ({}), logger: {},
    onBatch: async () => {}, onGithubPrs: async () => {} });
  const follow = { ...schedule('follow'), webhookTrigger: undefined, recurring: true,
    preRunHook: { command: 'node gate.mjs https://github.com/example/project/pull/1' } } as Schedule;
  try {
    await remote.sync([follow]);
    await expect(remote.githubStatus()).resolves.toMatchObject({ repositories: [], unavailable: ['example/project'] });
    if (outcome.endsWith('oauth')) {
      await remote.connectGithub();
      const { redirectUri, state } = server.githubConnect!;
      // Only the ephemeral port comes from the captured request. Keep the test
      // request on loopback even if a broken callback advertises another host.
      const port = Number(new URL(redirectUri).port);
      const callback = await fetch(`http://127.0.0.1:${port}/github/callback?state=${encodeURIComponent(state)}&code=synthetic`, { redirect: 'manual' });
      expect(callback.headers.get('location')).toBe(installUrl);
    } else {
      await expect(remote.installGithub()).resolves.toBe(installUrl);
    }
    // Regular task refreshes while the browser is open must not consume the pending recheck.
    await remote.refresh();
    let registrations = outcome.endsWith('oauth') ? 2 : 1;
    expect(server.githubSubscriptionBodies).toHaveLength(registrations);
    if (outcome.startsWith('early-')) {
      // PR #10508: a successful status read is not installation completion.
      // The user returns once before granting access, then returns after granting it.
      await expect(remote.githubStatus()).resolves.toMatchObject({ repositories: [], unavailable: ['example/project'] });
      registrations++;
      expect(server.githubSubscriptionBodies).toHaveLength(registrations);
      await remote.refresh();
      expect(server.githubSubscriptionBodies).toHaveLength(registrations);
    }
    server.githubAllowedRepositories = ['example/project'];
    if (outcome === 'retry') {
      server.githubUnavailable = true;
      await expect(remote.githubStatus()).rejects.toThrow();
      server.githubUnavailable = false;
    }
    await expect(remote.githubStatus()).resolves.toMatchObject({ repositories: ['example/project'], unavailable: [] });
    expect(server.githubSubscriptionBodies).toHaveLength(registrations + 1);
    await remote.refresh();
    await remote.githubStatus();
    expect(server.githubSubscriptionBodies).toHaveLength(registrations + 1);
  } finally { remote.stop(); await server.close(); }
});

it('keeps ordinary Webhooks and connection status usable while a GitHub batch is waiting', async () => {
  const server = new FakeServer();
  server.github = { available: true, login: 'example-user', endpointId: 'whk-github', repositories: [], automationSubscriptions: true };
  const baseUrl = await server.listen();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const onGithubPrs = vi.fn(async (_urls: string[], _current: () => boolean, refresh: GithubPrRefresh) => {
    if (refresh.reason === 'event') await waiting;
  });
  const onBatch = vi.fn(async () => {});
  const onGithubBatch = vi.fn(async () => {});
  const remote = new ScheduleWebhookRemote({ baseUrl: () => baseUrl, getAccessToken: async () => 'token-1',
    refreshAccessToken: async () => false, fetch, socketOptions: async () => ({}), logger: {}, onBatch, onGithubPrs, onGithubBatch });
  const url = 'https://github.com/example/project/pull/1';
  try {
    await remote.sync([schedule('app', ['issues'], { preset: 'github-app', repositories: ['other/project'] }), schedule('ordinary'), { ...schedule('follow'), webhookTrigger: undefined, recurring: true,
      preRunHook: { command: `node gate.mjs ${url}` } }]);
    await vi.waitFor(() => expect(remote.githubEventsHealthy(url)).toBe(true));
    server.push({ batchId: 'slow-github', endpointId: 'whk-github', scheduleId: '__github_pr_watch__', omitted: 0,
      events: [{ deliveryId: 'comment', event: 'issue_comment', repository: 'example/project', number: 1, receivedAt: 1 }] });
    await vi.waitFor(() => expect(onGithubPrs).toHaveBeenCalledTimes(2));
    server.push({ batchId: 'ordinary', endpointId: server.endpoints.get('ordinary')!.id, scheduleId: 'ordinary', omitted: 0,
      events: [{ deliveryId: 'ordinary-event', event: 'issues', receivedAt: 1 }] });
    await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'ordinary' }));
    expect(onBatch).toHaveBeenCalledTimes(1);
    server.push({ batchId: 'fast-app', endpointId: 'whk-github', scheduleId: '__github_pr_watch__', omitted: 0,
      events: [{ deliveryId: 'issue', event: 'issues', repository: 'other/project', number: 2, receivedAt: 2 }] });
    await vi.waitFor(() => expect(onGithubBatch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'fast-app' }));

    expect(server.frames).not.toContainEqual({ type: 'ack', batchId: 'slow-github' });
    await expect(remote.githubStatus()).resolves.toMatchObject({ login: 'example-user' });
    release();
    await vi.waitFor(() => expect(server.frames).toContainEqual({ type: 'ack', batchId: 'slow-github' }));
  } finally { release(); remote.stop(); await server.close(); }
});
