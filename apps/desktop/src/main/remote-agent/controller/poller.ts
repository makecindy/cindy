/**
 * 远程 Agent 事件拉取(控制端，每台运行 Agent 的电脑一个)。
 *
 * 同一台电脑上的全部任务共用一个 `poll`：一次带上每个任务的游标，对方没有新数据时挂起最多
 * READ_WAIT_MS。任务再多也只占设备互联一个长等待；新任务登记时另发一个覆盖全部任务的 poll，
 * 同时在途的 poll 不超过两个。两个 poll 返回的数据可能重叠，按 from 去重，游标只前进不后退。
 *
 * 链路抖动：poll 按游标幂等，可恢复的错误退避后重拉；对方长时间不可达时结束全部任务。
 */
import {
  REMOTE_AGENT_MAX_POLL_RUNS,
  REMOTE_AGENT_READ_WAIT_MS,
  parseRemoteAgentPollResult,
  type RemoteAgentErrorInfo,
  type RemoteAgentPollResult,
} from '@cindy/device-link';

/** 经设备互联调用对方；失败时抛出带 `code` 的错误(与 remoteBackgroundInvoke 一致)。 */
export type RemoteAgentInvoke = (args: unknown[]) => Promise<unknown>;

/** 对方不可达时持续重拉的最长时间。 */
export const REMOTE_AGENT_READ_GIVE_UP_MS = 2 * 60_000;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5_000;
/** 同时在途的 poll 上限：一个长等待 + 一个覆盖新任务的。 */
const MAX_INFLIGHT_POLLS = 2;
/** 对方连续几次立刻返回、却没有任何新数据时，放慢重拉(防止对方行为异常时空转)。 */
const EMPTY_FAST_STREAK = 3;
const EMPTY_FAST_MS = 50;
const EMPTY_FAST_DELAY_MS = 1_000;

export interface PolledRun {
  readonly runId: string;
  /** 收到从当前游标开始的新数据(已去重)；done 表示对方的流已结束且读完。 */
  onData(data: Buffer, done: boolean): void;
  /** 任务已不能再拉取(对方不认识这个任务、协议错误或对方长时间不可达)。 */
  onLost(reason: string, error: RemoteAgentErrorInfo): void;
}

interface Entry {
  run: PolledRun;
  cursor: number;
}

/** 可恢复的链路错误：重拉即可。 */
export function isRetryableLinkError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string' && [
    'PEER_RESET', 'TIMEOUT', 'INVOKE_TIMEOUT', 'BACKPRESSURE', 'DEVICE_OFFLINE', 'LINK_CLOSED', 'LINK_NOT_OPEN', 'NOT_CONNECTED',
  ].includes(code)) {
    return true;
  }
  return /PEER_RESET|TIMEOUT|BACKPRESSURE|OFFLINE|NOT_CONNECTED|LINK_CLOSED|timed out/i.test(message)
    && !/REMOTE_AGENT_(NOT_FOUND|INVALID|UNSUPPORTED|ACCOUNT_CHANGED)/.test(message);
}

export function remoteAgentErrorFrom(error: unknown, fallbackCode = 'REMOTE_AGENT_UNAVAILABLE'): RemoteAgentErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  return {
    code: /\[([A-Z_]+)\]/.exec(message)?.[1] ?? (typeof code === 'string' && code ? code : fallbackCode),
    message,
  };
}

export class RemoteAgentPoller {
  private readonly entries = new Map<string, Entry>();
  private inflight = 0;
  /** 有任务还没被任何在途 poll 覆盖。 */
  private needFresh = false;
  private unreachableSince: number | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private rotation = 0;
  private emptyFastStreak = 0;

  constructor(
    readonly invoke: RemoteAgentInvoke,
    private readonly log?: { warn(message: string, meta?: Record<string, unknown>): void },
    private readonly now: () => number = Date.now,
  ) {}

  /** 开始拉取一个任务(游标从 0 开始)。 */
  register(run: PolledRun): void {
    if (this.entries.has(run.runId)) return;
    this.entries.set(run.runId, { run, cursor: 0 });
    this.needFresh = true;
    this.ensure();
  }

  unregister(runId: string): void {
    this.entries.delete(runId);
  }

  get size(): number {
    return this.entries.size;
  }

  private ensure(): void {
    if (this.entries.size === 0 || this.retryTimer) return;
    if (this.inflight > 0 && !this.needFresh) return;
    if (this.inflight >= MAX_INFLIGHT_POLLS) return;
    this.needFresh = false;
    void this.pollOnce();
  }

  private snapshot(): Array<{ runId: string; cursor: number }> {
    const all = [...this.entries.values()].map((entry) => ({ runId: entry.run.runId, cursor: entry.cursor }));
    if (all.length <= REMOTE_AGENT_MAX_POLL_RUNS) return all;
    // 超出单次上限时轮流取(对方每台控制端的任务数远低于这个上限，正常走不到)。
    const start = this.rotation++ % all.length;
    this.needFresh = true;
    return [...all.slice(start), ...all.slice(0, start)].slice(0, REMOTE_AGENT_MAX_POLL_RUNS);
  }

