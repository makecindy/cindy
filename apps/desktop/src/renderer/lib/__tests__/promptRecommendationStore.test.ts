import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  startedAtBySession: new Map<string, number>(),
  statusBySession: new Map<
    string,
    {
      turnStoppedByUser: boolean;
      hasTerminalError: boolean;
      sideTask: boolean;
      hasBackgroundAgentWork: boolean;
      hasAutoDrainingQueue: boolean;
    }
  >(),
}));

vi.mock('@/hooks/usePromptRecommendationPreference', () => ({
  PROMPT_RECOMMENDATION_KEY: 'prompt-recommendation-enabled',
  getPromptRecommendationPreference: () => h.enabled,
  subscribePromptRecommendationPreference: () => () => undefined,
  syncPromptRecommendationPreferenceFromStorageValue: () => h.enabled,
}));

vi.mock('@/contexts/dataOwnerGeneration', () => ({
  isDataOwnerPushCurrent: () => true,
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getRunningSnapshot: () => new Map(),
    subscribeAll: () => () => undefined,
    getPromptRecommendationRunStartedAt: (sessionId: string) =>
      h.startedAtBySession.get(sessionId) ?? null,
    getPromptRecommendationCompletionStatus: (sessionId: string) =>
      h.statusBySession.get(sessionId) ?? null,
  },
}));

import {
  __testing,
  beginPromptRecommendationPrediction,
  dismissPromptRecommendation,
  ensureHistoricalPromptRecommendation,
  resolvePromptRecommendationPrediction,
} from '../promptRecommendationStore';

const ELIGIBLE = {
  turnStoppedByUser: false,
  hasTerminalError: false,
  sideTask: false,
  hasBackgroundAgentWork: false,
  hasAutoDrainingQueue: false,
};

function complete(sessionId: string, revision: number): void {
  h.startedAtBySession.set(sessionId, revision - 1);
  __testing.applyRunningSnapshot(new Map([[sessionId, { isRunning: true }]]));
  __testing.noteTurnEnded(sessionId, revision);
  __testing.applyRunningSnapshot(new Map());
  __testing.settleCompletion(sessionId);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.enabled = true;
  h.startedAtBySession.clear();
  h.statusBySession.clear();
  __testing.reset();
});

afterEach(() => {
  __testing.reset();
  vi.useRealTimers();
});

