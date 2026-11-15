import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  remote: new Map<string, string>(),
  running: new Map<string, { isRunning: boolean }>(),
  onRunning: (() => undefined) as () => void,
  onRemotePush: ((_push: unknown) => undefined) as (push: unknown) => void,
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
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: (id: string) => h.remote.get(id),
}));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({
  isDeviceLinkRemotePushCurrent: () => true,
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getRunningSnapshot: () => h.running,
    subscribeAll: (listener: () => void) => { h.onRunning = listener; return () => undefined; },
    getPromptRecommendationRunStartedAt: (sessionId: string) =>
      h.startedAtBySession.get(sessionId) ?? null,
    getPromptRecommendationCompletionStatus: (sessionId: string) =>
      h.statusBySession.get(sessionId) ?? null,
  },
}));

import {
  __testing,
  initializePromptRecommendationStore,
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
  h.remote.clear();
  h.running.clear();
  h.startedAtBySession.clear();
  h.statusBySession.clear();
  __testing.reset();
});

afterEach(() => {
  __testing.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Regression: A's clock and push arrival order must not decide B's completion.
// Existing cases inject ordered local edges only. Unit: drive the production bridge
// subscription with B revision 200, skewed A start, and reordered/duplicate frames.
describe('remote completion ingress', () => {
  function setup(startedAt: number) {
    h.remote.set('remote', 'host-b');
    h.startedAtBySession.set('remote', startedAt);
    h.statusBySession.set('remote', ELIGIBLE);
    vi.stubGlobal('window', {
      electronAPI: { deviceLink: { onRemotePush: (listener: typeof h.onRemotePush) => {
        h.onRemotePush = listener;
        return () => undefined;
      } } },
      addEventListener: () => undefined, removeEventListener: () => undefined,
    });
    initializePromptRecommendationStore();
    return {
      running(value: boolean) {
        h.running = value ? new Map([['remote', { isRunning: true }]]) : new Map();
        h.onRunning();
      },
      ended(revision = 200) {
        h.onRemotePush({ deviceId: 'host-b', channel: 'local-db:sessions:patched',
          payload: { sessionId: 'remote', patch: { lastTurnEndedAt: revision } } });
      },
    };
  }

  it.each([50, 50_000])('uses B completion when A recorded start at %d', (startedAt) => {
    const ingress = setup(startedAt);
    ingress.running(true);
    ingress.ended();
    ingress.running(false);
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('remote')?.revision).toBe(200);
  });

  it('buffers completion received before the running stream, without predicting historical navigation', () => {
    const ingress = setup(50_000);
    ingress.ended();
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('remote')).toBeUndefined();
    ingress.running(true);
    ingress.running(false);
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('remote')?.phase).toBe('candidate');
  });

  it('discards A clock evidence captured before the remote origin was resolved', () => {
    const ingress = setup(50_000);
    h.remote.delete('remote');
    ingress.running(true);
    h.remote.set('remote', 'host-b');
    ingress.ended();
    ingress.running(false);
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('remote')?.revision).toBe(200);
  });

  // Unit regression: an existing ready/consumed recommendation used to drop the
  // next B completion before its running stream arrived. Exercise both ingress
  // subscriptions; a higher revision alone must still not trigger generation.
  it.each(['ready', 'consumed'])('buffers the next B completion after %s until its delayed running arrives', (previous) => {
    const ingress = setup(50_000);
    ingress.running(true);
    ingress.ended();
    ingress.running(false);
    vi.advanceTimersByTime(500);
    const first = beginPromptRecommendationPrediction('remote', 200)!;
    resolvePromptRecommendationPrediction('remote', 200, first, 'first result');
    if (previous === 'consumed') dismissPromptRecommendation('remote');

    ingress.ended(300);
    expect(__testing.getSessionSnapshot('remote')).toBeUndefined();
    // A stale UI event for the old visible recommendation cannot consume 300.
    dismissPromptRecommendation('remote', 200);
    vi.advanceTimersByTime(500);
    expect(beginPromptRecommendationPrediction('remote', 300)).toBeNull();
    ingress.running(true);
    ingress.ended(200); // An old duplicate must not replace the buffered turn.
    ingress.running(false);
    vi.advanceTimersByTime(500);
    const second = beginPromptRecommendationPrediction('remote', 300);
    expect(second).not.toBeNull();
    resolvePromptRecommendationPrediction('remote', 300, second!, 'next result');
    expect(__testing.getSessionSnapshot('remote')?.prompt).toBe('next result');
  });

  it('recovers the same host revision after a delayed running snapshot hides a received result', () => {
    const ingress = setup(100);
    ingress.running(true);
    ingress.ended();
    ingress.running(false);
    vi.advanceTimersByTime(500);
    const first = beginPromptRecommendationPrediction('remote', 200)!;
    resolvePromptRecommendationPrediction('remote', 200, first, 'host result');
    ingress.running(true);
    ingress.running(false);
    vi.advanceTimersByTime(500);
    const second = beginPromptRecommendationPrediction('remote', 200);
    expect(second).not.toBeNull();
    resolvePromptRecommendationPrediction('remote', 200, second!, 'host result');
    expect(__testing.getSessionSnapshot('remote')?.prompt).toBe('host result');
    dismissPromptRecommendation('remote');
    ingress.ended();
    ingress.running(true);
    ingress.ended();
    ingress.running(false);
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('remote')).toBeUndefined();
  });

  it('keeps a completion while a queue projection is temporarily busy', () => {
    const ingress = setup(100);
    ingress.running(true);
    ingress.ended();
    h.statusBySession.set('remote', { ...ELIGIBLE, hasAutoDrainingQueue: true });
    ingress.running(false);
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('remote')).toBeUndefined();
    h.statusBySession.set('remote', ELIGIBLE);
    h.onRunning();
    vi.advanceTimersByTime(500);
    expect(__testing.getSessionSnapshot('remote')?.revision).toBe(200);
  });
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
