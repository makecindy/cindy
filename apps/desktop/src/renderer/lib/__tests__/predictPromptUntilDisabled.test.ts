import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.useFakeTimers();
  _resetPromptRecommendationPreferenceForTests();
  syncPromptRecommendationPreferenceFromStorageValue('true');
});
afterEach(() => vi.useRealTimers());

// Unit regression: a remote timeout must recover the host's existing prediction;
// the old helper only covered preference cancellation, not transport recovery.
describe('prediction recovery', () => {
  it.each(['timeout', 'busy', 'pending'])('recovers %s using the exact same host completion', async (kind) => {
    const api = { predictNextPrompt: vi.fn().mockResolvedValue({ prompt: 'received' }) };
    if (kind === 'timeout') api.predictNextPrompt.mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] slow'));
    else if (kind === 'busy') api.predictNextPrompt.mockRejectedValueOnce(new Error('[DEVICE_LINK_BUSY] busy'));
    else api.predictNextPrompt.mockResolvedValueOnce({ prompt: null, retryable: true });
    const pending = predictPromptUntilDisabled(api, request);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ prompt: 'received' });
    expect(api.predictNextPrompt.mock.calls).toEqual([[request], [request]]);
  });

  it('bounds recovery while another controller of the same host completes without waiting', async () => {
    // Two controller routes share B; A's timeout/backoff must not block C's in-flight request.
    const a = { predictNextPrompt: vi.fn().mockRejectedValue(new Error('[DEVICE_LINK_TIMEOUT] slow')) };
    let resolveC!: (value: { prompt: string }) => void;
    const c = { predictNextPrompt: vi.fn(() => new Promise<{ prompt: string }>(resolve => { resolveC = resolve; })) };
    const failed = expect(predictPromptUntilDisabled(a, request)).rejects.toThrow('slow');
    const other = predictPromptUntilDisabled(c, request);
    resolveC({ prompt: 'Other controller received' });
    await expect(other).resolves.toEqual({ prompt: 'Other controller received' });
    expect(a.predictNextPrompt).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await failed;
    expect(a.predictNextPrompt).toHaveBeenCalledTimes(4);
    expect(c.predictNextPrompt).toHaveBeenCalledTimes(1);
  });

  it('does not retry a terminal empty result or permission rejection', async () => {
    const api = { predictNextPrompt: vi.fn().mockResolvedValue({ prompt: null }) };
    await expect(predictPromptUntilDisabled(api, request)).resolves.toEqual({ prompt: null });
    expect(api.predictNextPrompt).toHaveBeenCalledTimes(1);
    api.predictNextPrompt.mockRejectedValueOnce(new Error('[DEVICE_LINK_ACCESS_REVOKED] revoked'));
    await expect(predictPromptUntilDisabled(api, request)).rejects.toThrow('revoked');
    expect(api.predictNextPrompt).toHaveBeenCalledTimes(2);
  });

  it.each(['superseded', 'disabled'])('does not retry after the request is %s', async (reason) => {
    let current = true;
    const api = { predictNextPrompt: vi.fn().mockRejectedValue(new Error('[DEVICE_LINK_TIMEOUT] slow')) };
    const pending = predictPromptUntilDisabled(api, request, () => current);
    await vi.advanceTimersByTimeAsync(0);
    if (reason === 'superseded') current = false;
    else syncPromptRecommendationPreferenceFromStorageValue('false');
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ prompt: null });
    expect(api.predictNextPrompt.mock.calls.filter(([value]) => !value.cancel)).toHaveLength(1);
  });
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
