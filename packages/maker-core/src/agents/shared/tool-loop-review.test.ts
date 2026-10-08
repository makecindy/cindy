import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../interfaces/logger.js';
import { ToolLoopGuard, type ToolLoopGuardVerdict } from './loop-guard.js';
import {
  ToolLoopMonitor,
  type HardToolLoopVerdict,
  type ToolLoopReviewBudget,
  type ToolLoopReviewDecision,
  type ToolLoopReviewer,
} from './tool-loop-review.js';

const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return logger; },
};

afterEach(() => {
  vi.useRealTimers();
});

function setup(reviewer?: ToolLoopReviewer, reviewBudget?: ToolLoopReviewBudget) {
  vi.useFakeTimers();
  const stops: HardToolLoopVerdict[] = [];
  const monitor = new ToolLoopMonitor(new ToolLoopGuard(), {
    reviewer,
    reviewBudget,
    context: () => ({ sessionId: 's1', agentKind: 'codex', model: 'm1' }),
    onReviewedStop: (verdict) => stops.push(verdict),
    logger,
  });
  let n = 0;
  // varyOutput: 同一调用、输出每次不同 → 只由窗口层(pingpong)命中,不触及完全相同上限。
  const repeat = (varyOutput = false): ToolLoopGuardVerdict => {
    const id = String(n++);
    monitor.onToolUse(id, 'read', { path: 'same.ts' });
    return monitor.onToolResult(id, varyOutput ? `changed ${id}` : 'unchanged');
  };
  const repeatTimes = (times: number, varyOutput = false): ToolLoopGuardVerdict[] =>
    Array.from({ length: times }, () => repeat(varyOutput));
  return { monitor, stops, repeat, repeatTimes };
}

function deferredReviewer() {
  const pending: Array<{ resolve: (decision: ToolLoopReviewDecision) => void; signal: AbortSignal }> = [];
  const reviewer = vi.fn<ToolLoopReviewer>((_request, { signal }) =>
    new Promise((resolve) => pending.push({ resolve, signal })));
  return { reviewer, pending };
}

