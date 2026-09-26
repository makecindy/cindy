import { useEffect, useRef, useState } from 'react';
import {
  MODEL_FAVORITES_GET,
  MODEL_FAVORITES_APPLY,
  MODEL_FAVORITES_CHANGED,
  parseModelFavorites,
  type ModelFavoriteMutation,
} from '@cindy/device-link';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { ModelFavoriteItem, ModelFavoriteConfig, ModelFavoritePatch } from './modelFavorites';

export interface FavoriteStore {
  get(uid: string): ModelFavoriteItem | undefined;
  add(config: ModelFavoriteConfig): void | Promise<void>;
  update(uid: string, patch: ModelFavoritePatch): void | Promise<void>;
  remove(uid: string): void | Promise<void>;
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
  const [writeErrorKey, setWriteErrorKey] = useState<string | null>(null);
  const sequence = useRef(0);
  const items = state?.key === key ? state.items : [];
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
      setState({ key, items: parseModelFavorites(value) as ModelFavoriteItem[] });
      setError(false);
    } catch {
      if (current.current === key && sequence.current === seq) {
        setError(true);
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
      state?.key !== key ||
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
  return { items, store, error: error || writeErrorKey === key };
}
