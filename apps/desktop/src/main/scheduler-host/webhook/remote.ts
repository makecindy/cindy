import { followedGithubPrs, GITHUB_WATCH_SCHEDULE, matchingGithubPrs, type GithubAppStatus, type GithubPrRefresh } from './github';
/**
 * 自动化任务 Webhook 的服务器通道：地址和密钥走 webhook-server，事件经 Desktop 主动拨出的
 * 长连接送达，本机不开端口。合同见 cindy-server 仓 docs/webhook-server.md。
 */
import { connectionBackoffDelayMs } from '@cindy/im/connection-retry';
import {
  parseWebhookFormat,
  resolveScheduleWebhookFormat,
  type Schedule,
  type ScheduleWebhookEvent,
  type WebhookFormat,
} from '@cindy/maker-scheduler';
import WebSocket, { type ClientOptions } from 'ws';
import { beginGithubConnect } from './githubConnect';
import type { WebhookAccountOverview } from '../../../shared/webhookAccount';

const CLOSE_TOKEN_EXPIRED = 4401;
const CLOSE_ACCOUNT_SUSPENDED = 4403;
const CLOSE_REPLACED = 4409;

/** 服务器偶发错误或账号被封停，都不值得频繁重试。 */
const RECONCILE_RETRY_MS = 60_000;
// The existing server pings every 30s. A quiet repository is healthy; a silent socket is not.
const SOCKET_HEALTH_MS = 70_000;

export interface RemoteEndpointView {
  id: string;
  url: string;
  scheduleId: string;
  events: string[];
  /** 服务器上保存的发送方格式；存储损坏时为 null。 */
  format: WebhookFormat | null;
  /** 签名地址是否有和当前格式匹配的密钥。 */
  hasSecret: boolean;
  status: 'active' | 'suspended';
  lastReceivedAt: string | null;
  scheduleName?: string | null;
  deviceName?: string | null;
}

/** 本机希望服务器上的地址是什么样。format 为 null 表示本机认不出发送方，保留服务器上的格式。 */
interface WantedEndpoint {
  identity: string;
  events: readonly string[];
  format: WebhookFormat | null;
  scheduleName: string;
  deviceName?: string;
}

export interface RemoteWebhookBatch {
  batchId?: string;
  endpointId: string;
  scheduleId: string;
  events: ScheduleWebhookEvent[];
  omitted: number;
}

export type RemoteEndpointProblem = 'limit' | 'failed' | 'unsupported' | 'released';

/** 账号今天的 Webhook 接收次数已用完。 */
export interface RemoteWebhookQuota {
  limit: number;
  /** 恢复时刻（毫秒）。 */
  resetAt: number;
}

export interface ScheduleWebhookRemoteDeps {
  onGithubBatch?(batch: RemoteWebhookBatch, isCurrent: () => boolean): Promise<void>;
  onGithubPrs?(urls: string[], isCurrent: () => boolean, refresh: GithubPrRefresh): Promise<void>;
  githubPrHeads?(urls: readonly string[]): Promise<Readonly<Record<string, string>>>;
  /** 空字符串表示当前环境没有部署 webhook-server。 */
  baseUrl(): string;
  getAccessToken(): Promise<string | null>;
  refreshAccessToken(): Promise<boolean>;
  fetch: typeof fetch;
  socketOptions(url: string): Promise<Pick<ClientOptions, 'agent'>>;
  /** 落盘后才 resolve：resolve 后才 ack，服务器据此删除暂存。 */
  onBatch(batch: RemoteWebhookBatch): Promise<void>;
  /** 地址或连接状态变化，让界面重新读取。 */
  onChanged?(): void;
  /** 每个恢复时刻只通知一次；重连时服务器重发不会重复触发。 */
  onQuotaExhausted?(quota: RemoteWebhookQuota): void;
  logger: { warn?: (message: string, meta?: Record<string, unknown>) => void };
  deviceName?(): string;
  /** Discard queued events after release or a local trigger identity change. */
  onInvalidated?(scheduleId: string): Promise<void>;
  /** Owner-scoped local trigger identities; never URLs or secrets. */
  identityStore?: {
    load(): Record<string, string>;
    save(identities: Record<string, string>): void;
  };
}

class RemoteRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`webhook-server request failed: ${status}${code ? ` ${code}` : ''}`);
  }
}

const sameEvents = (a: readonly string[], b: readonly string[]): boolean =>
  [...a].sort().join('\n') === [...b].sort().join('\n');

