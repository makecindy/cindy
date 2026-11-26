import { byteLength, DeviceLinkError, type PushOwnerStamp } from '@cindy/device-link';
import {
  projectScheduleEvent,
  type NormalizedSchedulerEvent,
  type ScheduleEventProjection,
} from '@cindy/maker-shared/schedule-events';

/**
 * 拥塞期的调度事件推送整流（per-peer 有界因果队列 + 超限权威状态补读 + 无进展停滞退避）。
 *
 * 背景：对端链路正常时（可靠发送队列 < SESSION_ACTIVITY_WINDOW_SOFT_CAP），刷新类
 * `maker:schedule:event` 保持 0ms 逐帧即时发送；一旦对端慢或停 ACK 越过软上限，
 * 心跳与高频自动化若继续逐帧灌入 64 帧可靠窗口，会挤占 `invoke-result` 并触发
 * `reliable transport buffer is full`（现场 38/64 帧为 `maker:schedule:event`）。
 *
 * 不变量：
 * 1. 严格因果顺序（未超限时）：新事件一律追加到队尾，绝不把旧事件挪到 `read` / `all-read` /
 *    `ready` / `unknown` 等屏障之后（如 `completed(A) -> read -> fired(B)` 按原因果顺序输出）。
 * 2. 接收端投影等价折叠（未超限时）：在同一 `scheduleId` 最后屏障之后的连续运行段内，仅当删除
 *    更早的未发运行事件不改变 `sessionIndex` 刷新、`unreadImpact === 'may-increase'` 以及任何
 *    非空绑定 `sessionId` 时，才淘汰该冗余中间事件。
 * 3. 硬上限条数与字节（64 条 / 16 KiB）+ 权威状态补读（绝不静默删终态）：一旦不可写对端持续产生
 *    不可等价合并的事件（如每轮新 `sessionId` 的 `completed + changed` 或 >64 个不同 `scheduleId`），
 *    立即切换为 `O(1)` 权威补读汇总：队头置 `{ type: 'resync' }`（新旧 Desktop / Mobile 端均按共享
 *    `projectScheduleEvent` 投影为 `runRefresh: all` + `scheduleList` + `sessionIndex` + `unreadSummary`
 *    全量重拉，并清空局部会话归属缓存以恢复全部未读、运行态与会话归属），同时按因果序保留至多 3 个紧凑槽位
 *    （最近已读清除、最近带 `sessionId` 事件以触发旧手机首页会话列表 reseed、以及最新末尾事件），不再逐条扫描数组。
 * 4. 无进展不永久空转：持续不可写时退避探测并在无进展达到上限后挂起定时器（0 次后台唤醒），由对端 ACK 排空窗口、
 *    重连、建链或重新可写时的 `nudge()` / `enqueue()` 唤醒。
 */

export const SCHEDULE_EVENT_STAGE_DELAY_MS = 125;
export const SCHEDULE_EVENT_STAGE_MAX_EVENTS = 64;
export const SCHEDULE_EVENT_STAGE_MAX_BYTES = 16 * 1024;

const SCHEDULE_EVENT_DRAIN_BATCH = 8;
const OVERFLOW_SLOT_MAX_BYTES = 1024;
const STALL_FAST_RETRY_MS = 250;
const STALL_FAST_PROBES = 9;
const STALL_MAX_PROBES = 14;
const STALL_UNNOTIFIED_POLL_MS = 5_000;
const RETRY_CODES = new Set(['BACKPRESSURE', 'NOT_CONNECTED', 'LINK_NOT_OPEN']);
const RESYNC_PAYLOAD = Object.freeze({ type: 'resync' as const });

type RunLifecycleEvent = Extract<
  NormalizedSchedulerEvent,
  { type: 'fired' | 'deferred' | 'session-bound' | 'completed' | 'failed' | 'skipped' }
>;

interface StagedScheduleEvent {
  payload: unknown;
  proj: ScheduleEventProjection;
  bytes: number;
}

interface OrderedOverflowSlot {
  item: StagedScheduleEvent;
  order: number;
}

