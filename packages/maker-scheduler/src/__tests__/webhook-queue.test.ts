import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SCHEDULE_WEBHOOK_LIMITS as LIMITS,
  ScheduleWebhookQueue,
  scheduleWebhookEventMatches,
  type ScheduleWebhookQueueDeps,
  type ScheduleWebhookQueueState,
} from '../webhook-queue.js';
import type { Schedule, ScheduleWebhookEvent } from '../types.js';

// 测试价值
// - 生产入口与可观察结果：ScheduleWebhookQueue 公开方法；断言任务何时运行、拿到哪些事件、落盘内容。
// - 规则依据：docs/product-rules/schedule-webhook-trigger.md 的门铃、合并和重启语义。
// - 现有覆盖缺口：新模块。
// - 最小失败输入：一批连续事件、任务忙时顺延、落盘失败、重启。
// - tier：unit，假时钟与内存存储。

const event = (deliveryId: string, name = 'check_suite'): ScheduleWebhookEvent => ({ deliveryId, event: name, receivedAt: Date.now() });

function setup(initial?: ScheduleWebhookQueueState) {
  let saved: ScheduleWebhookQueueState = initial ?? { endpoints: {} };
  let schedule: Schedule | null = { id: 's1', status: 'active', webhookTrigger: { endpointId: 'e1' } } as Schedule;
  const fire = vi.fn<ScheduleWebhookQueueDeps['fire']>(async (_id, _batch, onRunCreated) => {
    await onRunCreated();
    return {};
  });
  const save = vi.fn<ScheduleWebhookQueueDeps['save']>(async (state) => { saved = state; });
  const isBusy = vi.fn(() => false);
  const queue = new ScheduleWebhookQueue({
    load: async () => structuredClone(saved),
    save,
    getSchedule: async () => schedule,
    isBusy,
    fire,
    now: () => Date.now(),
  });
  return {
    queue, fire, save, isBusy,
    saved: () => saved,
    setSchedule: (next: Schedule | null) => { schedule = next; },
  };
}

