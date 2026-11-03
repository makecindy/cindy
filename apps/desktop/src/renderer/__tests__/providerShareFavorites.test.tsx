// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseModelFavorites, providerShareParsers, type ProviderShareReceived } from '@cindy/device-link';
import type { ModelFavoritesHostApi } from '../../shared/modelFavoritesSync';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  __resetForTest, addModelFavorite, listModelFavorites, setModelFavoritesOwner, useModelFavorites,
} from '@/state/modelFavorites';
import {
  parseProviderShareFavoriteSource, providerShareFavoriteSource, reconcileProviderShareFavorites,
  useProviderShareFavorites, useProviderShareFavoriteCleanupFailed,
  useProviderShareFavoriteSources,
} from '@/state/providerShareFavorites';
import { useModelFavoritesHost } from '@/state/useModelFavoritesHost';

const share = (shareId = 's1', memberId = 'm1'): ProviderShareReceived => ({
  shareId, memberId, providerId: 'anthropic', providerLabel: 'Anthropic',
  hostDeviceId: 'host', deviceName: 'Host', status: 'active', hostOnline: true, hostCapable: true,
  owner: { displayName: 'Owner', avatarUrl: null, region: 'global' },
});
const config = { providerId: 'anthropic', modelId: 'opus', agent: 'cc' as const, effort: 'high' as const, fast: true as const };
const publish = (received: ProviderShareReceived[], confirmed = true, dataOwnerId = 'recipient', ownerGeneration = 1) => {
  reconcileProviderShareFavorites({ received, confirmedRegions: confirmed ? ['global', 'cn'] : [], ownerStamp: { dataOwnerId, ownerGeneration } });
};
const mount = (deviceId = 'share:s1') => renderHook(() => useProviderShareFavorites(deviceId, useModelFavorites()));

