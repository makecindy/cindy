import { useReducer, useRef } from 'react';
import { getModelEngineOverride, type ModelEngine } from '@/state/modelEnginePrefs';
import { useModelFavorites, type ModelFavoriteItem } from '@/state/modelFavorites';
import { normalizeModelConfigCopy, modelConfigCopyIdentity } from '@/state/modelConfigCopy';
import { useRemoteModelFavorites, type FavoriteStore } from '@/state/useRemoteModelFavorites';
import type { ModelMemoryAccessors } from './ModelSelector';

export interface ModelPickerPreferenceStore {
  engines: {
    get(providerId: string, modelId: string): ModelEngine | undefined;
    set(providerId: string, modelId: string, engine: ModelEngine): void;
    clear(providerId: string, modelId: string): void;
  };
  favorites: { items: readonly ModelFavoriteItem[]; store: FavoriteStore };
  memory: ModelMemoryAccessors;
}

/** A picker request may read favorites, but every edit stays in its own draft. */
export function useTransientModelPickerPreferences(deviceId?: string): ModelPickerPreferenceStore {
  const localFavorites = useModelFavorites();
  const remoteFavorites = useRemoteModelFavorites(deviceId);
  const sourceFavorites = deviceId ? remoteFavorites.items : localFavorites;
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const draft = useRef({
    engines: new Map<string, ModelEngine | undefined>(),
    efforts: new Map<string, ReturnType<ModelMemoryAccessors['getEffort']>>(),
    fast: new Map<string, ReturnType<ModelMemoryAccessors['getFast']>>(),
    favorites: null as ModelFavoriteItem[] | null,
  }).current;
  const key = (...parts: string[]) => JSON.stringify(parts);
  const favorites = () => draft.favorites ?? sourceFavorites;
  const editFavorites = (items: ModelFavoriteItem[]) => {
    draft.favorites = items;
    refresh();
  };
  return {
    engines: {
      get: (providerId, modelId) => {
        const id = key(providerId, modelId);
        if (!draft.engines.has(id))
          draft.engines.set(id, deviceId ? undefined : getModelEngineOverride(providerId, modelId));
        return draft.engines.get(id);
      },
      set: (providerId, modelId, engine) => {
        draft.engines.set(key(providerId, modelId), engine);
        refresh();
      },
      clear: (providerId, modelId) => {
        draft.engines.set(key(providerId, modelId), undefined);
        refresh();
      },
    },
    memory: {
      getEffort: (agent, providerId, modelId) => draft.efforts.get(key(agent, providerId, modelId)),
      setEffort: (agent, providerId, modelId, effort) => {
        draft.efforts.set(key(agent, providerId, modelId), effort);
        refresh();
      },
      clearEffort: (agent, providerId, modelId) => {
        draft.efforts.delete(key(agent, providerId, modelId));
        refresh();
      },
      getFast: (agent, providerId, modelId) => draft.fast.get(key(agent, providerId, modelId)),
      setFast: (agent, providerId, modelId, fast) => {
        draft.fast.set(key(agent, providerId, modelId), fast);
        refresh();
      },
      clearFast: (agent, providerId, modelId) => {
        draft.fast.delete(key(agent, providerId, modelId));
        refresh();
      },
    },
    favorites: {
      items: favorites(),
      store: {
        get: (uid) => favorites().find((item) => item.uid === uid),
        add: (config) => {
          const normalized = normalizeModelConfigCopy(config);
          if (!normalized || favorites().some((item) =>
            modelConfigCopyIdentity(item) === modelConfigCopyIdentity(normalized))) return;
          editFavorites([...favorites(), { ...normalized, uid: crypto.randomUUID() }]);
        },
        update: (uid, patch) => {
          editFavorites(favorites().map((item) => {
            if (item.uid !== uid) return item;
            const normalized = normalizeModelConfigCopy({ ...item, ...patch });
            return normalized ? { ...normalized, uid } : item;
          }));
        },
        remove: (uid) => editFavorites(favorites().filter((item) => item.uid !== uid)),
      },
    },
  };
}
