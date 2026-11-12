// @vitest-environment jsdom
/**
 * 远程 Agent 的收藏(model-selector-unified §1.5「远程收藏按被控电脑共享」):浏览另一台电脑的目录时,
 * 收藏仍读写任务所在电脑那一份列表,运行位置编进 providerId。锁住:
 *   1. 只投影编码成那台电脑的条目,并还原成那台的真实 providerId;
 *   2. 新增编码后写进 home,编辑 / 删除只认属于那台的锚点;
 *   3. 编码成任务所在电脑自己的条目按普通收藏用;分享的设备 id 不认;
 *   4. 编码后的 providerId 仍能经既有收藏同步协议(≤512)发给远程控制端。
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentDeviceFavoriteSource,
  MODEL_FAVORITE_TEXT_MAX_LENGTH,
  parseModelFavorites,
} from '@cindy/device-link';
import type { ModelFavoritesHostApi } from '../../shared/modelFavoritesSync';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  __resetForTest,
  addModelFavorite,
  listModelFavorites,
  setModelFavoritesOwner,
  useModelFavorites,
  type ModelFavoriteItem,
} from '@/state/modelFavorites';
import {
  agentDeviceOfFavorite,
  LOCAL_MODEL_FAVORITE_STORE,
  useAgentDeviceFavorites,
} from '@/state/agentDeviceFavorites';
import type { FavoriteStore } from '@/state/useRemoteModelFavorites';
import { useModelFavoritesHost } from '@/state/useModelFavoritesHost';

const config = {
  providerId: 'anthropic',
  modelId: 'opus',
  agent: 'cc' as const,
  effort: 'high' as const,
};
const mountLocal = (deviceId: string | undefined, homeDeviceId: string | null = null) =>
  renderHook(
    (props: { deviceId: string | undefined }) =>
      useAgentDeviceFavorites({
        deviceId: props.deviceId,
        homeDeviceId,
        home: { items: useModelFavorites(), store: LOCAL_MODEL_FAVORITE_STORE },
      }),
    { initialProps: { deviceId } },
  );

beforeEach(() => {
  __resetForTest();
  window.localStorage.clear();
  setDataOwnerGeneration('owner', 1);
  setModelFavoritesOwner('owner');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('favorites of another computer live in the home list', () => {
  it('writes the encoded source into the home list and projects only that computer back', () => {
    addModelFavorite(config);
    const studio = mountLocal('device-c');
    expect(studio.result.current.items).toEqual([]);
    act(() => {
      studio.result.current.store.add(config);
    });
    const stored = listModelFavorites();
    expect(stored).toHaveLength(2);
    expect(stored[1]!.providerId).toBe(
      agentDeviceFavoriteSource({ deviceId: 'device-c', providerId: 'anthropic' }),
    );
    expect(studio.result.current.items).toEqual([{ ...config, uid: stored[1]!.uid }]);
    // 另一台电脑看不到 device-c 的收藏;同配置在本机与 device-c 是两条。
    const office = mountLocal('device-d');
    expect(office.result.current.items).toEqual([]);
    act(() => {
      studio.result.current.store.add(config);
    });
    expect(listModelFavorites()).toHaveLength(2);
  });

  it('edits and removes only anchors that belong to that computer', () => {
    addModelFavorite(config);
    const localUid = listModelFavorites()[0]!.uid;
    const studio = mountLocal('device-c');
    act(() => {
      studio.result.current.store.add(config);
    });
    const uid = studio.result.current.items[0]!.uid;
    act(() => {
      studio.result.current.store.update(uid, { effort: 'low', fast: true });
    });
    expect(listModelFavorites()[1]).toMatchObject({
      providerId: agentDeviceFavoriteSource({ deviceId: 'device-c', providerId: 'anthropic' }),
      effort: 'low',
      fast: true,
    });
    expect(studio.result.current.store.get(uid)).toMatchObject({
      providerId: 'anthropic',
      effort: 'low',
    });
    // 本机那条的锚点不能经那台电脑的视图改动或删除。
    expect(() => studio.result.current.store.remove(localUid)).toThrow();
    expect(() => studio.result.current.store.update(localUid, { effort: 'low' })).toThrow();
    act(() => {
      studio.result.current.store.remove(uid);
    });
    expect(listModelFavorites()).toEqual([expect.objectContaining(config)]);
  });

  it('keeps the home view in list order and treats the home computer encoding as a plain favorite', () => {
    addModelFavorite({
      ...config,
      providerId: agentDeviceFavoriteSource({ deviceId: 'device-c', providerId: 'anthropic' }),
    });
    addModelFavorite({
      ...config,
      providerId: agentDeviceFavoriteSource({ deviceId: 'home-pc', providerId: 'openai' }),
    });
    addModelFavorite(config);
    const home = mountLocal(undefined, 'home-pc');
    expect(home.result.current.items.map((item) => item.providerId)).toEqual([
      agentDeviceFavoriteSource({ deviceId: 'device-c', providerId: 'anthropic' }),
      'openai',
      'anthropic',
    ]);
    // 浏览任务所在电脑自己 = home 视图,不当作另一台电脑。
    home.rerender({ deviceId: 'home-pc' });
    expect(home.result.current.items.map((item) => item.providerId)[1]).toBe('openai');
    expect(agentDeviceOfFavorite(listModelFavorites()[1]!.providerId, 'home-pc')).toBeNull();
    expect(agentDeviceOfFavorite(listModelFavorites()[0]!.providerId, 'home-pc')).toEqual({
      deviceId: 'device-c',
      providerId: 'anthropic',
    });
    expect(agentDeviceOfFavorite('anthropic', null)).toBeNull();
    // 分享的设备 id 有自己的收藏存储,不认这种编码。
    expect(
      agentDeviceOfFavorite(
        agentDeviceFavoriteSource({ deviceId: 'share:abc', providerId: 'p' }),
        null,
      ),
    ).toBeNull();
  });

  it('writes through the remote home store when the home list is on a controlled computer', async () => {
    const encoded = agentDeviceFavoriteSource({ deviceId: 'device-c', providerId: 'anthropic' });
    const items: ModelFavoriteItem[] = [
      { uid: 'fav-1', ...config },
      { uid: 'fav-2', ...config, providerId: encoded },
    ];
    const store: FavoriteStore = {
      get: (uid) => items.find((item) => item.uid === uid),
      add: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const view = renderHook(() =>
      useAgentDeviceFavorites({
        deviceId: 'device-c',
        homeDeviceId: 'device-b',
        home: { items, store },
      }),
    );
    expect(view.result.current.items).toEqual([{ uid: 'fav-2', ...config }]);
    await view.result.current.store.add({ ...config, effort: 'low' });
    expect(store.add).toHaveBeenCalledWith({ ...config, effort: 'low', providerId: encoded });
    await view.result.current.store.update('fav-2', { fast: true });
    expect(store.update).toHaveBeenCalledWith('fav-2', { fast: true });
    expect(() => view.result.current.store.remove('fav-1')).toThrow();
    await view.result.current.store.remove('fav-2');
    expect(store.remove).toHaveBeenCalledWith('fav-2');
  });

  it('fits the existing favorites wire protocol so a remote controller sees the entry', () => {
    const deviceId = '7f3c2a10-1b2c-4d5e-8f90-0123456789ab';
    const providerId = 'p'.repeat(256);
    const encoded = agentDeviceFavoriteSource({ deviceId, providerId });
    expect(encoded.length).toBeLessThanOrEqual(MODEL_FAVORITE_TEXT_MAX_LENGTH);
    const studio = mountLocal(deviceId);
    act(() => {
      studio.result.current.store.add({ ...config, providerId });
    });
    const onRequest = vi.fn<ModelFavoritesHostApi['onRequest']>().mockReturnValue(() => {});
    const reply = vi.fn<ModelFavoritesHostApi['reply']>();
    vi.stubGlobal('electronAPI', {
      modelFavoritesHost: { onRequest, reply, ready: vi.fn(), changed: vi.fn() },
    });
    renderHook(() => useModelFavoritesHost());
    const request = onRequest.mock.calls[0]![0];
    act(() =>
      request({
        requestId: 'get',
        expiresAt: Date.now() + 1000,
        ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
      }),
    );
    expect(parseModelFavorites(reply.mock.calls[0]![0].items)).toEqual([
      expect.objectContaining({ providerId: encoded, modelId: 'opus' }),
    ]);
  });
});