/** 两边都按同一份校验规整后再比较，键的顺序不影响结果。 */
const sameFormat = (a: unknown, b: WebhookFormat): boolean =>
  JSON.stringify(parseWebhookFormat(a)) === JSON.stringify(parseWebhookFormat(b));

function parseEvent(value: unknown): ScheduleWebhookEvent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.deliveryId !== 'string' || typeof raw.event !== 'string' || typeof raw.receivedAt !== 'number') return null;
  const text = (key: 'action' | 'repository' | 'sender' | 'headSha' | 'conclusion') =>
    typeof raw[key] === 'string' ? { [key]: raw[key] as string } : {};
  return {
    deliveryId: raw.deliveryId,
    event: raw.event,
    receivedAt: raw.receivedAt,
    ...text('action'),
    ...text('repository'),
    ...text('sender'),
    ...text('headSha'),
    ...text('conclusion'),
    ...(Number.isSafeInteger(raw.number) ? { number: raw.number as number } : {}),
  };
}

function parseBatch(frame: Record<string, unknown>): (RemoteWebhookBatch & { batchId: string }) | null {
  const { batchId, endpointId, scheduleId, events, omitted } = frame;
  if (typeof batchId !== 'string' || typeof endpointId !== 'string' || typeof scheduleId !== 'string' || !Array.isArray(events)) return null;
  const parsed = events.map(parseEvent);
  if (parsed.some((event) => event === null)) return null;
  return {
    batchId,
    endpointId,
    scheduleId,
    events: parsed as ScheduleWebhookEvent[],
    omitted: typeof omitted === 'number' && omitted > 0 ? omitted : 0,
  };
}

export class ScheduleWebhookRemote {
  private githubPrs: string[] = [];
  private github: GithubAppStatus = { available: false };
  private githubSynced = '';
  private githubError: unknown = null;
  private readonly githubVerified = new Set<string>();
  private githubBatchFailed = false;
  private githubAutomations = new Map<string, Schedule>();
  private closeGithubConnect: (() => void) | undefined;
  private githubConnectAttempt = 0;
  private lastSocketActivity = 0;
  private wanted = new Map<string, WantedEndpoint>();
  private readonly views = new Map<string, RemoteEndpointView>();
  private readonly problems = new Map<string, RemoteEndpointProblem>();
  private loaded = false;
  private generation = 0;
  private readonly releases = new Map<string, string>();
  private running = false;
  private suspended = false;
  private replaced = false;
  private exhausted: RemoteWebhookQuota | null = null;
  private work: Promise<void> = Promise.resolve();
  private githubWork: Promise<void> = Promise.resolve();
  private githubRecoveryQueued = false;
  private githubCheckedAt = 0;
  private githubHealthQueued = false;
  private socket: WebSocket | null = null;
  private connecting = false;
  private connected = false;
  private attempt = 0;
  private refreshedAfterRejection = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private identities: Map<string, string>;

  constructor(private readonly deps: ScheduleWebhookRemoteDeps) {
    this.identities = new Map(Object.entries(deps.identityStore?.load() ?? {}));
  }

  private rememberIdentity(scheduleId: string, identity: string | undefined): void {
    if (this.identities.get(scheduleId) === identity) return;
    const next = new Map(this.identities);
    if (identity === undefined) next.delete(scheduleId);
    else next.set(scheduleId, identity);
    this.deps.identityStore?.save(Object.fromEntries(next));
    this.identities = next;
  }

