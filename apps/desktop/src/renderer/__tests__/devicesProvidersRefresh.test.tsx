// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(cleanup);

function directory(ids = ['xd', 'ollama']) {
  return { modelVisibilityOverrides: { 'codex:xd:hidden': false }, providers: ids.map((id) => ({
    id, name: id, agents: ['codex'], connected: true, remoteInvocationEnabled: true,
    models: { codex: [] }, routing: { codex: {} },
  })) };
}

async function fixture(retainDisplaySnapshot = true) {
  const pending = new Map<string, {
    resolve: (value: ReturnType<typeof directory>) => void;
    reject: (error: Error) => void;
  }>();
  const held = new Set<string>();
  const invoke = vi.fn(async (device: string, channel: string) => {
    if (channel !== 'maker:provider:list') return {
      availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [],
    };
    if (!held.has(device)) return directory();
    return new Promise<ReturnType<typeof directory>>((resolve, reject) => {
      pending.set(device, { resolve, reject });
    });
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true, value: { deviceLink: { invoke } },
  });
  const mod = await import('@/hooks/useDeviceProviders');
  const { useDevicesProviders } = await import('@/hooks/useDevicesProviders');
  const { refreshRemoteCatalogSnapshot } = await import('@/lib/remoteCatalogSnapshot');
  const hook = renderHook(({ ids }) => useDevicesProviders(
    ids, retainDisplaySnapshot ? { retainDisplaySnapshot: true } : undefined,
  ), {
    initialProps: { ids: ['a', 'b'] },
  });
  await waitFor(() => expect(hook.result.current.get('a')?.providers).toHaveLength(2));
  await waitFor(() => expect(hook.result.current.get('b')?.providers).toHaveLength(2));
  async function start() {
    held.add('a');
    let done!: Promise<void>;
    act(() => { done = refreshRemoteCatalogSnapshot('a'); });
    await waitFor(() => expect(pending.has('a')).toBe(true));
    return { done };
  }
  return { ...hook, mod, invoke, pending, held, start, refreshRemoteCatalogSnapshot };
}

describe('multi-device provider rows during real catalog refresh', () => {
  it('keeps the default model-selector consumer empty and loading during refresh', async () => {
    const f = await fixture(false);
    const { done } = await f.start();
    expect(f.result.current.get('a')).toMatchObject({ providers: [], loading: true, error: null });
    expect(f.result.current.get('b')?.providers).toHaveLength(2);
    await act(async () => { f.pending.get('a')!.resolve(directory()); await done; });
    expect(f.result.current.get('a')?.providers).toHaveLength(2);
    expect(f.result.current.get('a')?.loading).toBe(false);
  });

  it('keeps both existing rows through repeated refreshes, then publishes the new list', async () => {
    const f = await fixture();
    for (let n = 0; n < 2; n++) {
      const { done } = await f.start();
      expect(f.mod.getCachedDeviceProviders('a')).toBeNull();
      expect(f.result.current.get('a')).toMatchObject({ loading: true, error: null });
      expect(f.result.current.get('a')?.providers.map(p => p.id)).toEqual(['xd', 'ollama']);
      expect(f.result.current.get('a')?.modelVisibilityOverrides).toEqual({ 'codex:xd:hidden': false });
      expect(f.result.current.get('b')?.providers).toHaveLength(2);
      await act(async () => { f.pending.get('a')!.resolve(directory()); await done; });
      f.pending.delete('a');
    }
    const { done } = await f.start();
    await act(async () => { f.pending.get('a')!.resolve(directory(['xd'])); await done; });
    expect(f.result.current.get('a')?.providers.map(p => p.id)).toEqual(['xd']);
    expect(f.result.current.get('a')?.loading).toBe(false);
  });

  it('accepts an authoritative empty list', async () => {
    const f = await fixture();
    const { done } = await f.start();
    await act(async () => { f.pending.get('a')!.resolve(directory([])); await done; });
    expect(f.result.current.get('a')).toMatchObject({ providers: [], loading: false, error: null });
  });

  it('retains rows across overlapping refreshes without publishing a stale result', async () => {
    const f = await fixture();
    const first = await f.start();
    const old = f.pending.get('a')!;
    let trailing!: Promise<void>;
    act(() => { trailing = f.refreshRemoteCatalogSnapshot('a'); });
    expect(f.result.current.get('a')?.providers).toHaveLength(2);
    await act(async () => { old.resolve(directory(['stale'])); });
    await waitFor(() => expect(f.pending.get('a')).not.toBe(old));
    expect(f.result.current.get('a')?.providers.map(p => p.id)).toEqual(['xd', 'ollama']);
    await act(async () => {
      f.pending.get('a')!.resolve(directory(['latest']));
      await Promise.all([first.done, trailing]);
    });
    expect(f.result.current.get('a')?.providers.map(p => p.id)).toEqual(['latest']);
  });

  it('clears display data on failure instead of presenting it as a usable directory', async () => {
    const f = await fixture();
    const { done } = await f.start();
    await act(async () => { f.pending.get('a')!.reject(new Error('[ACCESS_REVOKED] denied')); await done; });
    expect(f.result.current.get('a')).toMatchObject({ providers: [], loading: false });
    expect(f.result.current.get('a')?.error).toContain('ACCESS_REVOKED');
  });

  it('clears immediately on a real eviction and ignores the late refresh', async () => {
    const f = await fixture();
    const { done } = await f.start();
    act(() => { f.mod.evictDeviceProviders('a'); });
    expect(f.result.current.get('a')?.providers).toEqual([]);
    await act(async () => { f.pending.get('a')!.resolve(directory()); await done; });
    expect(f.result.current.get('a')?.providers).toEqual([]);
    expect(f.result.current.get('b')?.providers).toHaveLength(2);
  });

  it('does not restore a removed device from its old display snapshot', async () => {
    const f = await fixture();
    const { done } = await f.start();
    f.rerender({ ids: ['b'] });
    expect(f.result.current.has('a')).toBe(false);
    act(() => { f.mod.evictDeviceProviders('a'); });
    await act(async () => { f.pending.get('a')!.resolve(directory()); await done; });
    f.pending.delete('a');
    f.rerender({ ids: ['a', 'b'] });
    expect(f.result.current.get('a')?.providers).toEqual([]);
    await waitFor(() => expect(f.pending.has('a')).toBe(true));
    await act(async () => { f.pending.get('a')!.resolve(directory([])); });
  });
});
