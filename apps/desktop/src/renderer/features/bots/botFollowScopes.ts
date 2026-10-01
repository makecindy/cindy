/**
 * 侧栏「<伙伴>在跟进」的数据:每个在用的本机伙伴接手了哪些项目。
 *
 * 整个窗口共享一份:第一次有任务行订阅时读一次,之后只在伙伴工作台变化或换账号时重读。
 * 任务行各自只做本地匹配(与工作台同一套项目归属规则 `findWorkbenchProject`),不各自发 IPC。
 */
import { useMemo, useSyncExternalStore } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';

import {
  findWorkbenchProject,
  isCaseInsensitivePlatform,
  isWorkbenchTaskSource,
} from '../../../shared/botWorkbench';
import { ensureBotProfilesLoaded, hasLoadedBotProfiles, useBotProfiles, type BotProfile } from './botStore';

const log = createLogger('BotFollowScopes');

export interface BotFollowScope {
  botId: string;
  directories: readonly string[];
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
    changeSubscribed = off !== undefined;
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

/** 能被伙伴跟进的任务:本机、未归档、普通来源、不是伙伴自己的任务或 Orca worker。 */
function isFollowableSession(session: Session): boolean {
  if (session.status !== 'active' || !session.workingDir) return false;
  if (session.remoteHostId || session.deviceLinkDeviceId) return false;
  if (session.source === 'bot' || session.orcaRole === 'worker') return false;
  return isWorkbenchTaskSource(session.source);
}

/** 正在跟进这件任务所在项目的伙伴(按名字排序;隐藏、停用的伙伴不显示)。 */
export function useSessionFollowers(session: Session): BotProfile[] {
  const followScopes = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const profiles = useBotProfiles();
  const followable = isFollowableSession(session);
  const workingDir = session.workingDir;
  return useMemo(() => {
    if (!followable || followScopes.length === 0) return [];
    const caseInsensitive = isCaseInsensitivePlatform(window.electronAPI?.platform);
    const following = new Set(
      followScopes
        .filter((scope) => findWorkbenchProject(workingDir, scope.directories, caseInsensitive) !== null)
        .map((scope) => scope.botId),
    );
    if (following.size === 0) return [];
    return profiles
      .filter((bot) => following.has(bot.id) && bot.enabled && !bot.hiddenAt
        && (bot.status === undefined || bot.status === 'active'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [followable, followScopes, profiles, workingDir]);
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
