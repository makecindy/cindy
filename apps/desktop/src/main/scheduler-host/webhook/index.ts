/**
 * 自动化任务 Webhook 的宿主：账号隔离的事件队列，以及两种事件来源。
 * 正式来源是 webhook-server（需要 Cindy 账号）；本机接收服务只在开发版显式开启时启动，
 * 只监听 127.0.0.1，密钥存在本机。规则见 docs/product-rules/schedule-webhook-trigger.md。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { safeStorage } from 'electron';
import {
  ScheduleWebhookQueue,
  scheduleWebhookEventMatches,
  type Schedule,
  type ScheduleWebhookQueueState,
  type Scheduler,
} from '@cindy/maker-scheduler';
import { ownerScopedUserDataPath } from '../../appSessionState.js';
import { oauthSecureStorageAvailable } from '../../plugin-oauth/identityStore.js';
import { createWebhookIngress, type WebhookDeliveryOutcome } from './ingress.js';
import {
  ScheduleWebhookRemote,
  type RemoteWebhookBatch,
  type RemoteWebhookQuota,
  type ScheduleWebhookRemoteDeps,
} from './remote.js';

const DIR = 'schedule-webhooks';
const PATH_PREFIX = '/schedule-webhook/';
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const STATUS_BY_OUTCOME: Record<WebhookDeliveryOutcome, number> = {
  queued: 202,
  duplicate: 200,
  ignored: 200,
  filtered: 200,
  ping: 200,
  'not-found': 404,
  'no-secret': 401,
  'bad-signature': 401,
  'rate-limited': 429,
  'store-failed': 503,
};

/**
 * - cloud：经 webhook-server 接收
 * - local：开发版的本机接收服务
 * - signed-out：没有 Cindy 账号，配置保留、不接收
 * - unavailable：当前环境没有部署 webhook-server
 */
export type ScheduleWebhookReceiver = 'cloud' | 'local' | 'signed-out' | 'unavailable';

export interface ScheduleWebhookStatus {
  receiver: ScheduleWebhookReceiver;
  /** 接收方就绪时才有。 */
  url?: string;
  hasSecret: boolean;
  lastReceivedAt?: number;
  received: number;
  ignored: number;
  /** 这台电脑到服务器的长连接是否在线。 */
  connected?: boolean;
  problem?: 'limit' | 'failed' | 'suspended' | 'quota';
  /** 今天的 Webhook 接收次数已用完时才有。 */
  quotaLimit?: number;
  quotaResetAt?: number;
}

export interface ScheduleWebhookHostOptions {
  /** 开发版的本机接收服务。 */
  local?: boolean;
  /** 服务器通道；缺省表示不接服务器。 */
  remote?: Omit<ScheduleWebhookRemoteDeps, 'onBatch' | 'onChanged'> & { isSignedIn(): boolean };
  onStatusChanged?(): void;
  onQuotaExhausted?(quota: RemoteWebhookQuota): void;
}

interface Logger {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}

function dataPath(...parts: string[]): string {
  return ownerScopedUserDataPath(DIR, ...parts);
}

function writeAtomically(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function secretFile(endpointId: string): string {
  // endpointId 由引擎生成，这里仍防止它被拼出目录。
  return dataPath('secrets', `${path.basename(endpointId)}.enc`);
}

function secureStorageAvailable(): boolean {
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
  return oauthSecureStorageAvailable({
    platform: process.platform,
    available: safeStorage.isEncryptionAvailable(),
    backend,
  });
}

function loadState(): ScheduleWebhookQueueState {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPath('state.json'), 'utf8')) as Partial<ScheduleWebhookQueueState>;
    return { port: parsed.port, endpoints: parsed.endpoints ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { endpoints: {} };
  }
}

export class ScheduleWebhookHost {
  private readonly queue: ScheduleWebhookQueue;
  private readonly secrets = new Map<string, string>();
  private readonly deliver: ReturnType<typeof createWebhookIngress>;
  private readonly remote: ScheduleWebhookRemote | null;
  private byEndpoint = new Map<string, Schedule>();
  private server: Server | null = null;
  private port: number | undefined;
  private stopped = false;
  private refreshing: Promise<void> = Promise.resolve();
  private readonly onChanged = () => {
    this.refreshing = this.refreshing.then(() => this.refresh()).catch((error) => {
      this.logger.warn?.('[schedule-webhook] refresh failed', { error: String(error) });
    });
  };