function measurePayloadBytes(payload: unknown): number {
  try {
    const json = JSON.stringify(payload);
    return typeof json === 'string' ? byteLength(json) : 64;
  } catch {
    return 64;
  }
}

function makeStagedEvent(payload: unknown): StagedScheduleEvent {
  return {
    payload,
    proj: projectScheduleEvent(payload),
    bytes: measurePayloadBytes(payload),
  };
}

const RESYNC_STAGED_EVENT: StagedScheduleEvent = makeStagedEvent(RESYNC_PAYLOAD);

function compactSlotEvent(item: StagedScheduleEvent): StagedScheduleEvent {
  if (item.bytes <= OVERFLOW_SLOT_MAX_BYTES) return item;
  const ev = item.proj.event;
  if (ev.type === 'failed') {
    const compactPayload = ev.sessionId
      ? {
          type: 'failed' as const,
          scheduleId: ev.scheduleId,
          runId: ev.runId,
          error: ev.error.slice(0, 256),
          sessionId: ev.sessionId,
        }
      : {
          type: 'failed' as const,
          scheduleId: ev.scheduleId,
          runId: ev.runId,
          error: ev.error.slice(0, 256),
        };
    return makeStagedEvent(compactPayload);
  }
  if (ev.type === 'unknown') return RESYNC_STAGED_EVENT;
  // Strip any unexpected extra top-level fields on oversized known events.
  return makeStagedEvent(ev);
}

function isRunLifecycleEvent(event: NormalizedSchedulerEvent): event is RunLifecycleEvent {
  return (
    event.type === 'fired'
    || event.type === 'deferred'
    || event.type === 'session-bound'
    || event.type === 'completed'
    || event.type === 'failed'
    || event.type === 'skipped'
  );
}

function isBarrierForSchedule(event: NormalizedSchedulerEvent, scheduleId: string): boolean {
  if (event.type === 'all-read' || event.type === 'ready' || event.type === 'unknown') return true;
  if (event.type === 'read' && event.scheduleId === scheduleId) return true;
  return false;
}

export class ScheduleEventPushStage {
  private readonly queue: StagedScheduleEvent[] = [];
  private queuedBytes = 0;
  private inFlightItem: StagedScheduleEvent | null = null;
  private overflowed = false;
  private overflowOrder = 0;
  private overflowClear: OrderedOverflowSlot | null = null;
  private overflowSession: OrderedOverflowSlot | null = null;
  private overflowTail: OrderedOverflowSlot | null = null;
  private consecutiveStalls = 0;
  private parkedOnStall = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDelayMs: number | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private nudgedWhileDraining = false;
  private draining = false;
  private disposed = false;

  constructor(
    readonly ownerStamp: PushOwnerStamp | undefined,
    private readonly writable: () => boolean,
    private readonly send: (payload: unknown, isCurrent: () => boolean) => Promise<void>,
    private readonly failed: (error: unknown) => void,
    private readonly canParkOnStall: () => boolean = () => true,
  ) {}

  get size(): number {
    return this.queue.length;
  }

  get byteSize(): number {
    return this.queuedBytes;
  }

  get hasActiveTimer(): boolean {
    return this.timer !== null || this.nudgeTimer !== null;
  }

  enqueue(payload: unknown): void {
    if (this.disposed) return;
    let next = makeStagedEvent(payload);
    if (this.overflowed) {
      this.foldIntoOverflow(next);
      this.rebuildOverflowQueue();
    } else {
      next = this.compactBeforeAppend(next);
      if (
        this.queue.length + 1 > SCHEDULE_EVENT_STAGE_MAX_EVENTS
        || this.queuedBytes + next.bytes > SCHEDULE_EVENT_STAGE_MAX_BYTES
      ) {
        this.enterOverflow(next);
      } else {
        this.queue.push(next);
        this.queuedBytes += next.bytes;
      }
    }
    if (this.writable()) {
      this.parkedOnStall = false;
      this.consecutiveStalls = 0;
      if (this.draining) {
        this.nudgedWhileDraining = true;
        return;
      }
      this.scheduleAtMost(SCHEDULE_EVENT_STAGE_DELAY_MS);
      return;
    }
    if (this.parkedOnStall) {
      if (this.canParkOnStall()) return;
      this.parkedOnStall = false;
    }
    this.schedule(this.nextDelayMs());
  }

