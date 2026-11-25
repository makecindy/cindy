// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexContextWindow } from '@/hooks/useCodexContextWindow';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { evictDeviceProviders } from '@/hooks/useDeviceProviders';
const originalApi = window.electronAPI;
beforeEach(() => setDataOwnerGeneration('owner-a'));
afterEach(() => Object.defineProperty(window, 'electronAPI', { configurable: true, value: originalApi }));
function installApi(getModelContextLimit: unknown, invoke?: unknown) {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    maker: { getModelContextLimit }, deviceLink: { invoke },
  } });
}
const info = { contextWindow: 272_000, usableContextWindow: 258_400, autoCompactTokenLimit: 244_800 };
describe('native Codex capacity lookup', () => {
  // #11716/#4477, unit: the old hook had no device scope and read the controller.
  // Minimal input: the same task/model on two devices with different native windows.
  it('reads the target task without consulting controller preferences and rejects a late device reply', async () => {
    let finish!: (value: unknown) => void;
    const local = vi.fn(async () => ({ codexContext: info }));
    const invoke = vi.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ codexContext: { ...info, contextWindow: 100_000 } });
    installApi(local, invoke);
    const { result, rerender } = renderHook(({ deviceId }) => useCodexContextWindow({
      enabled: true, deviceId, providerId: 'xd', modelId: 'gpt', sessionId: 'same-id',
    }), { initialProps: { deviceId: 'device-a' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('device-a', 'maker:model-context-limit:get', [{
      agent: 'codex', providerId: 'xd', modelId: 'gpt', sessionId: 'same-id',
    }]));
    rerender({ deviceId: 'device-b' });
    await waitFor(() => expect(result.current?.contextWindow).toBe(100_000));
    await act(async () => finish({ codexContext: info }));
    expect(result.current?.contextWindow).toBe(100_000);
    expect(local).not.toHaveBeenCalled();
  });
  it.each(['unsupported', 'timeout', 'disconnected'])('keeps a remote %s unknown instead of using local config', async error => {
    const local = vi.fn(async () => ({ codexContext: info }));
    installApi(local, vi.fn().mockRejectedValue(new Error(error)));
    const { result } = renderHook(() => useCodexContextWindow({
      enabled: true, deviceId: 'device-a', providerId: 'xd', modelId: 'gpt', sessionId: 'task',
    }));
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(local).not.toHaveBeenCalled();
  });
  it('discards in-flight facts on peer invalidation without retrying a disconnected peer', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn().mockReturnValue(new Promise(resolve => { finish = resolve; }));
    installApi(vi.fn(), invoke);
    const { result } = renderHook(() => useCodexContextWindow({
      enabled: true, deviceId: 'device-a', providerId: 'xd', modelId: 'gpt', sessionId: 'task',
    }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    act(() => evictDeviceProviders('device-a'));
    await act(async () => finish({ codexContext: info }));
    expect(result.current).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('clears the previous account and rejects its delayed read', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ codexContext: null });
    installApi(vi.fn(), invoke);
    const { result } = renderHook(() => useCodexContextWindow({
      enabled: true, deviceId: 'device-a', providerId: 'xd', modelId: 'gpt', sessionId: 'task',
    }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    act(() => setDataOwnerGeneration('owner-b'));
    await act(async () => finish({ codexContext: info }));
    expect(result.current).toBeNull();
  });
  it('does not restore a retired peer snapshot when re-enabling the lookup', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ codexContext: info })
      .mockImplementation(() => new Promise(() => {}));
    installApi(vi.fn(), invoke);
    const { result, rerender } = renderHook(({ enabled }) => useCodexContextWindow({
      enabled, deviceId: 'device-a', providerId: 'xd', modelId: 'gpt', sessionId: 'task',
    }), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current).toEqual(info));
    rerender({ enabled: false });
    act(() => evictDeviceProviders('device-a'));
    rerender({ enabled: true });
    expect(result.current).toBeNull();
  });
  it('coalesces repeated inspections while the same remote native read is pending', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ codexContext: { ...info, contextWindow: 100_000 } });
    installApi(vi.fn(), invoke);
    const { result, rerender } = renderHook(({ refreshKey }) => useCodexContextWindow({
      enabled: true, deviceId: 'device-a', providerId: 'xd', modelId: 'gpt', sessionId: 'task', refreshKey,
    }), { initialProps: { refreshKey: '0' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    rerender({ refreshKey: '1' });
    rerender({ refreshKey: '2' });
    rerender({ refreshKey: '3' });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => finish({ codexContext: info }));
    await waitFor(() => expect(result.current?.contextWindow).toBe(100_000));
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('waits for the native hidden-window signal before reading a hidden remote view', async () => {
    let hiddenChanged: ((hidden: boolean) => void) | undefined;
    const offHidden = vi.fn();
    const invoke = vi.fn().mockResolvedValue({ codexContext: info });
    installApi(vi.fn(), invoke);
    Object.assign(window.electronAPI, { onWindowHiddenChange: (callback: typeof hiddenChanged) => {
      hiddenChanged = callback; return offHidden;
    } });
    document.documentElement.setAttribute('data-app-hidden', '');
    const { result, unmount } = renderHook(() => useCodexContextWindow({
      enabled: true, deviceId: 'device-a', providerId: 'xd', modelId: 'gpt', sessionId: 'task',
    }));
    document.documentElement.removeAttribute('data-app-hidden');
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
    act(() => hiddenChanged?.(false));
    await waitFor(() => expect(result.current).toEqual(info));
    unmount();
    expect(offHidden).toHaveBeenCalledTimes(1);
  });
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
    await waitFor(() => expect(getModelContextLimit).toHaveBeenCalledTimes(1));
    rerender({ modelId: 'glm' });
    await act(async () => finish({ codexContext: info }));
    expect(result.current).toBeNull();
  });
});
