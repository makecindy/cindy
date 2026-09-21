import { useEffect } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerPushStampCurrent,
} from '@/contexts/dataOwnerGeneration';
import { accessHostModelFavorites, subscribeModelFavorites } from './modelFavorites';

export function useModelFavoritesHost(): void {
  useEffect(() => {
    const api = window.electronAPI.modelFavoritesHost;
    if (!api) return;
    const off = api.onRequest((request) => {
      try {
        if (Date.now() > request.expiresAt || !isDataOwnerPushStampCurrent(request.ownerStamp))
          throw new Error('Expired favorite request');
        const items = accessHostModelFavorites(request.ownerStamp.dataOwnerId, request.mutation);
        api.reply({ requestId: request.requestId, items: [...items] });
      } catch {
        api.reply({ requestId: request.requestId, failed: true });
      }
    });
    api.ready();
    const unsubscribe = subscribeModelFavorites(() => {
      const owner = getDataOwnerGeneration();
      api.changed({ dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation });
    });
    return () => {
      off();
      unsubscribe();
    };
  }, []);
}
