import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPromptRecommendationPreferenceForTests,
  syncPromptRecommendationPreferenceFromStorageValue,
} from '@/hooks/usePromptRecommendationPreference';
import { predictPromptUntilDisabled } from '../predictPromptUntilDisabled';

const request = {
  sessionId: 'original-session', agentKind: 'codex' as const, messages: [],
  turnGen: 0, completionRevision: 200,
};

beforeEach(() => {
  _resetPromptRecommendationPreferenceForTests();
  syncPromptRecommendationPreferenceFromStorageValue('true');
});

describe('request-owned prediction cancellation', () => {
  it('关闭开关后只向最初捕获的路由取消一次，重新打开也不恢复旧结果', async () => {
    let resolve!: (result: { prompt: string }) => void;
    const api = { predictNextPrompt: vi.fn()
      .mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValue({ prompt: null }) };
    const pending = predictPromptUntilDisabled(api, request);
    syncPromptRecommendationPreferenceFromStorageValue('false');
    syncPromptRecommendationPreferenceFromStorageValue('true');
    syncPromptRecommendationPreferenceFromStorageValue('false');
    expect(api.predictNextPrompt).toHaveBeenCalledTimes(2);
    expect(api.predictNextPrompt).toHaveBeenLastCalledWith({
      sessionId: 'original-session', completionRevision: 200, cancel: true,
    });
    resolve({ prompt: 'late result' });
    await expect(pending).resolves.toEqual({ prompt: null });
  });

  it('已关闭时不生成，已完成后释放订阅，下一轮仍能生成', async () => {
    const api = { predictNextPrompt: vi.fn().mockResolvedValue({ prompt: 'next' }) };
    await expect(predictPromptUntilDisabled(api, request)).resolves.toEqual({ prompt: 'next' });
    syncPromptRecommendationPreferenceFromStorageValue('false');
    await expect(predictPromptUntilDisabled(api, request)).resolves.toEqual({ prompt: null });
    expect(api.predictNextPrompt).toHaveBeenCalledTimes(1);
    syncPromptRecommendationPreferenceFromStorageValue('true');
    await predictPromptUntilDisabled(api, { ...request, completionRevision: 300 });
    expect(api.predictNextPrompt).toHaveBeenCalledTimes(2);
  });

  it('旧主机拒绝取消时也丢弃结果，取消载荷不带生成所需字段', async () => {
    let resolve!: (result: { prompt: string }) => void;
    const api = { predictNextPrompt: vi.fn()
      .mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockRejectedValue(new Error('[INVALID_PARAMS] legacy host')) };
    const pending = predictPromptUntilDisabled(api, request);
    syncPromptRecommendationPreferenceFromStorageValue('false');
    const cancellation = api.predictNextPrompt.mock.calls[1][0];
    expect(cancellation).not.toHaveProperty('agentKind');
    expect(cancellation).not.toHaveProperty('turnGen');
    resolve({ prompt: 'late result' });
    await expect(pending).resolves.toEqual({ prompt: null });
  });

  it('生成失败后释放订阅', async () => {
    const api = { predictNextPrompt: vi.fn().mockRejectedValue(new Error('failed')) };
    await expect(predictPromptUntilDisabled(api, request)).rejects.toThrow('failed');
    syncPromptRecommendationPreferenceFromStorageValue('false');
    expect(api.predictNextPrompt).toHaveBeenCalledTimes(1);
  });
});
