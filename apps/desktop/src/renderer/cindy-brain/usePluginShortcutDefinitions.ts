import { useSyncExternalStore } from 'react';

import {
  isPluginShortcutId,
  type PluginShortcutDefinition,
} from '../../shared/appShortcuts';

let definitions: PluginShortcutDefinition[] = [];
let initialized = false;
const listeners = new Set<() => void>();

function readDefinitions(raw: unknown): PluginShortcutDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is PluginShortcutDefinition =>
    !!item && typeof item === 'object' &&
    isPluginShortcutId(item.id) &&
    typeof item.label === 'string' &&
    typeof item.pluginName === 'string' &&
    (item.scope === 'session' || item.scope === 'message'),
  );
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  const api = window.electronAPI?.appShortcuts;
  if (!api) return;
  try {
    definitions = readDefinitions(api.getState().pluginShortcuts);
    api.onChanged((state) => {
      definitions = readDefinitions(state.pluginShortcuts);
      listeners.forEach((listener) => listener());
    });
  } catch {
    definitions = [];
  }
}

function subscribe(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): PluginShortcutDefinition[] {
  ensureInitialized();
  return definitions;
}

/** Current plugin declarations from the existing app-shortcut channel. */
export function usePluginShortcutDefinitions(): PluginShortcutDefinition[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}
