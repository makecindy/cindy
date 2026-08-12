import { describe, expect, it } from 'vitest';

import { createTelegramMessageLifecycle } from '../messageLifecycle.js';

describe('telegram message lifecycle', () => {
  it('终稿栅栏后拒绝迟到 progress，且发送后才能进入清理', () => {
    const lifecycle = createTelegramMessageLifecycle('round-1');
    expect(lifecycle.acceptProgress()).toBe(true);
    const final = lifecycle.beginFinal();

    expect(final).toMatchObject({ deliveryKey: 'round-1:final', sequence: 1, attempt: 1 });
    expect(lifecycle.acceptProgress()).toBe(false);
    expect(lifecycle.beginCleanup()).toBe(false);
    expect(lifecycle.markFinalSent(final!)).toBe(true);
    expect(lifecycle.beginCleanup()).toBe(true);
    expect(lifecycle.finishCleanup()).toBe(true);
    expect(lifecycle.phase).toBe('complete');
  });

  it('重复终态共享同一在途 intent，失败重试保持 delivery key', () => {
    const lifecycle = createTelegramMessageLifecycle('round-2');
    const first = lifecycle.beginFinal()!;
    const duplicate = lifecycle.beginFinal()!;

    expect(duplicate).toEqual(first);
    expect(lifecycle.markFinalFailed(first)).toBe(true);
    const retry = lifecycle.beginFinal()!;
    expect(retry.deliveryKey).toBe(first.deliveryKey);
    expect(retry.attempt).toBe(2);
    // 旧尝试的迟到回执不能收口新尝试。
    expect(lifecycle.markFinalSent(first)).toBe(false);
    expect(lifecycle.markFinalSent(retry)).toBe(true);
  });

  it('取消冻结过程与终稿，但不删除已经确认的答案', () => {
    const pending = createTelegramMessageLifecycle('pending');
    expect(pending.cancel()).toBe(true);
    expect(pending.acceptProgress()).toBe(false);
    expect(pending.beginFinal()).toBeNull();

    const sent = createTelegramMessageLifecycle('sent');
    const final = sent.beginFinal()!;
    expect(sent.markFinalSent(final)).toBe(true);
    expect(sent.cancel()).toBe(false);
    expect(sent.phase).toBe('final-sent');
  });
});

