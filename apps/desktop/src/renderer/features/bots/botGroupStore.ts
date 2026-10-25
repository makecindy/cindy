/**
 * 伙伴群聊列表的 renderer 镜像，以及分工（安排）操作的调用入口。
 *
 * 权威数据在 main（当前账号本地库的 bot_groups / members / messages），这里只缓存
 * `listBotGroups()` 的最新一份摘要，供统一侧栏与群设置抽屉读取。main 每次
 * 变更都会推 `onBotGroupChanged`，收到后整表重取（IPC 没有单群摘要读取）：推送先攒
 * 300ms 再读一次，一段对话里连发的推送只读一两次；同一时刻只有一个请求在飞，期间再来的
 * 合并成一次补取；读回的摘要与当前一致时不通知订阅者，侧栏与角标不重绘。账号（data
 * owner）切换时立即清空，旧账号的迟到响应一律丢弃（electron-security-and-process-boundaries
 * §4–5：renderer 不持有真相）。
 */
import { useCallback, useSyncExternalStore } from 'react';
import { seedBotGroupReadState } from './botReadState';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import type {
  BotGroupMutationResult,
  BotGroupPlanAction,
  BotGroupPlanActionInput,
  BotGroupPlanEditInput,
  BotGroupSummary,
} from '../../../shared/botGroupChat';

export interface BotGroupListSnapshot {
  groups: readonly BotGroupSummary[];
  /** True once the first list request for the current owner settled. */
  loaded: boolean;
}

type MakerApi = Window['electronAPI']['maker'];

const EMPTY_SNAPSHOT: BotGroupListSnapshot = { groups: [], loaded: false };

let snapshot: BotGroupListSnapshot = EMPTY_SNAPSHOT;
let owner = getDataOwnerGeneration();
let generation = 0;
const personalList = new Map<string, { hidden: boolean; revision: number }>();
const visibleGroups = (groups: readonly BotGroupSummary[]) => groups.filter(group => !personalList.get(group.id)?.hidden);
let inFlight: Promise<void> | null = null;
let refreshQueued = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let syncUsers = 0;
/** Pushes within this window collapse into one list read. */
const PUSH_REFRESH_DELAY_MS = 300;
let unsubscribePush: (() => void) | null = null;
const listeners = new Set<() => void>();

/**
 * The group IPC surface, or null while the preload in this window has not
 * bridged it (secondary windows, older hosts, tests).
 */
export function botGroupApi(): MakerApi | null {
  if (typeof window === 'undefined') return null;
  const maker = window.electronAPI?.maker;
  return maker && typeof maker.listBotGroups === 'function' ? maker : null;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function ensureOwner(): void {
  if (isDataOwnerGenerationCurrent(owner)) return;
  owner = getDataOwnerGeneration();
  generation += 1;
  inFlight = null;
  refreshQueued = false;
  cancelPushRefresh();
  snapshot = EMPTY_SNAPSHOT;
  personalList.clear();
}

function cancelPushRefresh(): void {
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = null;
}

/** A push changed something: read the list once the burst has settled. */
function schedulePushRefresh(): void {
  if (pushTimer !== null) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    refreshBotGroups();
  }, PUSH_REFRESH_DELAY_MS);
}

function applySnapshot(next: BotGroupListSnapshot): void {
  snapshot = next;
  emit();
}

/** Re-read the list from main; concurrent calls collapse into one follow-up. */
export function refreshBotGroups(): void {
  ensureOwner();
  const api = botGroupApi();
  if (!api) return;
  if (inFlight) {
    refreshQueued = true;
    return;
  }
  const requestOwner = owner;
  const requestGeneration = generation;
  const isCurrent = () =>
    requestGeneration === generation && isDataOwnerGenerationCurrent(requestOwner);
  const request = (async () => {
    try {
      // Every change kind re-reads the list, including 'plan' (open-plan status in the row).
      const result = await api.listBotGroups();
      if (!isCurrent()) return;
      if (result.ok) seedBotGroupReadState(visibleGroups(result.groups));
      // An unchanged list keeps its snapshot: subscribers (sidebar, Dock badge) do not re-render.
      if (result.ok && snapshot.loaded && JSON.stringify(visibleGroups(result.groups)) === JSON.stringify(snapshot.groups)) return;
      // 失败时保留上一份列表：侧栏不因一次读失败把所有群清空。
      applySnapshot(result.ok ? { groups: visibleGroups(result.groups), loaded: true } : { ...snapshot, loaded: true });
    } catch {
      if (isCurrent()) applySnapshot({ ...snapshot, loaded: true });
    }
  })();
  inFlight = request;
  void request.finally(() => {
    if (inFlight !== request) return;
    inFlight = null;
    if (refreshQueued) {
      refreshQueued = false;
      refreshBotGroups();
    }
  });
}

