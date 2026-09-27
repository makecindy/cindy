/**
 * 伙伴群聊列表的 renderer 镜像，以及分工（安排）操作的调用入口。
 *
 * 权威数据在 main（当前账号本地库的 bot_groups / members / messages），这里只缓存
 * `listBotGroups()` 的最新一份摘要，供侧栏「群聊」分组与群设置抽屉读取。main 每次
 * 变更都会推 `onBotGroupChanged`，收到后整表重取；同一时刻只有一个请求在飞，期间
 * 再来的推送合并成一次补取。账号（data owner）切换时立即清空，旧账号的迟到响应
 * 一律丢弃（electron-security-and-process-boundaries §4–5：renderer 不持有真相）。
 */
import { useSyncExternalStore } from 'react';

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
let inFlight: Promise<void> | null = null;
let refreshQueued = false;
let syncUsers = 0;
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
  snapshot = EMPTY_SNAPSHOT;
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
      // 失败时保留上一份列表：侧栏不因一次读失败把所有群清空。
      applySnapshot(result.ok ? { groups: result.groups, loaded: true } : { ...snapshot, loaded: true });
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
      unsubscribePush = api.onBotGroupChanged((_payload, ownerStamp) => {
        if (!isDataOwnerPushCurrent(ownerStamp)) return;
        refreshBotGroups();
      });
    }
  }
  refreshBotGroups();
  return () => {
    syncUsers = Math.max(0, syncUsers - 1);
    if (syncUsers === 0) {
      unsubscribePush?.();
      unsubscribePush = null;
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
  owner = getDataOwnerGeneration();
  snapshot = EMPTY_SNAPSHOT;
  listeners.clear();
}