describe('promptRecommendationStore', () => {
  it.each([400, 600, 5_000])('最终 done 晚于 status:false %dms 时仍能生成推荐', (delay) => {
    h.statusBySession.set('session-a', ELIGIBLE);
    h.startedAtBySession.set('session-a', 100);
    __testing.applyRunningSnapshot(new Map([['session-a', { isRunning: true }]]));
    __testing.applyRunningSnapshot(new Map());
    __testing.noteTurnEnded('session-a', 200);
    vi.advanceTimersByTime(delay);

    const early = __testing.getSessionSnapshot('session-a');
    if (early) {
      const seq = beginPromptRecommendationPrediction('session-a', early.revision)!;
      // Main 的 dispatch boundary 尚未释放，本次没有调用模型。
      resolvePromptRecommendationPrediction('session-a', early.revision, seq, null);
    }
    __testing.noteTurnEnded('session-a', 200 + delay);
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('session-a')?.revision).toBe(200 + delay);
  });

  it('更新的完成通知立即作废旧预测，不让旧 Promise 抢先消费最终完成', () => {
    h.statusBySession.set('session-a', ELIGIBLE);
    complete('session-a', 200);
    const seq = beginPromptRecommendationPrediction('session-a', 200)!;
    __testing.noteTurnEnded('session-a', 800);
    resolvePromptRecommendationPrediction('session-a', 200, seq, '旧结果');
    expect(__testing.getSessionSnapshot('session-a')?.prompt).not.toBe('旧结果');
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('session-a')?.revision).toBe(800);
  });

  it.each(['accepted', 'dismissed'])('%s 后迟到的结束 patch 不会重新生成推荐', (outcome) => {
    h.statusBySession.set('session-a', ELIGIBLE);
    complete('session-a', 200);
    const seq = beginPromptRecommendationPrediction('session-a', 200)!;
    if (outcome === 'accepted') {
      resolvePromptRecommendationPrediction('session-a', 200, seq, '继续测试');
    }
    dismissPromptRecommendation('session-a', 200);
    __testing.noteTurnEnded('session-a', 800);
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();
  });

  it('等待最终 done 时即使没有 entry，显式发送也取消这份等待', () => {
    h.statusBySession.set('session-a', ELIGIBLE);
    complete('session-a', 200);
    const seq = beginPromptRecommendationPrediction('session-a', 200)!;
    resolvePromptRecommendationPrediction('session-a', 200, seq, null);
    dismissPromptRecommendation('session-a');
    __testing.noteTurnEnded('session-a', 800);
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();
  });

  it('新 running 后输入框的同步失效不会误删新轮完成资格', () => {
    h.statusBySession.set('session-a', ELIGIBLE);
    h.startedAtBySession.set('session-a', 100);
    __testing.applyRunningSnapshot(new Map([['session-a', { isRunning: true }]]));
    dismissPromptRecommendation('session-a');
    __testing.noteTurnEnded('session-a', 200);
    __testing.applyRunningSnapshot(new Map());
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('session-a')?.revision).toBe(200);
  });

  it('不会为本次运行期间未观察到 running 的历史 session 创建候选', () => {
    h.statusBySession.set('old-session', ELIGIBLE);

    __testing.noteTurnEnded('old-session', 10);
    __testing.settleCompletion('old-session');

    expect(__testing.getSessionSnapshot('old-session')).toBeUndefined();
  });

  it('后台正常完成后按 session 和完成 revision 创建候选', () => {
    h.statusBySession.set('session-a', ELIGIBLE);

    complete('session-a', 101);

    expect(__testing.getSessionSnapshot('session-a')).toEqual({
      revision: 101,
      phase: 'candidate',
      prompt: null,
      requestSeq: 0,
    });
    expect(__testing.getSessionSnapshot('session-b')).toBeUndefined();
  });

  it.each([
    ['用户 Stop', { turnStoppedByUser: true }],
    ['终端错误', { hasTerminalError: true }],
    ['side-task', { sideTask: true }],
    ['仍有后台工作', { hasBackgroundAgentWork: true }],
    ['队列即将自动续跑', { hasAutoDrainingQueue: true }],
  ])('%s 的完成不会创建推荐候选', (_label, patch) => {
    h.statusBySession.set('session-a', { ...ELIGIBLE, ...patch });

    complete('session-a', 102);

    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();
  });

  it('开关关闭时耗尽本轮，不在重新打开 session 时补付费预测', () => {
    h.enabled = false;
    h.statusBySession.set('session-a', ELIGIBLE);

    complete('session-a', 103);

    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();
  });

  it('上一轮迟到的 ended revision 不会被配给下一轮 stopped 边沿', () => {
    h.statusBySession.set('session-a', ELIGIBLE);
    h.startedAtBySession.set('session-a', 50);
    __testing.applyRunningSnapshot(new Map([['session-a', { isRunning: true }]]));
    __testing.applyRunningSnapshot(new Map());

    // 下一轮与上一轮 ended 落在同一毫秒，旧 revision 也必须被拒绝。
    h.startedAtBySession.set('session-a', 100);
    __testing.applyRunningSnapshot(new Map([['session-a', { isRunning: true }]]));
    __testing.noteTurnEnded('session-a', 100);
    __testing.applyRunningSnapshot(new Map());
    __testing.settleCompletion('session-a');
    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();

    __testing.noteTurnEnded('session-a', 200);
    __testing.settleCompletion('session-a');
    expect(__testing.getSessionSnapshot('session-a')?.revision).toBe(200);
  });

  it('wake bridge 连续 running 时按底层 startedAt 换代丢弃中间轮 revision', () => {
    h.statusBySession.set('session-a', ELIGIBLE);
    h.startedAtBySession.set('session-a', 50);
    const running = new Map([['session-a', { isRunning: true }]]);
    __testing.applyRunningSnapshot(running);
    __testing.noteTurnEnded('session-a', 100);

    // 聚合 running 没有熄灭，但 wake turn 已经用新的 startedAt 启动。
    h.startedAtBySession.set('session-a', 150);
    __testing.applyRunningSnapshot(running);
    __testing.applyRunningSnapshot(new Map());
    __testing.settleCompletion('session-a');
    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();

    __testing.noteTurnEnded('session-a', 200);
    __testing.settleCompletion('session-a');
    expect(__testing.getSessionSnapshot('session-a')?.revision).toBe(200);
  });

  it('A 与 B 的请求和结果互不覆盖', () => {
    h.statusBySession.set('session-a', ELIGIBLE);
    h.statusBySession.set('session-b', ELIGIBLE);
    complete('session-a', 201);
    complete('session-b', 301);

    const requestA = beginPromptRecommendationPrediction('session-a', 201);
    const requestB = beginPromptRecommendationPrediction('session-b', 301);
    expect(requestA).not.toBeNull();
    expect(requestB).not.toBeNull();

    resolvePromptRecommendationPrediction('session-a', 201, requestA!, 'A 的推荐');
    resolvePromptRecommendationPrediction('session-b', 301, requestB!, 'B 的推荐');

    expect(__testing.getSessionSnapshot('session-a')?.prompt).toBe('A 的推荐');
    expect(__testing.getSessionSnapshot('session-b')?.prompt).toBe('B 的推荐');
  });

  it('新 turn 开始会使旧推荐和旧 Promise 失效', () => {
    h.statusBySession.set('session-a', ELIGIBLE);
    complete('session-a', 401);
    const request = beginPromptRecommendationPrediction('session-a', 401);
    expect(request).not.toBeNull();

    __testing.applyRunningSnapshot(new Map([['session-a', { isRunning: true }]]));
    resolvePromptRecommendationPrediction('session-a', 401, request!, '过期推荐');

    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();
  });

  it('Tab/发送消费后，同 revision 的迟到结果不能复活', () => {
    h.statusBySession.set('session-a', ELIGIBLE);
    complete('session-a', 501);
    const request = beginPromptRecommendationPrediction('session-a', 501);
    expect(request).not.toBeNull();

    dismissPromptRecommendation('session-a', 501);
    resolvePromptRecommendationPrediction('session-a', 501, request!, '不应复活');

    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();
  });
});