describe('ScheduleWebhookQueue', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('admits selected GitHub App events once without authorizing unscoped omissions', async () => {
    const h = setup();
    const schedule = { id: 's1', status: 'active', webhookTrigger: { endpointId: 'e1', events: ['issue_comment.created'],
      source: { preset: 'github-app', repositories: ['example/project'] } } } as Schedule;
    h.setSchedule(schedule);
    await h.queue.start();
    const comment = { ...event('comment', 'issue_comment'), action: 'created', repository: 'example/project' };
    expect(await h.queue.acceptBatch('s1', [comment, { ...comment, deliveryId: 'wrong-repo', repository: 'private/other' },
      { ...comment, deliveryId: 'wrong-action', action: 'edited' }], 0, 'e1')).toEqual(['queued', 'filtered', 'filtered']);
    expect(await h.queue.accept('s1', comment)).toBe('duplicate');
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    expect(h.fire).toHaveBeenCalledTimes(1);
    expect(h.fire.mock.calls[0]![1].events).toEqual([comment]);
    const recovery = event('overflow', 'github.reconcile');
    expect(await h.queue.acceptBatch('s1', [recovery], 5, 'e1')).toEqual(['filtered']);
    await vi.advanceTimersByTimeAsync(LIMITS.minGapMs);
    expect(h.fire).toHaveBeenCalledTimes(1);
    h.setSchedule({ ...schedule, status: 'paused' });
    expect(await h.queue.acceptBatch('s1', [{ ...comment, deliveryId: 'paused' }], 1, 'e1')).toEqual(['ignored']);
    h.setSchedule({ ...schedule, webhookTrigger: { ...schedule.webhookTrigger!, endpointId: 'new-scope' } });
    expect(await h.queue.acceptBatch('s1', [comment], 0, 'e1')).toEqual(['ignored']);
    await vi.advanceTimersByTimeAsync(LIMITS.minGapMs);
    expect(h.fire).toHaveBeenCalledTimes(1);
    h.queue.stop();
  });

  // PR #9378 / security review: old on-disk recovery markers carry no scope.
  // Exercise restart through the real queue, including interrupted preparation.
  it.each(['pending', 'preparing'] as const)('filters legacy unscoped recovery markers from restored %s', async where => {
    const marker = event('legacy', 'github.reconcile');
    const initial: ScheduleWebhookQueueState = { endpoints: { s1: {
      endpointId: 'e1', pending: where === 'pending' ? [marker] : [],
      ...(where === 'preparing' ? { preparing: { events: [marker], omitted: 4 } } : {}),
      omitted: where === 'pending' ? 4 : 0, received: 1, ignored: 0, receipts: {},
    } } };
    const h = setup(initial);
    h.setSchedule({ id: 's1', status: 'active', webhookTrigger: { endpointId: 'e1', events: ['release.published'],
      source: { preset: 'github-app', repositories: ['example/project'] } } } as Schedule);
    await h.queue.start();
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    expect(h.fire).not.toHaveBeenCalled();
    expect(h.saved().endpoints.s1?.pending).toEqual([]);
    h.queue.stop();
  });

  it('collapses a burst into one run, and later events wait for the minimum gap', async () => {
    const h = setup();
    await h.queue.start();
    await h.queue.accept('s1', event('a'));
    await h.queue.accept('s1', event('b'));
    expect(h.fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    expect(h.fire).toHaveBeenCalledTimes(1);
    expect(h.fire.mock.calls[0]![1].events.map((e) => e.deliveryId)).toEqual(['a', 'b']);

    await h.queue.accept('s1', event('c'));
    await vi.advanceTimersByTimeAsync(LIMITS.minGapMs - 1);
    expect(h.fire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fire).toHaveBeenCalledTimes(2);
  });

  it('merges events arriving during a run into exactly one following run', async () => {
    const h = setup();
    let finish!: () => void;
    h.fire.mockImplementationOnce(async (_id, _batch, onRunCreated) => {
      await onRunCreated();
      return new Promise((resolve) => { finish = () => resolve({}); });
    });
    await h.queue.start();
    await h.queue.accept('s1', event('a'));
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    await h.queue.accept('s1', event('b'));
    await h.queue.accept('s1', event('c'));
    await vi.advanceTimersByTimeAsync(LIMITS.minGapMs * 2);
    expect(h.fire).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(LIMITS.minGapMs);
    expect(h.fire).toHaveBeenCalledTimes(2);
    expect(h.fire.mock.calls[1]![1].events.map((e) => e.deliveryId)).toEqual(['b', 'c']);
  });

  it('keeps a deferred batch ahead of newer events and retries it', async () => {
    const h = setup();
    // The deferral resolves only after 'b' arrived, which replaces the endpoint record.
    let defer!: () => void;
    h.fire.mockImplementationOnce(() => new Promise((resolve) => { defer = () => resolve({ deferred: true }); }));
    await h.queue.start();
    await h.queue.accept('s1', event('a'));
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    await h.queue.accept('s1', event('b'));
    defer();
    await vi.advanceTimersByTimeAsync(LIMITS.retryMs);
    expect(h.fire).toHaveBeenCalledTimes(2);
    expect(h.fire.mock.calls[1]![1].events.map((e) => e.deliveryId)).toEqual(['a', 'b']);
  });

  it('does not start a second run while a scheduled run is in flight', async () => {
    const h = setup();
    h.isBusy.mockReturnValueOnce(true);
    await h.queue.start();
    await h.queue.accept('s1', event('a'));
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    expect(h.fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LIMITS.retryMs);
    expect(h.fire).toHaveBeenCalledTimes(1);
  });

  it('treats a redelivery as a duplicate, and evicts rather than rejects when receipts are full', async () => {
    const oldest = `old-${LIMITS.receiptsPerSchedule - 1}`;
    const receipts = Object.fromEntries(
      Array.from({ length: LIMITS.receiptsPerSchedule }, (_, i) => [`old-${i}`, Date.now() - i - 1]),
    );
    const pending = Array.from({ length: LIMITS.batchEvents }, (_, i) => event(`old-${i}`));
    const h = setup({ endpoints: { s1: { pending, omitted: 0, received: 0, ignored: 0, receipts } } });
    await h.queue.start();
    expect(await h.queue.accept('s1', event('a'))).toBe('queued');
    expect(await h.queue.accept('s1', event('a'))).toBe('duplicate');
    const saved = h.saved().endpoints.s1!;
    expect(Object.keys(saved.receipts)).toHaveLength(LIMITS.receiptsPerSchedule);
    expect(saved.receipts.a).toBeDefined();
    expect(saved.receipts[oldest]).toBeUndefined();
    expect(saved.pending.length).toBe(LIMITS.batchEvents);
    expect(saved.pending.at(-1)?.deliveryId).toBe('a');
    expect(saved.omitted).toBe(1);
  });

  it('allows a redelivery after a failed save, because the first delivery was not acknowledged', async () => {
    const h = setup();
    await h.queue.start();
    h.save.mockRejectedValueOnce(new Error('disk full'));
    await expect(h.queue.accept('s1', event('a'))).rejects.toThrow('disk full');
    expect(await h.queue.accept('s1', event('a'))).toBe('queued');
  });

  // PR #8470: preparation can hang/throw before insertRun. Existing restart coverage
  // only stopped an already-started run. Unit: restart from the last durable snapshot.
  it('recovers an acknowledged batch when preparation never creates a run', async () => {
    const first = setup();
    first.fire.mockImplementationOnce(() => new Promise(() => {}));
    await first.queue.start();
    await first.queue.accept('s1', event('waiting'));
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    first.queue.stop();
    const second = setup(first.saved());
    await second.queue.start();
    await vi.advanceTimersByTimeAsync(LIMITS.minGapMs);
    expect(second.fire).toHaveBeenCalledTimes(1);
    expect(second.fire.mock.calls[0]![1].events.map(e => e.deliveryId)).toEqual(['waiting']);
    second.queue.stop();
  });

  // PR #8470: a failed pump write must not let a later accept persist an empty
  // batch. Unit: one failed save followed by a new event and a successful retry.
  it('keeps the original batch and timing after a pump save fails', async () => {
    const h = setup();
    await h.queue.start();
    await h.queue.accept('s1', event('a'));
    const firstPendingAt = h.saved().endpoints.s1!.firstPendingAt;
    h.save.mockRejectedValueOnce(new Error('disk full'));
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    expect(h.fire).not.toHaveBeenCalled();
    await h.queue.accept('s1', event('b'));
    expect(h.saved().endpoints.s1!.firstPendingAt).toBe(firstPendingAt);
    await vi.advanceTimersByTimeAsync(LIMITS.retryMs);
    expect(h.fire.mock.calls[0]![1].events.map(e => e.deliveryId)).toEqual(['a', 'b']);
    h.queue.stop();
  });

  // Unit: handoff and deferred restoration are two distinct durability boundaries;
  // failure at either must retain the batch, including an event arriving meanwhile.
  it.each(['handoff', 'deferred restore'] as const)('retries after a failed %s write without losing newer events', async (phase) => {
    const h = setup();
    h.fire.mockImplementationOnce(async (_id, _batch, onRunCreated) => {
      if (phase === 'handoff') h.save.mockRejectedValueOnce(new Error('disk full'));
      await onRunCreated();
      h.save.mockRejectedValueOnce(new Error('disk full'));
      return { deferred: true };
    });
    await h.queue.start();
    await h.queue.accept('s1', event('a'));
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    await h.queue.accept('s1', event('b'));
    await vi.advanceTimersByTimeAsync(LIMITS.retryMs);
    expect(h.fire).toHaveBeenCalledTimes(2);
    expect(h.fire.mock.calls[1]![1].events.map(e => e.deliveryId)).toEqual(['a', 'b']);
    h.queue.stop();
  });

  it('ignores events for a paused or expired schedule, including ones already queued', async () => {
    const h = setup();
    await h.queue.start();
    await h.queue.accept('s1', event('a'));
    h.setSchedule({ id: 's1', status: 'paused', webhookTrigger: { endpointId: 'e1' } } as Schedule);
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    expect(h.fire).not.toHaveBeenCalled();
    expect(await h.queue.accept('s1', event('b'))).toBe('ignored');
    h.setSchedule({ id: 's1', status: 'active', expireAt: Date.now() - 1, webhookTrigger: { endpointId: 'e1' } } as Schedule);
    expect(await h.queue.accept('s1', event('c'))).toBe('ignored');
    expect(h.queue.snapshot('s1').ignored).toBe(3);
  });

  // PR #8470, unit: the existing pause test stops before preparation begins.
  // A delayed remote refresh / run insertion can outlive that first state check.
  it.each(['paused', 'expired', 'disabled', 'deleted', 'replaced'] as const)(
    'rechecks %s state at handoff and never replays the discarded batch', async (state) => {
      const h = setup();
      const dispatch = vi.fn();
      let finishPreparation!: () => void;
      const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
      h.fire.mockImplementationOnce(async (_id, _batch, onRunCreated) => {
        await preparation;
        await onRunCreated();
        dispatch();
        return {};
      });
      await h.queue.start();
      await h.queue.acceptBatch('s1', [event('old')], 2);
      await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
      expect(h.fire).toHaveBeenCalledOnce();
      const active = { id: 's1', status: 'active', webhookTrigger: { endpointId: 'e1' } } as Schedule;
      h.setSchedule(state === 'deleted' ? null : {
        ...active,
        ...(state === 'paused' ? { status: 'paused' } : {}),
        ...(state === 'expired' ? { expireAt: Date.now() } : {}),
        ...(state === 'disabled' ? { webhookTrigger: undefined } : {}),
        ...(state === 'replaced' ? { webhookTrigger: { endpointId: 'e2' } } : {}),
      });
      finishPreparation();
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).not.toHaveBeenCalled();
      expect(h.saved().endpoints.s1).toMatchObject({ pending: [], ignored: 3 });
      expect(h.saved().endpoints.s1?.preparing).toBeUndefined();
      expect(h.saved().endpoints.s1?.lastStartedAt).toBeUndefined();
      h.setSchedule(active);
      await vi.advanceTimersByTimeAsync(LIMITS.minGapMs);
      expect(h.fire).toHaveBeenCalledOnce();
      await h.queue.accept('s1', event('new'));
      await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
      expect(h.fire).toHaveBeenCalledTimes(2);
      expect(h.fire.mock.calls[1][1].events.map(e => e.deliveryId)).toEqual(['new']);
      h.queue.stop();
    },
  );

  // PR #8470, unit: a revoked route must not own a batch after a restart or
  // delayed reconciliation. Existing restart cases keep the same route.
  it.each(['pending', 'preparing'] as const)('discards %s events from a replaced route after restart', async (phase) => {
    const first = setup();
    first.fire.mockImplementationOnce(() => new Promise(() => {}));
    await first.queue.start();
    await first.queue.accept('s1', event('old'));
    if (phase === 'preparing') await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    first.queue.stop();
    const second = setup(first.saved());
    second.setSchedule({ id: 's1', status: 'active', webhookTrigger: { endpointId: 'e2' } } as Schedule);
    await second.queue.start();
    await vi.advanceTimersByTimeAsync(LIMITS.minGapMs);
    expect(second.fire).not.toHaveBeenCalled();
    expect(second.queue.snapshot('s1').ignored).toBe(1);
    await second.queue.accept('s1', event('new'));
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    expect(second.fire.mock.calls[0][1].events.map(e => e.deliveryId)).toEqual(['new']);
    second.queue.stop();
  });

  // The old attempt may reject its handoff or return a no-effects deferral
  // after forget() and a new arrival. Neither may restore its batch over the new queue.
  it.each([
    ['handoff', 'forgotten'], ['deferred', 'forgotten'],
    ['handoff', 'replaced'], ['deferred', 'replaced'],
  ] as const)('does not restore a late %s batch after it was %s', async (phase, change) => {
    const h = setup();
    const dispatch = vi.fn();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    h.fire.mockImplementationOnce(async (_id, _batch, onRunCreated) => {
      if (phase === 'deferred') await onRunCreated();
      await waiting;
      if (phase === 'handoff') {
        await onRunCreated();
        dispatch();
      }
      return { deferred: true };
    });
    await h.queue.start();
    await h.queue.accept('s1', event('old'));
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    if (change === 'forgotten') {
      // Account release/restore can retain the local route id.
      await h.queue.forget('s1');
    } else {
      h.setSchedule({ id: 's1', status: 'active', webhookTrigger: { endpointId: 'e2' } } as Schedule);
    }
    await h.queue.accept('s1', event('new'));
    release();
    await vi.advanceTimersByTimeAsync(LIMITS.minGapMs);
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.fire).toHaveBeenCalledTimes(2);
    expect(h.fire.mock.calls[1][1].events.map(e => e.deliveryId)).toEqual(['new']);
    h.queue.stop();
  });

  it('carries the count of events the server already dropped into the next batch, once', async () => {
    const { queue, fire } = setup();
    await queue.start();
    await queue.acceptBatch('s1', [event('a')], 3);
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0]?.[1].omitted).toBe(3);

    await vi.advanceTimersByTimeAsync(LIMITS.minGapMs);
    await queue.accept('s1', event('b'));
    await vi.advanceTimersByTimeAsync(LIMITS.minGapMs);
    expect(fire.mock.calls[1]?.[1].omitted).toBe(0);
    queue.stop();
  });

  it('resumes queued events after restart, but never replays a batch whose run already started', async () => {
    const first = setup();
    let finish!: () => void;
    first.fire.mockImplementationOnce(async (_id, _batch, onRunCreated) => {
      await onRunCreated();
      return new Promise((resolve) => { finish = () => resolve({}); });
    });
    await first.queue.start();
    await first.queue.accept('s1', event('started'));
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    await first.queue.accept('s1', event('waiting'));
    first.queue.stop();
    finish();

    const second = setup(first.saved());
    await second.queue.start();
    await vi.advanceTimersByTimeAsync(LIMITS.minGapMs);
    expect(second.fire).toHaveBeenCalledTimes(1);
    expect(second.fire.mock.calls[0]![1].events.map((e) => e.deliveryId)).toEqual(['waiting']);
  });

  // PR #8470 / discussion_r4488736908, unit: cached filters and reads performed
  // before queued saves finish miss edits. Admit against the current trigger
  // after earlier writes, and do not move a batch into a replacement route.
  it.each(['filter', 'route'] as const)('rechecks the %s after an earlier save completes', async (change) => {
    const h = setup();
    await h.queue.start();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const persist = h.save.getMockImplementation()!;
    h.save.mockImplementationOnce(async (state) => { entered(); await resume; await persist(state); });
    const first = h.queue.accept('s1', event('first'));
    await waiting;
    const next = h.queue.acceptBatch('s1', [event('later')], 4, 'e1');
    h.setSchedule({ id: 's1', status: 'active', webhookTrigger: change === 'filter'
      ? { endpointId: 'e1', events: ['issues'] } : { endpointId: 'e2' } } as Schedule);
    release();
    await first;
    expect(await next).toEqual([change === 'filter' ? 'filtered' : 'ignored']);
    expect(h.saved().endpoints.s1!.pending.map(e => e.deliveryId)).toEqual(['first']);
    expect(h.saved().endpoints.s1!.omitted).toBe(0);
    h.queue.stop();
  });

  // PR #8470 / discussion_r4488736912, unit: the former count test did not
  // replay a committed server batch after restart. Receipts must cover its count.
  it('keeps a remote batch count exactly once across restart and redelivery', async () => {
    const first = setup();
    await first.queue.start();
    const events = [event('a'), event('b')];
    await first.queue.acceptBatch('s1', events, 3, 'e1');
    expect(first.save).toHaveBeenCalledTimes(1);
    first.queue.stop();
    const second = setup(first.saved());
    await second.queue.start();
    expect(await second.queue.acceptBatch('s1', events, 3, 'e1')).toEqual(['duplicate', 'duplicate']);
    await vi.advanceTimersByTimeAsync(LIMITS.debounceMs);
    expect(second.fire).toHaveBeenCalledTimes(1);
    expect(second.fire.mock.calls[0]![1]).toEqual({ events, omitted: 3 });
    second.queue.stop();
  });
});

describe('scheduleWebhookEventMatches', () => {
  it.each([
    [undefined, true],
    [[], true],
    [['pull_request'], true],
    [['pull_request.closed'], true],
    [['pull_request.opened'], false],
    [['issues'], false],
  ])('filter %j -> %s for pull_request.closed', (allowed, expected) => {
    expect(scheduleWebhookEventMatches(allowed, { event: 'pull_request', action: 'closed' })).toBe(expected);
  });
});