  /** 同步“哪些任务需要接收”。登录后调用；未登录时调用也安全。 */
  sync(schedules: readonly Schedule[]): Promise<void> {
    this.githubPrs = followedGithubPrs(schedules);
    this.githubAutomations = new Map(schedules.filter(schedule => schedule.status === 'active'
      && schedule.webhookTrigger?.source?.preset === 'github-app'
      && (schedule.expireAt === undefined || schedule.expireAt > Date.now())).map(schedule => [schedule.id, schedule]));
    const wanted = new Map<string, WantedEndpoint>();
    for (const schedule of schedules) {
      const trigger = schedule.webhookTrigger;
      if (trigger?.source?.preset === 'github-app') continue;
      if (trigger) wanted.set(schedule.id, {
        identity: trigger.endpointId,
        events: trigger.events ?? [], format: resolveScheduleWebhookFormat(trigger.source),
        // eslint-disable-next-line no-control-regex -- Strip control characters from display names.
        scheduleName: schedule.name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200),
        // eslint-disable-next-line no-control-regex -- Same display-name sanitization for devices.
        deviceName: this.deps.deviceName?.().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200),
      });
    }
    this.wanted = wanted;
    this.running = true;
    return this.enqueueReconcile();
  }

  /** 退出登录或换账号：断开连接、丢弃账号相关的缓存，任务配置不动。 */
  pause(): void {
    this.closeGithubConnect?.();
    this.closeGithubConnect = undefined;
    this.githubWork = Promise.resolve();
    this.githubRecoveryQueued = false;
    this.githubCheckedAt = 0;
    this.githubHealthQueued = false;
    this.generation += 1;
    this.running = false;
    this.loaded = false;
    this.suspended = false;
    this.replaced = false;
    this.exhausted = null;
    this.views.clear();
    this.github = { available: false };
    this.githubError = null;
    this.githubSynced = '';
    this.problems.clear();
    this.releases.clear();
    this.clearTimers();
    this.closeSocket();
    this.deps.onChanged?.();
  }

  stop(): void {
    this.pause();
    this.wanted = new Map();
  }

  isConnected(): boolean {
    return this.connected;
  }

  githubEventsHealthy(url: string): boolean {
    return this.running && this.loaded && this.connected && !this.suspended && !this.replaced
      && !this.githubError && !this.githubBatchFailed && this.github.deliveryHealthy !== false
      && Date.now() - this.githubCheckedAt < 90_000
      && (!this.quota() || this.github.dailyQuotaExempt === true)
      && Date.now() - this.lastSocketActivity < SOCKET_HEALTH_MS
      && this.githubVerified.has(url.toLowerCase())
      && this.coveredGithubPrs().some(pr => pr.toLowerCase() === url.toLowerCase());
  }

  private coveredGithubPrs(): string[] {
    if (!this.github.available || !this.github.login || !this.github.endpointId) return [];
    const repositories = new Set(this.github.repositories?.map(repo => repo.toLowerCase()));
    const unavailable = new Set(this.github.unavailable?.map(repo => repo.toLowerCase()));
    return this.githubPrs.filter(url => {
      const repository = url.split('/').slice(3, 5).join('/').toLowerCase();
      return repositories.has(repository) && !unavailable.has(repository);
    });
  }

  canDeliver(scheduleId: string): boolean {
    if (this.githubAutomations.has(scheduleId)) return this.canDeliverGithub(scheduleId);
    return this.running && this.loaded && this.views.has(scheduleId) && !this.releases.has(scheduleId)
      && this.wanted.has(scheduleId) && this.identities.get(scheduleId) === this.wanted.get(scheduleId)?.identity;
  }

  canDeliverGithub(scheduleId: string): boolean {
    const source = this.githubAutomations.get(scheduleId)?.webhookTrigger?.source;
    return source?.preset === 'github-app' && this.running && this.loaded && !this.suspended
      && !this.githubError && this.github.automationSubscriptions === true && !!this.github.login && !!this.github.endpointId
      && source.repositories.every(repo => this.github.repositories?.some(value => value.toLowerCase() === repo.toLowerCase())
        && !this.github.unavailable?.some(value => value.toLowerCase() === repo.toLowerCase()));
  }

  view(scheduleId: string): RemoteEndpointView | undefined {
    return this.canDeliver(scheduleId) ? this.views.get(scheduleId) : undefined;
  }

  problem(scheduleId: string): RemoteEndpointProblem | undefined {
    if (this.githubAutomations.has(scheduleId)) return this.canDeliverGithub(scheduleId) ? undefined : 'failed';
    return this.problems.get(scheduleId);
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  async githubStatus(): Promise<GithubAppStatus> {
    const generation = this.generation;
    if (!this.deps.baseUrl() || !(await this.deps.getAccessToken())) return { available: false };
    if (generation !== this.generation) throw new Error('WEBHOOK_ACCOUNT_CHANGED');
    return this.enqueue(async () => {
      this.loaded = false;
      await this.reconcile();
      if (generation !== this.generation) throw new Error('WEBHOOK_ACCOUNT_CHANGED');
      if (this.githubError) throw this.githubError;
      if (this.running && !this.loaded) throw new Error('GITHUB_CONNECTION_UNAVAILABLE');
      // Capture this refresh's result before the next queued refresh resets loaded.
      return this.github;
    });
  }

  async connectGithub(): Promise<string> {
    this.closeGithubConnect?.();
    const attemptId = ++this.githubConnectAttempt;
    const generation = this.generation;
    const attempt = await beginGithubConnect({
      start: input => this.request('POST', '/github/connect', input),
      complete: input => this.request('POST', '/github/connect/complete', input),
      isCurrent: () => generation === this.generation && attemptId === this.githubConnectAttempt && this.running,
      onConnected: () => { this.githubSynced = ''; void this.refresh().catch(() => undefined); },
    });
    this.closeGithubConnect = attempt.close;
    return attempt.url;
  }

  async disconnectGithub(): Promise<void> {
    this.githubConnectAttempt++;
    this.closeGithubConnect?.();
    this.closeGithubConnect = undefined;
    await this.request('DELETE', '/github');
    this.github = { available: true, login: null };
    this.githubSynced = '';
    this.githubVerified.clear();
    this.updateConnection();
  }

  private async syncGithub(): Promise<void> {
    const state = await this.request<GithubAppStatus>('GET', '/github').catch(error => {
      if (error instanceof RemoteRequestError && error.status === 404) return { available: false } as GithubAppStatus;
      throw error;
    });
    if (state.login !== this.github.login || state.endpointId !== this.github.endpointId) this.githubVerified.clear();
    if (this.github.login && (state.login !== this.github.login || state.endpointId !== this.github.endpointId)) {
      for (const id of this.githubAutomations.keys()) await this.deps.onInvalidated?.(id);
    }
    this.github = state;
    this.githubCheckedAt = Date.now();
    this.githubError = null;
    if (!state.available || !state.login) { this.githubSynced = ''; return; }
    const prs = [...new Set(this.githubPrs.map(url => url.toLowerCase()))].sort().map(url => ({
      repository: url.split('/').slice(3, 5).join('/'), number: Number(url.split('/')[6]),
    }));
    const repositorySubscriptions = state.automationSubscriptions
      ? [...new Set([...this.githubAutomations.values()].flatMap(schedule => {
        const source = schedule.webhookTrigger?.source;
        return source?.preset === 'github-app' ? source.repositories.map(repo => repo.toLowerCase()) : [];
      }))].sort() : [];
    const repositories = [...new Set([...prs.map(pr => pr.repository), ...repositorySubscriptions])];
    // Capability negotiation keeps old servers working. Above the precise-list
    // bound retain repository delivery, rather than silently omitting follows.
    const subscription = { repositories, ...(state.prSubscriptions && prs.length <= 1_000 ? { pullRequests: prs } : {}),
      ...(state.automationSubscriptions ? { repositorySubscriptions } : {}) };
    const key = JSON.stringify([state.login, state.endpointId, subscription]);
    if (key !== this.githubSynced) {
      this.github = await this.request<GithubAppStatus>('PUT', '/github/repositories', subscription);
      this.githubSynced = JSON.stringify([this.github.login, this.github.endpointId, subscription]);
    }
    // Recovery uses the GitHub lane. A slow GitHub read cannot block ordinary
    // Webhook admission, configuration refreshes or event-triggered script tasks.
    if (!this.githubRecoveryQueued && this.connected && this.coveredGithubPrs().some(url => !this.githubVerified.has(url.toLowerCase()))) {
      this.githubRecoveryQueued = true;
      const generation = this.generation;
      void this.enqueueGithub(() => this.recoverGithubPrs()).catch(error => {
        if (generation !== this.generation) return;
        this.deps.logger.warn?.('[schedule-webhook] GitHub status recovery failed', { error: String(error) });
        this.scheduleRetry();
      }).finally(() => {
        if (generation !== this.generation) return;
        this.githubRecoveryQueued = false;
        if (this.running && this.coveredGithubPrs().some(url => !this.githubVerified.has(url.toLowerCase()))) this.scheduleRetry();
      });
    }
  }

  private async recoverGithubPrs(): Promise<void> {
    const socket = this.socket;
    if (!this.connected || !socket) return;
    const covered = this.coveredGithubPrs();
    const coveredKeys = new Set(covered.map(url => url.toLowerCase()));
    for (const url of this.githubVerified) if (!coveredKeys.has(url)) this.githubVerified.delete(url);
    const missing = covered.filter(url => !this.githubVerified.has(url.toLowerCase()));
    if (!missing.length) return;
    const isCurrent = this.githubGuard(socket);
    if (!this.deps.onGithubPrs) throw new Error('GITHUB_RECEIVER_UNAVAILABLE');
    await this.deps.onGithubPrs(missing, isCurrent, { reason: 'reconnect', notify: missing });
    if (isCurrent()) for (const url of missing) this.githubVerified.add(url.toLowerCase());
  }

  private refreshGithubHealth(): void {
    if (!this.running || !this.github.login || this.githubHealthQueued || Date.now() - this.githubCheckedAt < 60_000) return;
    const generation = this.generation;
    this.githubHealthQueued = true;
    // Reuse server pings: one cached status read per minute, without re-registering
    // subscriptions or calling GitHub. A stale response cannot suppress fallback.
    void this.enqueueReconcile().catch(() => undefined).finally(() => {
      if (generation === this.generation) this.githubHealthQueued = false;
    });
  }

  async accountOverview(): Promise<WebhookAccountOverview> {
    try {
      return await this.request('GET', '/account/endpoints');
    } catch (error) {
      if (error instanceof RemoteRequestError && error.status === 404) throw new Error('WEBHOOK_MANAGEMENT_UNAVAILABLE');
      throw error;
    }
  }

  async releaseEndpoint(id: string): Promise<void> {
    await this.enqueue(async () => {
      await this.request('DELETE', `/account/endpoints/${encodeURIComponent(id)}`);
      this.loaded = false;
      await this.reconcile();
    });
  }

  async restoreEndpoint(scheduleId: string): Promise<void> {
    await this.enqueue(async () => {
      const generation = this.generation;
      this.loaded = false;
      await this.reconcile();
      if (generation !== this.generation) throw new Error('WEBHOOK_ACCOUNT_CHANGED');
      const releaseId = this.releases.get(scheduleId);
      const wanted = this.wanted.get(scheduleId);
      if (!releaseId || !wanted?.format) throw new Error('WEBHOOK_RESTORE_UNAVAILABLE');
      const view = await this.request<RemoteEndpointView>('POST', `/endpoints/by-schedule/${encodeURIComponent(scheduleId)}/restore`, {
        releaseId, events: wanted.events, format: wanted.format,
      });
      this.releases.delete(scheduleId);
      this.problems.delete(scheduleId);
      this.views.set(scheduleId, view);
      await this.reconcile();
      this.deps.onChanged?.();
    });
  }

  /** 打开详情、回到窗口或服务器通知时读取最新状态；不增加常驻轮询。 */
  async refresh(): Promise<void> {
    await this.enqueue(async () => { this.loaded = false; await this.reconcile(); });
  }

  /** 服务器不发恢复通知，到了恢复时刻自然失效。 */
  quota(now = Date.now()): RemoteWebhookQuota | null {
    return this.exhausted && this.exhausted.resetAt > now ? this.exhausted : null;
  }

  /** 保存密钥。密钥由本机生成或用户从发送方粘贴，服务器不回显。 */
  async setSecret(scheduleId: string, secret: string): Promise<void> {
    const view = await this.currentView(scheduleId);
    this.views.set(scheduleId, await this.request<RemoteEndpointView>('PUT', `/endpoints/${view.id}/secret`, { secret }));
    this.deps.onChanged?.();
  }

  /** 换一个新地址，旧地址立即失效；配置、密钥和暂存事件都保留。 */
  async rotateUrl(scheduleId: string): Promise<{ url: string }> {
    const view = await this.currentView(scheduleId);
    const rotated = await this.request<RemoteEndpointView>('POST', `/endpoints/${view.id}/rotate`);
    this.views.set(scheduleId, rotated);
    this.deps.onChanged?.();
    return { url: rotated.url };
  }

  /** 先把最新配置同步到服务器，避免在旧格式上设置密钥。 */
  private async currentView(scheduleId: string): Promise<RemoteEndpointView> {
    await this.enqueueReconcile();
    const view = this.view(scheduleId);
    if (!view) throw new Error('Webhook endpoint is not available');
    return view;
  }

  private enqueueReconcile(): Promise<void> {
    return this.enqueue(() => this.reconcile());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const run = this.work.then(() => {
      if (generation !== this.generation) throw new Error('WEBHOOK_ACCOUNT_CHANGED');
      return operation();
    });
    this.work = run.then(() => undefined, () => undefined);
    return run;
  }

  private githubGuard(socket: WebSocket): () => boolean {
    const generation = this.generation;
    const subscription = this.githubSynced;
    let current = true;
    return () => current && (current = this.running && this.socket === socket
      && generation === this.generation && subscription === this.githubSynced);
  }

  private enqueueGithub<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const reconciled = this.work;
    const run = this.githubWork.then(() => reconciled).then(() => {
      if (generation !== this.generation) throw new Error('WEBHOOK_ACCOUNT_CHANGED');
      return operation();
    });
    this.githubWork = run.then(() => undefined, () => undefined);
    return run;
  }

  private async reconcile(): Promise<void> {
    const generation = this.generation;
    try {
      if (!this.running || !this.deps.baseUrl() || !(await this.deps.getAccessToken()) || generation !== this.generation) return;
      if (!this.loaded) {
        const { endpoints } = await this.request<{ endpoints: RemoteEndpointView[] }>('GET', '/endpoints');
        // 老服务没有释放记录接口，沿用原有接收能力。
        const result = await this.request<{ released: { scheduleId: string; releaseId: string }[] }>('GET', '/endpoints/released')
          .catch((error: unknown) => {
            if (error instanceof RemoteRequestError && error.status === 404) return { released: [] };
            throw error;
          });
        if (generation !== this.generation) return;
        this.releases.clear();
        for (const [id, problem] of this.problems) if (problem === 'released') this.problems.delete(id);
        for (const release of result.released) {
          if (generation !== this.generation) return;
          this.releases.set(release.scheduleId, release.releaseId);
          this.problems.set(release.scheduleId, 'released');
          await this.deps.onInvalidated?.(release.scheduleId);
        }
        if (generation !== this.generation) return;
        this.views.clear();
        for (const endpoint of endpoints) this.views.set(endpoint.scheduleId, endpoint);
        this.loaded = true;
      }
      for (const [scheduleId, wanted] of this.wanted) {
        if (generation !== this.generation) return;
        if (this.releases.has(scheduleId)) continue;
        let view = this.views.get(scheduleId);
        const previousIdentity = this.identities.get(scheduleId);
        if (previousIdentity !== undefined && previousIdentity !== wanted.identity) {
          await this.deps.onInvalidated?.(scheduleId);
          if (generation !== this.generation) return;
          // Disable/re-enable changes the local identity even when deletion could
          // not reach the server. Revoke first; never update an old URL/key in place.
          if (view) {
            await this.request('DELETE', `/endpoints/${view.id}`);
            this.views.delete(scheduleId);
            view = undefined;
          }
        }
        // Persist before creation: a lost PUT response must not lose the identity
        // of an endpoint that the server may already have created.
        this.rememberIdentity(scheduleId, wanted.identity);
        if (view && sameEvents(view.events, wanted.events) && (wanted.format === null || sameFormat(view.format, wanted.format))
          && (view.scheduleName === undefined || view.scheduleName === wanted.scheduleName)
          && (view.deviceName === undefined || view.deviceName === (wanted.deviceName ?? null))) {
          continue;
        }
        await this.upsert(scheduleId, wanted);
      }
      for (const [scheduleId, view] of this.views) {
        if (generation !== this.generation) return;
        if (this.wanted.has(scheduleId)) continue;
        await this.request('DELETE', `/endpoints/${view.id}`);
        this.views.delete(scheduleId);
        this.problems.delete(scheduleId);
      }
      for (const scheduleId of this.identities.keys()) {
        if (!this.wanted.has(scheduleId)) this.rememberIdentity(scheduleId, undefined);
      }
      try { await this.syncGithub(); }
      catch (error) {
        if (generation !== this.generation) return;
        this.githubError = error;
        this.scheduleRetry();
      }
      if (generation !== this.generation) return;
      this.suspended = false;
    } catch (error) {
      if (generation !== this.generation) return;
      this.loaded = false;
      if (error instanceof RemoteRequestError && error.code === 'WEBHOOK_ACCOUNT_SUSPENDED') this.suspended = true;
      this.deps.logger.warn?.('[schedule-webhook] sync failed', { error: String(error) });
      this.scheduleRetry();
    }
    this.deps.onChanged?.();
    this.updateConnection();
  }

  private async upsert(scheduleId: string, { events, format, scheduleName, deviceName }: WantedEndpoint): Promise<void> {
    // 本机认不出发送方时沿用服务器上的格式；新建时没有可沿用的，只能报错。
    const effective = format ?? this.views.get(scheduleId)?.format ?? null;
    if (!effective) {
      this.problems.set(scheduleId, 'unsupported');
      return;
    }
    try {
      const view = await this.request<RemoteEndpointView>('PUT', `/endpoints/by-schedule/${encodeURIComponent(scheduleId)}`, {
        events,
        format: effective,
        scheduleName,
        ...(deviceName !== undefined ? { deviceName } : {}),
      });
      this.views.set(scheduleId, view);
      this.problems.delete(scheduleId);
    } catch (error) {
      if (!(error instanceof RemoteRequestError) || error.status >= 500 || error.status === 403) throw error;
      // 这一个任务的问题，不挡住其他任务。
      this.problems.set(scheduleId, error.code === 'WEBHOOK_ENDPOINT_LIMIT' ? 'limit'
        : error.code === 'WEBHOOK_ENDPOINT_RELEASED' ? 'released'
          // 400／422 是服务器不认这份端点定义，实际只有格式版本不一致这一种；重试不会变。
          : error.status === 400 || error.status === 422 ? 'unsupported' : 'failed');
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const generation = this.generation;
    const send = async (): Promise<Response> => {
      const token = await this.deps.getAccessToken();
      if (generation !== this.generation) throw new Error('WEBHOOK_ACCOUNT_CHANGED');
      if (!token) throw new RemoteRequestError(401, 'SIGNED_OUT');
      return this.deps.fetch(`${this.deps.baseUrl()}/api/v1${path}`, {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };
    let response = await send();
    if (generation !== this.generation) throw new Error('WEBHOOK_ACCOUNT_CHANGED');
    if (response.status === 401 && (await this.deps.refreshAccessToken())) response = await send();
    if (generation !== this.generation) throw new Error('WEBHOOK_ACCOUNT_CHANGED');
    if (!response.ok) {
      const parsed = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      if (generation !== this.generation) throw new Error('WEBHOOK_ACCOUNT_CHANGED');
      throw new RemoteRequestError(response.status, parsed?.error?.code);
    }
    const result = response.status === 204 ? undefined : await response.json();
    if (generation !== this.generation) throw new Error('WEBHOOK_ACCOUNT_CHANGED');
    return result as T;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueueReconcile().catch(() => undefined);
    }, RECONCILE_RETRY_MS);
    this.retryTimer.unref?.();
  }

  /** 只有需要接收事件时才保持连接。 */
  private updateConnection(): void {
    if (this.running && (this.wanted.size > 0 || (this.github.login && (this.githubPrs.length > 0 || this.githubAutomations.size > 0))) && !this.suspended && !this.replaced) void this.connect();
    else this.closeSocket();
  }

  private async connect(): Promise<void> {
    if (this.replaced || this.socket || this.connecting || this.reconnectTimer || !this.deps.baseUrl()) return;
    this.connecting = true;
    const generation = this.generation;
    try {
      const token = await this.deps.getAccessToken();
      if (!token || !this.running || generation !== this.generation) return;
      const url = `${this.deps.baseUrl().replace(/^http/, 'ws')}/ws`;
      const options = await this.deps.socketOptions(url);
      if (!this.running || generation !== this.generation) return;
      this.open(url, token, options);
    } catch (error) {
      this.deps.logger.warn?.('[schedule-webhook] connect failed', { error: String(error) });
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private open(url: string, token: string, options: Pick<ClientOptions, 'agent'>): void {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 15_000,
      ...options,
    });
    this.socket = socket;
    this.githubVerified.clear();
    this.githubBatchFailed = false;
    this.lastSocketActivity = 0;
    let rejected = false;
    socket.on('unexpected-response', (_request, response) => {
      rejected = response.statusCode === 401;
      socket.terminate();
    });
    socket.on('message', (raw) => this.onFrame(socket, String(raw)));
    socket.on('ping', () => {
      if (this.socket !== socket) return;
      this.lastSocketActivity = Date.now();
      this.refreshGithubHealth();
    });
    socket.on('error', (error) => {
      this.deps.logger.warn?.('[schedule-webhook] connection error', { error: String(error) });
    });
    socket.on('close', (code) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const wasConnected = this.connected;
      this.connected = false;
      this.githubVerified.clear();
      if (code === CLOSE_REPLACED) this.replaced = true;
      if (wasConnected) this.deps.onChanged?.();
      void this.onClosed(code, rejected);
    });
  }

  private async onClosed(code: number, rejected: boolean): Promise<void> {
    if (!this.running) return;
    if (code === CLOSE_ACCOUNT_SUSPENDED) {
      this.suspended = true;
      this.deps.onChanged?.();
      return;
    }
    if (code === CLOSE_REPLACED) return;
    if (rejected || code === CLOSE_TOKEN_EXPIRED) {
      // 连续被拒绝时只强制刷新一次，避免坏凭证形成刷新风暴。
      if (rejected && this.refreshedAfterRejection) {
        this.scheduleReconnect();
        return;
      }
      this.refreshedAfterRejection = rejected;
      const refreshed = await this.deps.refreshAccessToken().catch(() => false);
      if (refreshed && this.running) {
        void this.connect();
        return;
      }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.replaced || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.updateConnection();
    }, connectionBackoffDelayMs(this.attempt));
    this.reconnectTimer.unref?.();
    this.attempt += 1;
  }

  private onFrame(socket: WebSocket, raw: string): void {
    if (this.socket !== socket) return;
    this.lastSocketActivity = Date.now();
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.type === 'welcome') {
      this.attempt = 0;
      this.refreshedAfterRejection = false;
      this.connected = true;
      void this.refresh().catch(() => undefined);
      this.deps.onChanged?.();
      return;
    }
    if (frame.type === 'endpoints-changed') {
      void this.refresh().catch(() => undefined);
      return;
    }
    if (frame.type === 'quota') {
      this.onQuota(frame);
      return;
    }
    if (frame.type !== 'events') return;
    const batch = parseBatch(frame);
    if (!batch) return;
    const { batchId, ...delivery } = batch;
    let canAcknowledge = () => this.socket === socket && this.running;
    // Persist task doorbells on the ordinary admission lane. Only PR lookups
    // join the GitHub lane, so a slow PR cannot delay an unrelated App task.
    const receive = this.enqueue(async () => {
      if (this.socket !== socket || !this.running) return;
      if (delivery.scheduleId !== GITHUB_WATCH_SCHEDULE) { await this.deps.onBatch(delivery); return; }
      if (delivery.endpointId !== this.github.endpointId || !this.github.login) throw new Error('GitHub subscription is not reconciled');
      const isCurrent = this.githubGuard(socket);
      canAcknowledge = isCurrent;
      await this.deps.onGithubBatch?.({ ...delivery, batchId }, isCurrent);
      return isCurrent;
    }).then(async (isCurrent) => {
      if (!isCurrent?.()) return;
      const covered = this.coveredGithubPrs();
      const recover = delivery.omitted > 0 || this.githubBatchFailed;
      if (recover) this.githubBatchFailed = true;
      const heads = await this.deps.githubPrHeads?.(covered) ?? {};
      if (!isCurrent()) return;
      // Unknown/evicted heads are re-read once, never every PR in the repository.
      const unknown = covered.filter(url => !heads[url] && delivery.events.some(event => ['check_run', 'check_suite', 'status', 'workflow_run'].includes(event.event) && event.number === undefined
        && event.repository?.toLowerCase() === url.split('/').slice(3, 5).join('/').toLowerCase()));
      const urls = recover ? covered : [...new Set([...matchingGithubPrs(covered, delivery.events, heads), ...unknown])];
      const notify = recover ? covered : matchingGithubPrs(covered,
        delivery.events.filter(event => !['check_run', 'check_suite', 'status'].includes(event.event)), heads);
      if (urls.length) {
        if (!this.deps.onGithubPrs) throw new Error('GITHUB_RECEIVER_UNAVAILABLE');
        await this.enqueueGithub(async () => {
          if (!isCurrent()) return;
          await this.deps.onGithubPrs!(urls, isCurrent, { reason: recover ? 'overflow' : 'event', notify });
          if (isCurrent()) this.githubBatchFailed = false;
        });
      }
    });
    receive.then(
      () => {
        if (canAcknowledge() && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'ack', batchId }));
      },
      (error) => {
        if (canAcknowledge() && delivery.scheduleId === GITHUB_WATCH_SCHEDULE) this.githubBatchFailed = true;
        // 不 ack：服务器保留这批事件，之后重发。
        this.deps.logger.warn?.('[schedule-webhook] batch not stored', { error: String(error) });
      },
    );
  }

  private onQuota({ limit, resetAt }: Record<string, unknown>): void {
    if (typeof limit !== 'number' || typeof resetAt !== 'number') return;
    if (this.exhausted?.resetAt === resetAt) return;
    this.exhausted = { limit, resetAt };
    this.deps.onChanged?.();
    // The generic allowance is still visible to ordinary Webhook tasks. A
    // GitHub-only device must not show an unrelated "notifications stopped" alert.
    if (this.wanted.size || !this.github.dailyQuotaExempt) this.deps.onQuotaExhausted?.(this.exhausted);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.reconnectTimer = null;
    this.retryTimer = null;
    this.attempt = 0;
    this.refreshedAfterRejection = false;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.githubVerified.clear();
    this.githubBatchFailed = false;
    this.lastSocketActivity = 0;
    if (!socket) return;
    socket.removeAllListeners('close');
    socket.on('error', () => undefined);
    socket.close();
  }
}
