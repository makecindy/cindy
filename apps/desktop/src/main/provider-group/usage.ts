/** Subscription snapshots used for group eligibility and balancing, never credentials or token estimates. */
import {
  matchScopedWindowForModel,
  type ClaudeSubscriptionUsageSnapshot,
  type ClaudeUsageWindow,
} from '@cindy/maker-shared/subscription-usage';

import { codexLimitBucketKey, matchCodexBucketForModel, resolveCodexBucketTable } from '@cindy/maker-shared/codex-usage-buckets';
import { accountUsageLimitFromWindows, claudeAccountUsageLimit } from '../../shared/accountUsageLimit.js';
import type { ProviderGroupMember, ProviderGroupMemberQuota } from '../../shared/providerGroup.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';

export const PROVIDER_GROUP_USAGE_MAX_AGE_MS = 10 * 60_000;
export const PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS = 1_500;
const REMOTE_USAGE_CACHE_MS = 15_000;
const MAX_CACHED_ACCOUNTS = 512;
const WEEK_MS = 7 * 86_400_000;
const FIVE_HOURS_MS = 5 * 3_600_000;

/**
 * 5 小时配额用到这么多以上算快满：离重置还早时先不分新任务，免得刚开始就撞上限、被迫换电脑丢上下文
 * (2026-10-21 用户裁决)。5 小时配额是限速，没用完不会少用周配额。
 */
export const PROVIDER_GROUP_FIVE_HOUR_TIGHT_PERCENT = 85;
/** 5 小时配额这么快就重置的，快满也照常分，把剩下的用掉(同日用户裁决)。 */
export const PROVIDER_GROUP_FIVE_HOUR_RESET_SOON_MS = 60 * 60_000;

/** 5 小时窗口快满、离重置还早或不知道何时重置。已过重置时刻的旧窗口不算(等新快照)。 */
function fiveHourTight(usedPercent: number | undefined, resetAtMs: number | null, now: number): boolean {
  if (usedPercent === undefined || usedPercent < PROVIDER_GROUP_FIVE_HOUR_TIGHT_PERCENT) return false;
  if (resetAtMs === null) return true;
  return resetAtMs > now && resetAtMs - now > PROVIDER_GROUP_FIVE_HOUR_RESET_SOON_MS;
}

/** 窗口还剩多少时间(按窗口长度的百分比)；没开始计时为 100，已过重置时刻、用过却没有重置时刻为 null。 */
function timeLeftPercent(window: ProviderGroupMemberQuota, now: number): number | null {
  if (window.resetAtMs === null) return window.usedPercent > 0 ? null : 100;
  const left = window.resetAtMs - now;
  return left > 0 ? Math.min(100, (left / window.windowMs) * 100) : null;
}

/**
 * 配额有多急着用：剩下的配额 ÷ 剩下的时间(都按窗口的百分比)。1 = 正好按时间用完；快重置还剩很多的最急，
 * 刚重置的不急；重置时间相同时剩得多的更急，所以各账号的用量会被拉平(2026-10-21 用户裁决：快作废的最优先，
 * 其次平均)。没开始计时的窗口没有要作废的，按 1 算；读不到返回 null。
 */
function quotaUrgency(window: ProviderGroupMemberQuota, now: number): number | null {
  const left = timeLeftPercent(window, now);
  return left === null ? null : Math.max(0, 100 - window.usedPercent) / left;
}

/**
 * 任务进行中换号的门槛(2026-10-21 用户确认「明显不划算才提议」)：换过去，在它重置前比留在原处多用掉这么多个百分点的
 * 配额才提议。换号要把对话交接过去(只带最近几轮与摘要)，差得不多不打扰用户。
 */
export const PROVIDER_GROUP_REBALANCE_MIN_GAIN = 15;

/**
 * 任务进行中换号换去哪台(provider-groups.md §6.2「任务进行中换号」)：候选里挑最急的(与新任务同一把尺子，相同时按组里的
 * 顺序)，再看值不值得——它比当前急，且换过去在它重置前多用掉的配额 = (它的急迫度 − 当前的急迫度) × 它剩下的时间，
 * 至少 PROVIDER_GROUP_REBALANCE_MIN_GAIN 个百分点。重置时间相同时就是两边剩下的配额差 15 个百分点以上(用了 70%
 * 对 50%)；快作废的一台即使剩得不多也会被提议，刚重置的不会把任务从快作废的那台拉走。读不到返回 null。
 */
