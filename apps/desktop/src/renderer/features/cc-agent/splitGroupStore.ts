/**
 * splitGroupStore — chat-main 内部的同窗多任务递归分屏状态。
 *
 * 主界面布局树仍只包含一个 `chat-main`；本 store 维护该面板内部的二叉分屏树。
 * 每次拖入只拆目标 pane，因此可组合出左一右二、左二右二等混合布局。
 */

import { useSyncExternalStore } from 'react';

import { isSecondaryWindow } from '@/lib/secondaryWindow';

export type SplitDirection = 'row' | 'column';
export type DropSide = 'left' | 'right' | 'top' | 'bottom';
export type SplitGroupAddBlockReason = 'invalid' | 'duplicate' | 'limit-reached' | 'missing-anchor';

export interface SplitPaneNode {
  type: 'pane';
  key: string;
  sessionId: string;
}

export interface SplitBranchNode {
  type: 'split';
  key: string;
  direction: SplitDirection;
  fraction: number;
  first: SplitNode;
  second: SplitNode;
}

export type SplitNode = SplitPaneNode | SplitBranchNode;

export interface SplitGroupState {
  root: SplitNode | null;
}

export const MIN_SPLIT_CHILD_FRACTION = 0.1;
export const MAX_SPLIT_PANES = 8;
export const SPLIT_GROUP_STORAGE_KEY = 'cc-agent.splitGroup.v2';
export const LEGACY_SPLIT_GROUP_STORAGE_KEY = 'cc-agent.splitGroup.v1';

const EMPTY: SplitGroupState = { root: null };

let keySequence = 0;
let state: SplitGroupState = EMPTY;
let hydrated = false;
const listeners = new Set<() => void>();

