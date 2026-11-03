// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/usePromptRecommendationPreference', () => ({
  PROMPT_RECOMMENDATION_KEY: 'prompt-recommendation-enabled',
  getPromptRecommendationPreference: () => true,
  subscribePromptRecommendationPreference: () => () => undefined,
  syncPromptRecommendationPreferenceFromStorageValue: () => true,
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getPromptRecommendationRunStartedAt: () => 100,
    getPromptRecommendationCompletionStatus: () => ({
      turnStoppedByUser: false, hasTerminalError: false, sideTask: false,
      hasBackgroundAgentWork: false, hasAutoDrainingQueue: false,
    }),
  },
}));

import {
  __testing,
  dismissPromptRecommendation,
  usePromptRecommendation,
} from '@/lib/promptRecommendationStore';
import { isComposerReadyForPromptRecommendation } from '@/components/new-chat/composerPromptRecommendation';
import { usePromptRecommendationPrediction } from '../usePromptRecommendationPrediction';

const READY = {
  enabled: true, hydrated: true, hasMessage: false, hasAttachments: false,
  hasBrowserComments: false, hasVoiceDraftText: false, mutationLocked: false,
};

function complete(): void {
  __testing.applyRunningSnapshot(new Map([['a', { isRunning: true }]]));
  __testing.noteTurnEnded('a', 200);
  __testing.applyRunningSnapshot(new Map());
  vi.advanceTimersByTime(500);
}

function useHarness(sessionId: string, ready: typeof READY, predict: () => Promise<string | null>) {
  const recommendation = usePromptRecommendation(sessionId);
  usePromptRecommendationPrediction({
    sessionId, recommendation, canPredict: isComposerReadyForPromptRecommendation(ready), predict,
  });
  return recommendation;
}

beforeEach(() => {
  vi.useFakeTimers();
  __testing.reset();
});
afterEach(() => {
  cleanup();
  __testing.reset();
  vi.useRealTimers();
});

describe('composer prediction lifecycle', () => {
  it.each([
    { hasMessage: true }, { hasAttachments: true }, { hasBrowserComments: true },
    { hasVoiceDraftText: true }, { mutationLocked: true }, { hydrated: false },
  ])('暂态 %j 期间保留候选，恢复后只生成一次', async (blocked) => {
    const predict = vi.fn(async () => '继续测试');
    const hook = renderHook(({ ready }) => useHarness('a', ready, predict), {
      initialProps: { ready: { ...READY, ...blocked } },
    });
    act(complete);
    expect(hook.result.current?.phase).toBe('candidate');
    expect(predict).not.toHaveBeenCalled();
    await act(async () => hook.rerender({ ready: READY }));
    expect(hook.result.current?.prompt).toBe('继续测试');
    await act(async () => {
      hook.rerender({ ready: { ...READY, ...blocked } });
    });
    await act(async () => hook.rerender({ ready: READY }));
    expect(hook.result.current?.prompt).toBe('继续测试');
    expect(predict).toHaveBeenCalledTimes(1);
  });

  it('分屏共享同一笔预测，切换任务不丢掉原任务结果', async () => {
    let resolve!: (prompt: string) => void;
    const predict = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    const first = renderHook(({ id }) => useHarness(id, READY, predict), { initialProps: { id: 'a' } });
    const second = renderHook(() => useHarness('a', READY, predict));
    act(complete);
    expect(predict).toHaveBeenCalledTimes(1);
    first.rerender({ id: 'b' });
    await act(async () => resolve('原任务推荐'));
    expect(first.result.current).toBeUndefined();
    expect(second.result.current?.prompt).toBe('原任务推荐');
    first.rerender({ id: 'a' });
    expect(first.result.current?.prompt).toBe('原任务推荐');
  });

  it('候选被发送消费后，清空草稿不能重新发起预测', async () => {
    const predict = vi.fn(async () => '不应生成');
    const hook = renderHook(({ ready }) => useHarness('a', ready, predict), {
      initialProps: { ready: { ...READY, hasMessage: true } },
    });
    act(complete);
    act(() => dismissPromptRecommendation('a'));
    await act(async () => hook.rerender({ ready: READY }));
    expect(hook.result.current).toBeUndefined();
    expect(predict).not.toHaveBeenCalled();
  });
});
