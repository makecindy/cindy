// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '../../contexts/dataOwnerGeneration';
import { useModelContextLimit } from '../useModelContextLimit';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const target = { agent: 'codex' as const, providerId: 'openai', modelId: 'gpt-test' };
const view = (limit: number | null) => ({ limit, isCustomized: limit !== null });
const get = vi.fn();
const set = vi.fn();
const setCompaction = vi.fn();
let providersChanged: () => void;
beforeEach(() => {
  vi.resetAllMocks();
  setDataOwnerGeneration('owner-a', 1);
  Object.assign(window, {
    electronAPI: { maker: {
      getModelContextLimit: get, setModelContextLimit: set, setModelCompaction: setCompaction,
      onProvidersChanged: (listener: () => void) => { providersChanged = listener; return () => {}; },
    } },
  });
});

// B2: existing ownership tests did not overlap provider notifications with saves.
// Unit tier: deferred IPC drives the real hook; assert committed values and visible errors.
describe('provider refresh during model settings saves', () => {
  const piTarget = { ...target, agent: 'pi' as const };
  const saved = { ...view(128_000), compaction: { pct: 90, isCustomized: false } };
  const mutations = [
    { name: 'window', start: (hook: ReturnType<typeof useModelContextLimit>) => hook.setLimit(256_000),
      result: { ...saved, ...view(256_000) }, api: set },
    { name: 'reset', start: (hook: ReturnType<typeof useModelContextLimit>) => hook.reset(),
      result: { ...saved, ...view(null) }, api: set },
    { name: 'compaction', start: (hook: ReturnType<typeof useModelContextLimit>) => hook.setCompaction(80),
      result: { ...saved, compaction: { pct: 80, isCustomized: true } }, api: setCompaction },
  ];

  it.each(mutations)('keeps the committed $name after a refresh during save', async ({ start, result, api }) => {
    const pending = deferred<typeof saved>();
    get.mockResolvedValue(saved);
    api.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useModelContextLimit(piTarget));
    await act(async () => {});
    let saving!: Promise<void>;
    act(() => { saving = start(hook.result.current); });
    await act(async () => { providersChanged(); });
    expect(hook.result.current.loading).toBe(true);
    await act(async () => { get.mockResolvedValue(result); pending.resolve(result); await saving; });
    expect(hook.result.current).toMatchObject({ ...result, error: false, loading: false });
    hook.unmount();
  });

  it.each(mutations)('shows a failed $name and its recovered value despite refreshes', async ({ start, api }) => {
    const pending = deferred<typeof saved>();
    const recovery = deferred<typeof saved>();
    get.mockResolvedValue(saved);
    api.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useModelContextLimit(piTarget));
    await act(async () => {});
    let saving!: Promise<void>;
    act(() => { saving = start(hook.result.current); });
    await act(async () => { providersChanged(); });
    get.mockReturnValueOnce(recovery.promise);
    await act(async () => { pending.reject(new Error('synthetic save failure')); });
    await act(async () => { providersChanged(); });
    const recovered = { ...saved, ...view(192_000) };
    await act(async () => { get.mockResolvedValue(recovered); recovery.resolve(recovered); await saving; });
    expect(hook.result.current).toMatchObject({ ...recovered, error: true, loading: false });
    hook.unmount();
  });

  it('keeps Codex native readback authoritative while provider events arrive', async () => {
    const native = deferred<typeof saved>();
    get.mockResolvedValueOnce(view(128_000)).mockReturnValueOnce(native.promise);
    set.mockResolvedValue(view(256_000));
    const hook = renderHook(() => useModelContextLimit(target));
    await act(async () => {});
    let saving!: Promise<void>;
    await act(async () => { saving = hook.result.current.setLimit(256_000); });
    await act(async () => { providersChanged(); });
    // Main snapshots preferences before awaiting native metadata; a second window can update them meanwhile.
    const latest = { ...saved, ...view(240_000), compaction: { pct: 80, isCustomized: true } };
    await act(async () => {
      get.mockResolvedValue(latest);
      native.resolve({ ...saved, ...view(240_000) });
      await saving;
    });
    expect(hook.result.current).toMatchObject({ ...latest, error: false, loading: false });
    hook.unmount();
  });

  it('ignores a pre-save read that returns after the save, then accepts a new refresh', async () => {
    const oldRead = deferred<ReturnType<typeof view>>();
    get.mockResolvedValueOnce(view(128_000)).mockReturnValueOnce(oldRead.promise);
    set.mockResolvedValue(view(256_000));
    const hook = renderHook(() => useModelContextLimit(piTarget));
    await act(async () => {});
    act(() => { providersChanged(); });
    await act(async () => { await hook.result.current.setLimit(256_000); });
    await act(async () => { oldRead.resolve(view(128_000)); });
    expect(hook.result.current.limit).toBe(256_000);
    get.mockResolvedValueOnce(view(384_000));
    await act(async () => { providersChanged(); });
    expect(hook.result.current.limit).toBe(384_000);
    hook.unmount();
  });

  it.each(['success', 'failure'])('ignores an older save %s after a newer save starts', async (outcome) => {
    const first = deferred<ReturnType<typeof view>>();
    const second = deferred<ReturnType<typeof view>>();
    get.mockResolvedValue(view(128_000));
    set.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const hook = renderHook(() => useModelContextLimit(piTarget));
    await act(async () => {});
    act(() => { void hook.result.current.setLimit(256_000); void hook.result.current.setLimit(384_000); });
    await act(async () => {
      if (outcome === 'success') first.resolve(view(256_000));
      else first.reject(new Error('older save failed'));
      providersChanged();
    });
    expect(hook.result.current.loading).toBe(true);
    await act(async () => { get.mockResolvedValue(view(384_000)); second.resolve(view(384_000)); });
    expect(hook.result.current).toMatchObject({ limit: 384_000, error: false, loading: false });
    hook.unmount();
  });

  it.each(['model', 'owner'])('allows the new %s to refresh while the old save is pending', async (boundary) => {
    const pending = deferred<ReturnType<typeof view>>();
    get.mockResolvedValueOnce(view(128_000)).mockResolvedValue(view(64_000));
    set.mockReturnValueOnce(pending.promise);
    const hook = renderHook(({ modelId }) => useModelContextLimit({ ...piTarget, modelId }),
      { initialProps: { modelId: 'old' } });
    await act(async () => {});
    act(() => { void hook.result.current.setLimit(256_000); });
    await act(async () => { providersChanged(); });
    await act(async () => {
      if (boundary === 'model') hook.rerender({ modelId: 'new' });
      else { setDataOwnerGeneration('owner-b', 2); providersChanged(); }
    });
    expect(hook.result.current.limit).toBe(64_000);
    await act(async () => { pending.reject(new Error('old scope failed')); });
    expect(hook.result.current).toMatchObject({ limit: 64_000, error: false, loading: false });
    hook.unmount();
  });
});
describe('context editor request ownership', () => {
  it('writes compaction separately from the window with the same owner stamp and reads native facts back', async () => {
    get.mockResolvedValue(view(272_000));
    setCompaction.mockResolvedValue(view(272_000));
    const hook = renderHook(() => useModelContextLimit(target));
    await act(async () => {});
    await act(async () => { await hook.result.current.setCompaction(80); });
    expect(setCompaction).toHaveBeenCalledWith(target, 80, { dataOwnerId: 'owner-a', ownerGeneration: 1 });
    expect(set).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
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
