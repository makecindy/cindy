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
  isValidWebhookSecret,
  resolveScheduleWebhookFormat,
  webhookSecretKind,
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
  problem?: 'limit' | 'failed' | 'suspended' | 'quota' | 'released';
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

/** whsec 形式给 Standard Webhooks 系发送方（如 GitLab 签名令牌），其余用十六进制。 */
function generateSecret(whsec: boolean): string {
  const bytes = randomBytes(32);
  return whsec ? `whsec_${bytes.toString('base64')}` : bytes.toString('hex');
}

function secureStorageAvailable(): boolean {
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
  return oauthSecureStorageAvailable({
    platform: process.platform,
    available: safeStorage.isEncryptionAvailable(),
    backend,
  });
}

function loadState(file: string): ScheduleWebhookQueueState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ScheduleWebhookQueueState>;
    return { port: parsed.port, endpoints: parsed.endpoints ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { endpoints: {} };
  }
}

function remoteIdentityStore(file: string): NonNullable<ScheduleWebhookRemoteDeps['identityStore']> {
  return {
    load: () => {
      try {
        const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.values(value).some((identity) => typeof identity !== 'string' || !identity)) {
          throw new Error('Invalid webhook identity store');
        }
        return value as Record<string, string>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
      }
    },
    save: (identities) => writeAtomically(file, JSON.stringify(identities)),
  };
}

