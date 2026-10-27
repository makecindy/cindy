/** Window-shared exact task responsibility IDs. Project discovery never implies ownership.
 * Older hosts without task IDs produce no marks; changes and owner switches reload the snapshot.
 */
import { useMemo, useSyncExternalStore } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';

import { isWorkbenchTaskSource } from '../../../shared/botWorkbench';
import { ensureBotProfilesLoaded, hasLoadedBotProfiles, useBotProfiles, type BotProfile } from './botStore';

const log = createLogger('BotFollowScopes');

export interface BotFollowScope {
  botId: string;
  /** Every task the Bot is responsible for: its own background tasks and the ones it took over. */
  sessionIds?: readonly string[];
  /** Only the background tasks the Bot started itself; older hosts omit it. */
  delegatedSessionIds?: readonly string[];
}

const EMPTY: readonly BotFollowScope[] = [];

let scopes: readonly BotFollowScope[] = EMPTY;
let owner = getDataOwnerGeneration();
let requested = false;
let loadSeq = 0;
let changeSubscribed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 读取失败(例如刚启动时本机数据还没就绪)时有限次退避重试,不让标记一直缺失。 */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function load(attempt = 0): void {
  const api = window.electronAPI?.localDb?.bots?.workbench?.followScopes;
  if (!api) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const seq = ++loadSeq;
  const loadOwner = getDataOwnerGeneration();
  void api()
    .then((next) => {
      if (seq !== loadSeq || !isDataOwnerGenerationCurrent(loadOwner)) return;
      scopes = Array.isArray(next) ? next : EMPTY;
      // 名字与头像来自伙伴列表;侧栏还没打开过伙伴页时顺带读一次。
      if (scopes.length > 0 && !hasLoadedBotProfiles()) {
        void ensureBotProfilesLoaded().catch((error: unknown) => log.warn('Bot profiles load failed', error));
      }
      emit();
    })
    .catch((error: unknown) => {
      if (seq !== loadSeq || !isDataOwnerGenerationCurrent(loadOwner)) return;
      scopes = EMPTY;
      emit();
      log.warn('Bot follow scopes load failed', error);
      const delay = RETRY_DELAYS_MS[attempt];
      if (seq !== loadSeq || delay === undefined) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (seq === loadSeq && isDataOwnerGenerationCurrent(loadOwner)) load(attempt + 1);
      }, delay);
    });
}

/** 换账号时清空并重读;快照读取里只重置,不同步发 IPC。 */
function ensureOwner(): void {
  if (isDataOwnerGenerationCurrent(owner)) return;
  owner = getDataOwnerGeneration();
  scopes = EMPTY;
  requested = false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!changeSubscribed) {
    // 窗口级订阅,不随任务行挂载 / 卸载反复增删(侧栏滚动时行会频繁重建)。
    const off = window.electronAPI?.maker?.onBotWorkbenchChanged?.(() => load());
    const offDelegation = window.electronAPI?.maker?.onBotDelegationChanged?.(() => load());
    changeSubscribed = off !== undefined || offDelegation !== undefined;
  }
  ensureOwner();
  if (!requested) {
    requested = true;
    load();
  }
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly BotFollowScope[] {
  if (!isDataOwnerGenerationCurrent(owner)) {
    ensureOwner();
    queueMicrotask(() => {
      if (requested) return;
      requested = true;
      load();
    });
  }
  return scopes;
}

/** 本机普通任务:不是远程任务、伙伴自己的主任务或 Orca worker。 */
function isLocalPlainSession(session: Session): boolean {
  if (session.remoteHostId || session.deviceLinkDeviceId) return false;
  if (session.source === 'bot' || session.orcaRole === 'worker') return false;
  return isWorkbenchTaskSource(session.source);
}

/** 能被伙伴跟进的任务:本机、未归档的普通任务。 */
function isFollowableSession(session: Session): boolean {
  return session.status === 'active' && isLocalPlainSession(session);
}

/** 伙伴自己开的后台任务:归档后从工作台打开仍要标明归属并能回到该伙伴(cindy-bots-runtime.md 任务入口)。 */
function isDelegatableSession(session: Session): boolean {
  return (session.status === 'active' || session.status === 'archived') && isLocalPlainSession(session);
}

function useScopedBots(
  session: Session,
  eligible: (session: Session) => boolean,
  ids: (scope: BotFollowScope) => readonly string[] | undefined,
): BotProfile[] {
  const followScopes = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const profiles = useBotProfiles();
  const followable = eligible(session);
  const sessionId = session.id;
  return useMemo(() => {
    if (!followable || followScopes.length === 0) return [];
    const matching = new Set(
      followScopes
        .filter((scope) => { const list = ids(scope); return Array.isArray(list) && list.includes(sessionId); })
        .map((scope) => scope.botId),
    );
    if (matching.size === 0) return [];
    return profiles
      .filter((bot) => matching.has(bot.id) && bot.enabled && !bot.hiddenAt
        && (bot.status === undefined || bot.status === 'active'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [followable, followScopes, ids, profiles, sessionId]);
}

const responsibleIds = (scope: BotFollowScope) => scope.sessionIds;
const delegatedIds = (scope: BotFollowScope) => scope.delegatedSessionIds;

/** 正在负责这件任务的伙伴(按名字排序;隐藏、停用的伙伴不显示)。 */
export function useSessionFollowers(session: Session): BotProfile[] {
  return useScopedBots(session, isFollowableSession, responsibleIds);
}

/**
 * 这件任务是哪位伙伴自己开的后台任务(委派子任务);主人的任务被伙伴接手只算「在跟进」,
 * 不算伙伴的后台任务。已归档的后台任务仍标归属。旧宿主没有这份投影时不猜。
 */
export function useSessionDelegatingBot(session: Session): BotProfile | null {
  return useScopedBots(session, isDelegatableSession, delegatedIds)[0] ?? null;
}

export const __testing = {
  reset(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    scopes = EMPTY;
    owner = getDataOwnerGeneration();
    requested = false;
    loadSeq = 0;
    changeSubscribed = false;
    listeners.clear();
  },
};