describe('ToolLoopMonitor', () => {
  it('interrupts immediately when no reviewer is configured', () => {
    const t = setup();
    const verdicts = t.repeatTimes(4);
    expect(verdicts[3]).toMatchObject({ kind: 'hard', reason: 'consecutive', count: 4, final: false });
  });

  it('keeps running during review and grants a grace window on continue', async () => {
    const { reviewer, pending } = deferredReviewer();
    const t = setup(reviewer);
    expect(t.repeatTimes(6).every((verdict) => verdict.kind === 'ok')).toBe(true);
    // 复核进行中再命中不重复发起。
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 's1', agentKind: 'codex', model: 'm1',
      verdict: { reason: 'consecutive', count: 4, toolName: 'read' },
    });
    expect(reviewer.mock.calls[0]?.[0].evidence).toHaveLength(4);

    pending[0]?.resolve('continue');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops).toEqual([]);
    expect(t.repeatTimes(20).every((verdict) => verdict.kind === 'ok')).toBe(true);
    expect(reviewer).toHaveBeenCalledTimes(1);
    t.repeat();
    expect(reviewer).toHaveBeenCalledTimes(2);
  });

  it('reports a reviewed stop through onReviewedStop', async () => {
    const { reviewer, pending } = deferredReviewer();
    const t = setup(reviewer);
    t.repeatTimes(4);
    pending[0]?.resolve('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops).toEqual([expect.objectContaining({ reason: 'consecutive', count: 4 })]);
  });

  it('treats reviewer failure and timeout as stop', async () => {
    const failing = setup(vi.fn<ToolLoopReviewer>(async () => { throw new Error('no model'); }));
    failing.repeatTimes(4);
    await vi.advanceTimersByTimeAsync(0);
    expect(failing.stops).toHaveLength(1);

    const { reviewer, pending } = deferredReviewer();
    const slow = setup(reviewer);
    slow.repeatTimes(4);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(slow.stops).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(slow.stops).toHaveLength(1);
    expect(pending[0]?.signal.aborted).toBe(true);
    // 超时后迟到的 continue 不再生效。
    pending[0]?.resolve('continue');
    await vi.advanceTimersByTimeAsync(0);
    expect(slow.stops).toHaveLength(1);
  });

  it('returns final verdicts immediately and discards the in-flight review', async () => {
    const { reviewer, pending } = deferredReviewer();
    const t = setup(reviewer);
    const verdicts = t.repeatTimes(30);
    expect(verdicts.slice(0, 29).every((verdict) => verdict.kind === 'ok')).toBe(true);
    expect(verdicts[29]).toMatchObject({ kind: 'hard', count: 30, final: true });
    expect(pending[0]?.signal.aborted).toBe(true);
    pending[0]?.resolve('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops).toEqual([]);
  });

  it('discards a pending review once the flagged pattern is broken', async () => {
    const { reviewer, pending } = deferredReviewer();
    const t = setup(reviewer);
    t.repeatTimes(4);
    // 等待/轮询工具不打破模式,复核仍在进行。
    t.monitor.onToolUse('wait', 'TaskOutput', { task_id: 'x' });
    t.monitor.onToolResult('wait', 'running');
    expect(pending[0]?.signal.aborted).toBe(false);
    // 一次正常的编辑打破了重复模式。
    t.monitor.onToolUse('edit', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' });
    expect(t.monitor.onToolResult('edit', 'updated').kind).toBe('ok');
    expect(pending[0]?.signal.aborted).toBe(true);
    pending[0]?.resolve('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops).toEqual([]);
  });

  it('discards a pending review once a different call replaces the flagged pattern', async () => {
    const { reviewer, pending } = deferredReviewer();
    const t = setup(reviewer);
    // 同一 Read、输出各不相同:第 12 次由窗口层判 pingpong 并发起复核。
    t.repeatTimes(12, true);
    expect(reviewer).toHaveBeenCalledTimes(1);
    // 一次成功的编辑:窗口仍只有两种调用(仍 hard),但已不是被复核的模式。
    t.monitor.onToolUse('edit', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' });
    t.monitor.onToolResult('edit', 'updated');
    expect(pending[0]?.signal.aborted).toBe(true);
    pending[0]?.resolve('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops).toEqual([]);
    // 新模式另行复核。
    expect(reviewer).toHaveBeenCalledTimes(2);
  });

  it('discards a settled review while a replacement call is still in flight', async () => {
    const { reviewer, pending } = deferredReviewer();
    const t = setup(reviewer);
    t.repeatTimes(4);
    // 一个不同的长时调用已开始、结果未到时结论到达:不适用于它,丢弃。
    t.monitor.onToolUse('build', 'exec', { cmd: 'pnpm build' });
    pending[0]?.resolve('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops).toEqual([]);
  });

  it('applies a settled review when in-flight calls belong to the reviewed pattern', async () => {
    const { reviewer, pending } = deferredReviewer();
    const t = setup(reviewer);
    t.repeatTimes(4);
    // Claude 流式:先以空参数开始,完整参数随后补齐为同一被复核调用;等待工具不算。
    t.monitor.onToolUse('again', 'read', {});
    t.monitor.onToolUse('again', 'read', { path: 'same.ts' });
    t.monitor.onToolUse('wait', 'TaskOutput', { task_id: 'x' });
    expect(pending[0]?.signal.aborted).toBe(false);
    pending[0]?.resolve('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops).toHaveLength(1);
  });

  it('ignores review results after dispose or a new turn', async () => {
    const { reviewer, pending } = deferredReviewer();
    const t = setup(reviewer);
    t.repeatTimes(4);
    t.monitor.dispose();
    pending[0]?.resolve('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops).toEqual([]);

    t.monitor.resetTurn();
    t.repeatTimes(4);
    t.monitor.resetTurn();
    pending[1]?.resolve('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops).toEqual([]);
  });

  it('stops reviewing after three reviews in one turn', async () => {
    const reviewer = vi.fn<ToolLoopReviewer>(async () => 'continue');
    const t = setup(reviewer);
    for (let review = 0; review < 3; review++) {
      // 窗口在第 12 次填满并报疑似;每次放行 20 次后,下一次结果重新报疑似并复核。
      t.repeatTimes(review === 0 ? 12 : 21, true);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(reviewer).toHaveBeenCalledTimes(3);
    const verdicts = t.repeatTimes(21, true);
    expect(verdicts.slice(0, 20).every((verdict) => verdict.kind === 'ok')).toBe(true);
    expect(verdicts[20]).toMatchObject({ kind: 'hard', reason: 'pingpong', final: false });
    expect(reviewer).toHaveBeenCalledTimes(3);
  });

  it('waits for the last allowed review instead of cancelling it at the limit', async () => {
    const { reviewer, pending } = deferredReviewer();
    const t = setup(reviewer);
    t.repeatTimes(12, true);
    for (let review = 0; review < 2; review++) {
      pending[review]?.resolve('continue');
      await vi.advanceTimersByTimeAsync(0);
      t.repeatTimes(21, true);
    }
    expect(reviewer).toHaveBeenCalledTimes(3);
    // 第三次复核进行中,后续疑似命中不因次数用完而提前中断或取消它。
    expect(t.repeatTimes(5, true).every((verdict) => verdict.kind === 'ok')).toBe(true);
    expect(pending[2]?.signal.aborted).toBe(false);
    pending[2]?.resolve('continue');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stops).toEqual([]);
  });

  it('shares one review budget across monitors of the same turn', async () => {
    const reviewer = vi.fn<ToolLoopReviewer>(async () => 'continue');
    const budget: ToolLoopReviewBudget = { used: 0 };
    const first = setup(reviewer, budget);
    const second = setup(reviewer, budget);
    first.repeatTimes(12, true);
    await vi.advanceTimersByTimeAsync(0);
    second.repeatTimes(12, true);
    await vi.advanceTimersByTimeAsync(0);
    first.repeatTimes(21, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(reviewer).toHaveBeenCalledTimes(3);
    const verdicts = second.repeatTimes(21, true);
    expect(verdicts[20]).toMatchObject({ kind: 'hard', reason: 'pingpong', final: false });
    expect(reviewer).toHaveBeenCalledTimes(3);
  });
});