export class ScheduleWebhookHost {
  // Pending queue writes and cleanup may finish after stop. Never resolve their
  // storage against a newly active account; each host belongs to its original owner.
  private readonly dataDir = ownerScopedUserDataPath(DIR);
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
          identityStore: remoteIdentityStore(this.dataPath('remote-identities.json')),
          onBatch: (batch) => this.acceptBatch(batch),
          onInvalidated: (id) => this.queue.forget(id),
          ...(options.onStatusChanged ? { onChanged: options.onStatusChanged } : {}),
          ...(options.onQuotaExhausted ? { onQuotaExhausted: options.onQuotaExhausted } : {}),
        })
      : null;
    const stateFile = this.dataPath('state.json');
    this.queue = new ScheduleWebhookQueue({
      load: async () => loadState(stateFile),
      save: async (state) => writeAtomically(stateFile, JSON.stringify(state)),
      getSchedule: (id) => scheduler.get(id),
      isBusy: (id) => scheduler.getInflightCount(id) > 0,
      fire: async (id, webhook, onRunCreated) => {
        if (this.remote && !this.options.local) {
          // Offline disk backlog must observe account release before starting a new run.
          await this.remote.refresh();
          if (this.remote.problem(id) === 'released') return {};
          if (!this.remote.canDeliver(id)) return { deferred: true };
        }
        if (this.stopped) return { deferred: true };
        return scheduler.runNow(id, { deferToCaller: true, webhook, onRunCreated });
      },
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
      files = fs.readdirSync(this.dataPath('secrets'));
    } catch {
      return;
    }
    for (const file of files) {
      if (file.endsWith('.enc') && !this.byEndpoint.has(file.slice(0, -'.enc'.length))) fs.rmSync(this.dataPath('secrets', file), { force: true });
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
  authChanged(ownerChanged = false): void {
    if (this.options.local || this.stopped) return;
    if (ownerChanged) this.remote?.pause();
    this.onChanged();
  }

  async accountOverview() {
    if (this.receiver() !== 'cloud' || !this.remote) throw new Error('WEBHOOK_ACCOUNT_REQUIRED');
    const schedules = await this.scheduler.list();
    const overview = await this.remote.accountOverview();
    return { ...overview, endpoints: overview.endpoints.map((endpoint) => ({
      ...endpoint,
      scheduleName: endpoint.currentDevice
        ? schedules.find((schedule) => schedule.id === endpoint.scheduleId)?.name ?? endpoint.scheduleName
        : endpoint.scheduleName,
    })) };
  }

  async releaseEndpoint(id: string): Promise<void> {
    if (this.receiver() !== 'cloud' || !this.remote) throw new Error('WEBHOOK_ACCOUNT_REQUIRED');
    await this.remote.releaseEndpoint(id);
  }

  async restoreEndpoint(schedule: Schedule): Promise<void> {
    if (!schedule.webhookTrigger || this.receiver() !== 'cloud' || !this.remote) throw new Error('WEBHOOK_ACCOUNT_REQUIRED');
    await this.remote.restoreEndpoint(schedule.id);
  }

  async refreshStatus(): Promise<void> {
    if (this.receiver() === 'cloud') await this.remote?.refresh();
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
        hasSecret: fs.existsSync(this.secretFile(endpointId)),
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
      : this.remote.problem(schedule.id) === 'released' ? 'released'
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

  /**
   * 设置密钥：传入时保存用户从发送方复制的密钥；不传时按发送方格式生成，明文只在这次返回。
   * 用户动作触发，可以访问钥匙串。
   */
  async setSecret(schedule: Schedule, pasted?: string): Promise<{ secret?: string }> {
    const trigger = schedule.webhookTrigger;
    if (!trigger) throw new Error('Webhook trigger is not enabled for this schedule');
    const receiver = this.receiver();
    if (receiver === 'cloud' && this.remote) {
      const format = resolveScheduleWebhookFormat(trigger.source);
      const kind = format ? webhookSecretKind(format) : null;
      if (!kind) throw new Error('WEBHOOK_UNSIGNED');
      const secret = pasted ?? generateSecret(kind === 'hmac-whsec');
      if (!isValidWebhookSecret(kind, secret)) throw new Error('WEBHOOK_SECRET_INVALID');
      await this.remote.setSecret(schedule.id, secret);
      return pasted === undefined ? { secret } : {};
    }
    // 开发版的本机接收服务只认 GitHub 格式，不看任务的发送方设置。
    if (receiver !== 'local') throw new Error('WEBHOOK_ACCOUNT_REQUIRED');
    if (!secureStorageAvailable()) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
    const secret = pasted ?? generateSecret(false);
    if (!isValidWebhookSecret('hmac-text', secret)) throw new Error('WEBHOOK_SECRET_INVALID');
    writeAtomically(this.secretFile(trigger.endpointId), safeStorage.encryptString(secret).toString('base64'));
    this.secrets.set(trigger.endpointId, secret);
    return pasted === undefined ? { secret } : {};
  }

  /** 换一个新地址，旧地址立即失效。地址泄露时使用，不签名的地址尤其需要。 */
  async rotateUrl(schedule: Schedule): Promise<{ url: string }> {
    if (!schedule.webhookTrigger) throw new Error('Webhook trigger is not enabled for this schedule');
    if (this.receiver() !== 'cloud' || !this.remote) throw new Error('WEBHOOK_ACCOUNT_REQUIRED');
    return this.remote.rotateUrl(schedule.id);
  }

  private urlFor(endpointId: string): string {
    return `http://127.0.0.1:${this.port}${PATH_PREFIX}${endpointId}`;
  }

  private dataPath(...parts: string[]): string {
    return path.join(this.dataDir, ...parts);
  }

  private secretFile(endpointId: string): string {
    // endpointId 由引擎生成，这里仍防止它被拼出目录。
    return this.dataPath('secrets', `${path.basename(endpointId)}.enc`);
  }

  /** 启动时不碰钥匙串：收到第一个事件才解密，避免 macOS 开机弹窗。 */
  private readSecret(endpointId: string): string | null {
    const cached = this.secrets.get(endpointId);
    if (cached) return cached;
    let raw: string;
    try {
      raw = fs.readFileSync(this.secretFile(endpointId), 'utf8');
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
      fs.rmSync(this.secretFile(endpointId), { force: true });
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
    if (this.remote?.problem(batch.scheduleId) === 'released') return;
    const schedule = [...this.byEndpoint.values()].find((candidate) => candidate.id === batch.scheduleId);
    if (!schedule?.webhookTrigger) return;
    if (this.remote && !this.remote.canDeliver(batch.scheduleId)) throw new Error('Webhook endpoint is not reconciled');
    if (this.remote && this.remote.view(batch.scheduleId)?.id !== batch.endpointId) return;
    // Admission reads the latest filter and commits details, receipts and count
    // together. A failed save leaves the entire batch available for redelivery.
    await this.queue.acceptBatch(schedule.id, batch.events, batch.omitted, schedule.webhookTrigger.endpointId);
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