  private async pollOnce(): Promise<void> {
    const wanted = this.snapshot();
    const startedAt = this.now();
    this.inflight += 1;
    let raw: unknown;
    let failure: unknown = null;
    try {
      raw = await this.invoke([{ op: 'poll', runs: wanted, waitMs: REMOTE_AGENT_READ_WAIT_MS }]);
    } catch (error) {
      failure = error;
    } finally {
      this.inflight -= 1;
    }
    let result: RemoteAgentPollResult | null = null;
    if (!failure) {
      try {
        result = parseRemoteAgentPollResult(raw);
      } catch {
        failure = Object.assign(new Error('[REMOTE_AGENT_INVALID] The other computer sent an invalid event stream.'), {
          code: 'REMOTE_AGENT_INVALID',
        });
      }
    }
    if (result) {
      if (this.retryTimer && this.attempt > 0) {
        // 另一个在途的 poll 成功了：链路已恢复，不必等退避。
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.unreachableSince = null;
      this.attempt = 0;
      const delivered = this.apply(wanted, result);
      if (!delivered && this.now() - startedAt < EMPTY_FAST_MS) this.emptyFastStreak += 1;
      else this.emptyFastStreak = 0;
      if (this.emptyFastStreak >= EMPTY_FAST_STREAK) {
        this.emptyFastStreak = 0;
        this.retryLater(EMPTY_FAST_DELAY_MS);
        return;
      }
      this.ensureAfterReturn();
      return;
    }
    this.handleFailure(wanted, failure);
  }

  private ensureAfterReturn(): void {
    // 这个 poll 回来了：没有其它在途的就再发一个；有任务没被覆盖时也发。
    if (this.inflight === 0) this.needFresh = true;
    this.ensure();
  }

  /** 处理一次 poll 的结果；返回是否交付了任何新数据或状态变化。 */
  private apply(wanted: ReadonlyArray<{ runId: string; cursor: number }>, result: RemoteAgentPollResult): boolean {
    const requested = new Map(wanted.map((item) => [item.runId, item.cursor]));
    let delivered = false;
    for (const item of result.runs) {
      const entry = this.entries.get(item.runId);
      const requestedCursor = requested.get(item.runId);
      if (!entry || requestedCursor === undefined) continue;
      if (item.missing) {
        delivered = true;
        this.lose(entry, 'missing', {
          code: 'REMOTE_AGENT_EXPIRED',
          message: '[REMOTE_AGENT_EXPIRED] The task is no longer running on the other computer.',
        });
        continue;
      }
      const from = item.from ?? requestedCursor;
      const data = item.data ? Buffer.from(item.data, 'base64') : Buffer.alloc(0);
      if (from < requestedCursor || from + data.length !== item.cursor || from > entry.cursor) {
        // 数据与游标对不上，或在本机游标之后留了空洞：流已不可信。
        delivered = true;
        this.lose(entry, 'invalid-stream', {
          code: 'REMOTE_AGENT_INVALID',
          message: 'The other computer sent an invalid event stream.',
        });
        continue;
      }
      // 另一个 poll 已经交付过这一段。
      if (item.cursor < entry.cursor || (item.cursor === entry.cursor && !item.done)) continue;
      delivered = true;
      const fresh = data.subarray(entry.cursor - from);
      entry.cursor = item.cursor;
      if (item.done) this.entries.delete(item.runId);
      try {
        entry.run.onData(fresh, item.done === true);
      } catch (error) {
        this.log?.warn('remote agent: event handler failed', { runId: item.runId, error: String(error) });
      }
    }
    return delivered;
  }

  private handleFailure(wanted: ReadonlyArray<{ runId: string; cursor: number }>, error: unknown): void {
    if (!isRetryableLinkError(error)) {
      // 对方拒绝整个 poll(远程控制已关、版本不支持等)：涉及的任务都无法继续。
      const info = remoteAgentErrorFrom(error);
      for (const { runId } of wanted) {
        const entry = this.entries.get(runId);
        if (entry) this.lose(entry, 'read-failed', info);
      }
      this.ensureAfterReturn();
      return;
    }
    this.unreachableSince ??= this.now();
    if (this.now() - this.unreachableSince > REMOTE_AGENT_READ_GIVE_UP_MS) {
      this.unreachableSince = null;
      this.attempt = 0;
      for (const entry of [...this.entries.values()]) {
        this.lose(entry, 'unreachable', {
          code: 'REMOTE_AGENT_UNAVAILABLE',
          message: '[REMOTE_AGENT_UNAVAILABLE] The computer running this agent is unreachable.',
        });
      }
      return;
    }
    this.attempt += 1;
    this.retryLater(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(this.attempt, 4)));
  }

  private retryLater(delayMs: number): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.needFresh = true;
      this.ensure();
    }, delayMs);
  }

  private lose(entry: Entry, reason: string, error: RemoteAgentErrorInfo): void {
    if (this.entries.get(entry.run.runId) !== entry) return;
    this.entries.delete(entry.run.runId);
    try {
      entry.run.onLost(reason, error);
    } catch (handlerError) {
      this.log?.warn('remote agent: close handler failed', { runId: entry.run.runId, error: String(handlerError) });
    }
  }
}
