/**
 * 本机建的供应商组(只读设置，不读远端)：模型列表与设置页据此收起本机组里的远程供应商与分享，
 * 与其他电脑的组同一条规则(provider-groups.md §10)。组设置变化时 main 广播 CHANGED，重读一次。
 * 全窗口共用一份，多个组件同时用也只发一次 IPC。
 *
 * 组设置属于当前账号：快照按账号代次存，换账号后清空重读，旧账号还在路上的结果直接丢弃——否则新账号的
 * 模型列表会按旧账号的组收起供应商。
 *
 * `ready` 区分「还没读到」与「读到了、没有组」：供应商详情据此等第一次读完再显示组的状态，
 * 不先显示「未设置」再跳成组(2026-10-11 用户反馈)。
 */
import { useEffect, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { ProviderGroupConfig } from '../../../shared/providerGroup';

type LocalGroups = Readonly<Record<string, ProviderGroupConfig>>;

export interface LocalProviderGroupsState {
  groups: LocalGroups;
  /** 当前账号至少读完过一次(读失败也算，按没有组处理)。 */
  ready: boolean;
}

const EMPTY: LocalGroups = Object.freeze({});

interface GroupsState {
  owner: DataOwnerGeneration | null;
  snapshot: LocalGroups;
  ready: boolean;
  loaded: Promise<void> | null;
  /** 每次重读或换账号加一，只认最后一次读取的结果。 */
  revision: number;
}

const state: GroupsState = { owner: null, snapshot: EMPTY, ready: false, loaded: null, revision: 0 };
let offChanged: (() => void) | null = null;
const listeners = new Set<() => void>();

function sameOwner(a: DataOwnerGeneration | null, b: DataOwnerGeneration): boolean {
  return a?.dataOwnerId === b.dataOwnerId && a.generation === b.generation;
}

function stateFor(owner: DataOwnerGeneration): GroupsState {
  if (!sameOwner(state.owner, owner)) {
    // 同一账号只是代次变了(内部修复)：保留快照免得组员闪出来，只重读一次；换了账号才清空。
    if (state.owner?.dataOwnerId !== owner.dataOwnerId) {
      state.snapshot = EMPTY;
      state.ready = false;
    }
    state.owner = owner;
    state.loaded = null;
    state.revision += 1;
  }
  return state;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function reload(owner: DataOwnerGeneration): Promise<void> {
  const api = window.electronAPI?.providerGroup;
  stateFor(owner);
  if (typeof api?.command !== 'function') {
    // 读不到(旧窗口 / 测试)就当没有组，不让等 ready 的界面一直不出现。
    if (!state.ready) {
      state.ready = true;
      notify();
    }
    return Promise.resolve();
  }
  const revision = ++state.revision;
  const settle = (groups: LocalGroups | null) => {
    if (revision !== state.revision || !sameOwner(state.owner, owner) || !isDataOwnerGenerationCurrent(owner)) return;
    if (groups) state.snapshot = groups;
    state.ready = true;
    notify();
  };
  state.loaded = Promise.resolve()
    .then(() => api.command({ action: 'list' }))
    .then(
      (groups) => settle(groups ?? EMPTY),
      () => settle(null),
    )
    .catch(() => undefined);
  return state.loaded;
}

function subscribe(owner: DataOwnerGeneration, listener: () => void): () => void {
  listeners.add(listener);
  if (!stateFor(owner).loaded) void reload(owner);
  offChanged ??= window.electronAPI?.providerGroup?.onChanged?.(() => void reload(getDataOwnerGeneration())) ?? null;
  return () => {
    listeners.delete(listener);
  };
}

/** 不订阅，读一眼当前账号的快照：`ready` 为 false 时 `config` 为 null 不代表没有组。 */
export function peekLocalProviderGroup(providerId: string): { ready: boolean; config: ProviderGroupConfig | null } {
  const source = stateFor(getDataOwnerGeneration());
  return { ready: source.ready, config: source.snapshot[providerId] ?? null };
}

function current(source: GroupsState): LocalProviderGroupsState {
  return { groups: source.snapshot, ready: source.ready };
}

export function useLocalProviderGroupsState(): LocalProviderGroupsState {
  const owner = getDataOwnerGeneration();
  const source = stateFor(owner);
  const [view, setView] = useState(() => ({ owner, value: current(source) }));
  useEffect(() => {
    setView({ owner, value: current(source) });
    return subscribe(owner, () => setView({ owner, value: current(state) }));
  }, [owner, source]);
  return view.owner === owner ? view.value : current(source);
}

export function useLocalProviderGroups(): LocalGroups {
  return useLocalProviderGroupsState().groups;
}

export const __testing = {
  reset(): void {
    state.owner = null;
    state.snapshot = EMPTY;
    state.ready = false;
    state.loaded = null;
    state.revision = 0;
    offChanged?.();
    offChanged = null;
    listeners.clear();
  },
};
