/**
 * 本机建的供应商组(只读设置，不读远端)：模型列表与设置页据此收起本机组里的远程供应商与分享，
 * 与其他电脑的组同一条规则(provider-groups.md §10)。组设置变化时 main 广播 CHANGED，重读一次。
 * 全窗口共用一份，多个组件同时用也只发一次 IPC。
 */
import { useEffect, useState } from 'react';

import type { ProviderGroupConfig } from '../../../shared/providerGroup';

type LocalGroups = Readonly<Record<string, ProviderGroupConfig>>;

const EMPTY: LocalGroups = Object.freeze({});
let snapshot: LocalGroups = EMPTY;
let loaded: Promise<void> | null = null;
let offChanged: (() => void) | null = null;
const listeners = new Set<(groups: LocalGroups) => void>();

function reload(): Promise<void> {
  const api = window.electronAPI?.providerGroup;
  if (typeof api?.command !== 'function') return Promise.resolve();
  loaded = Promise.resolve()
    .then(() => api.command({ action: 'list' }))
    .then((groups) => {
      snapshot = groups ?? EMPTY;
      for (const listener of listeners) listener(snapshot);
    })
    .catch(() => undefined);
  return loaded;
}

function subscribe(listener: (groups: LocalGroups) => void): () => void {
  listeners.add(listener);
  if (!loaded) void reload();
  offChanged ??= window.electronAPI?.providerGroup?.onChanged?.(() => void reload()) ?? null;
  return () => {
    listeners.delete(listener);
  };
}

export function useLocalProviderGroups(): LocalGroups {
  const [groups, setGroups] = useState<LocalGroups>(snapshot);
  useEffect(() => {
    setGroups(snapshot);
    return subscribe(setGroups);
  }, []);
  return groups;
}

export const __testing = {
  reset(): void {
    snapshot = EMPTY;
    loaded = null;
    offChanged?.();
    offChanged = null;
    listeners.clear();
  },
};
