/**
 * 本机建的供应商组(只读设置，不读远端)：模型列表与设置页据此收起本机组里的远程供应商与分享，
 * 与其他电脑的组同一条规则(provider-groups.md §10)。组设置变化时 main 广播 CHANGED，重读一次。
 * 全窗口共用一份，多个组件同时用也只发一次 IPC。
 *
 * 快照按当前数据归属账号隔离(与 providerModelMemory 同一处切换，AuthContext 调
 * setLocalProviderGroupsOwner)：换账号后清空并重读，旧账号迟到的读取结果丢弃——否则同一 Renderer
 * 里从账号 A 切到 B 后，模型列表会拿 A 的组成员键去收起 B 的供应商与分享。
 */
import { useEffect, useState } from 'react';

import type { ProviderGroupConfig } from '../../../shared/providerGroup';

type LocalGroups = Readonly<Record<string, ProviderGroupConfig>>;

const EMPTY: LocalGroups = Object.freeze({});
let owner: string | null = null;
let snapshot: LocalGroups = EMPTY;
let loaded: Promise<void> | null = null;
let offChanged: (() => void) | null = null;
const listeners = new Set<(groups: LocalGroups) => void>();

function emit(groups: LocalGroups): void {
  for (const listener of [...listeners]) listener(groups);
}

function reload(): Promise<void> {
  const api = window.electronAPI?.providerGroup;
  if (typeof api?.command !== 'function') return Promise.resolve();
  const ownerAtStart = owner;
  loaded = Promise.resolve()
    .then(() => api.command({ action: 'list' }))
    .then((groups) => {
      // 换账号后迟到的旧账号结果丢弃，不写进新账号的快照。
      if (owner !== ownerAtStart) return;
      snapshot = groups ?? EMPTY;
      emit(snapshot);
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

/**
 * 账号切换入口(与 setProviderModelMemoryOwner 同一处、同一个 dataOwnerId；AuthContext 调用)：
 * 清空上一个账号的快照与在途读取，立即按新账号重读。owner 相同(同账号的重复推送)不动。
 */
export function setLocalProviderGroupsOwner(ownerId: string | null): void {
  const normalized = typeof ownerId === 'string' && ownerId.trim().length > 0 ? ownerId : null;
  if (owner === normalized) return;
  owner = normalized;
  snapshot = EMPTY;
  loaded = null;
  emit(EMPTY);
  void reload();
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
    owner = null;
    snapshot = EMPTY;
    loaded = null;
    offChanged?.();
    offChanged = null;
    listeners.clear();
  },
};
