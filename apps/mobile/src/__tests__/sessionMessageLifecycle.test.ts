import { describe, expect, it, vi } from 'vitest';
import {
  createSessionMessageLifecycleController,
  type SessionMessageReclaimReason,
} from '@/session/sessionMessageLifecycle';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('sessionMessageLifecycle', () => {
  it('blur 后重进会让第一代读取永久失效，第二代可提交', () => {
    const lifecycle = createSessionMessageLifecycleController();
    const first = lifecycle.enter('s1');
    expect(lifecycle.canCommit(first)).toBe(true);

    lifecycle.leave('s1', 'detail-blur', first);
    const second = lifecycle.enter('s1');

    expect(lifecycle.canCommit(first)).toBe(false);
    expect(lifecycle.canCommit(second)).toBe(true);
  });

  it('旧 cleanup 晚到不能撤销重新聚焦后的新 authority', () => {
    const lifecycle = createSessionMessageLifecycleController();
    const first = lifecycle.enter('s1');
    lifecycle.leave('s1', 'detail-blur', first);
    const second = lifecycle.enter('s1');

    expect(lifecycle.leave('s1', 'session-switch', first)).toBe(false);
    expect(lifecycle.canCommit(second)).toBe(true);
  });

  it('页面卸载后等待最后一份本地工作释放再执行回收', async () => {
    const lifecycle = createSessionMessageLifecycleController();
    const reclaim = vi.fn((_sessionId: string, _reason: SessionMessageReclaimReason) => true);
    lifecycle.setReclaimer(reclaim);
    const first = lifecycle.acquireWork('s1', true);
    const second = lifecycle.acquireWork('s1', true);
    const authority = lifecycle.enter('s1');

    lifecycle.leave('s1', 'session-switch', authority);
    first.release();
    await flushMicrotasks();
    expect(reclaim).not.toHaveBeenCalled();

    second.release();
    await flushMicrotasks();
    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(reclaim).toHaveBeenCalledWith('s1', 'session-switch');
  });

  it('页面 lease 释放后，独立异步操作 lease 仍能跨卸载保护到 finally', async () => {
    const lifecycle = createSessionMessageLifecycleController();
    const reclaim = vi.fn((_sessionId: string, _reason: SessionMessageReclaimReason) => true);
    lifecycle.setReclaimer(reclaim);
    const pageLease = lifecycle.acquireWork('s1', true);
    const operationLease = lifecycle.acquireWork('s1', true);
    const authority = lifecycle.enter('s1');

    lifecycle.leave('s1', 'session-switch', authority);
    pageLease.release();
    await flushMicrotasks();
    expect(reclaim).not.toHaveBeenCalled();

    operationLease.release();
    await flushMicrotasks();
    expect(reclaim).toHaveBeenCalledTimes(1);
  });

  it('旧 deferred reclaim 在重新聚焦后即使排空也不能清新窗口', async () => {
    const lifecycle = createSessionMessageLifecycleController();
    const reclaim = vi.fn((_sessionId: string, _reason: SessionMessageReclaimReason) => true);
    lifecycle.setReclaimer(reclaim);
    const work = lifecycle.acquireWork('s1', true);
    const first = lifecycle.enter('s1');
    lifecycle.leave('s1', 'detail-blur', first);

    const second = lifecycle.enter('s1');
    work.release();
    await flushMicrotasks();

    expect(reclaim).not.toHaveBeenCalled();
    expect(lifecycle.canCommit(second)).toBe(true);
  });

  it('不同 session 隔离，release 幂等', async () => {
    const lifecycle = createSessionMessageLifecycleController();
    const reclaim = vi.fn((_sessionId: string, _reason: SessionMessageReclaimReason) => true);
    lifecycle.setReclaimer(reclaim);
    const workA = lifecycle.acquireWork('a', true);
    const a = lifecycle.enter('a');
    const b = lifecycle.enter('b');
    lifecycle.leave('a', 'detail-blur', a);
    lifecycle.leave('b', 'app-background', b);

    await flushMicrotasks();
    expect(reclaim).toHaveBeenCalledWith('b', 'app-background');
    expect(reclaim).not.toHaveBeenCalledWith('a', 'detail-blur');

    workA.release();
    workA.release();
    await flushMicrotasks();
    expect(reclaim.mock.calls.filter(([id]) => id === 'a')).toHaveLength(1);
  });

  it('store 保护返回 false 时保留 pending，状态变化可显式重试', async () => {
    const lifecycle = createSessionMessageLifecycleController();
    const reclaim = vi.fn((_sessionId: string, _reason: SessionMessageReclaimReason) => true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    lifecycle.setReclaimer(reclaim);
    const authority = lifecycle.enter('s1');
    lifecycle.leave('s1', 'detail-blur', authority);
    await flushMicrotasks();

    expect(lifecycle.inspect('s1').pendingReclaim).toBe('detail-blur');
    lifecycle.retryPendingReclaim('s1');
    await flushMicrotasks();
    expect(reclaim).toHaveBeenCalledTimes(2);
    expect(lifecycle.inspect('s1').pendingReclaim).toBeNull();
  });

  it('后来的 leave 不会让已经排队的回收请求永久丢失', async () => {
    const lifecycle = createSessionMessageLifecycleController();
    const reclaim = vi.fn((_sessionId: string, _reason: SessionMessageReclaimReason) => true);
    lifecycle.setReclaimer(reclaim);
    const authority = lifecycle.enter('s1');

    lifecycle.leave('s1', 'detail-blur', authority);
    lifecycle.leave('s1', 'session-switch');
    await flushMicrotasks();

    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(reclaim).toHaveBeenCalledWith('s1', 'session-switch');
    expect(lifecycle.inspect('s1').pendingReclaim).toBeNull();
  });

  it('forget 和 reset 后不会复用旧 authority 的 generation', () => {
    const lifecycle = createSessionMessageLifecycleController();
    const beforeForget = lifecycle.enter('s1');
    lifecycle.forget('s1');
    const afterForget = lifecycle.enter('s1');

    expect(afterForget.generation).toBeGreaterThan(beforeForget.generation);
    expect(lifecycle.canCommit(beforeForget)).toBe(false);

    lifecycle.reset();
    const afterReset = lifecycle.enter('s1');
    expect(afterReset.generation).toBeGreaterThan(afterForget.generation);
    expect(lifecycle.canCommit(afterForget)).toBe(false);
  });

  it('reset 会永久撤销此前未进入详情读取的 authority', () => {
    const lifecycle = createSessionMessageLifecycleController();
    const beforeReset = lifecycle.captureUnentered('s1');
    expect(lifecycle.canCommitUnentered(beforeReset)).toBe(true);

    lifecycle.reset();
    expect(lifecycle.canCommitUnentered(beforeReset)).toBe(false);

    const afterReset = lifecycle.captureUnentered('s1');
    expect(lifecycle.canCommitUnentered(afterReset)).toBe(true);
  });

  it('forget/reset 后旧 work lease 不能污染同 ID 的新生命周期', () => {
    const lifecycle = createSessionMessageLifecycleController();
    const beforeForget = lifecycle.acquireWork('s1', true);
    lifecycle.forget('s1');
    beforeForget.update(true);
    expect(lifecycle.hasLocalWork('s1')).toBe(false);

    const beforeReset = lifecycle.acquireWork('s1', true);
    lifecycle.reset();
    beforeReset.update(true);
    expect(lifecycle.hasLocalWork('s1')).toBe(false);
  });
});
