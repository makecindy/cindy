// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '../../contexts/dataOwnerGeneration';
import { useModelImageInputOverride } from '../useModelImageInputOverride';

const target = { agent: 'pi' as const, providerId: 'relay', modelId: 'vision' };
const view = (value: boolean | null) => ({ value, mixed: false });
const get = vi.fn();
const set = vi.fn();
let changed: () => void;
let authChanged: () => void;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  authChanged = () => {};
  setDataOwnerGeneration('owner-a', 1);
  Object.assign(window, {
    electronAPI: {
      onAuthStateChange: (listener: () => void) => {
        authChanged = listener;
        return () => {};
      },
      maker: {
        getModelImageInputOverride: get,
        setModelImageInputOverride: set,
        onProvidersChanged: (listener: () => void) => {
          changed = listener;
          return () => {};
        },
      },
    },
  });
});
// Unit: new hook; real request lifecycle with deferred IPC. False, reset, failure,
// catalog pushes and owner/model changes produce distinct visible results.
describe('image input override editor', () => {
  // Same-owner repair advances the IPC fence without remounting the drawer.
  // A new read must settle loading even if the old read/save has not returned.
  it.each(['read', 'save'])('recovers after an owner generation change during %s without a provider push', async (operation) => {
    const pending = deferred<ReturnType<typeof view>>();
    get.mockResolvedValue(view(null));
    if (operation === 'read') get.mockImplementationOnce(() => pending.promise);
    else set.mockReturnValue(pending.promise);
    const hook = renderHook(() => useModelImageInputOverride(target));
    await act(async () => {});
    let saving: Promise<void> | undefined;
    if (operation === 'save') act(() => { saving = hook.result.current.setValue(true); });
    expect(hook.result.current.loading).toBe(true);
    await act(async () => {
      get.mockResolvedValue(view(false));
      setDataOwnerGeneration('owner-a', 2);
      authChanged();
    });
    expect(hook.result.current).toMatchObject({ value: false, loading: false, error: false });
    await act(async () => {
      pending.resolve(view(true));
      await saving;
    });
    expect(hook.result.current).toMatchObject({ value: false, loading: false, error: false });
    hook.unmount();
  });
  it.each([true, false, null])(
    'keeps %s after a catalog notification during save',
    async (value) => {
      const pending = deferred<ReturnType<typeof view>>();
      get.mockResolvedValue(view(null));
      set.mockReturnValue(pending.promise);
      const hook = renderHook(() => useModelImageInputOverride(target));
      await act(async () => {});
      let saving!: Promise<void>;
      act(() => {
        saving = hook.result.current.setValue(value);
      });
      act(() => changed());
      expect(hook.result.current.loading).toBe(true);
      await act(async () => {
        get.mockResolvedValue(view(value));
        pending.resolve(view(value));
        await saving;
      });
      expect(hook.result.current).toMatchObject({ ...view(value), loading: false, error: false });
      expect(set).toHaveBeenCalledWith(target, value, {
        dataOwnerId: 'owner-a',
        ownerGeneration: 1,
      });
      hook.unmount();
    },
  );
  it('shows the committed value and error after a rejected save', async () => {
    get.mockResolvedValue(view(false));
    set.mockRejectedValue(new Error('refresh failed'));
    const hook = renderHook(() => useModelImageInputOverride(target));
    await act(async () => {});
    await act(async () => {
      await hook.result.current.setValue(true);
    });
    expect(hook.result.current).toMatchObject({ value: false, error: true, loading: false });
    hook.unmount();
  });
  it('does not replace the newly selected model with the previous save result', async () => {
    const pending = deferred<ReturnType<typeof view>>();
    get.mockResolvedValue(view(null));
    set.mockReturnValue(pending.promise);
    const hook = renderHook(({ modelId }) => useModelImageInputOverride({ ...target, modelId }), {
      initialProps: { modelId: 'vision' },
    });
    await act(async () => {});
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.setValue(true);
    });
    hook.rerender({ modelId: 'other' });
    await act(async () => {
      pending.resolve(view(true));
      await saving;
    });
    expect(hook.result.current.value).toBeNull();
    hook.unmount();
  });
});