  constructor(
    private readonly scheduler: Scheduler,
    private readonly logger: Logger,
    private readonly options: ScheduleWebhookHostOptions = {},
  ) {
    this.remote = options.remote
      ? new ScheduleWebhookRemote({
          ...options.remote,
          onBatch: (batch) => this.acceptBatch(batch),
          ...(options.onStatusChanged ? { onChanged: options.onStatusChanged } : {}),
          ...(options.onQuotaExhausted ? { onQuotaExhausted: options.onQuotaExhausted } : {}),
        })
      : null;
    this.queue = new ScheduleWebhookQueue({
      load: async () => loadState(),
      save: async (state) => writeAtomically(dataPath('state.json'), JSON.stringify(state)),
      getSchedule: (id) => scheduler.get(id),
      isBusy: (id) => scheduler.getInflightCount(id) > 0,
      fire: (id, webhook) => scheduler.runNow(id, { deferToCaller: true, webhook }),
      now: () => Date.now(),
      onError: (message, detail) => logger.warn?.(`[schedule-webhook] ${message}`, detail),
    });
    this.deliver = createWebhookIngress({
      findSchedule: (endpointId) => this.byEndpoint.get(endpointId),
      readSecret: (endpointId) => this.readSecret(endpointId),
      accept: (id, event) => this.queue.accept(id, event),
      touch: (id) => this.queue.touch(id),
      now: () => Date.now(),
      onStoreError: (error) => logger.warn?.('[schedule-webhook] store failed', { error: String(error) }),
    });
  }

  async start(): Promise<void> {
    await this.queue.start();
    if (this.stopped) {
      this.queue.stop();
      return;
    }
    this.port = this.queue.port;
    this.scheduler.on('changed', this.onChanged);
    await this.refresh();
    if (!this.stopped) await this.sweepOrphans();
  }

