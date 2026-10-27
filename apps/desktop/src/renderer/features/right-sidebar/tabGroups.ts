/**
 * tabGroups —— 页签属于哪个页签组(左 / 右 / 上 / 下)。
 *
 * 右侧栏的页签默认都在右侧组(历史右侧栏)。用户可以把任意页签(任务页签或全局
 * 页签)移到聊天区的另一条边:这里只记「tabId → 组」,页签本体仍在原来的存储里
 * (任务页签在 SQLite 桶,全局页签在 globalTabs)。缺省 = 右侧组,所以老数据零迁移。
 *
 * 持久化走 renderer 自有的 localStorage(按数据所有者分键,与 globalTabs 同一条路;
 * 存的是界面配置而不是任务数据),`storage` 事件做跨窗口同步。条目有上限,关闭
 * 页签时顺手清掉(store.forgetClosedTab / globalTabs.removeGlobalTab)。
 *
 * 每个组另有一份「组内激活页签」的运行期记忆(不持久化):任务桶的 activeTabId
 * 仍是任务级的焦点页签;某组里不含它时,组内显示自己上次选中的那个。
 */

import { useSyncExternalStore } from 'react';

import { isTabGroupId, TAB_GROUP_IDS, type TabGroupId } from '../../../shared/layoutTree';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';

export { TAB_GROUP_IDS };
export type { TabGroupId };

const log = createLogger('rightSidebar.tabGroups');

const STORAGE_KEY_PREFIX = 'xdt:sidebarTabGroups:v1:';
const MAX_ENTRIES = 1000;
export const DEFAULT_TAB_GROUP: TabGroupId = 'right';

/** tabId → 非默认组。右侧组不落条目。 */
export type TabGroupAssignments = Readonly<Record<string, TabGroupId>>;

const EMPTY: TabGroupAssignments = Object.freeze({}) as TabGroupAssignments;

let cache: TabGroupAssignments | null = null;
let cacheOwnerKey: string | null = null;
const subscribers = new Set<() => void>();
let storageListenerWired = false;
/** `${groupId}|${sessionId ?? ''}` → 组内上次激活的页签。 */
const groupActive = new Map<string, string>();

function ownerKey(): string {
  return STORAGE_KEY_PREFIX + (getDataOwnerGeneration().dataOwnerId ?? 'none');
}

export function sanitizeTabGroupAssignments(raw: unknown): TabGroupAssignments {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY;
  const out: Record<string, TabGroupId> = {};
  let count = 0;
  for (const [tabId, groupId] of Object.entries(raw as Record<string, unknown>)) {
    if (!tabId || !isTabGroupId(groupId) || groupId === DEFAULT_TAB_GROUP) continue;
    out[tabId] = groupId;
    if (++count >= MAX_ENTRIES) break;
  }
  return out;
}

function load(): TabGroupAssignments {
  try {
    const raw = window.localStorage.getItem(ownerKey());
    if (!raw) return EMPTY;
    return sanitizeTabGroupAssignments(JSON.parse(raw));
  } catch {
    return EMPTY;
  }
}

function notify(): void {
  for (const cb of [...subscribers]) cb();
}

function ensureStorageListener(): void {
  if (storageListenerWired || typeof window === 'undefined') return;
  storageListenerWired = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== cacheOwnerKey) return;
    cache = null;
    notify();
  });
}

/** 写路径专用:丢掉本窗口缓存、从 localStorage 重读最新再改(理由同 globalTabs 的 freshSnapshot)。 */
function freshAssignments(): TabGroupAssignments {
  cache = null;
  return getTabGroupAssignments();
}

export function getTabGroupAssignments(): TabGroupAssignments {
  const key = ownerKey();
  if (cache === null || cacheOwnerKey !== key) {
    cache = load();
    cacheOwnerKey = key;
    ensureStorageListener();
  }
  return cache;
}

function persist(next: Record<string, TabGroupId>): void {
  const key = ownerKey();
  cache = next;
  cacheOwnerKey = key;
  try {
    if (Object.keys(next).length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(next));
  } catch (err) {
    log.warn('persist tab group assignments failed', { err });
  }
  notify();
}

/** 某页签所在的组;没有记录 = 右侧组。 */
export function getTabGroup(tabId: string): TabGroupId {
  return getTabGroupAssignments()[tabId] ?? DEFAULT_TAB_GROUP;
}

export function tabGroupOf(assignments: TabGroupAssignments, tabId: string): TabGroupId {
  return assignments[tabId] ?? DEFAULT_TAB_GROUP;
}

/** 把页签放进某组。放回右侧组 = 删条目。超出上限时丢最早的条目。 */
export function setTabGroup(tabId: string, groupId: TabGroupId): void {
  const current = freshAssignments();
  if (tabGroupOf(current, tabId) === groupId) return;
  const next: Record<string, TabGroupId> = { ...current };
  if (groupId === DEFAULT_TAB_GROUP) {
    delete next[tabId];
  } else {
    delete next[tabId];
    next[tabId] = groupId;
    const keys = Object.keys(next);
    for (let i = 0; keys.length - i > MAX_ENTRIES; i++) delete next[keys[i]];
  }
  persist(next);
}

/** 页签关闭:清掉它的组记录(没有记录时 no-op,不触发通知)。 */
export function clearTabGroup(tabId: string): void {
  const current = freshAssignments();
  if (!(tabId in current)) return;
  const next = { ...current };
  delete next[tabId];
  persist(next);
}

function activeKey(groupId: TabGroupId, sessionId: string | null): string {
  return `${groupId}|${sessionId ?? ''}`;
}

/** 组内上次激活的页签(运行期记忆);没有返回 null。 */
export function getGroupActiveTabId(groupId: TabGroupId, sessionId: string | null): string | null {
  return groupActive.get(activeKey(groupId, sessionId)) ?? null;
}

export function setGroupActiveTabId(
  groupId: TabGroupId,
  sessionId: string | null,
  tabId: string | null,
): void {
  const key = activeKey(groupId, sessionId);
  const prev = groupActive.get(key) ?? null;
  if (prev === tabId) return;
  if (tabId === null) groupActive.delete(key);
  else groupActive.set(key, tabId);
  notify();
}

export function subscribeTabGroups(cb: () => void): () => void {
  getTabGroupAssignments();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** React hook:全部组归属(引用变化 = 有写入或跨窗口同步)。 */
export function useTabGroupAssignments(): TabGroupAssignments {
  return useSyncExternalStore(subscribeTabGroups, getTabGroupAssignments);
}

/** 右键菜单 / 入口文案的 i18n key。 */
export function tabGroupLabelKey(groupId: TabGroupId): string {
  return `rightSidebar.tabGroups.${groupId}`;
}

/** 仅测试用。 */
export function __resetTabGroupsForTest(): void {
  cache = null;
  cacheOwnerKey = null;
  subscribers.clear();
  groupActive.clear();
}