export function providerGroupRebalanceTarget(
  current: ProviderGroupMemberQuota,
  candidates: readonly { key: string; quota: ProviderGroupMemberQuota }[],
  now: number,
): string | null {
  const from = quotaUrgency(current, now);
  if (from === null) return null;
  let best: { key: string; urgency: number; quota: ProviderGroupMemberQuota } | null = null;
  for (const candidate of candidates) {
    const urgency = quotaUrgency(candidate.quota, now);
    if (urgency !== null && (!best || urgency > best.urgency)) best = { key: candidate.key, urgency, quota: candidate.quota };
  }
  if (!best || best.urgency <= from) return null;
  const left = timeLeftPercent(best.quota, now);
  return left !== null && (best.urgency - from) * left >= PROVIDER_GROUP_REBALANCE_MIN_GAIN ? best.key : null;
}

/**
 * 几个窗口取最不急的那个：一个窗口已经用得太快，就不再催这台。有一个读不到就整台读不到。
 */
function paceOf(
  windows: readonly ProviderGroupMemberQuota[],
  now: number,
): { urgency: number; window: ProviderGroupMemberQuota } | null {
  let pace: { urgency: number; window: ProviderGroupMemberQuota } | null = null;
  for (const window of windows) {
    const urgency = quotaUrgency(window, now);
    if (urgency === null) return null;
    if (!pace || urgency < pace.urgency) pace = { urgency, window };
  }
  return pace;
}

/** 排序用的急不急，加上算出它的那个窗口；读不到时两者都是 null。 */
function paceState(windows: readonly ProviderGroupMemberQuota[] | null, now: number) {
  const pace = windows ? paceOf(windows, now) : null;
  return { urgency: pace?.urgency ?? null, quota: pace?.window ?? null };
}

