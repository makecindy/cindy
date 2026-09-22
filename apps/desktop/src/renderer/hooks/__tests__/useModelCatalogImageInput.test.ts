// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelCatalogImageInput } from '../useModelCatalogImageInput';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const target = { agent: 'pi' as const, providerId: 'opencode-go', modelId: 'mimo-v2.6-flash' };
const view = (value: boolean | null) => ({ value, isCustomized: value !== null });
const get = vi.fn();
const set = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(window, {
    electronAPI: {
      maker: { getModelCatalogImageInput: get, setModelCatalogImageInput: set },
    },
  });
});

describe('model catalog image input override', () => {
  it('loads the current declaration', async () => {
    get.mockResolvedValue(view(null));
    const hook = renderHook(() => useModelCatalogImageInput(target));
    await act(async () => {});
    expect(get).toHaveBeenCalledWith(target);
    expect(hook.result.current).toMatchObject({ value: null, isCustomized: false, loading: false });
  });

  it('applies the written declaration', async () => {
    get.mockResolvedValue(view(null));
    set.mockResolvedValue(view(true));
    const hook = renderHook(() => useModelCatalogImageInput(target));
    await act(async () => {});
    let persisted = false;
    await act(async () => {
      persisted = await hook.result.current.setValue(true);
    });
    expect(set).toHaveBeenCalledWith(target, true);
    expect(persisted).toBe(true);
    expect(hook.result.current).toMatchObject({ value: true, isCustomized: true, saving: false });
  });

  it('reflects the new value before the write echoes back', async () => {
    get.mockResolvedValue(view(null));
    const pending = deferred<ReturnType<typeof view>>();
    set.mockReturnValue(pending.promise);
    const hook = renderHook(() => useModelCatalogImageInput(target));
    await act(async () => {});
    // 不等待回声：调用后立即就是新值（消除「点完卡一下」的观感）。
    act(() => {
      void hook.result.current.setValue(true);
    });
    expect(hook.result.current.value).toBe(true);
    expect(hook.result.current.isCustomized).toBe(true);
    expect(hook.result.current.saving).toBe(true);
    await act(async () => {
      pending.resolve(view(true));
    });
    expect(hook.result.current).toMatchObject({ value: true, saving: false });
  });

  it('reverts to the committed value when the write fails instead of keeping the optimistic one', async () => {
    get.mockResolvedValue(view(false));
    set.mockRejectedValue(new Error('persist failed'));
    const hook = renderHook(() => useModelCatalogImageInput(target));
    await act(async () => {});
    let persisted = true;
    await act(async () => {
      persisted = await hook.result.current.setValue(true);
    });
    // 回读拿到的真值（false）必须盖掉乐观值，并标 error；返回值告诉调用方别提示成功。
    expect(persisted).toBe(false);
    expect(hook.result.current).toMatchObject({ value: false, isCustomized: true, error: true });
  });

  it('falls back to "follow the catalog" when both the write and the recovery read fail', async () => {
    get.mockResolvedValueOnce(view(true)).mockRejectedValue(new Error('read failed'));
    set.mockRejectedValue(new Error('persist failed'));
    const hook = renderHook(() => useModelCatalogImageInput(target));
    await act(async () => {});
    await act(async () => {
      await hook.result.current.setValue(null);
    });
    expect(hook.result.current).toMatchObject({ value: null, isCustomized: false, error: true });
  });

  it('does not let a stale read for a previous model win', async () => {
    const stale = deferred<ReturnType<typeof view>>();
    get.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(view(true));
    const hook = renderHook(({ modelId }) => useModelCatalogImageInput({ ...target, modelId }), {
      initialProps: { modelId: 'old' },
    });
    await act(async () => {
      hook.rerender({ modelId: 'new' });
    });
    expect(hook.result.current.value).toBe(true);
    await act(async () => {
      stale.resolve(view(false));
    });
    expect(hook.result.current.value).toBe(true);
    hook.unmount();
  });
});
