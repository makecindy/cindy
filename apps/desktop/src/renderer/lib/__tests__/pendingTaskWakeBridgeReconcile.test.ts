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
 * 修复:活动熄灭延迟对账路径拿到 main 权威后收口桥接,六条件全部满足才清
 * (计数与代际一致 / 置位代次未变 / 主 turn 不在跑 / 距最近置位超过最小年龄 /
 * 权威表无 wake 型任务 / main 权威 continuation 计数明确为 0),见
 * seedBackgroundTaskSnapshots 的 reconcileWakeBridge。本测试直接驱动真实 store
 * (__applyStatusUpdateForTest / __applyStreamEventForTest),断言 getRunningSnapshot
 * 的可观察行为;用 fake timers 控制最小年龄时钟。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makerChatStore } from '@/lib/makerChatStore';

/** 与 makerChatStore 的 WAKE_BRIDGE_RECONCILE_MIN_AGE_MS 对齐(10s)+ 余量。 */
const OVER_MIN_AGE_MS = 11_000;
const UNDER_MIN_AGE_MS = 2_000;

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

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

/** 模拟延迟对账:请求前捕获代际 → 快照落地(main 权威 continuation 计数可指定)。 */
function reconcileWithSnapshot(
  sessionId: string,
  tasks: Array<{ taskId: string; taskType?: string }>,
  pendingContinuations: number | null = 0,
): void {
  const captured = makerChatStore.capturePendingWakeBridge(sessionId);
  makerChatStore.seedBackgroundTaskSnapshots(sessionId, tasks, {
    reconcileWakeBridge: captured,
    authorityPendingContinuations: pendingContinuations,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('pendingTaskWake 桥接泄漏对账(reconcileWakeBridge)', () => {
  it('主轮 Done 后迟到的 wake 终态撑住 running 快照;六条件齐 → 收口熄灭', () => {
    const S = 'wake-bridge-leak-reconcile';
    runMainTurn(S);
    expect(isRunningInSnapshot(S)).toBe(false);

    // 迟到/误投的 wake 终态:置位桥接,running 快照被撑起(bug 现场)。
    pushLateWakeTerminal(S, 't-late');
    expect(isRunningInSnapshot(S)).toBe(true);

    // 超过最小年龄后延迟对账落地:权威表空、continuation 计数 0、代际静止、
    // 主 turn 不在跑 → 桥接收口,spinner 熄灭。
    vi.setSystemTime(T0 + OVER_MIN_AGE_MS);
    reconcileWithSnapshot(S, [], 0);
    expect(isRunningInSnapshot(S)).toBe(false);
  });

  it('main 权威 continuation 计数 > 0 时不收口(空任务表 ≠ 无待启动的 wake)', () => {
    const S = 'wake-bridge-pending-continuation';
    runMainTurn(S);
    pushLateWakeTerminal(S, 't-cont');
    expect(isRunningInSnapshot(S)).toBe(true);

    // 任务终态后立即从运行表出表,但 continuation claim 仍 awaiting:
    // 即便任务表为空、代际静止、超龄,也必须保留桥接。
    vi.setSystemTime(T0 + OVER_MIN_AGE_MS);
    reconcileWithSnapshot(S, [], 1);
    expect(isRunningInSnapshot(S)).toBe(true);

    // continuation 归零后的下一轮对账才收口。
    vi.setSystemTime(T0 + OVER_MIN_AGE_MS * 2);
    reconcileWithSnapshot(S, [], 0);
    expect(isRunningInSnapshot(S)).toBe(false);
  });

  it('continuation 信号缺失(旧 main,null)时不收口 —— 不退化回空表判据', () => {
    const S = 'wake-bridge-missing-signal';
    runMainTurn(S);
    pushLateWakeTerminal(S, 't-null-signal');
    vi.setSystemTime(T0 + OVER_MIN_AGE_MS);
    reconcileWithSnapshot(S, [], null);
    expect(isRunningInSnapshot(S)).toBe(true);
  });

  it('距最近置位不足最小年龄时不收口(合法 wake 启动慢于对账延迟不被误熄)', () => {
    const S = 'wake-bridge-min-age-gate';
    runMainTurn(S);
    pushLateWakeTerminal(S, 't-late-age');
    expect(isRunningInSnapshot(S)).toBe(true);

    // 3s 级延迟对账先到:年龄不足,桥接保留,快照继续 running。
    vi.setSystemTime(T0 + UNDER_MIN_AGE_MS);
    reconcileWithSnapshot(S, [], 0);
    expect(isRunningInSnapshot(S)).toBe(true);

    // 复查轮到点(已超龄)才收口。
    vi.setSystemTime(T0 + OVER_MIN_AGE_MS);
    reconcileWithSnapshot(S, [], 0);
    expect(isRunningInSnapshot(S)).toBe(false);
  });

  it('请求在飞窗口内新置位的桥接不被旧快照清除(计数代际)', () => {
    const S = 'wake-bridge-inflight-generation';
    runMainTurn(S);
    pushLateWakeTerminal(S, 't-late-old');
    // 模拟请求发起前捕获代际(此刻计数 = 1)。
    const capturedBeforeFlight = makerChatStore.capturePendingWakeBridge(S);
    expect(capturedBeforeFlight.count).toBe(1);

    // 请求在飞期间:又一条 wake 终态置位(计数 = 2,armedAt / 代次刷新)。
    vi.setSystemTime(T0 + OVER_MIN_AGE_MS);
    pushLateWakeTerminal(S, 't-late-new');

    // 旧空快照落地:计数(2)≠ 代际(1)→ 一个都不清,快照继续 running。
    makerChatStore.seedBackgroundTaskSnapshots(S, [], {
      reconcileWakeBridge: capturedBeforeFlight,
      authorityPendingContinuations: 0,
    });
    expect(isRunningInSnapshot(S)).toBe(true);

    // 下一轮对账:代际静止且距第二次置位已超龄 → 收口。
    vi.setSystemTime(T0 + OVER_MIN_AGE_MS * 2);
    reconcileWithSnapshot(S, [], 0);
    expect(isRunningInSnapshot(S)).toBe(false);
  });

  it('ABA 碰撞:在飞窗口内消费后又置位、计数回到捕获值 —— 代次不同,不收口', () => {
    const S = 'wake-bridge-aba-generation';
    runMainTurn(S);
    pushLateWakeTerminal(S, 't-aba-1');
    // 请求发起前捕获:count = 1, gen = g。
    const capturedBeforeFlight = makerChatStore.capturePendingWakeBridge(S);
    expect(capturedBeforeFlight.count).toBe(1);

    // 在飞期间:wake turn 启动消费桥接(count → 0)→ Done → 新终态又置位
    // (count 回到 1,但置位代次 +1)。
    pushStatus(S, { isRunning: true, status: 'Working' });
    pushStatus(S, { isRunning: false, status: 'Done' });
    pushLateWakeTerminal(S, 't-aba-2');
    expect(makerChatStore.capturePendingWakeBridge(S).count).toBe(1);
    expect(makerChatStore.capturePendingWakeBridge(S).gen).not.toBe(capturedBeforeFlight.gen);

    // 超长延迟的旧快照落地:计数相等(1 = 1)且新桥接已超龄,但代次不同 → 不收口。
    vi.setSystemTime(T0 + OVER_MIN_AGE_MS * 3);
    makerChatStore.seedBackgroundTaskSnapshots(S, [], {
      reconcileWakeBridge: capturedBeforeFlight,
      authorityPendingContinuations: 0,
    });
    expect(isRunningInSnapshot(S)).toBe(true);

    // 用当前代际的对账才允许收口。
    reconcileWithSnapshot(S, [], 0);
    expect(isRunningInSnapshot(S)).toBe(false);
  });

  it('多 wake 依次消费:对账不一次清空尚待消费的合法计数', () => {
    const S = 'wake-bridge-multi-wake';
    runMainTurn(S);
    pushLateWakeTerminal(S, 't-multi-1');
    pushLateWakeTerminal(S, 't-multi-2');
    expect(makerChatStore.capturePendingWakeBridge(S).count).toBe(2);

    // 捕获代际(2)后 wake turn A 启动:isTurnStart 消费一个计数(剩 1)。
    vi.setSystemTime(T0 + OVER_MIN_AGE_MS);
    const capturedBeforeFlight = makerChatStore.capturePendingWakeBridge(S);
    pushStatus(S, { isRunning: true, status: 'Working' });
    expect(makerChatStore.capturePendingWakeBridge(S).count).toBe(1);

    // 旧快照落地:计数(1)≠ 代际(2),且主 turn 在跑 → 不清。
    makerChatStore.seedBackgroundTaskSnapshots(S, [], {
      reconcileWakeBridge: capturedBeforeFlight,
      authorityPendingContinuations: 0,
    });
    expect(makerChatStore.capturePendingWakeBridge(S).count).toBe(1);

    // turn A Done:剩余 1 个桥接继续撑住 running 快照,等 wake turn B。
    pushStatus(S, { isRunning: false, status: 'Done' });
    expect(isRunningInSnapshot(S)).toBe(true);

    // wake turn B 启动并完成:计数消费到 0,快照自然收敛。
    pushStatus(S, { isRunning: true, status: 'Working' });
    pushStatus(S, { isRunning: false, status: 'Done' });
    expect(isRunningInSnapshot(S)).toBe(false);
  });

  it('权威表仍有 wake 任务在跑时不收口(不误杀真实空窗)', () => {
    const S = 'wake-bridge-leak-alive-task';
    runMainTurn(S);
    pushLateWakeTerminal(S, 't-late-2');
    expect(isRunningInSnapshot(S)).toBe(true);

    // main 权威表仍报告一个 wake 型任务在跑:即便其余条件齐,桥接保留。
    vi.setSystemTime(T0 + OVER_MIN_AGE_MS);
    reconcileWithSnapshot(S, [{ taskId: 't-alive', taskType: 'local_agent' }], 0);
    expect(isRunningInSnapshot(S)).toBe(true);
  });

  it('未传 reconcileWakeBridge 的既有路径行为不变(挂载水合不收口)', () => {
    const S = 'wake-bridge-leak-legacy-path';
    runMainTurn(S);
    pushLateWakeTerminal(S, 't-late-3');
    expect(isRunningInSnapshot(S)).toBe(true);

    // 旧签名调用(挂载/面板路径):空表 early-return,桥接保持原状。
    vi.setSystemTime(T0 + OVER_MIN_AGE_MS);
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