  /** 对端窗口排空或链路重连后由外层主动唤醒，只提前、绝不延后已排期的 drain。 */
  nudge(): void {
    if (this.disposed || this.queue.length === 0) return;
    if (!this.writable()) return;
    this.parkedOnStall = false;
    this.consecutiveStalls = 0;
    if (this.draining) {
      this.nudgedWhileDraining = true;
      return;
    }
    this.scheduleAtMost(SCHEDULE_EVENT_STAGE_DELAY_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.nudgedWhileDraining = false;
    this.inFlightItem = null;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.resetOverflowState();
  }

  private resetOverflowState(): void {
    this.overflowed = false;
    this.overflowOrder = 0;
    this.overflowClear = null;
    this.overflowSession = null;
    this.overflowTail = null;
  }

  private enterOverflow(next: StagedScheduleEvent): void {
    const start = this.inFlightItem !== null && this.queue[0] === this.inFlightItem ? 1 : 0;
    this.overflowed = true;
    this.overflowOrder = 0;
    this.overflowClear = null;
    this.overflowSession = null;
    this.overflowTail = null;
    for (let i = start; i < this.queue.length; i++) {
      this.foldIntoOverflow(this.queue[i]!);
    }
    this.foldIntoOverflow(next);
    this.rebuildOverflowQueue();
  }

  private foldIntoOverflow(item: StagedScheduleEvent): void {
    const compact = compactSlotEvent(item);
    const ev = compact.proj.event;
    if (ev.type === 'ready') {
      // Host restart / account switch resets previous run bindings before subsequent events.
      this.overflowSession = null;
      this.overflowTail = null;
      return;
    }
    const order = ++this.overflowOrder;
    if (ev.type === 'all-read') {
      this.overflowClear = { item: compact, order };
    } else if (ev.type === 'read') {
      if (this.overflowClear?.item.proj.event.type !== 'all-read') {
        this.overflowClear = { item: compact, order };
      }
    }
    if (compact.proj.runPatch.sessionId !== null) {
      this.overflowSession = { item: compact, order };
    }
    if (ev.type !== 'unknown') {
      this.overflowTail = { item: compact, order };
    }
  }

  private rebuildOverflowQueue(): void {
    const keepHead = this.inFlightItem !== null && this.queue[0] === this.inFlightItem
      ? this.inFlightItem
      : null;
    this.queue.length = 0;
    this.queuedBytes = 0;
    if (keepHead) {
      this.queue.push(keepHead);
      this.queuedBytes += keepHead.bytes;
    }
    this.queue.push(RESYNC_STAGED_EVENT);
    this.queuedBytes += RESYNC_STAGED_EVENT.bytes;

    const slots = [this.overflowClear, this.overflowSession, this.overflowTail]
      .filter((slot): slot is OrderedOverflowSlot => slot !== null)
      .sort((a, b) => a.order - b.order);
    const seen = new Set<StagedScheduleEvent>([RESYNC_STAGED_EVENT]);
    for (const slot of slots) {
      if (seen.has(slot.item)) continue;
      if (
        this.queue.length + 1 > SCHEDULE_EVENT_STAGE_MAX_EVENTS
        || this.queuedBytes + slot.item.bytes > SCHEDULE_EVENT_STAGE_MAX_BYTES
      ) {
        break;
      }
      seen.add(slot.item);
      this.queue.push(slot.item);
      this.queuedBytes += slot.item.bytes;
    }
  }

  private compactBeforeAppend(next: StagedScheduleEvent): StagedScheduleEvent {
    const start = this.inFlightItem !== null && this.queue[0] === this.inFlightItem ? 1 : 0;
    if (start >= this.queue.length) return next;
    const ev = next.proj.event;

    if (ev.type === 'ready') {
      this.removeWhere(start, (item) => item.proj.event.type === 'ready');
      return next;
    }
    if (ev.type === 'all-read') {
      this.removeWhere(
        start,
        (item) => item.proj.event.type === 'all-read' || item.proj.event.type === 'read',
      );
      return next;
    }
    if (ev.type === 'changed') {
      const hadUnconditionalChange = Boolean(ev.skippedRunId) && this.queue
        .slice(start)
        .some((item) => (
          item.proj.event.type === 'changed'
          && item.proj.event.scheduleId === ev.scheduleId
          && !item.proj.event.skippedRunId
        ));
      this.removeWhere(
        start,
        (item) => item.proj.event.type === 'changed' && item.proj.event.scheduleId === ev.scheduleId,
      );
      return hadUnconditionalChange
        ? makeStagedEvent({ type: 'changed', scheduleId: ev.scheduleId })
        : next;
    }
    if (ev.type === 'read') {
      this.removeWhere(
        start,
        (item) => item.proj.event.type === 'read' && item.proj.event.scheduleId === ev.scheduleId,
      );
      return next;
    }
    if (!isRunLifecycleEvent(ev)) return next;

    let barrierIdx = start - 1;
    for (let i = this.queue.length - 1; i >= start; i--) {
      if (isBarrierForSchedule(this.queue[i]!.proj.event, ev.scheduleId)) {
        barrierIdx = i;
        break;
      }
    }

    const segIndices: number[] = [];
    for (let i = barrierIdx + 1; i < this.queue.length; i++) {
      const candidateEv = this.queue[i]!.proj.event;
      if (isRunLifecycleEvent(candidateEv) && candidateEv.scheduleId === ev.scheduleId) {
        segIndices.push(i);
      }
    }
    if (segIndices.length === 0) return next;

    const hasSkippedTimingPatch = (x: StagedScheduleEvent): boolean =>
      x.proj.event.type === 'skipped'
      && (x.proj.event.lastFiredAt !== undefined
        || x.proj.event.lastFinishedAt !== undefined
        || x.proj.event.nextFireAt !== undefined);
    const hasPreRunRecovery = (x: StagedScheduleEvent): boolean =>
      (x.proj.event.type === 'skipped' && x.proj.event.preRunCheckSucceeded === true)
      || (x.proj.refresh.sessionIndex && x.proj.refresh.unreadSummary);

    let kept: StagedScheduleEvent[] = [...segIndices.map((i) => this.queue[i]!), next];
    const origHasSessionIndex = kept.some((x) => x.proj.refresh.sessionIndex);
    const origHasUnreadIncrease = kept.some((x) => x.proj.unreadImpact === 'may-increase');
    const origHasPreRunRecovery = kept.some(hasPreRunRecovery);
    const toRemove = new Set<number>();

    for (const idx of segIndices) {
      const candidate = this.queue[idx]!;
      const pos = kept.indexOf(candidate);
      const after = pos >= 0 ? kept.slice(pos + 1) : [];
      const without = kept.filter((x) => x !== candidate);
      const keepsSessionIndex = without.some((x) => x.proj.refresh.sessionIndex) === origHasSessionIndex;
      const keepsUnreadIncrease =
        without.some((x) => x.proj.unreadImpact === 'may-increase') === origHasUnreadIncrease;
      const keepsPreRunRecovery = without.some(hasPreRunRecovery) === origHasPreRunRecovery;
      const sid = candidate.proj.runPatch.sessionId;
      const keepsSessionBinding =
        sid === null || without.some((x) => x.proj.runPatch.sessionId === sid);
      const keepsSkippedTiming =
        !hasSkippedTimingPatch(candidate)
        || after.some((x) => x.proj.refresh.sessionIndex || hasSkippedTimingPatch(x));
      if (
        keepsSessionIndex
        && keepsUnreadIncrease
        && keepsPreRunRecovery
        && keepsSessionBinding
        && keepsSkippedTiming
      ) {
        kept = without;
        toRemove.add(idx);
      }
    }

    if (toRemove.size > 0) {
      let write = start;
      for (let read = start; read < this.queue.length; read++) {
        const item = this.queue[read]!;
        if (toRemove.has(read)) {
          this.queuedBytes -= item.bytes;
        } else {
          this.queue[write++] = item;
        }
      }
      this.queue.length = write;
    }
    return next;
  }

  private removeWhere(start: number, predicate: (item: StagedScheduleEvent) => boolean): void {
    let write = start;
    for (let read = start; read < this.queue.length; read++) {
      const item = this.queue[read]!;
      if (predicate(item)) {
        this.queuedBytes -= item.bytes;
      } else {
        this.queue[write++] = item;
      }
    }
    this.queue.length = write;
  }

  private nextDelayMs(): number {
    if (this.consecutiveStalls === 0) return SCHEDULE_EVENT_STAGE_DELAY_MS;
    if (this.consecutiveStalls <= STALL_FAST_PROBES) return STALL_FAST_RETRY_MS;
    if (this.consecutiveStalls >= STALL_MAX_PROBES) return STALL_UNNOTIFIED_POLL_MS;
    const exp = this.consecutiveStalls - STALL_FAST_PROBES;
    return Math.min(4_000, STALL_FAST_RETRY_MS * 2 ** exp);
  }

  private clearTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.timerDelayMs = null;
  }

