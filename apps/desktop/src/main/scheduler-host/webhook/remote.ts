/**
 * 自动化任务 Webhook 的服务器通道：地址和密钥走 webhook-server，事件经 Desktop 主动拨出的
 * 长连接送达，本机不开端口。合同见 cindy-server 仓 docs/webhook-server.md。
 */
import { connectionBackoffDelayMs } from '@cindy/im/connection-retry';
import type { Schedule, ScheduleWebhookEvent } from '@cindy/maker-scheduler';
import WebSocket, { type ClientOptions } from 'ws';

const CLOSE_TOKEN_EXPIRED = 4401;
const CLOSE_ACCOUNT_SUSPENDED = 4403;
const CLOSE_REPLACED = 4409;

/** 服务器偶发错误或账号被封停，都不值得频繁重试。 */
const RECONCILE_RETRY_MS = 60_000;

export interface RemoteEndpointView {
  id: string;
  url: string;
  scheduleId: string;
  events: string[];
  hasSecret: boolean;
  status: 'active' | 'suspended';
  lastReceivedAt: string | null;
}

export interface RemoteWebhookBatch {
  endpointId: string;
  scheduleId: string;
  events: ScheduleWebhookEvent[];
  omitted: number;
}

export type RemoteEndpointProblem = 'limit' | 'failed';

/** 账号今天的 Webhook 接收次数已用完。 */
export interface RemoteWebhookQuota {
  limit: number;
  /** 恢复时刻（毫秒）。 */
  resetAt: number;
}

