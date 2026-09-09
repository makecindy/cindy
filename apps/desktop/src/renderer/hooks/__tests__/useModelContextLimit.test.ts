// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '../../contexts/dataOwnerGeneration';
import { useModelContextLimit } from '../useModelContextLimit';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const target = { agent: 'codex' as const, providerId: 'openai', modelId: 'gpt-test' };
const view = (limit: number | null) => ({ limit, isCustomized: limit !== null });
const get = vi.fn();
const set = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner-a', 1);
  Object.assign(window, {
    electronAPI: { maker: { getModelContextLimit: get, setModelContextLimit: set } },
  });
});
describe('context editor request ownership', () => {
  it('does not let an old model read overwrite the current model', async () => {
    const old = deferred<ReturnType<typeof view>>();
    get.mockReturnValueOnce(old.promise).mockResolvedValueOnce(view(200_000));
    const hook = renderHook(({ modelId }) => useModelContextLimit({ ...target, modelId }), {
      initialProps: { modelId: 'old' },
    });
    await act(async () => {
      hook.rerender({ modelId: 'new' });
    });
    expect(hook.result.current.limit).toBe(200_000);
    await act(async () => {
      old.resolve(view(1_000_000));
    });
    expect(hook.result.current.limit).toBe(200_000);
    hook.unmount();
  });
  it('sends the owner stamp and never applies a write response to another owner', async () => {
    get.mockResolvedValue(view(null));
    const pending = deferred<ReturnType<typeof view>>();
    set.mockReturnValue(pending.promise);
    const hook = renderHook(() => useModelContextLimit(target));
    await act(async () => {});
    act(() => {
      void hook.result.current.setLimit(272_000);
    });
    expect(set).toHaveBeenCalledWith(target, 272_000, {
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
    });
    setDataOwnerGeneration('owner-b', 2);
    await act(async () => {
      pending.resolve(view(272_000));
    });
    expect(hook.result.current.limit).toBeNull();
    hook.unmount();
  });
  it('rereads the actual committed value when a save rejects', async () => {
    get.mockResolvedValueOnce(view(272_000)).mockResolvedValue(view(500_000));
    set.mockRejectedValueOnce(new Error('runtime refresh/rollback failed'));
    const hook = renderHook(() => useModelContextLimit(target));
    await act(async () => {});
    await act(async () => { await hook.result.current.setLimit(1_000_000); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(hook.result.current.limit).toBe(500_000);
    expect(hook.result.current.error).toBe(true);
    hook.unmount();
  });

  it('ignores a failure recovery read after switching models', async () => {
    const delayed = deferred<ReturnType<typeof view>>();
    get.mockResolvedValueOnce(view(272_000)).mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(view(128_000));
    set.mockRejectedValueOnce(new Error('refresh failed'));
    const hook = renderHook(({ modelId }) => useModelContextLimit({ ...target, modelId }),
      { initialProps: { modelId: 'old' } });
    await act(async () => {});
    await act(async () => { void hook.result.current.setLimit(1_000_000); });
    await act(async () => { hook.rerender({ modelId: 'new' }); });
    await act(async () => { delayed.resolve(view(500_000)); });
    expect(hook.result.current.limit).toBe(128_000);
    expect(hook.result.current.error).toBe(false);
    hook.unmount();
  });

  it('restores defaults by deletion and exposes failed saves', async () => {
    get.mockResolvedValueOnce(view(500_000)).mockResolvedValue(view(null));
    set.mockResolvedValueOnce(view(null)).mockRejectedValueOnce(new Error('disk full'));
    const hook = renderHook(() => useModelContextLimit(target));
    await act(async () => {});
    await act(async () => {
      await hook.result.current.reset();
    });
    expect(set).toHaveBeenLastCalledWith(target, null, {
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
    });
    expect(hook.result.current.isCustomized).toBe(false);
    await act(async () => {
      await hook.result.current.setLimit(272_000);
    });
    expect(hook.result.current.error).toBe(true);
    expect(hook.result.current.limit).toBeNull();
    hook.unmount();
  });
});
