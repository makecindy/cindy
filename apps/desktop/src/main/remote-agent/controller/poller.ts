/**
 * 远程 Agent 事件拉取(控制端，每台运行 Agent 的电脑一个)。
 *
 * 同一台电脑上的全部任务共用一个拉取器：每个 `poll` 最多携带 64 个任务的游标，按整批轮转，
 * 对方没有新数据时挂起最多 READ_WAIT_MS。新任务登记时可另发一个 poll，长等待同时在途最多两个；
 * 两个都被旧任务的长等待占着时，再留一个名额给没有在途 poll 覆盖的任务(排在最前)，
 * 否则新任务要等旧长等待超时(恰好等于 Codex 执行环境握手的 10 秒上限)才有人拉。
 * 几个 poll 返回的数据可能重叠，按 from 去重，游标只前进不后退。
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
/** 有任务没有被在途 poll 覆盖时，多留一个补位名额，直到普通 poll 接手。 */
const FRESH_RUN_EXTRA_POLLS = 1;
/** 补位不要变成长等待，否则第四个新任务仍会被三个旧 poll 挡住。 */
const FRESH_RUN_WAIT_MS = 1_000;
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
  /** 本机还有这个任务的工作在进行、对方看不到(拉取时报 hold，对方不按闲置收回)。 */
  holdsRemote?(): boolean;
  /** Revalidate a direct-share grant through its owner, only during an existing outage. */
  recoverAuthorization?(): Promise<void>;
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
  private readonly recoveringAuthorization = new WeakSet<PolledRun>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private rotation = 0;
  private emptyFastStreak = 0;
  /** 在途的 poll 各自覆盖哪些任务(判断有没有任务没人在拉)。 */
  private readonly inflightCoverage = new Set<ReadonlySet<string>>();

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
    if (this.entries.size === 0) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.unreachableSince = null;
      this.attempt = 0;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private ensure(): void {
    if (this.entries.size === 0 || this.retryTimer) return;
    if (this.inflight > 0 && !this.needFresh) return;
    const limit = this.hasUncoveredRun() ? MAX_INFLIGHT_POLLS + FRESH_RUN_EXTRA_POLLS : MAX_INFLIGHT_POLLS;
    if (this.inflight >= limit) return;
    this.needFresh = false;
    void this.pollOnce();
  }

  private snapshot(): Array<{ runId: string; cursor: number; hold?: true }> {
    const all = [...this.entries.values()].map((entry) => {
      let hold = false;
      try {
        hold = entry.run.holdsRemote?.() === true;
      } catch {
        // 判断失败时照常拉取，不报 hold。
      }
      return { runId: entry.run.runId, cursor: entry.cursor, ...(hold ? { hold: true as const } : {}) };
    });
    let wanted = all;
    if (all.length > REMOTE_AGENT_MAX_POLL_RUNS) {
      // 按整批推进，避免大量空闲任务在下次被拉取前超过 host 的存活期限；没有在途覆盖的任务排在最前。
      const start = this.rotation % all.length;
      const ordered = [...all.slice(start), ...all.slice(0, start)];
      const uncovered = new Set(all.filter((item) => !this.isCovered(item.runId)).map((item) => item.runId));
      const fresh = ordered.filter((item) => uncovered.has(item.runId)).slice(0, REMOTE_AGENT_MAX_POLL_RUNS);
      const rotated = ordered
        .filter((item) => !uncovered.has(item.runId))
        .slice(0, REMOTE_AGENT_MAX_POLL_RUNS - fresh.length);
      this.rotation = (start + fresh.length + rotated.length) % all.length;
      this.needFresh = true;
      wanted = [...fresh, ...rotated];
    }
    return wanted;
  }

  private async pollOnce(): Promise<void> {
    const wanted = this.snapshot();
    const startedAt = this.now();
    const coverage: ReadonlySet<string> = new Set(wanted.map((item) => item.runId));
    const waitMs = this.inflight >= MAX_INFLIGHT_POLLS ? FRESH_RUN_WAIT_MS : REMOTE_AGENT_READ_WAIT_MS;
    this.inflight += 1;
    this.inflightCoverage.add(coverage);
    let raw: unknown;
    let failure: unknown = null;
    try {
      raw = await this.invoke([{ op: 'poll', runs: wanted, waitMs }]);
    } catch (error) {
      failure = error;
    } finally {
      this.inflight -= 1;
      this.inflightCoverage.delete(coverage);
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
    // 这个 poll 回来了：没有其它在途的就再发一个；有任务没被仍在途的 poll 覆盖时也发——否则新登记的
    // 任务在覆盖它的那个 poll 带回第一段数据后，要等旧的长等待超时(最长 READ_WAIT_MS)才有人再拉它。
    if (this.inflight === 0 || this.hasUncoveredRun()) this.needFresh = true;
    this.ensure();
  }

  private hasUncoveredRun(): boolean {
    for (const runId of this.entries.keys()) {
      if (!this.isCovered(runId)) return true;
    }
    return false;
  }

  private isCovered(runId: string): boolean {
    for (const coverage of this.inflightCoverage) {
      if (coverage.has(runId)) return true;
    }
    return false;
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
    if (!wanted.some(({ runId }) => this.entries.has(runId))) {
      this.ensureAfterReturn();
      return;
    }
    // A restarting share can briefly look revoked while its route is being restored.
    // Only an established outage gets this grace; never bypass the owner or reset its deadline.
    // remoteAgentInvoker may prefix a rejection with UNAVAILABLE while preserving
    // the authoritative transport code on the Error, so check both.
    const shareRefusal = (code: unknown) => code === 'ACCESS_REVOKED' || code === 'REMOTE_AGENT_SHARE_UNAVAILABLE';
    const shareRefused = shareRefusal(remoteAgentErrorFrom(error).code) || shareRefusal((error as { code?: unknown })?.code);
    if (shareRefused ? this.unreachableSince === null : !isRetryableLinkError(error)) {
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
    if (shareRefused) {
      for (const { runId } of wanted) {
        const run = this.entries.get(runId)?.run;
        if (!run?.recoverAuthorization || this.recoveringAuthorization.has(run)) continue;
        this.recoveringAuthorization.add(run);
        // Do not await authorization: the poll deadline and per-task lease expiry
        // must still fire if O or M never answers. A grant alone is not poll success.
        void Promise.resolve().then(() => {
          if (this.entries.get(runId)?.run === run) return run.recoverAuthorization!();
        }).catch(() => undefined).finally(() => this.recoveringAuthorization.delete(run));
      }
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
