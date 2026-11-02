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
  const fire = vi.fn<ScheduleWebhookQueueDeps['fire']>(async () => ({}));
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
    h.fire.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({}); }));
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
    const h = setup();
    await h.queue.start();
    expect(await h.queue.accept('s1', event('a'))).toBe('queued');
    expect(await h.queue.accept('s1', event('a'))).toBe('duplicate');
    for (let i = 0; i <= LIMITS.receiptsPerSchedule; i += 1) {
      vi.setSystemTime(1_000_000 + i + 1);
      expect(await h.queue.accept('s1', event(`d${i}`))).toBe('queued');
    }
    expect(Object.keys(h.saved().endpoints.s1!.receipts)).toHaveLength(LIMITS.receiptsPerSchedule);
    expect(h.saved().endpoints.s1!.pending.length).toBe(LIMITS.batchEvents);
    expect(h.saved().endpoints.s1!.omitted).toBeGreaterThan(0);
  });

  it('allows a redelivery after a failed save, because the first delivery was not acknowledged', async () => {
    const h = setup();
    await h.queue.start();
    h.save.mockRejectedValueOnce(new Error('disk full'));
    await expect(h.queue.accept('s1', event('a'))).rejects.toThrow('disk full');
    expect(await h.queue.accept('s1', event('a'))).toBe('queued');
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

  it('carries the count of events the server already dropped into the next batch, once', async () => {
    const { queue, fire } = setup();
    await queue.start();
    await queue.accept('s1', event('a'));
    await queue.addOmitted('s1', 3);
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
    first.fire.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({}); }));
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