beforeEach(() => {
  __resetForTest();
  window.localStorage.clear();
  setDataOwnerGeneration('recipient', 1);
  setModelFavoritesOwner('recipient');
  publish([share(), share('s2', 'm2')]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('recipient-owned shared model favorites', () => {
  // #8028 r4429989411 / unit: B's membership is absent/different on A.
  // Exercise real projections and writes; never infer membership from an old favorite.
  it.each(['missing', 'different'])('uses B membership when A membership is %s and rejects replaced grants', mode => {
    publish(mode === 'missing' ? [] : [share('s1', 'a-member')], false);
    const bShare = share('s1', 'b-member');
    const item = { ...config, uid: 'b-favorite', providerId: providerShareFavoriteSource(bShare) };
    const home = { items: [item], store: { get: vi.fn(() => item), add: vi.fn(), update: vi.fn(), remove: vi.fn() } };
    const view = renderHook(({ sources }) => ({
      favorites: useProviderShareFavorites('share:s1', useModelFavorites(), home, sources),
      sources: useProviderShareFavoriteSources(sources),
    }), { initialProps: { sources: new Map([['share:s1', bShare]]) } });
    expect(view.result.current.sources.get(item.providerId)).toBe('share:s1');
    expect(view.result.current.favorites.items).toEqual([{ ...config, uid: item.uid }]);
    act(() => {
      view.result.current.favorites.store.add(config);
      view.result.current.favorites.store.update(item.uid, { effort: 'low' });
      view.result.current.favorites.store.remove(item.uid);
    });
    expect(home.store.add).toHaveBeenCalledWith({ ...config, providerId: item.providerId });
    expect(home.store.update).toHaveBeenCalledWith(item.uid, { effort: 'low' });
    expect(home.store.remove).toHaveBeenCalledWith(item.uid);
    expect(listModelFavorites()).toEqual([]);
    const stale = view.result.current.favorites.store;
    view.rerender({ sources: new Map([['share:s1', share('s1', 'replacement')]]) });
    expect(view.result.current.favorites.items).toEqual([]);
    expect(() => stale.add(config)).toThrow('Shared favorite source unavailable');
    expect(() => stale.remove(item.uid)).toThrow('Shared favorite source unavailable');
    view.rerender({ sources: new Map() });
    expect(view.result.current.sources.size).toBe(0);
    expect(() => view.result.current.favorites.store.add(config)).toThrow('Shared favorite source unavailable');
  });

  it('aggregates only exact, available grants for the current account', () => {
    const sources = renderHook(() => useProviderShareFavoriteSources());
    expect([...sources.result.current.values()]).toEqual(['share:s1', 'share:s2']);
    act(() => publish([{ ...share(), status: 'paused' }, { ...share('s2', 'm2'), hostOnline: false }]));
    expect(sources.result.current.size).toBe(0);
    act(() => publish([share('s1', 'replacement')]));
    expect(sources.result.current.has(providerShareFavoriteSource(share()))).toBe(false);
    expect(sources.result.current.get(providerShareFavoriteSource(share('s1', 'replacement')))).toBe('share:s1');
    act(() => { setDataOwnerGeneration('other', 2); publish([], true, 'other', 2); });
    expect(sources.result.current.size).toBe(0);
  });

  it('projects and edits the task computer store without touching the controller copy', () => {
    addModelFavorite(config);
    const item = { ...config, uid: 'remote-1', providerId: providerShareFavoriteSource(share()) };
    const home = { items: [item], store: {
      get: vi.fn((uid: string) => uid === item.uid ? item : undefined),
      add: vi.fn(), update: vi.fn(), remove: vi.fn(),
    } };
    const view = renderHook(() => useProviderShareFavorites('share:s1', useModelFavorites(), home));
    expect(view.result.current.items).toEqual([{ ...config, uid: item.uid }]);
    act(() => view.result.current.store.update(item.uid, { effort: 'low', fast: false }));
    expect(home.store.update).toHaveBeenCalledWith(item.uid, { effort: 'low', fast: false });
    expect(() => view.result.current.store.update('unknown', { effort: 'low' })).toThrow();
    expect(listModelFavorites()).toEqual([expect.objectContaining(config)]);
    const stale = view.result.current.store;
    act(() => publish([share('s1', 'replacement')]));
    expect(() => stale.remove(item.uid)).toThrow('Shared favorite source unavailable');
    expect(home.store.remove).not.toHaveBeenCalled();
  });

  it('keeps long local sources out of legacy remote replies without removing stored favorites', () => {
    const received = providerShareParsers.received({ ...share('s'.repeat(128), 'm'.repeat(128)), providerId: 'p'.repeat(256) });
    publish([received]);
    const view = mount(`share:${received.shareId}`);
    act(() => view.result.current.store.add({ ...config, providerId: received.providerId }));
    act(() => { addModelFavorite(config); });
    const onRequest = vi.fn<ModelFavoritesHostApi['onRequest']>().mockReturnValue(() => {});
    const reply = vi.fn<ModelFavoritesHostApi['reply']>();
    vi.stubGlobal('electronAPI', { modelFavoritesHost: { onRequest, reply, ready: vi.fn(), changed: vi.fn() } });
    renderHook(() => useModelFavoritesHost());
    const request = onRequest.mock.calls[0]![0];
    act(() => request({ requestId: 'get', expiresAt: Date.now() + 1000, ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 1 } }));
    const items = reply.mock.calls[0]![0].items;
    expect(parseModelFavorites(items)).toEqual([expect.objectContaining(config)]);
    expect(listModelFavorites()).toHaveLength(2);
    expect(view.result.current.items).toHaveLength(1);
  });

  it.each(['p'.repeat(256), '"\\'.repeat(128), '\ud800'.repeat(256)])('supports protocol-valid maximum identifiers including JSON escaping (%#)', (providerId) => {
    const received = providerShareParsers.received({ ...share('s'.repeat(128), 'm'.repeat(128)), providerId });
    const source = providerShareFavoriteSource(received);
    expect(source.length).toBeGreaterThan(512);
    expect(parseProviderShareFavoriteSource(source)).toEqual({
      shareId: received.shareId, memberId: received.memberId, providerId, region: 'global',
    });
    addModelFavorite(config);
    publish([received]);
    const view = mount(`share:${received.shareId}`);
    const longConfig = { ...config, providerId };
    act(() => view.result.current.store.add(longConfig));
    act(() => { setModelFavoritesOwner('other'); setModelFavoritesOwner('recipient'); });
    expect(view.result.current.items).toEqual([{ ...longConfig, uid: expect.any(String) }]);
    const uid = view.result.current.items[0]!.uid;
    act(() => view.result.current.store.update(uid, { effort: 'low' }));
    expect(view.result.current.items[0]?.effort).toBe('low');
    act(() => publish([received]));
    expect(view.result.current.items).toHaveLength(1);
    const failed = renderHook(() => useProviderShareFavoriteCleanupFailed());
    act(() => publish([]));
    expect(failed.result.current).toBe(false);
    expect(listModelFavorites()).toEqual([expect.objectContaining(config)]);
  });

  it.each(['cn', 'global'] as const)('keeps %s favorites usable and cleans only confirmed regions when the other region fails to load', (region) => {
    const localShare = { ...share(), owner: { ...share().owner, region } };
    const peerRegion = region === 'cn' ? 'global' as const : 'cn' as const;
    const peerShare = { ...share('peer', 'peer-member'), owner: { ...share().owner, region: peerRegion } };
    // 模拟重启前已有对方区域收藏，启动后该区域尚未成功加载。
    addModelFavorite({ ...config, providerId: providerShareFavoriteSource(peerShare) });
    publish([], false);
    const view = mount();
    const update = (received: ProviderShareReceived[], confirmedRegions: Array<'cn' | 'global'>) => {
      reconcileProviderShareFavorites({ received, confirmedRegions, ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 1 } });
    };
    act(() => update([localShare], [region]));
    act(() => view.result.current.store.add(config));
    expect(view.result.current.items).toHaveLength(1);
    expect(listModelFavorites()).toHaveLength(2);
    const uid = view.result.current.items[0]!.uid;
    act(() => view.result.current.store.update(uid, { effort: 'low' }));
    expect(view.result.current.items[0]?.effort).toBe('low');
    // 已确认区域撤权立即清理，未知区域继续保留。
    act(() => update([], [region]));
    expect(view.result.current.items).toEqual([]);
    expect(listModelFavorites()).toEqual([expect.objectContaining({ providerId: providerShareFavoriteSource(peerShare) })]);
    // 对方区域恢复并确认空名单后，才清掉它的最后一条收藏。
    act(() => update([], [region, peerRegion]));
    expect(listModelFavorites()).toEqual([]);
  });

  it('persists the complete configuration and distinguishes local providers, shares and grants', () => {
    addModelFavorite(config);
    const a = mount();
    const b = mount('share:s2');
    act(() => { a.result.current.store.add(config); b.result.current.store.add(config); });
    expect(listModelFavorites()).toHaveLength(3);
    expect(parseProviderShareFavoriteSource(listModelFavorites()[1]!.providerId)).toEqual({ shareId: 's1', memberId: 'm1', providerId: 'anthropic', region: 'global' });
    expect(a.result.current.items).toEqual([{ ...config, uid: listModelFavorites()[1]!.uid }]);
    expect(b.result.current.items).toEqual([{ ...config, uid: listModelFavorites()[2]!.uid }]);
    act(() => a.result.current.store.add(config));
    expect(listModelFavorites()).toHaveLength(3);
    act(() => a.result.current.store.add({ ...config, effort: 'low' }));
    expect(a.result.current.items).toHaveLength(2);
    // 换账号再回来强制从持久化值加载，配置和来源仍完整。
    act(() => { setModelFavoritesOwner('other'); setModelFavoritesOwner('recipient'); });
    expect(a.result.current.items[0]).toMatchObject(config);
    expect(b.result.current.items).toHaveLength(1);
  });

  it('edits and removes only the selected copy while preserving its share source', () => {
    const view = mount();
    act(() => view.result.current.store.add(config));
    const uid = view.result.current.items[0]!.uid;
    act(() => view.result.current.store.update(uid, { effort: 'low', fast: false }));
    expect(listModelFavorites()[0]).toMatchObject({ providerId: providerShareFavoriteSource(share()), effort: 'low' });
    expect(view.result.current.items[0]?.fast).toBeUndefined();
    act(() => view.result.current.store.remove(uid));
    expect(listModelFavorites()).toEqual([]);
  });

  it('never clears on an unknown empty list, pause, offline, or a stale account snapshot', () => {
    const view = mount();
    act(() => view.result.current.store.add(config));
    act(() => {
      publish([], false);
      publish([{ ...share(), status: 'paused', hostOnline: false }]);
      publish([], true, 'other');
      publish([], true, 'recipient', 0);
    });
    expect(listModelFavorites()).toHaveLength(1);
    expect(view.result.current.items).toHaveLength(1);
  });

  it('clears revoked shares including the last share and a replaced membership, preserving unrelated favorites', () => {
    addModelFavorite(config);
    const a = mount();
    const b = mount('share:s2');
    act(() => { a.result.current.store.add(config); b.result.current.store.add(config); });
    const staleStore = a.result.current.store;
    act(() => publish([share('s1', 'new-member'), share('s2', 'm2')]));
    expect(a.result.current.items).toEqual([]);
    expect(() => staleStore.add(config)).toThrow('Shared favorite source unavailable');
    expect(b.result.current.items).toHaveLength(1);
    act(() => publish([]));
    expect(listModelFavorites()).toEqual([expect.objectContaining(config)]);
  });

  it('fences writes and cleanup across account changes', () => {
    const view = mount();
    act(() => view.result.current.store.add(config));
    const oldStore = view.result.current.store;
    act(() => {
      setDataOwnerGeneration('other', 2);
      setModelFavoritesOwner('other');
      publish([], true, 'recipient', 1);
    });
    expect(() => oldStore.add(config)).toThrow();
    expect(listModelFavorites()).toEqual([]);
    act(() => { setDataOwnerGeneration('recipient', 3); setModelFavoritesOwner('recipient'); });
    expect(listModelFavorites()).toHaveLength(1);
    act(() => publish([], true, 'recipient', 3));
    expect(listModelFavorites()).toEqual([]);
  });

  it('reports persistence failures without claiming a save or losing the previous copy', () => {
    const view = mount();
    act(() => view.result.current.store.add(config));
    const uid = view.result.current.items[0]!.uid;
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => view.result.current.store.add({ ...config, effort: 'low' })).toThrow('quota');
    expect(() => view.result.current.store.update(uid, { effort: 'low' })).toThrow('quota');
    expect(() => view.result.current.store.remove(uid)).toThrow('quota');
    expect(view.result.current.items).toEqual([{ uid, ...config }]);
    const failed = renderHook(() => useProviderShareFavoriteCleanupFailed());
    act(() => publish([]));
    expect(failed.result.current).toBe(true);
    expect(listModelFavorites()).toHaveLength(1);
    writes.mockRestore();
    act(() => publish([]));
    expect(failed.result.current).toBe(false);
    expect(listModelFavorites()).toEqual([]);
  });
});
