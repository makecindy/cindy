import { useEffect, useRef, useState } from 'react';
import {
  MODEL_FAVORITES_GET,
  MODEL_FAVORITES_APPLY,
  MODEL_FAVORITES_CHANGED,
  parseModelFavorites,
  type ModelFavoriteMutation,
} from '@cindy/device-link';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { extractIpcError } from '@/utils/ipcError';
import type { ModelFavoriteItem, ModelFavoriteConfig, ModelFavoritePatch } from './modelFavorites';

export interface FavoriteStore {
  get(uid: string): ModelFavoriteItem | undefined;
  add(config: ModelFavoriteConfig): void | Promise<void>;
  update(uid: string, patch: ModelFavoritePatch): void | Promise<void>;
  remove(uid: string): void | Promise<void>;
}
// 上次从那台电脑读到的收藏(按数据归属代次 + 电脑):面板每次打开先显示它，再在后台读最新的。
// 写入仍带 expected 交给那台电脑核对，旧快照改不坏真相。
const lastFavorites = new Map<string, ModelFavoriteItem[]>();
let lastFavoritesOwner = '';
/** 数据归属换了(切换 / 退出账号)就丢掉上一个账号的快照,缓存里只留当前归属的。 */
function rememberFavorites(owner: string, key: string, items: ModelFavoriteItem[]): void {
  if (owner !== lastFavoritesOwner) {
    lastFavorites.clear();
    lastFavoritesOwner = owner;
  }
  lastFavorites.set(key, items);
}
export function __resetRemoteModelFavoritesCacheForTest(): void {
  lastFavorites.clear();
  lastFavoritesOwner = '';
}

/** Remote views already hold the device's sessions topic. Only invalidate this
 * device's favorites; never reset the link or touch the controller's local store. */
export function useRemoteModelFavorites(deviceId?: string) {
  const owner = getDataOwnerGeneration();
  const key = JSON.stringify([owner, deviceId]);
  const current = useRef(key);
  current.current = key;
  const [state, setState] = useState<{ key: string; items: ModelFavoriteItem[] } | null>(null);
  const [error, setError] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [writeErrorKey, setWriteErrorKey] = useState<string | null>(null);
  const sequence = useRef(0);
  const cached = lastFavorites.get(key);
  const items = state?.key === key ? state.items : (cached ?? []);
  const refresh = async () => {
    if (!deviceId) return;
    const seq = ++sequence.current;
    try {
      const value = await window.electronAPI.deviceLink.invoke(deviceId, MODEL_FAVORITES_GET, []);
      if (
        current.current !== key ||
        sequence.current !== seq ||
        JSON.stringify(getDataOwnerGeneration()) !== JSON.stringify(owner)
      )
        return;
      const next = parseModelFavorites(value) as ModelFavoriteItem[];
      rememberFavorites(JSON.stringify(owner), key, next);
      setState({ key, items: next });
      setError(false);
      setErrorCode(null);
    } catch (err) {
      if (current.current === key && sequence.current === seq) {
        setError(true);
        setErrorCode(extractIpcError(err)?.code ?? null);
      }
    }
  };
  useEffect(() => {
    if (!deviceId) return;
    void refresh();
    const api = window.electronAPI?.deviceLink;
    if (!api) return;
    const off = api.onRemotePush((event) => {
      if (event.deviceId === deviceId && event.channel === MODEL_FAVORITES_CHANGED) void refresh();
    });
    const offStatus = api.onStatusChanged(() => {
      void refresh();
    });
    const offPeer = api.onPeerLinkReset?.((event) => {
      if (event.deviceId === deviceId) {
        void refresh();
      }
    });
    const offResponsive = api.onResponsivenessChanged?.((event) => {
      if (event.deviceId === deviceId && !event.unresponsive && event.recovered !== false) {
        void refresh();
      }
    });
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    return () => {
      off();
      offStatus();
      offPeer?.();
      offResponsive?.();
      window.removeEventListener('focus', focus);
      ++sequence.current;
    };
  }, [key]);
  const write = async (mutation: ModelFavoriteMutation) => {
    setWriteErrorKey(null);
    if (
      !deviceId ||
      (state?.key !== key && cached === undefined) ||
      current.current !== key ||
      JSON.stringify(getDataOwnerGeneration()) !== JSON.stringify(owner)
    )
      throw new Error('Favorites not ready');
    ++sequence.current;
    try {
      await window.electronAPI.deviceLink.invoke(deviceId, MODEL_FAVORITES_APPLY, [mutation]);
      if (current.current !== key) throw new Error('Device changed');
      // Re-read instead of installing a possibly superseded write response.
      await refresh();
    } catch (error) {
      if (current.current === key) {
        setWriteErrorKey(key);
        setErrorCode(extractIpcError(error)?.code ?? null);
        void refresh();
      }
      throw error;
    }
  };
  const expected = (uid: string) => {
    const item = items.find((i) => i.uid === uid);
    if (!item) throw new Error('Favorite unavailable');
    return item;
  };
  const store: FavoriteStore = {
    get: (uid) => items.find((item) => item.uid === uid),
    add: (item) => write({ kind: 'add', item }),
    update: (uid, patch) => {
      const before = expected(uid);
      const item = { ...before, ...patch };
      return write({
        kind: 'update',
        expected: before,
        item: { ...item, effort: item.effort ?? undefined, fast: item.fast ? true : undefined },
      });
    },
    remove: (uid) => write({ kind: 'remove', expected: expected(uid) }),
  };
  return { items, store, error: error || writeErrorKey === key, errorCode };
}