  private schedule(delayMs: number): void {
    if (this.disposed || this.timer || this.draining || this.queue.length === 0 || this.parkedOnStall) return;
    this.timerDelayMs = delayMs;
    this.timer = setTimeout(() => {
      this.clearTimers();
      void this.drain();
    }, delayMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private scheduleAtMost(delayMs: number): void {
    if (this.disposed || this.draining || this.queue.length === 0 || this.parkedOnStall) return;
    if (!this.timer) {
      this.schedule(delayMs);
      return;
    }
    if (this.timerDelayMs !== null && this.timerDelayMs > delayMs && !this.nudgeTimer) {
      this.nudgeTimer = setTimeout(() => {
        this.clearTimers();
        void this.drain();
      }, delayMs);
      (this.nudgeTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.draining) return;
    this.draining = true;
    let sentCount = 0;
    try {
      for (let count = 0; count < SCHEDULE_EVENT_DRAIN_BATCH && this.queue.length > 0; count++) {
        if (this.disposed || !this.writable()) break;
        const item = this.queue[0]!;
        this.inFlightItem = item;
        const isCurrent = () => !this.disposed && this.inFlightItem === item && this.queue[0] === item;
        try {
          await this.send(item.payload, isCurrent);
        } catch (error) {
          this.inFlightItem = null;
          if (error instanceof DeviceLinkError && RETRY_CODES.has(error.code)) break;
          this.failed(error);
        }
        if (!this.disposed && this.queue[0] === item) {
          this.queue.shift();
          this.queuedBytes = Math.max(0, this.queuedBytes - item.bytes);
          sentCount += 1;
        }
        this.inFlightItem = null;
      }
      if (this.queue.length === 0) {
        this.queuedBytes = 0;
        this.resetOverflowState();
      }
    } finally {
      const wasNudged = this.nudgedWhileDraining;
      this.nudgedWhileDraining = false;
      this.inFlightItem = null;
      this.draining = false;
      if (this.disposed || this.queue.length === 0) {
        this.consecutiveStalls = 0;
        this.parkedOnStall = false;
      } else if (sentCount > 0 || (wasNudged && this.writable())) {
        this.consecutiveStalls = 0;
        this.parkedOnStall = false;
        this.schedule(SCHEDULE_EVENT_STAGE_DELAY_MS);
      } else {
        this.consecutiveStalls += 1;
        if (this.consecutiveStalls >= STALL_MAX_PROBES && this.canParkOnStall()) {
          this.parkedOnStall = true;
        } else {
          this.schedule(this.nextDelayMs());
        }
      }
    }
  }
}
