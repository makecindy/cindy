/** Window-shared exact task responsibility IDs. Project discovery never implies ownership.
 * Older hosts without task IDs produce no marks; changes and owner switches reload the snapshot.
 */
import { useMemo, useSyncExternalStore } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';

import { isTeammateTaskSession } from '../../../shared/sessionSource';
import { isWorkbenchTaskSource } from '../../../shared/botWorkbench';
import { useRemoteBots, useRemoteCindyIds } from './useRemoteBots';
import { useCompanionCloud } from './companionCloudStore';
import { cloudRemoteBots, withoutShadowedBots } from './companionCloudPresentation';
import { taskCreatorFilterKey } from './cindyDeviceRoster';
import { taskBotKey, type RemoteBot } from './remoteBotRoster';
export { taskBotKey } from './remoteBotRoster';
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

export function useBotFollowScopes(): readonly BotFollowScope[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Display identity only; a remote identity must never become a local action target. */
export type TaskBotIdentity = Pick<BotProfile, 'id' | 'name' | 'avatar' | 'avatarColor'> & {
  deviceId?: string;
  deviceName?: string;
  taskRelation?: 'created' | 'owned';
  templateId?: string;
  filterKey?: string;
  /** Previous per-computer/cloud selection keys, preserving existing filter choices. */
  filterMemberKeys?: readonly string[];
};

export function useTaskCreatorOptions(): TaskBotIdentity[] {
  const profiles = useBotProfiles();
  const remote = useRemoteBots();
  const cloud = useCompanionCloud();
  const cindyIds = useRemoteCindyIds();
  return useMemo(() => {
    const grouped = new Map<string, TaskBotIdentity>();
    for (const source of [...withoutShadowedBots(profiles, cloud).filter(bot => !bot.hiddenAt && bot.status !== 'deleting'), ...cloudRemoteBots(cloud, remote)]) {
      const bot = cindyIds.has(source.id) ? { ...source, templateId: 'cindy' } : source;
      const key = taskCreatorFilterKey(bot, cloud);
      const memberKeys = [taskBotKey(bot), ...(cloud.enabled && cloud.actors.some(actor => actor.externalId === bot.id)
        ? [JSON.stringify(['companion', bot.id])] : [])];
      const existing = grouped.get(key);
      if (existing) {
        existing.filterMemberKeys = [...new Set([...(existing.filterMemberKeys ?? []), ...memberKeys])];
      } else {
        // Keep the original device ID for avatar resolution; the merged choice has no device subtitle.
        grouped.set(key, { ...bot, filterKey: key, deviceName: key === taskBotKey(bot) && 'deviceName' in bot ? bot.deviceName : undefined,
          filterMemberKeys: memberKeys });
      }
    }
    // Old per-computer choices follow the same cloud companion after it moves home.
    for (const source of [...profiles, ...remote]) {
      const bot = cindyIds.has(source.id) ? { ...source, templateId: 'cindy' } : source;
      const option = grouped.get(taskCreatorFilterKey(bot, cloud));
      const member = taskBotKey(bot);
      if (option && !option.filterMemberKeys?.includes(member)) option.filterMemberKeys = [...(option.filterMemberKeys ?? []), member];
    }
    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [profiles, remote, cloud, cindyIds]);
}

/** Indexed once for the sidebar, so selecting multiple creators does not scan every Bot per row. */
export function useTaskCreatorIndex(): ReadonlyMap<string, ReadonlySet<string>> {
  const scopes = useBotFollowScopes();
  const profiles = useBotProfiles();
  const remote = useRemoteBots();
  const cloud = useCompanionCloud();
  const cindyIds = useRemoteCindyIds();
  return useMemo(() => {
    const index = new Map<string, Set<string>>();
    const filterKey = (bot: Pick<TaskBotIdentity, 'id' | 'deviceId' | 'templateId'>) =>
      taskCreatorFilterKey(cindyIds.has(bot.id) ? { ...bot, templateId: 'cindy' } : bot, cloud);
    const add = (bot: Pick<TaskBotIdentity, 'id' | 'deviceId' | 'templateId'>, ids: readonly string[] | undefined) => {
      for (const id of ids ?? []) {
        const key = taskCreatorSessionKey(id, bot.deviceId);
        const creators = index.get(key) ?? new Set<string>();
        creators.add(filterKey(bot));
        index.set(key, creators);
      }
    };
    for (const bot of [...profiles, ...remote]) {
      index.set(`creator:${taskBotKey(bot)}`, new Set([filterKey(bot)]));
    }
    const localById = new Map(profiles.map(bot => [bot.id, bot]));
    for (const scope of scopes) add(localById.get(scope.botId) ?? { id: scope.botId }, scope.delegatedSessionIds);
    for (const bot of remote) add(bot, bot.delegatedSessionIds);
    return index;
  }, [scopes, profiles, remote, cloud, cindyIds]);
}

function taskCreatorSessionKey(id: string, deviceId?: string): string {
  return JSON.stringify([deviceId ?? null, id]);
}

export function matchesTaskCreators(
  session: Session,
  selected: 'all' | 'none' | readonly string[],
  index: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (selected === 'all') return true;
  const creators = isTeammateTaskSession(session) && session.companion
    ? index.get(`creator:${taskBotKey({ id: session.companion.id, deviceId: session.deviceLinkDeviceId })}`)
    : index.get(taskCreatorSessionKey(session.id, session.deviceLinkDeviceId));
  if (selected === 'none') return !isTeammateTaskSession(session) && !creators?.size;
  return selected.some(key => creators?.has(key));
}

function useScopedBots(
  session: Session,
  eligible: (session: Session) => boolean,
  ids: (scope: BotFollowScope) => readonly string[] | undefined,
  activeProfilesOnly = true,
): BotProfile[] {
  const followScopes = useBotFollowScopes();
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
      .filter((bot) => matching.has(bot.id) && !bot.hiddenAt && bot.status !== 'deleting'
        && (!activeProfilesOnly || (bot.enabled && (bot.status === undefined || bot.status === 'active'))))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [followable, followScopes, ids, profiles, sessionId, activeProfilesOnly]);
}

const responsibleIds = (scope: BotFollowScope) => scope.sessionIds;
const delegatedIds = (scope: BotFollowScope) => scope.delegatedSessionIds;

/** 创建者归属不随归档消失；额外跟进者只在任务活跃时显示。 */
export function useSessionFollowers(session: Session): TaskBotIdentity[] {
  const local = useScopedBots(session, isFollowableSession, responsibleIds);
  const localCreators = useScopedBots(session, isDelegatableSession, delegatedIds, false);
  const remote = useRemoteBots();
  const profiles = useBotProfiles();
  return useMemo(() => {
    const order = (a: TaskBotIdentity, b: TaskBotIdentity) =>
      Number(b.taskRelation === 'created') - Number(a.taskRelation === 'created') || a.name.localeCompare(b.name);
    if (isTeammateTaskSession(session) && session.companion && session.orcaRole !== 'worker'
      && (session.status === 'active' || session.status === 'archived')) {
      const owner = session.deviceLinkDeviceId
        ? remote.find(bot => bot.deviceId === session.deviceLinkDeviceId && bot.id === session.companion!.id)
        : profiles.find(bot => bot.id === session.companion!.id && !bot.hiddenAt && bot.status !== 'deleting');
      return owner ? [{ ...owner, taskRelation: 'owned' as const }] : [];
    }
    if (!session.deviceLinkDeviceId) {
      const identities = new Map<string, TaskBotIdentity>(local.map(bot => [bot.id, bot]));
      for (const bot of localCreators) identities.set(bot.id, { ...bot, taskRelation: 'created' });
      return [...identities.values()].sort(order);
    }
    if ((session.status !== 'active' && session.status !== 'archived') || session.source === 'bot' || session.orcaRole === 'worker'
      || !isWorkbenchTaskSource(session.source)) return [];
    return remote.filter((bot: RemoteBot) => bot.deviceId === session.deviceLinkDeviceId
      && ((session.status === 'active' && bot.followingSessionIds?.includes(session.id)) || bot.delegatedSessionIds?.includes(session.id)))
      .map((bot): TaskBotIdentity => ({ ...bot, taskRelation: bot.delegatedSessionIds?.includes(session.id) ? 'created' : undefined }))
      .sort(order);
  }, [local, localCreators, remote, profiles, session.companion, session.deviceLinkDeviceId, session.status, session.source, session.orcaRole, session.id]);
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