interface CodexUsageWindow {
  usedPercent?: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

interface CodexUsageBucket {
  limitId: string | null;
  limitName: string | null;
  updatedAt: number | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
}

/** Only quota fields survive parsing; account identity and reset-credit offers stay out of the directory. */
export interface ProviderGroupCodexUsageSnapshot {
  appServerBuckets: Record<string, CodexUsageBucket> | null;
  webSnapshot: CodexUsageBucket | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function currentSnapshot(updatedAt: unknown, now: number): boolean {
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0
    && now - updatedAt <= PROVIDER_GROUP_USAGE_MAX_AGE_MS && updatedAt - now <= 60_000;
}

function codexWindow(raw: unknown): CodexUsageWindow | null {
  if (raw === undefined || raw === null) return null;
  const value = record(raw);
  return {
    usedPercent: typeof value?.usedPercent === 'number' && Number.isFinite(value.usedPercent) && value.usedPercent >= 0
      ? Math.min(100, value.usedPercent) : undefined,
    windowMinutes: typeof value?.windowMinutes === 'number' && Number.isFinite(value.windowMinutes) && value.windowMinutes > 0
      ? value.windowMinutes : null,
    resetsAt: typeof value?.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt : null,
  };
}

function codexBucket(raw: unknown): CodexUsageBucket | null {
  const value = record(raw);
  if (!value) return null;
  return {
    limitId: typeof value.limitId === 'string' ? value.limitId : null,
    limitName: typeof value.limitName === 'string' ? value.limitName : null,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : null,
    primary: codexWindow(value.primary), secondary: codexWindow(value.secondary),
  };
}

export function providerGroupCodexUsageSnapshot(raw: unknown): ProviderGroupCodexUsageSnapshot | null {
  const value = record(raw);
  if (!value) return null;
  const table = resolveCodexBucketTable({ appServerBuckets: value.appServerBuckets });
  const fallback = value.source !== 'openai-web' && (value.primary || value.secondary) ? codexBucket(value) : null;
  const appServerBuckets = table
    ? Object.fromEntries(Object.entries(table).map(([key, bucket]) => [key, codexBucket(bucket)!]))
    : fallback ? { [codexLimitBucketKey(fallback)]: fallback } : null;
  const webSnapshot = codexBucket(value.webSnapshot ?? (value.source === 'openai-web' ? value : null));
  return appServerBuckets || webSnapshot ? { appServerBuckets, webSnapshot } : null;
}

/** A completed account/rateLimits/read is fresh; cached account payloads retain each bucket's own timestamp. */
export function providerGroupCodexUsageFromReads(account: unknown, rateLimits: unknown, now: number) {
  const cached = providerGroupCodexUsageSnapshot(account);
  const result = record(rateLimits);
  const latest = record(result?.rateLimits);
  if (!latest) return cached;
  const table = resolveCodexBucketTable({ byLimitId: result?.rateLimitsByLimitId })
    ?? { [codexLimitBucketKey(latest)]: latest };
  return providerGroupCodexUsageSnapshot({
    appServerBuckets: Object.fromEntries(Object.entries(table).map(([key, bucket]) => [key, { ...bucket, updatedAt: now }])),
    webSnapshot: cached?.webSnapshot,
  });
}

/** Select a model's own bucket before checking age: fresh unrelated buckets cannot refresh it. */
function codexUsageState(snapshot: ProviderGroupCodexUsageSnapshot, model: string | null | undefined, now: number, agentKind?: string) {
  const bucket = (agentKind !== undefined && agentKind !== 'codex') || model?.startsWith('chatgpt/')
    ? snapshot.webSnapshot : matchCodexBucketForModel(snapshot.appServerBuckets, model, now);
  if (!bucket || !currentSnapshot(bucket.updatedAt, now)) return providerGroupUsageState(null, model, now);
  const windows = [bucket.primary, bucket.secondary].filter((w): w is CodexUsageWindow => w !== null);
  const limit = accountUsageLimitFromWindows(windows.flatMap((w) => w.usedPercent === undefined
    ? [] : [{ usedPercent: w.usedPercent, resetsAtSec: w.resetsAt }]), now);
  const current = (w: CodexUsageWindow) => w.usedPercent !== undefined && (!w.resetsAt || w.resetsAt * 1000 > now);
  // 按长于 5 小时的窗口(周额度)排；只有 5 小时窗口的套餐按它排。
  const timed = windows.filter((w) => w.windowMinutes !== null);
  const long = timed.filter((w) => w.windowMinutes! * 60_000 > FIVE_HOURS_MS);
  const paced = long.length > 0 ? long : timed;
  const tight = timed.some((w) => w.windowMinutes! * 60_000 <= FIVE_HOURS_MS
    && fiveHourTight(w.usedPercent, w.resetsAt ? w.resetsAt * 1000 : null, now));
  return {
    ...limit,
    fiveHourTight: tight,
    ...paceState(paced.length > 0 && paced.every(current)
      ? paced.map((w) => ({
        usedPercent: w.usedPercent!, resetAtMs: w.resetsAt ? w.resetsAt * 1000 : null, windowMs: w.windowMinutes! * 60_000,
      }))
      : null, now),
  };
}

export function providerGroupMemberUsageState(
  member: { claudeUsage?: ClaudeSubscriptionUsageSnapshot | null; codexUsage?: ProviderGroupCodexUsageSnapshot | null },
  model: string | null | undefined,
  now: number,
  agentKind?: string,
) {
  return member.codexUsage ? codexUsageState(member.codexUsage, model, now, agentKind) : providerGroupUsageState(member.claudeUsage, model, now);
}

function windowOf(raw: unknown): ClaudeUsageWindow | null {
  const value = record(raw);
  if (!value || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization) || value.utilization < 0) return null;
  return {
    utilization: Math.min(100, value.utilization),
    resetsAt: typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt : null,
  };
}

/** Old/malformed snapshots are unknown, not a claim of zero usage or a permanent cooldown. */
export function providerGroupUsageSnapshot(raw: unknown, now: number): ClaudeSubscriptionUsageSnapshot | null {
  const value = record(raw);
  if (!value || !currentSnapshot(value.updatedAt, now)) return null;
  return {
    updatedAt: value.updatedAt as number,
    fiveHour: windowOf(value.fiveHour),
    sevenDay: windowOf(value.sevenDay),
    scoped: (Array.isArray(value.scoped) ? value.scoped : []).flatMap((rawWindow) => {
      const item = record(rawWindow);
      const window = windowOf(rawWindow);
      if (!window || typeof item?.modelDisplayName !== 'string') return [];
      return [{ ...window, modelDisplayName: item.modelDisplayName, modelId: typeof item.modelId === 'string' ? item.modelId : null }];
    }),
    rateLimitStatus: typeof value.rateLimitStatus === 'string' ? value.rateLimitStatus : null,
    representativeClaim: typeof value.representativeClaim === 'string' ? value.representativeClaim : null,
  };
}

/**
 * Check exhaustion first. Ranking uses the weekly window plus the selected model's weekly window; the 5-hour
 * window excludes an exhausted account and marks a nearly full one that is not about to reset. Missing or stale
 * data stays unknown rather than looking unused.
 */
export function providerGroupUsageState(raw: unknown, model: string | null | undefined, now: number) {
  const snapshot = providerGroupUsageSnapshot(raw, now);
  const limit = claudeAccountUsageLimit(snapshot, model, now);
  const current = (w: ClaudeUsageWindow | null | undefined) =>
    w && (!w.resetsAt || w.resetsAt * 1000 > now) ? w : null;
  const sevenDay = current(snapshot?.sevenDay);
  const scoped = matchScopedWindowForModel(snapshot?.scoped, model);
  const scopedWeek = current(scoped);
  const fiveHour = snapshot?.fiveHour;
  return {
    limited: limit?.limited ?? false,
    resetAtMs: limit?.resetAtMs ?? null,
    fiveHourTight: fiveHour ? fiveHourTight(fiveHour.utilization, fiveHour.resetsAt ? fiveHour.resetsAt * 1000 : null, now) : false,
    ...paceState(sevenDay && (!scoped || scopedWeek)
      ? [sevenDay, ...(scopedWeek ? [scopedWeek] : [])].map((w) => ({
        usedPercent: w.utilization, resetAtMs: w.resetsAt ? w.resetsAt * 1000 : null, windowMs: WEEK_MS,
      }))
      : null, now),
  };
}

export interface ProviderGroupUsageReaderDeps<T> {
  readLocal(providerId: string): Promise<unknown>;
  readRemote(deviceId: string, providerId: string): Promise<unknown>;
  isCurrent(): boolean;
  now(): number;
  parseSnapshot(raw: unknown, now: number): T | null;
  cacheLocal?: boolean;
}

/** Per-owner, bounded remote reads. A slow/old peer cannot stall routing or multiply in-flight requests. */
export function createProviderGroupUsageReader<T>(deps: ProviderGroupUsageReaderDeps<T>) {
  const cached = new Map<string, { at: number; snapshot: T | null }>();
  const pending = new Map<string, Promise<T | null>>();

  async function bounded(promise: Promise<T | null>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** Completed sources remain usable when a caller's overall deadline precedes a sibling read's timeout. */
    peek(member: ProviderGroupMember): T | null {
      if (!deps.isCurrent() || member.kind === 'share'
        || (member.agentDeviceId && isProviderShareAgentDeviceId(member.agentDeviceId))
        || (member.kind === 'local' && !deps.cacheLocal)) return null;
      const previous = cached.get(JSON.stringify([member.agentDeviceId, member.providerId]));
      return previous && deps.now() - previous.at < REMOTE_USAGE_CACHE_MS
        ? deps.parseSnapshot(previous.snapshot, deps.now()) : null;
    },
    async read(member: ProviderGroupMember): Promise<T | null> {
      if (!deps.isCurrent() || member.kind === 'share'
        || (member.agentDeviceId && isProviderShareAgentDeviceId(member.agentDeviceId))) return null;
      const key = JSON.stringify([member.agentDeviceId, member.providerId]);
      const previous = cached.get(key);
      if ((member.kind !== 'local' || deps.cacheLocal) && previous && deps.now() - previous.at < REMOTE_USAGE_CACHE_MS) {
        return deps.parseSnapshot(previous.snapshot, deps.now());
      }
      let request = pending.get(key);
      if (!request) {
        if (pending.size >= MAX_CACHED_ACCOUNTS) return null;
        request = Promise.resolve().then(async () => {
          if (!deps.isCurrent()) return null;
          const raw = member.kind === 'local'
            ? await deps.readLocal(member.providerId)
            : await deps.readRemote(member.agentDeviceId!, member.providerId);
          return deps.isCurrent() ? deps.parseSnapshot(raw, deps.now()) : null;
        }).catch(() => null).then((snapshot) => {
          pending.delete(key);
          if (deps.isCurrent() && (member.kind !== 'local' || deps.cacheLocal)) {
            if (cached.size >= MAX_CACHED_ACCOUNTS) cached.delete(cached.keys().next().value!);
            cached.set(key, { at: deps.now(), snapshot });
          }
          return snapshot;
        });
        pending.set(key, request);
      }
      const snapshot = await bounded(request);
      return deps.isCurrent() ? deps.parseSnapshot(snapshot, deps.now()) : null;
    },
    invalidate() { cached.clear(); },
  };
}
