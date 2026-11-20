/**
 * queuedInputStatus.test.ts
 * ---------------------------------------------------------------------------
 * 会话「还在等队列里的消息」这条判定的输入矩阵(#11299)。
 *
 * 队列里的消息在派发前只存在于主进程内存态，气泡上标「排队中」；会话级状态
 * (侧栏行、底部状态栏)必须用同一份事实，否则「气泡说排队、会话说空闲」两边
 * 矛盾，用户无法判断这条排队消息还会不会执行。
 *
 * 这里锁住三条边界：队列为空 → 不等；用户 Stop 暂停的队列 → 有意搁置，不算等；
 * 回合正在跑 → 队列会在这轮结束后自动接续，会话有别的状态可以解释。
 */

import { describe, expect, it } from 'vitest';

import {
  hasUnpausedQueuedInput,
  shouldShowComposerRuntimeStatus,
} from '@/features/cc-agent/lib/queuedInputStatus';

describe('hasUnpausedQueuedInput', () => {
  it('treats an execution pause like a paused queue and ignores temporary interaction locks', () => {
    const queued = { queuedCount: 1, queuePaused: false, queueInteractionLocks: [] };
    expect(hasUnpausedQueuedInput(queued)).toBe(true);
    expect(hasUnpausedQueuedInput({ ...queued, queuedCount: 0 })).toBe(false);
    expect(hasUnpausedQueuedInput({ ...queued, queuePaused: true })).toBe(false);
    expect(hasUnpausedQueuedInput({ ...queued, queueInteractionLocks: ['execution-pause'] })).toBe(false);
    expect(hasUnpausedQueuedInput({ ...queued, queueInteractionLocks: ['drag'] })).toBe(true);
  });
});

describe('shouldShowComposerRuntimeStatus', () => {
  const idle = {
    pendingPlanReview: false,
    isRunning: false,
    waitingRemoteStart: false,
    backgroundTasksActive: false,
    hasRunningWorkflow: false,
    waitingForQueuedInput: false,
  };

  it('keeps the status bar visible while a queued message waits, and hides it when idle', () => {
    expect(shouldShowComposerRuntimeStatus(idle)).toBe(false);
    expect(shouldShowComposerRuntimeStatus({ ...idle, waitingForQueuedInput: true })).toBe(true);
    expect(shouldShowComposerRuntimeStatus({ ...idle, isRunning: true })).toBe(true);
    expect(shouldShowComposerRuntimeStatus({ ...idle, waitingRemoteStart: true })).toBe(true);
    expect(shouldShowComposerRuntimeStatus({ ...idle, backgroundTasksActive: true })).toBe(true);
    expect(shouldShowComposerRuntimeStatus({ ...idle, hasRunningWorkflow: true })).toBe(true);
    // 计划审阅有自己的接管界面，状态栏整体让位。
    expect(shouldShowComposerRuntimeStatus({ ...idle, pendingPlanReview: true, waitingForQueuedInput: true })).toBe(false);
  });
});
