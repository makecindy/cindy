import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { desktopMakerLogger } from './logger-adapter.js';
import type { SessionUsageLimitFallback } from '../maker-ipc/sessionUsageLimitFallback.js';

/**
 * 「被降级并成功续跑」的一次机会记录。回切只消费它：没有 episode 就不切。
 *
 * 记账而不是猜状态，是为了区分「降级后停在这里」与「用户自己就要这个模型」——
 * 后者会让用户选择落地时清掉 episode（含同值重选）。
 */
export interface SessionUsageLimitFallbackEpisode {
  /** 降级成功续跑的时刻。 */
  failedAtMs: number;
  /** 那次错误能确定的重置时刻；拿不到就是 null（回切改用宽限期）。 */
  knownResetAtMs: number | null;
  /** 降级到的组合，用来确认任务确实还停在那儿。 */
  targetRoute: { providerId: string; model: string };
  /** 已经尝试回切的次数（含成功的那次）。 */
  attempts: number;
  /** 下一次允许尝试的最早时刻（退避）。 */
  nextEligibleAtMs: number;
}

interface Settings {
  policies: Record<string, SessionUsageLimitFallback>;
  episodes: Record<string, SessionUsageLimitFallbackEpisode>;
}

function normalizeEpisode(raw: unknown): SessionUsageLimitFallbackEpisode | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<SessionUsageLimitFallbackEpisode>;
  const route = value.targetRoute;
  if (
    typeof value.failedAtMs !== 'number' || !Number.isFinite(value.failedAtMs) ||
    typeof value.nextEligibleAtMs !== 'number' || !Number.isFinite(value.nextEligibleAtMs) ||
    typeof value.attempts !== 'number' || !Number.isSafeInteger(value.attempts) || value.attempts < 0 ||
    (value.knownResetAtMs !== null && (typeof value.knownResetAtMs !== 'number' || !Number.isFinite(value.knownResetAtMs))) ||
    !route || typeof route !== 'object' ||
    typeof route.providerId !== 'string' || !route.providerId ||
    typeof route.model !== 'string' || !route.model
  ) {
    return null;
  }
  return {
    failedAtMs: value.failedAtMs,
    knownResetAtMs: value.knownResetAtMs ?? null,
    targetRoute: { providerId: route.providerId, model: route.model },
    attempts: value.attempts,
    nextEligibleAtMs: value.nextEligibleAtMs,
  };
}

/**
 * 任务级的额度备用路线，按 session id 保存到当前 Cindy 数据所有者。
 * 只存用户显式配置的任务；没有条目 = 沿用既有「等额度重置后自动继续」行为。
 * 同一文件里还存回切用的 episode（见 SessionUsageLimitFallbackEpisode）。
 */
const store = createOverrideSettingsFile<Settings>({
  filePath: () => ownerScopedUserDataPath('session-usage-limit-fallbacks.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { policies: {}, episodes: {} },
  normalize: (raw) => {
    const policies: Settings['policies'] = {};
    const entries = (raw as Partial<Settings> | null)?.policies;
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
      for (const [sessionId, policy] of Object.entries(entries)) {
        if (!policy || typeof policy !== 'object') continue;
        const { source, target } = policy as Partial<SessionUsageLimitFallback>;
        if (
          !source ||
          !target ||
          (source.agentKind !== 'codex' && source.agentKind !== 'claude-code' && source.agentKind !== 'pi') ||
          typeof source.model !== 'string' ||
          typeof target.providerId !== 'string' ||
          !target.providerId ||
          typeof target.model !== 'string' ||
          !target.model
        ) {
          continue;
        }
        policies[sessionId] = {
          source: {
            agentKind: source.agentKind,
            model: source.model,
            providerId: typeof source.providerId === 'string' ? source.providerId : null,
            effort: source.effort ?? null,
            fastMode: source.fastMode ?? false,
            agentDeviceId: source.agentDeviceId ?? null,
          },
          target: { providerId: target.providerId, model: target.model },
        };
      }
    }
    const episodes: Settings['episodes'] = {};
    const rawEpisodes = (raw as Partial<Settings> | null)?.episodes;
    if (rawEpisodes && typeof rawEpisodes === 'object' && !Array.isArray(rawEpisodes)) {
      for (const [sessionId, rawEpisode] of Object.entries(rawEpisodes)) {
        const episode = normalizeEpisode(rawEpisode);
        // 没有策略的 episode 永远用不上，读的时候就丢掉。
        if (episode && policies[sessionId]) episodes[sessionId] = episode;
      }
    }
    return { policies, episodes };
  },
  maxBytes: 2 * 1024 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
  log: desktopMakerLogger.child('session-usage-limit-fallback-store'),
  label: 'session usage limit fallback',
});

