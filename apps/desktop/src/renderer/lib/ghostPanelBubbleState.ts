/**
 * ghostPanelBubbleState —— 插件停靠面板「最小化为浮动气泡」的 renderer 端状态。
 *
 * 纯视图态,renderer 自有(localStorage 持久化,重启保留),不经 main:
 * 与 maximize(会话态)/ detach(main 持久化)三分天下——气泡既要重启保留
 * 又不涉及窗口/进程,localStorage 恰好(键规范照 state/modelVisibilityPrefs.ts)。
 *
 * 形如 { [ghostId]: { minimized, x?, y? } }:
 *  - minimized:面板是否收进气泡(LayoutRoot 据此隐藏停靠 pane,树不动);
 *  - x/y:**遗留字段**(2026-07-31 起气泡层只画一枚幽灵球,子气泡由球锚定,
 *    不再各记各的位置;幽灵球落点在气泡层自己的独立键)。历史写入保留不清,
 *    sanitize 照旧容忍,setGhostPanelBubblePosition 留作 API 兼容。
 *
 * reconcile 语义对齐 main/ghost-panel-window controller:卸载删条目;停用/
 * 无 panel/tab 形态/身份卡关按钮 → 强制还原(留位置)——气泡永不成死角。
 */

import { useSyncExternalStore } from 'react';

import { GHOST_PANEL_KIND_PREFIX, type InstalledGhost } from '../../shared/ghost';

const STORAGE_KEY = 'xdt:ghostPanelBubble:v1';

export interface GhostPanelBubbleEntry {
  minimized: boolean;
  x?: number;
  y?: number;
}

export type GhostPanelBubbleMap = Record<string, GhostPanelBubbleEntry>;

let cache: GhostPanelBubbleMap | null = null;
const subscribers = new Set<() => void>();
let storageListenerWired = false;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 解析并清洗持久化数据:坏形态整条丢弃,x/y 必须双双有限数否则略去。 */
function sanitize(raw: unknown): GhostPanelBubbleMap {
  if (!isPlainObject(raw)) return {};
  const out: GhostPanelBubbleMap = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.minimized !== 'boolean') continue;
    const hasPos = Number.isFinite(entry.x) && Number.isFinite(entry.y);
    if (!entry.minimized && !hasPos) continue; // 空条目不留
    out[id] = {
      minimized: entry.minimized,
      ...(hasPos ? { x: Math.round(entry.x as number), y: Math.round(entry.y as number) } : {}),
    };
  }
  return out;
}

function load(): GhostPanelBubbleMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return sanitize(JSON.parse(raw));
  } catch {
    return {};
  }
}

function ensureLoaded(): GhostPanelBubbleMap {
  if (cache === null) cache = load();
  ensureStorageListener();
  return cache;
}

/** Keep the in-memory mirror aligned when another BrowserWindow changes the bubble state. */
function ensureStorageListener(): void {
  if (storageListenerWired || typeof window === 'undefined') return;
  storageListenerWired = true;
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== window.localStorage || event.key !== STORAGE_KEY) return;
    let next: unknown = {};
    if (event.newValue) {
      try {
        next = JSON.parse(event.newValue);
      } catch {
        next = {};
      }
    }
    cache = sanitize(next);
    subscribers.forEach((cb) => cb());
  });
}

/** 整表替换 + 持久化 + 通知(引用变化即订阅者更新信号)。 */
function commit(next: GhostPanelBubbleMap): void {
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 持久化失败不拦交互(隐私模式等),内存态照常生效
  }
  subscribers.forEach((cb) => cb());
}

export function getGhostPanelBubbleState(): GhostPanelBubbleMap {
  return ensureLoaded();
}

/** 布局过滤谓词(非 hook,LayoutRoot 纯函数路径用)。非 ghost 面板恒 false。 */
export function isGhostPanelKindMinimized(panelKind: string): boolean {
  if (!panelKind.startsWith(GHOST_PANEL_KIND_PREFIX)) return false;
  const ghostId = panelKind.slice(GHOST_PANEL_KIND_PREFIX.length);
  return ensureLoaded()[ghostId]?.minimized === true;
}

/** 收进气泡(保留既有位置,重最小化回老位置)。 */
export function minimizeGhostPanel(ghostId: string): void {
  const cur = ensureLoaded();
  if (cur[ghostId]?.minimized === true) return;
  commit({ ...cur, [ghostId]: { ...cur[ghostId], minimized: true } });
}

/** 从气泡恢复停靠(位置保留;入场滑入由 GhostPanel 挂载时机自判)。 */
export function restoreGhostPanel(ghostId: string): void {
  const cur = ensureLoaded();
  const entry = cur[ghostId];
  if (!entry || entry.minimized === false) return;
  const next = { ...cur };
  const hasPos = Number.isFinite(entry.x) && Number.isFinite(entry.y);
  if (hasPos) next[ghostId] = { ...entry, minimized: false };
  else delete next[ghostId]; // 没位置的还原条目是空信息,不留
  commit(next);
}

/** 气泡拖放落点(视口 px,取整)。 */
export function setGhostPanelBubblePosition(ghostId: string, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const cur = ensureLoaded();
  const entry = cur[ghostId] ?? { minimized: false };
  commit({ ...cur, [ghostId]: { ...entry, x: Math.round(x), y: Math.round(y) } });
}

/**
 * 与"当前已装清单"对齐(syncGhostPanelRegistrations 每次同步时调):
 * 卸载删条目;失去气泡资格(停用/无 panel/tab 形态/身份卡关按钮)强制还原。
 */
export function reconcileGhostPanelBubbles(
  ghosts: readonly Pick<InstalledGhost, 'manifest' | 'enabled'>[],
): void {
  const cur = ensureLoaded();
  const ids = Object.keys(cur);
  if (ids.length === 0) return;
  const byId = new Map(ghosts.map((g) => [g.manifest.id, g]));
  let changed = false;
  const next: GhostPanelBubbleMap = { ...cur };
  for (const id of ids) {
    const ghost = byId.get(id);
    if (!ghost) {
      delete next[id];
      changed = true;
      continue;
    }
    const eligible =
      ghost.enabled !== false &&
      ghost.manifest.panel !== undefined &&
      ghost.manifest.panel.position !== 'tab' &&
      ghost.manifest.panel.systemButtons?.minimize !== false;
    if (!eligible && next[id].minimized) {
      const entry = next[id];
      const hasPos = Number.isFinite(entry.x) && Number.isFinite(entry.y);
      if (hasPos) next[id] = { ...entry, minimized: false };
      else delete next[id];
      changed = true;
    }
  }
  if (changed) commit(next);
}

function subscribe(cb: () => void): () => void {
  ensureLoaded();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** React hook:订阅全量表(commit 替换对象引用 = 更新信号)。 */
export function useGhostPanelBubbleState(): GhostPanelBubbleMap {
  return useSyncExternalStore(subscribe, getGhostPanelBubbleState);
}

/** 仅测试用。 */
export function __resetGhostPanelBubbleStateForTest(): void {
  cache = null;
  subscribers.clear();
  storageListenerWired = false;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
