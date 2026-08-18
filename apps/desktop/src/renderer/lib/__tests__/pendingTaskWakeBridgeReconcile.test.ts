/**
 * 唤醒桥接(pendingTaskWake)泄漏对账回归 —— sidebar spinner 永久转圈修复。
 *
 * 场景:主轮 Done 之后才到达的 wake 型任务终态(fork 会话收到父会话任务的终态、
 * 重连重放等)会置位桥接;设计上桥接等「wake turn 启动(isTurnStart 消费)」或
 * 「wake turn 失败的 Done」收尾,但这类迟到/误投终态不会有任何后续事件跟进,
 * 两条清除路径都永远不来 —— hasBackgroundAgentWork 永真,running 快照永久含
 * 该会话(spinner 永转),且 pendingTaskWake 不在 reconcileStaleRunningTasks
 * 的对账覆盖内(迟到终态本身就是 completed,不是 running 残留)。
 *
 * 修复:活动熄灭延迟对账路径拿到 main 权威表后收口桥接
 * (seedBackgroundTaskSnapshots 的 opts.reconcileWakeBridge)。
 * 本测试直接驱动真实 store(__applyStatusUpdateForTest / __applyStreamEventForTest),
 * 断言 getRunningSnapshot 的可观察行为。
 */

import { describe, expect, it } from 'vitest';

import { makerChatStore } from '@/lib/makerChatStore';

function pushStatus(
  sessionId: string,
  partial: Partial<CCAgentStatusUpdate> & Pick<CCAgentStatusUpdate, 'isRunning' | 'status'>,
): void {
  makerChatStore.__applyStatusUpdateForTest(sessionId, {
    sessionId,
    tokenUsage: 0,
    contextTokens: 0,
    contextWindow: 0,
    ...partial,
  } as CCAgentStatusUpdate);
}

/** 迟到的 wake 型任务终态(completed)—— 桥接置位的触发帧。 */
function pushLateWakeTerminal(sessionId: string, taskId: string): void {
  makerChatStore.__applyStreamEventForTest(sessionId, {
    sessionId,
    type: 'agent_task_update',
    source: 'claude-code',
    data: {
      provider: 'claude-code',
      taskId,
      taskType: 'local_agent',
      status: 'completed',
    },
  } as CCAgentStreamEvent);
}

function isRunningInSnapshot(sessionId: string): boolean {
  return makerChatStore.getRunningSnapshot().get(sessionId)?.isRunning ?? false;
}

/** 一轮正常主 turn:启动 → Done。 */
function runMainTurn(sessionId: string): void {
  pushStatus(sessionId, { isRunning: true, status: 'Working' });
  pushStatus(sessionId, { isRunning: false, status: 'Done' });
}

describe('pendingTaskWake 桥接泄漏对账(reconcileWakeBridge)', () => {
  it('主轮 Done 后迟到的 wake 终态撑住 running 快照;空权威表对账后收口熄灭', () => {
    const S = 'wake-bridge-leak-reconcile';
    runMainTurn(S);
    expect(isRunningInSnapshot(S)).toBe(false);

    // 迟到/误投的 wake 终态:置位桥接,running 快照被撑起(bug 现场)。
    pushLateWakeTerminal(S, 't-late');
    expect(isRunningInSnapshot(S)).toBe(true);

    // 延迟对账落地:main 权威表为空、主 turn 不在跑 → 桥接收口,spinner 熄灭。
    makerChatStore.seedBackgroundTaskSnapshots(S, [], { reconcileWakeBridge: true });
    expect(isRunningInSnapshot(S)).toBe(false);
  });

  it('权威表仍有 wake 任务在跑时不收口(不误杀真实空窗)', () => {
    const S = 'wake-bridge-leak-alive-task';
    runMainTurn(S);
    pushLateWakeTerminal(S, 't-late-2');
    expect(isRunningInSnapshot(S)).toBe(true);

    // main 权威表仍报告一个 wake 型任务在跑:桥接保留,快照继续 running。
    makerChatStore.seedBackgroundTaskSnapshots(
      S,
      [{ taskId: 't-alive', taskType: 'local_agent' }],
      { reconcileWakeBridge: true },
    );
    expect(isRunningInSnapshot(S)).toBe(true);
  });

  it('未传 reconcileWakeBridge 的既有路径行为不变(挂载水合不收口)', () => {
    const S = 'wake-bridge-leak-legacy-path';
    runMainTurn(S);
    pushLateWakeTerminal(S, 't-late-3');
    expect(isRunningInSnapshot(S)).toBe(true);

    // 旧签名调用(挂载/面板路径):空表 early-return,桥接保持原状。
    makerChatStore.seedBackgroundTaskSnapshots(S, []);
    expect(isRunningInSnapshot(S)).toBe(true);
  });

  it('wake turn 正常启动仍按原语义消费桥接(修复不破坏正常链路)', () => {
    const S = 'wake-bridge-normal-consume';
    runMainTurn(S);
    pushLateWakeTerminal(S, 't-late-4');
    expect(isRunningInSnapshot(S)).toBe(true);

    // wake turn 启动(isTurnStart 消费一个桥接计数)→ Done:快照正常收敛。
    pushStatus(S, { isRunning: true, status: 'Working' });
    pushStatus(S, { isRunning: false, status: 'Done' });
    expect(isRunningInSnapshot(S)).toBe(false);
  });
});