export function readSessionUsageLimitFallback(sessionId: string): SessionUsageLimitFallback | null {
  store.invalidateIfChanged();
  return store.read().policies[sessionId] ?? null;
}

export async function writeSessionUsageLimitFallback(
  sessionId: string,
  policy: SessionUsageLimitFallback | null,
): Promise<void> {
  await store.updateAtomic(({ value }) => {
    const policies = { ...value.policies };
    const episodes = { ...value.episodes };
    if (policy) policies[sessionId] = policy;
    else {
      // 清除策略时同一份 episode 也作废：没有策略的 episode 永远用不上。
      delete policies[sessionId];
      delete episodes[sessionId];
    }
    return { policies, episodes };
  });
}

/** 当前数据所有者下所有已配置策略（回切 sweep 用；只读快照，不缓存）。 */
export function readAllSessionUsageLimitFallbacks(): Array<{
  sessionId: string;
  policy: SessionUsageLimitFallback;
}> {
  store.invalidateIfChanged();
  return Object.entries(store.read().policies).map(([sessionId, policy]) => ({
    sessionId,
    policy,
  }));
}

/** 所有回切 episode（与策略同文件；调用方按 session 自行配对）。 */
export function readAllSessionUsageLimitFallbackEpisodes(): Array<{
  sessionId: string;
  episode: SessionUsageLimitFallbackEpisode;
}> {
  store.invalidateIfChanged();
  return Object.entries(store.read().episodes).map(([sessionId, episode]) => ({
    sessionId,
    episode,
  }));
}

export function readSessionUsageLimitFallbackEpisode(
  sessionId: string,
): SessionUsageLimitFallbackEpisode | null {
  store.invalidateIfChanged();
  return store.read().episodes[sessionId] ?? null;
}

/** 只写 episode，不动策略；`null` = 清掉（用户选模、回切成功、预算用完都会走到）。 */
export async function writeSessionUsageLimitFallbackEpisode(
  sessionId: string,
  episode: SessionUsageLimitFallbackEpisode | null,
): Promise<void> {
  if (!episode) {
    // 绝大多数任务没有 episode：先读缓存确认没有，避免每次选模都去抢一次文件锁。
    store.invalidateIfChanged();
    if (!store.read().episodes[sessionId]) return;
  }
  await store.updateAtomic(({ value }) => {
    const episodes = { ...value.episodes };
    if (episode) episodes[sessionId] = episode;
    else delete episodes[sessionId];
    return { policies: value.policies, episodes };
  });
}

/**
 * 原子地给 episode 记一次尝试：**只有 episode 仍是调用方读到的那个**（failedAtMs 与
 * attempts 都对得上）才写。返回 false = 期间被清掉或换过（例如用户刚选了模型），
 * 调用方必须放弃这次回切 —— 否则会把用户的选择重新复活成一条自动回切记录。
 */
export async function claimSessionUsageLimitFallbackEpisodeAttempt(
  sessionId: string,
  expected: { failedAtMs: number; attempts: number },
  next: SessionUsageLimitFallbackEpisode,
): Promise<boolean> {
  let claimed = false;
  await store.updateAtomic(({ value }) => {
    const current = value.episodes[sessionId];
    if (
      !current ||
      current.failedAtMs !== expected.failedAtMs ||
      current.attempts !== expected.attempts
    ) {
      return { policies: value.policies, episodes: value.episodes };
    }
    claimed = true;
    return { policies: value.policies, episodes: { ...value.episodes, [sessionId]: next } };
  });
  return claimed;
}