describe('ensureHistoricalPromptRecommendation（打开历史任务补一次，#6184）', () => {
  it('为历史完成点创建候选，并与预测流程共用同一状态机', () => {
    ensureHistoricalPromptRecommendation('old-session', 10);
    expect(__testing.getSessionSnapshot('old-session')).toEqual({
      revision: 10,
      phase: 'candidate',
      prompt: null,
      requestSeq: 0,
    });

    const seq = beginPromptRecommendationPrediction('old-session', 10);
    expect(seq).not.toBeNull();
    resolvePromptRecommendationPrediction('old-session', 10, seq!, '继续上次的重构');
    expect(__testing.getSessionSnapshot('old-session')?.prompt).toBe('继续上次的重构');
  });

  it('同一完成点只尝试一次；新完成点允许再请求', () => {
    ensureHistoricalPromptRecommendation('old-session', 10);
    const seq = beginPromptRecommendationPrediction('old-session', 10)!;
    resolvePromptRecommendationPrediction('old-session', 10, seq, null);
    expect(__testing.getSessionSnapshot('old-session')).toBeUndefined();

    ensureHistoricalPromptRecommendation('old-session', 10);
    expect(__testing.getSessionSnapshot('old-session')).toBeUndefined();

    ensureHistoricalPromptRecommendation('old-session', 20);
    expect(__testing.getSessionSnapshot('old-session')?.revision).toBe(20);
  });

  it('已有条目（含 live 完成）不被历史补生成覆盖', () => {
    h.statusBySession.set('session-a', ELIGIBLE);
    complete('session-a', 200);

    ensureHistoricalPromptRecommendation('session-a', 100);

    expect(__testing.getSessionSnapshot('session-a')?.revision).toBe(200);
  });

  it('运行中的会话不创建历史候选', () => {
    __testing.applyRunningSnapshot(new Map([['session-a', { isRunning: true }]]));

    ensureHistoricalPromptRecommendation('session-a', 300);

    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();
  });

  it('开关关闭或非法完成点不创建候选', () => {
    h.enabled = false;
    ensureHistoricalPromptRecommendation('session-a', 300);
    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();

    h.enabled = true;
    ensureHistoricalPromptRecommendation('session-a', 0);
    ensureHistoricalPromptRecommendation('session-a', Number.NaN);
    ensureHistoricalPromptRecommendation(undefined, 300);
    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();
  });

  it('有运行态时失败 / 被停止的完成轮不触发历史补生成', () => {
    h.statusBySession.set('session-a', { ...ELIGIBLE, hasTerminalError: true });
    ensureHistoricalPromptRecommendation('session-a', 300);
    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();

    h.statusBySession.set('session-b', { ...ELIGIBLE, turnStoppedByUser: true });
    ensureHistoricalPromptRecommendation('session-b', 300);
    expect(__testing.getSessionSnapshot('session-b')).toBeUndefined();
  });

  it('重启后的历史会话没有运行态信息，仍然允许补生成', () => {
    // statusBySession 未设置 → 运行态为 null（重启后 / 未加载），按历史允许处理。
    ensureHistoricalPromptRecommendation('old-session', 300);
    expect(__testing.getSessionSnapshot('old-session')?.revision).toBe(300);
  });

  it('dismiss 后同一完成点不再自动重现，新完成点恢复', () => {
    ensureHistoricalPromptRecommendation('session-a', 300);
    dismissPromptRecommendation('session-a');

    ensureHistoricalPromptRecommendation('session-a', 300);
    expect(__testing.getSessionSnapshot('session-a')).toBeUndefined();

    ensureHistoricalPromptRecommendation('session-a', 400);
    expect(__testing.getSessionSnapshot('session-a')?.revision).toBe(400);
  });

  it('live 完成与历史补生成同完成点交错时不互相删除，预测正常落地', () => {
    h.statusBySession.set('session-a', ELIGIBLE);
    h.startedAtBySession.set('session-a', 499);
    __testing.applyRunningSnapshot(new Map([['session-a', { isRunning: true }]]));
    __testing.applyRunningSnapshot(new Map());
    // settle 的 500ms 合并窗口内，打开会话的历史补生成已经发出请求。
    ensureHistoricalPromptRecommendation('session-a', 500);
    const seq = beginPromptRecommendationPrediction('session-a', 500);
    expect(seq).not.toBeNull();

    // 迟到的 live 完成通知与 settle 都不能作废这次在途预测。
    __testing.noteTurnEnded('session-a', 500);
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('session-a')?.phase).toBe('predicting');

    resolvePromptRecommendationPrediction('session-a', 500, seq!, '缓存命中的建议');
    expect(__testing.getSessionSnapshot('session-a')?.prompt).toBe('缓存命中的建议');
  });
});
