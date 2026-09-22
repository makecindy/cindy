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
const ownerState = { current: true };
let providersChanged: (() => void) | undefined;

vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
  isDataOwnerGenerationCurrent: () => ownerState.current,
}));

beforeEach(() => {
  vi.clearAllMocks();
  ownerState.current = true;
  providersChanged = undefined;
  Object.assign(window, {
    electronAPI: {
      maker: {
        getModelCatalogImageInput: get,
        setModelCatalogImageInput: set,
        onProvidersChanged: (callback: () => void) => {
          providersChanged = callback;
          return () => {};
        },
      },
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

  it('ignores broadcasts that arrive while a write is in flight', async () => {
    // 写入成功后 main 会广播 PROVIDER_CHANGED；而其它窗口期的广播可能在写盘前就到达。
    // 若让它触发的 GET 顶掉 generation，写入自己的回声会被丢弃，UI 停在旧值而写其实成功。
    get.mockResolvedValue(view(null));
    const pending = deferred<ReturnType<typeof view>>();
    set.mockReturnValue(pending.promise);
    const hook = renderHook(() => useModelCatalogImageInput(target));
    await act(async () => {});
    const callsAfterMount = get.mock.calls.length;

    act(() => {
      void hook.result.current.setValue(true);
    });
    expect(hook.result.current.value).toBe(true);

    // 写在途时的广播：不得再发 GET（发了就会抢走写入的回声）。
    await act(async () => {
      providersChanged?.();
    });
    expect(get.mock.calls.length).toBe(callsAfterMount);

    await act(async () => {
      pending.resolve(view(true));
    });
    expect(hook.result.current).toMatchObject({ value: true, isCustomized: true, saving: false });
  });

  it('still reads a different model while a write for another row is in flight', async () => {
    // 写在途时跳过回读只对同一个 target 生效：否则写 A 行后立刻打开 B 行，B 的回读会被跳过、
    // 界面永远停在 loading（显示成「跟随供应商」且点击无效）。
    const pendingWrite = deferred<ReturnType<typeof view>>();
    get.mockResolvedValue(view(null));
    set.mockReturnValue(pendingWrite.promise);
    const hook = renderHook(({ modelId }) => useModelCatalogImageInput({ ...target, modelId }), {
      initialProps: { modelId: 'mimo-v2.6-flash' },
    });
    await act(async () => {});
    act(() => {
      void hook.result.current.setValue(true);
    });

    get.mockResolvedValue(view(false));
    await act(async () => {
      hook.rerender({ modelId: 'gpt-6' });
    });
    // 新行的读取没有被在途写吞掉，拿到的是自己的值。
    expect(get).toHaveBeenLastCalledWith({ ...target, modelId: 'gpt-6' });
    expect(hook.result.current).toMatchObject({
      value: false,
      isCustomized: true,
      loading: false,
    });

    await act(async () => {
      pendingWrite.resolve(view(true));
    });
    hook.unmount();
  });

  it('drops a response that lands after the data owner changed', async () => {
    const pending = deferred<ReturnType<typeof view>>();
    get.mockReturnValue(pending.promise);
    const hook = renderHook(() => useModelCatalogImageInput(target));

    // 切号（账号/session owner 代次变化）后旧响应不得写进状态。
    ownerState.current = false;
    await act(async () => {
      pending.resolve(view(true));
    });
    expect(hook.result.current.value).toBeNull();
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