function nextKey(prefix: 'pane' | 'split'): string {
  keySequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${keySequence}`;
}

function nextUniqueKey(prefix: 'pane' | 'split', existingKeys: ReadonlySet<string>): string {
  let key = nextKey(prefix);
  while (existingKeys.has(key)) key = nextKey(prefix);
  return key;
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function directionForSide(side: DropSide): SplitDirection {
  return side === 'top' || side === 'bottom' ? 'column' : 'row';
}

function isBeforeSide(side: DropSide): boolean {
  return side === 'left' || side === 'top';
}

function normalizeFraction(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  return Math.min(1 - MIN_SPLIT_CHILD_FRACTION, Math.max(MIN_SPLIT_CHILD_FRACTION, value));
}

export function getSplitPanes(root: SplitNode | null): SplitPaneNode[] {
  if (!root) return [];
  if (root.type === 'pane') return [root];
  return [...getSplitPanes(root.first), ...getSplitPanes(root.second)];
}

export function getSplitSessionIds(root: SplitNode | null): string[] {
  return getSplitPanes(root).map((pane) => pane.sessionId);
}

function collectNodeKeys(root: SplitNode, keys: Set<string>): void {
  keys.add(root.key);
  if (root.type === 'pane') return;
  collectNodeKeys(root.first, keys);
  collectNodeKeys(root.second, keys);
}

function replaceNode(
  root: SplitNode,
  predicate: (node: SplitNode) => boolean,
  replacement: (node: SplitNode) => SplitNode,
): SplitNode {
  if (predicate(root)) return replacement(root);
  if (root.type === 'pane') return root;
  const first = replaceNode(root.first, predicate, replacement);
  const second = replaceNode(root.second, predicate, replacement);
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

function removePane(root: SplitNode, sessionId: string): SplitNode | null {
  if (root.type === 'pane') return root.sessionId === sessionId ? null : root;
  const first = removePane(root.first, sessionId);
  const second = removePane(root.second, sessionId);
  if (!first) return second;
  if (!second) return first;
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

interface CoerceContext {
  seenKeys: Set<string>;
  seenSessionIds: Set<string>;
  paneCount: number;
}

function coerceKey(value: unknown, prefix: 'pane' | 'split', context: CoerceContext): string {
  const persisted = typeof value === 'string' ? value.trim() : '';
  const key =
    persisted && !context.seenKeys.has(persisted)
      ? persisted
      : nextUniqueKey(prefix, context.seenKeys);
  context.seenKeys.add(key);
  return key;
}

function coerceNode(raw: unknown, context: CoerceContext): SplitNode | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.type === 'pane') {
    if (context.paneCount >= MAX_SPLIT_PANES) return null;
    const sessionId = normalizeSessionId(record.sessionId);
    if (!sessionId || context.seenSessionIds.has(sessionId)) return null;
    context.seenSessionIds.add(sessionId);
    context.paneCount += 1;
    return {
      type: 'pane',
      key: coerceKey(record.key, 'pane', context),
      sessionId,
    };
  }
  if (record.type !== 'split') return null;
  const first = coerceNode(record.first, context);
  const second = coerceNode(record.second, context);
  if (!first) return second;
  if (!second) return first;
  return {
    type: 'split',
    key: coerceKey(record.key, 'split', context),
    direction: record.direction === 'column' ? 'column' : 'row',
    fraction: normalizeFraction(record.fraction),
    first,
    second,
  };
}

function coerce(raw: unknown): SplitGroupState {
  if (typeof raw !== 'object' || raw === null) return EMPTY;
  const record = raw as Record<string, unknown>;
  const context: CoerceContext = {
    seenKeys: new Set<string>(),
    seenSessionIds: new Set<string>(),
    paneCount: 0,
  };
  const root = coerceNode(record.root, context);
  return root && getSplitPanes(root).length >= 2 ? { root } : EMPTY;
}

interface LegacyPane {
  key: string;
  sessionId: string;
  fraction: number;
}

function legacyTree(
  panes: readonly LegacyPane[],
  direction: SplitDirection,
  existingKeys: Set<string>,
): SplitNode | null {
  if (panes.length === 0) return null;
  const [firstPane, ...rest] = panes;
  const first: SplitPaneNode = {
    type: 'pane',
    key: firstPane.key,
    sessionId: firstPane.sessionId,
  };
  existingKeys.add(first.key);
  if (rest.length === 0) return first;
  const remainingWeight = rest.reduce((sum, pane) => sum + pane.fraction, 0);
  const second = legacyTree(rest, direction, existingKeys);
  if (!second) return first;
  return {
    type: 'split',
    key: nextUniqueKey('split', existingKeys),
    direction,
    fraction: normalizeFraction(firstPane.fraction / (firstPane.fraction + remainingWeight)),
    first,
    second,
  };
}

function coerceLegacy(raw: unknown): SplitGroupState {
  if (typeof raw !== 'object' || raw === null) return EMPTY;
  const record = raw as Record<string, unknown>;
  const rawPanes = Array.isArray(record.panes) ? record.panes : [];
  const seenSessionIds = new Set<string>();
  const seenKeys = new Set<string>();
  const panes: LegacyPane[] = [];
  for (const rawPane of rawPanes) {
    if (panes.length >= MAX_SPLIT_PANES) break;
    if (typeof rawPane !== 'object' || rawPane === null) continue;
    const paneRecord = rawPane as Record<string, unknown>;
    const sessionId = normalizeSessionId(paneRecord.sessionId);
    if (!sessionId || seenSessionIds.has(sessionId)) continue;
    const key = coerceKey(paneRecord.key, 'pane', {
      seenKeys,
      seenSessionIds,
      paneCount: panes.length,
    });
    const fraction =
      typeof paneRecord.fraction === 'number' &&
      Number.isFinite(paneRecord.fraction) &&
      paneRecord.fraction > 0
        ? paneRecord.fraction
        : 1;
    seenSessionIds.add(sessionId);
    panes.push({ key, sessionId, fraction });
  }
  if (panes.length < 2) return EMPTY;
  const total = panes.reduce((sum, pane) => sum + pane.fraction, 0);
  const normalized = panes.map((pane) => ({ ...pane, fraction: pane.fraction / total }));
  const root = legacyTree(normalized, record.direction === 'column' ? 'column' : 'row', seenKeys);
  return root ? { root } : EMPTY;
}

function removePersistedState(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(SPLIT_GROUP_STORAGE_KEY);
    localStorage.removeItem(LEGACY_SPLIT_GROUP_STORAGE_KEY);
  } catch {
    // localStorage 不可用时退化为进程内状态。
  }
}

function persist(next: SplitGroupState): void {
  try {
    // 「在新窗口打开」的副窗口与主窗共享同源 localStorage。持久化布局只归主窗，
    // 副窗口的分屏仅存内存——否则副窗口启动即恢复主窗布局、又把自己的布局写回，
    // 两个窗口会互相覆盖。
    if (isSecondaryWindow()) return;
    if (typeof localStorage === 'undefined') return;
    if (!next.root || getSplitPanes(next.root).length < 2) {
      removePersistedState();
      return;
    }
    localStorage.setItem(SPLIT_GROUP_STORAGE_KEY, JSON.stringify(next));
    localStorage.removeItem(LEGACY_SPLIT_GROUP_STORAGE_KEY);
  } catch {
    // 配额、私密模式或测试 stub 失败不能阻断 UI 操作。
  }
}

function ensureHydrated(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    // 副窗口不恢复主窗的持久化分屏（见 persist 的窗口归属说明）。
    if (isSecondaryWindow()) return;
    if (typeof localStorage === 'undefined') return;
    const currentRaw = localStorage.getItem(SPLIT_GROUP_STORAGE_KEY);
    const legacyRaw = currentRaw ? null : localStorage.getItem(LEGACY_SPLIT_GROUP_STORAGE_KEY);
    if (!currentRaw && !legacyRaw) return;
    state = currentRaw
      ? coerce(JSON.parse(currentRaw) as unknown)
      : coerceLegacy(JSON.parse(legacyRaw!) as unknown);
    persist(state);
  } catch {
    state = EMPTY;
    removePersistedState();
  }
}

function emit(next: SplitGroupState): void {
  const panes = getSplitPanes(next.root);
  state = panes.length >= 2 ? next : EMPTY;
  persist(state);
  for (const listener of listeners) listener();
}

export const splitGroupStore = {
  subscribe(listener: () => void): () => void {
    ensureHydrated();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): SplitGroupState {
    ensureHydrated();
    return state;
  },

  isActive(): boolean {
    ensureHydrated();
    return getSplitPanes(state.root).length >= 2;
  },

  getAddBlockReason(
    sessionIdInput: string,
    anchorSessionIdInput: string,
  ): SplitGroupAddBlockReason | null {
    ensureHydrated();
    const sessionId = normalizeSessionId(sessionIdInput);
    const anchorSessionId = normalizeSessionId(anchorSessionIdInput);
    if (!sessionId || !anchorSessionId) return 'invalid';
    if (sessionId === anchorSessionId) return 'duplicate';
    const panes = getSplitPanes(state.root);
    if (panes.some((pane) => pane.sessionId === sessionId)) return 'duplicate';
    if (panes.length >= MAX_SPLIT_PANES) return 'limit-reached';
    if (state.root && !panes.some((pane) => pane.sessionId === anchorSessionId)) {
      return 'missing-anchor';
    }
    return null;
  },

  addSession(sessionIdInput: string, anchorSessionIdInput: string, side: DropSide): boolean {
    ensureHydrated();
    const sessionId = normalizeSessionId(sessionIdInput);
    const anchorSessionId = normalizeSessionId(anchorSessionIdInput);
    if (this.getAddBlockReason(sessionId, anchorSessionId)) return false;

    const existingKeys = new Set<string>();
    if (state.root) collectNodeKeys(state.root, existingKeys);
    const newPane: SplitPaneNode = {
      type: 'pane',
      key: nextUniqueKey('pane', existingKeys),
      sessionId,
    };
    existingKeys.add(newPane.key);
    const makeSplit = (anchorPane: SplitPaneNode): SplitBranchNode => ({
      type: 'split',
      key: nextUniqueKey('split', existingKeys),
      direction: directionForSide(side),
      fraction: 0.5,
      first: isBeforeSide(side) ? newPane : anchorPane,
      second: isBeforeSide(side) ? anchorPane : newPane,
    });

    if (!state.root) {
      const anchorPane: SplitPaneNode = {
        type: 'pane',
        key: nextUniqueKey('pane', existingKeys),
        sessionId: anchorSessionId,
      };
      emit({ root: makeSplit(anchorPane) });
      return true;
    }
    emit({
      root: replaceNode(
        state.root,
        (node) => node.type === 'pane' && node.sessionId === anchorSessionId,
        (node) => makeSplit(node as SplitPaneNode),
      ),
    });
    return true;
  },

  removeSession(sessionIdInput: string): void {
    ensureHydrated();
    const sessionId = normalizeSessionId(sessionIdInput);
    if (!sessionId || !state.root) return;
    const root = removePane(state.root, sessionId);
    if (root === state.root) return;
    emit({ root });
  },

  replaceSession(currentSessionIdInput: string, nextSessionIdInput: string): void {
    ensureHydrated();
    const currentSessionId = normalizeSessionId(currentSessionIdInput);
    const nextSessionId = normalizeSessionId(nextSessionIdInput);
    if (!currentSessionId || !nextSessionId || currentSessionId === nextSessionId || !state.root)
      return;
    const panes = getSplitPanes(state.root);
    if (panes.some((pane) => pane.sessionId === nextSessionId)) return;
    if (!panes.some((pane) => pane.sessionId === currentSessionId)) return;
    emit({
      root: replaceNode(
        state.root,
        (node) => node.type === 'pane' && node.sessionId === currentSessionId,
        (node) => ({ ...node, sessionId: nextSessionId }),
      ),
    });
  },

  clear(): void {
    ensureHydrated();
    if (!state.root) return;
    emit(EMPTY);
  },

  toggleRootDirection(): void {
    ensureHydrated();
    if (!state.root || state.root.type !== 'split') return;
    emit({
      root: {
        ...state.root,
        direction: state.root.direction === 'row' ? 'column' : 'row',
      },
    });
  },

  setSplitFraction(splitKey: string, fraction: number): void {
    ensureHydrated();
    if (!state.root || !splitKey) return;
    const normalized = normalizeFraction(fraction);
    const root = replaceNode(
      state.root,
      (node) => node.type === 'split' && node.key === splitKey,
      (node) => ({ ...node, fraction: normalized }),
    );
    if (root === state.root) return;
    emit({ root });
  },

  __resetForTest(): void {
    state = EMPTY;
    hydrated = false;
    keySequence = 0;
    removePersistedState();
    for (const listener of listeners) listener();
  },
};

export function useSplitGroup(): SplitGroupState {
  return useSyncExternalStore(splitGroupStore.subscribe, splitGroupStore.getSnapshot, () => EMPTY);
}
