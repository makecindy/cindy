// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCodexContextWindow } from '@/hooks/useCodexContextWindow';
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ generation: 1 }),
  isDataOwnerGenerationCurrent: () => true,
}));
const originalApi = window.electronAPI;
afterEach(() => Object.defineProperty(window, 'electronAPI', { configurable: true, value: originalApi }));
function installApi(getModelContextLimit: unknown) {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { getModelContextLimit } } });
}
const info = { contextWindow: 272_000, usableContextWindow: 258_400, autoCompactTokenLimit: 244_800 };
describe('native Codex capacity lookup', () => {
  it('refreshes pending configuration when inspecting an idle task again', async () => {
    const getModelContextLimit = vi.fn()
      .mockResolvedValueOnce({ codexContext: { ...info, pendingApply: true } })
      .mockResolvedValue({ codexContext: { ...info, contextWindow: 1_000_000, pendingApply: true } });
    installApi(getModelContextLimit);
    const { result, rerender } = renderHook(({ refreshKey }) => useCodexContextWindow({
      enabled: true, providerId: 'xd', modelId: 'gpt', sessionId: 'idle-task', refreshKey,
    }), { initialProps: { refreshKey: 'idle:0' } });
    await waitFor(() => expect(result.current?.contextWindow).toBe(272_000));
    rerender({ refreshKey: 'idle:1' });
    await waitFor(() => expect(result.current).toMatchObject({ contextWindow: 1_000_000, pendingApply: true }));
  });
  it('queries only the existing task and ignores model preference limits', async () => {
    const getModelContextLimit = vi.fn(async () => ({ limit: 1_000_000, codexContext: info }));
    installApi(getModelContextLimit);
    const { result } = renderHook(() => useCodexContextWindow({
      enabled: true, providerId: 'xd', modelId: 'glm', sessionId: 'running-task', reportedWindow: 258_400,
    }));
    await waitFor(() => expect(result.current).toEqual(info));
    expect(getModelContextLimit).toHaveBeenCalledWith({ agent: 'codex', providerId: 'xd', modelId: 'glm', sessionId: 'running-task' });
  });
  it('rejects delayed facts from the previously selected model', async () => {
    let finish!: (value: unknown) => void;
    const getModelContextLimit = vi.fn()
      .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ limit: 500_000 });
    installApi(getModelContextLimit);
    const { result, rerender } = renderHook(({ modelId }) => useCodexContextWindow({ enabled: true, providerId: 'xd', modelId }), {
      initialProps: { modelId: 'gpt' },
    });
    rerender({ modelId: 'glm' });
    await act(async () => finish({ codexContext: info }));
    expect(result.current).toBeNull();
  });
});
