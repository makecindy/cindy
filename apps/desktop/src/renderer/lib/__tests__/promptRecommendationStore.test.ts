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