/**
 * Keep the list in sync with main while a Bots surface is mounted. Returns the
 * release callback; the push subscription is shared by all users.
 */
export function startBotGroupSync(): () => void {
  syncUsers += 1;
  if (syncUsers === 1) {
    const api = botGroupApi();
    if (api && typeof api.onBotGroupChanged === 'function') {
      unsubscribePush = api.onBotGroupChanged((payload, ownerStamp) => {
        if (!isDataOwnerPushCurrent(ownerStamp)) return;
        ensureOwner();
        if (payload.change === 'list' && payload.listState && (personalList.get(payload.groupId)?.revision ?? 0) < payload.listState.revision) {
          personalList.set(payload.groupId, payload.listState);
          const groups = visibleGroups(snapshot.groups);
          seedBotGroupReadState(groups);
          applySnapshot({ ...snapshot, groups });
        }
        schedulePushRefresh();
      });
    }
  }
  refreshBotGroups();
  return () => {
    syncUsers = Math.max(0, syncUsers - 1);
    if (syncUsers === 0) {
      unsubscribePush?.();
      unsubscribePush = null;
      cancelPushRefresh();
    }
  };
}

export function getBotGroupListSnapshot(): BotGroupListSnapshot {
  ensureOwner();
  return snapshot;
}

export function subscribeBotGroups(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBotGroupList(): BotGroupListSnapshot {
  return useSyncExternalStore(subscribeBotGroups, getBotGroupListSnapshot, getBotGroupListSnapshot);
}

/** One listed group, or null; a null id reads nothing and never re-renders on list refreshes. */
export function useBotGroupSummary(groupId: string | null): BotGroupSummary | null {
  const read = useCallback(
    () => (groupId ? getBotGroupListSnapshot().groups.find((group) => group.id === groupId) ?? null : null),
    [groupId],
  );
  return useSyncExternalStore(subscribeBotGroups, read, read);
}

const NOT_READY: BotGroupMutationResult = { ok: false, errorCode: 'HOST_NOT_READY', message: '' };

/**
 * Run a 分工 action (开始 / 不用了 / 继续 / 重试) on a plan. Main pushes a `'plan'`
 * change afterwards, which every mounted surface re-reads; the list is refreshed here
 * as well so the sidebar follows at once. Resolves null when the data owner changed
 * while the call was in flight — the answer belongs to another account.
 */
export async function runBotGroupPlanAction(
  action: BotGroupPlanAction,
  input: BotGroupPlanActionInput,
): Promise<BotGroupMutationResult | null> {
  const api = botGroupApi();
  const call =
    action === 'start'
      ? api?.startBotGroupPlan
      : action === 'dismiss'
        ? api?.dismissBotGroupPlan
        : action === 'continue'
          ? api?.continueBotGroupPlan
          : api?.retryBotGroupPlan;
  if (!api || typeof call !== 'function') return NOT_READY;
  return settlePlanMutation(() => call(input));
}

/** Reassign or remove a step of a proposed plan. */
export async function editBotGroupPlanStep(input: BotGroupPlanEditInput): Promise<BotGroupMutationResult | null> {
  const api = botGroupApi();
  if (!api || typeof api.editBotGroupPlanStep !== 'function') return NOT_READY;
  return settlePlanMutation(() => api.editBotGroupPlanStep(input));
}

/** Whether 分工 you start here go on by themselves; kept on this computer (§7.4). */
export async function setBotGroupAutoContinue(groupId: string, autoContinue: boolean): Promise<BotGroupMutationResult | null> {
  const api = botGroupApi();
  if (!api || typeof api.updateBotGroup !== 'function') return NOT_READY;
  return settlePlanMutation(() => api.updateBotGroup({ groupId, autoContinue }));
}

async function settlePlanMutation(
  run: () => Promise<BotGroupMutationResult>,
): Promise<BotGroupMutationResult | null> {
  const requestOwner = getDataOwnerGeneration();
  const result = await run();
  if (!isDataOwnerGenerationCurrent(requestOwner)) return null;
  if (result.ok) refreshBotGroups();
  return result;
}

/** Test-only reset of the module state. */
export function resetBotGroupStoreForTests(): void {
  unsubscribePush?.();
  unsubscribePush = null;
  syncUsers = 0;
  generation += 1;
  inFlight = null;
  refreshQueued = false;
  cancelPushRefresh();
  owner = getDataOwnerGeneration();
  snapshot = EMPTY_SNAPSHOT;
  listeners.clear();
}