  /** 任务可能在上次退出后才被删除（比如旧版本或另一入口），这里补清。 */
  private async sweepOrphans(): Promise<void> {
    const liveIds = new Set([...this.byEndpoint.values()].map((schedule) => schedule.id));
    for (const id of this.queue.ids()) if (!liveIds.has(id)) await this.queue.forget(id);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dataPath('secrets'));
    } catch {
      return;
    }
    for (const file of files) {
      if (file.endsWith('.enc') && !this.byEndpoint.has(file.slice(0, -'.enc'.length))) fs.rmSync(dataPath('secrets', file), { force: true });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.scheduler.off('changed', this.onChanged);
    this.remote?.stop();
    this.queue.stop();
    this.secrets.clear();
    await this.closeServer();
  }

  receiver(): ScheduleWebhookReceiver {
    if (this.options.local) return 'local';
    const remote = this.options.remote;
    if (!remote?.baseUrl()) return 'unavailable';
    return remote.isSignedIn() ? 'cloud' : 'signed-out';
  }

  /** 登录状态变化：登录后恢复接收，退出后暂停，任务配置都不动。 */
  authChanged(): void {
    if (this.options.local || this.stopped) return;
    this.onChanged();
  }

  status(schedule: Schedule): ScheduleWebhookStatus | null {
    const endpointId = schedule.webhookTrigger?.endpointId;
    if (!endpointId) return null;
    const receiver = this.receiver();
    const counters = this.queue.snapshot(schedule.id);
    if (receiver === 'local') {
      return {
        receiver,
        ...(this.server && this.port ? { url: this.urlFor(endpointId) } : {}),
        hasSecret: fs.existsSync(secretFile(endpointId)),
        ...counters,
      };
    }
    if (receiver !== 'cloud' || !this.remote) return { receiver, hasSecret: false, ...counters };
    const view = this.remote.view(schedule.id);
    const serverReceivedAt = view?.lastReceivedAt ? Date.parse(view.lastReceivedAt) : undefined;
    const lastReceivedAt = Math.max(serverReceivedAt ?? 0, counters.lastReceivedAt ?? 0);
    const quota = this.remote.quota();
    const problem = this.remote.isSuspended() || view?.status === 'suspended'
      ? 'suspended'
      : quota ? 'quota' : this.remote.problem(schedule.id);
    return {
      receiver,
      ...(view ? { url: view.url } : {}),
      hasSecret: view?.hasSecret ?? false,
      ...counters,
      ...(lastReceivedAt > 0 ? { lastReceivedAt } : {}),
      connected: this.remote.isConnected(),
      ...(problem ? { problem } : {}),
      ...(quota ? { quotaLimit: quota.limit, quotaResetAt: quota.resetAt } : {}),
    };
  }

  /** 生成并替换密钥，明文只在这次返回。用户动作触发，可以访问钥匙串。 */
  async rotateSecret(schedule: Schedule): Promise<{ secret: string; url?: string }> {
    const endpointId = schedule.webhookTrigger?.endpointId;
    if (!endpointId) throw new Error('Webhook trigger is not enabled for this schedule');
    const receiver = this.receiver();
    if (receiver === 'cloud' && this.remote) return this.remote.rotateSecret(schedule.id);
    if (receiver !== 'local') throw new Error('WEBHOOK_ACCOUNT_REQUIRED');
    if (!secureStorageAvailable()) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
    const secret = randomBytes(32).toString('hex');
    writeAtomically(secretFile(endpointId), safeStorage.encryptString(secret).toString('base64'));
    this.secrets.set(endpointId, secret);
    return { secret, ...(this.server && this.port ? { url: this.urlFor(endpointId) } : {}) };
  }

  private urlFor(endpointId: string): string {
    return `http://127.0.0.1:${this.port}${PATH_PREFIX}${endpointId}`;
  }

  /** 启动时不碰钥匙串：收到第一个事件才解密，避免 macOS 开机弹窗。 */
  private readSecret(endpointId: string): string | null {
    const cached = this.secrets.get(endpointId);
    if (cached) return cached;
    let raw: string;
    try {
      raw = fs.readFileSync(secretFile(endpointId), 'utf8');
    } catch {
      return null;
    }
    try {
      const secret = safeStorage.decryptString(Buffer.from(raw, 'base64'));
      this.secrets.set(endpointId, secret);
      return secret;
    } catch (error) {
      this.logger.warn?.('[schedule-webhook] secret unreadable', { error: String(error) });
      return null;
    }
  }

  private async refresh(): Promise<void> {
    const schedules = await this.scheduler.list();
    if (this.stopped) return;
    const next = new Map<string, Schedule>();
    for (const schedule of schedules) {
      if (schedule.webhookTrigger) next.set(schedule.webhookTrigger.endpointId, schedule);
    }
    for (const [endpointId, schedule] of this.byEndpoint) {
      if (next.get(endpointId)?.id === schedule.id) continue;
      this.secrets.delete(endpointId);
      fs.rmSync(secretFile(endpointId), { force: true });
      await this.queue.forget(schedule.id);
    }
    this.byEndpoint = next;
    if (this.options.local) {
      if (next.size > 0) await this.openServer();
      else await this.closeServer();
      return;
    }
    if (this.receiver() === 'cloud') await this.remote?.sync(schedules);
    else this.remote?.pause();
  }

  /** 服务器已验签并筛选过；这里按当前配置再筛一次，配置可能刚改过。 */
  private async acceptBatch(batch: RemoteWebhookBatch): Promise<void> {
    const schedule = [...this.byEndpoint.values()].find((candidate) => candidate.id === batch.scheduleId);
    if (!schedule?.webhookTrigger) return;
    let queued = false;
    for (const event of batch.events) {
      if (!scheduleWebhookEventMatches(schedule.webhookTrigger.events, event)) {
        this.queue.touch(schedule.id);
        continue;
      }
      if ((await this.queue.accept(schedule.id, event)) === 'queued') queued = true;
    }
    // 重发的批次全部是重复事件，这时不能再累加计数。
    if (queued) await this.queue.addOmitted(schedule.id, batch.omitted);
  }

  private async openServer(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => this.handle(req, res));
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    try {
      await listen(this.port ?? 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      // 换端口后地址会变；状态里展示的是新地址。
      this.logger.warn?.('[schedule-webhook] previous port busy, picking a new one', { port: this.port });
      await listen(0);
    }
    // 账号在监听途中切换：不留下属于旧账号的端口。
    if (this.stopped) {
      server.close();
      return;
    }
    this.server = server;
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : undefined;
    if (this.port) await this.queue.setPort(this.port);
    this.logger.info?.('[schedule-webhook] listening', { port: this.port });
  }

  private closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const reply = (status: number) => {
      if (!res.writableEnded) res.writeHead(status).end();
    };
    const pathname = (req.url ?? '').split('?')[0] ?? '';
    if (req.method !== 'POST' || !pathname.startsWith(PATH_PREFIX)) {
      reply(404);
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(413);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      void this.deliver({
        endpointId: pathname.slice(PATH_PREFIX.length),
        headers: req.headers,
        body: Buffer.concat(chunks),
      }).then((outcome) => reply(STATUS_BY_OUTCOME[outcome]), (error) => {
        this.logger.warn?.('[schedule-webhook] delivery failed', { error: String(error) });
        reply(503);
      });
    });
  }
}