export interface ScheduleWebhookRemoteDeps {
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
  private wanted = new Map<string, readonly string[]>();
  private readonly views = new Map<string, RemoteEndpointView>();
  private readonly problems = new Map<string, RemoteEndpointProblem>();
  private loaded = false;
  private running = false;
  private suspended = false;
  private exhausted: RemoteWebhookQuota | null = null;
  private work: Promise<void> = Promise.resolve();
  private socket: WebSocket | null = null;
  private connecting = false;
  private connected = false;
  private attempt = 0;
  private refreshedAfterRejection = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ScheduleWebhookRemoteDeps) {}

  /** 同步“哪些任务需要接收”。登录后调用；未登录时调用也安全。 */
  sync(schedules: readonly Schedule[]): Promise<void> {
    const wanted = new Map<string, readonly string[]>();
    for (const schedule of schedules) {
      if (schedule.webhookTrigger) wanted.set(schedule.id, schedule.webhookTrigger.events ?? []);
    }
    this.wanted = wanted;
    this.running = true;
    return this.enqueueReconcile();
  }

  /** 退出登录或换账号：断开连接、丢弃账号相关的缓存，任务配置不动。 */
  pause(): void {
    this.running = false;
    this.loaded = false;
    this.suspended = false;
    this.exhausted = null;
    this.views.clear();
    this.problems.clear();
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

  view(scheduleId: string): RemoteEndpointView | undefined {
    return this.views.get(scheduleId);
  }

  problem(scheduleId: string): RemoteEndpointProblem | undefined {
    return this.problems.get(scheduleId);
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  /** 服务器不发恢复通知，到了恢复时刻自然失效。 */
  quota(now = Date.now()): RemoteWebhookQuota | null {
    return this.exhausted && this.exhausted.resetAt > now ? this.exhausted : null;
  }

  async rotateSecret(scheduleId: string): Promise<{ secret: string; url: string }> {
    await this.enqueueReconcile();
    const view = this.views.get(scheduleId);
    if (!view) throw new Error('Webhook endpoint is not available');
    const result = await this.request<{ secret: string; endpoint: RemoteEndpointView }>('POST', `/endpoints/${view.id}/secret`);
    this.views.set(scheduleId, result.endpoint);
    return { secret: result.secret, url: result.endpoint.url };
  }

  private enqueueReconcile(): Promise<void> {
    const run = this.work.then(() => this.reconcile());
    this.work = run.catch(() => undefined);
    return run;
  }

  private async reconcile(): Promise<void> {
    if (!this.running || !this.deps.baseUrl() || !(await this.deps.getAccessToken())) return;
    try {
      if (!this.loaded) {
        const { endpoints } = await this.request<{ endpoints: RemoteEndpointView[] }>('GET', '/endpoints');
        this.views.clear();
        for (const endpoint of endpoints) this.views.set(endpoint.scheduleId, endpoint);
        this.loaded = true;
      }
      for (const [scheduleId, events] of this.wanted) {
        const view = this.views.get(scheduleId);
        if (view && sameEvents(view.events, events)) continue;
        await this.upsert(scheduleId, events);
      }
      for (const [scheduleId, view] of this.views) {
        if (this.wanted.has(scheduleId)) continue;
        await this.request('DELETE', `/endpoints/${view.id}`);
        this.views.delete(scheduleId);
        this.problems.delete(scheduleId);
      }
      this.suspended = false;
    } catch (error) {
      if (error instanceof RemoteRequestError && error.code === 'WEBHOOK_ACCOUNT_SUSPENDED') this.suspended = true;
      this.deps.logger.warn?.('[schedule-webhook] sync failed', { error: String(error) });
      this.scheduleRetry();
    }
    this.deps.onChanged?.();
    this.updateConnection();
  }

  private async upsert(scheduleId: string, events: readonly string[]): Promise<void> {
    try {
      const view = await this.request<RemoteEndpointView>('PUT', `/endpoints/by-schedule/${encodeURIComponent(scheduleId)}`, { events });
      this.views.set(scheduleId, view);
      this.problems.delete(scheduleId);
    } catch (error) {
      if (!(error instanceof RemoteRequestError) || error.status >= 500 || error.status === 403) throw error;
      // 这一个任务的问题，不挡住其他任务。
      this.problems.set(scheduleId, error.code === 'WEBHOOK_ENDPOINT_LIMIT' ? 'limit' : 'failed');
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const send = async (): Promise<Response> => {
      const token = await this.deps.getAccessToken();
      if (!token) throw new RemoteRequestError(401, 'SIGNED_OUT');
      return this.deps.fetch(`${this.deps.baseUrl()}/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };
    let response = await send();
    if (response.status === 401 && (await this.deps.refreshAccessToken())) response = await send();
    if (!response.ok) {
      const parsed = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      throw new RemoteRequestError(response.status, parsed?.error?.code);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
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
    if (this.running && this.wanted.size > 0 && !this.suspended) void this.connect();
    else this.closeSocket();
  }

  private async connect(): Promise<void> {
    if (this.socket || this.connecting || this.reconnectTimer || !this.deps.baseUrl()) return;
    this.connecting = true;
    try {
      const token = await this.deps.getAccessToken();
      if (!token || !this.running) return;
      const url = `${this.deps.baseUrl().replace(/^http/, 'ws')}/ws`;
      const options = await this.deps.socketOptions(url);
      if (!this.running) return;
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
    let rejected = false;
    socket.on('unexpected-response', (_request, response) => {
      rejected = response.statusCode === 401;
      socket.terminate();
    });
    socket.on('message', (raw) => this.onFrame(socket, String(raw)));
    socket.on('error', (error) => {
      this.deps.logger.warn?.('[schedule-webhook] connection error', { error: String(error) });
    });
    socket.on('close', (code) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const wasConnected = this.connected;
      this.connected = false;
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
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.updateConnection();
    }, connectionBackoffDelayMs(this.attempt));
    this.reconnectTimer.unref?.();
    this.attempt += 1;
  }

  private onFrame(socket: WebSocket, raw: string): void {
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
      this.deps.onChanged?.();
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
    this.deps.onBatch(delivery).then(
      () => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'ack', batchId }));
      },
      (error) => {
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
    this.deps.onQuotaExhausted?.(this.exhausted);
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
    if (!socket) return;
    socket.removeAllListeners('close');
    socket.on('error', () => undefined);
    socket.close();
  }
}
