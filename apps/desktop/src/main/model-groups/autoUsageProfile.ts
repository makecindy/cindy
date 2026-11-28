/**
 * 智能路由「自动（expiring）」本机用量画像（纯 Node，零 Electron 依赖）。
 *
 * 隐私与性能红线：
 * - 100% 本机封闭：仅读取本机 SQLite 已有 `sessions` 与 `daily_session_usage` 表，聚合结果只驻留主进程内存，
 *   不写盘、不跨 device-link 下发、不写入可上报日志（不记录账号/设备/模型/token 明细）。
 * - 切账号即清（按 owner scope 隔离）。
 * - 热路径 0ms 同步读：`peek()` 永不 await SQLite；仅在后台异步节流预热与刷新。
 */
import { and, eq, gte, lte, ne, or } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { localDayKey } from '../localDb/dailySpend.js';
import { dailySessionUsage, sessions } from '../localDb/schema.js';

export const AUTO_USAGE_WINDOW_DAYS = 14;
const AUTO_USAGE_WINDOW_MS = AUTO_USAGE_WINDOW_DAYS * 86_400_000;
const AUTO_USAGE_REFRESH_TTL_MS = 2 * 60_000;
const AUTO_USAGE_DIRTY_THROTTLE_MS = 15_000;
const MAX_PRIORITY_MODELS = 128;

export interface AutoUsageSample {
  sessionId?: string;
  providerId: string;
  agentDeviceId?: string | null;
  model: string;
  /** 活动发生的 unix ms（用于近 14 天衰减与工作日/周末归属）。 */
  atMs: number;
  /** 可选 token 量；部分来源（如插件引擎/远端）未报 token 时为 0，仍计入会话频次。 */
  tokens?: number;
}

export interface AutoUsageSourceStats {
  /** 近 14 天时间衰减后的综合使用权重。 */
  weight: number;
  sessions: number;
  tokens: number;
  lastActiveAt: number;
}

export interface AutoUsageProfileSnapshot {
  computedAtMs: number;
  /** 近 14 天内有活动的本地自然日天数（0–14）。 */
  activeDays: number;
  /** 近 14 天内有活动的工作日天数（周一至周五，0–10）。 */
  weekdayActiveDays: number;
  /** 近 14 天内有活动的周末天数（周六至周日，0–4）。 */
  weekendActiveDays: number;
  /** 按来源聚合：键为 `${agentDeviceId ?? ''}\u0000${providerId}`。 */
  bySource: ReadonlyMap<string, AutoUsageSourceStats>;
  /** 按来源 + 规范化模型聚合：键为 `${agentDeviceId ?? ''}\u0000${providerId}\u0000${canonicalModel}`。 */
  byCandidate: ReadonlyMap<string, AutoUsageSourceStats>;
  /** 按规范化模型聚合（跨来源合并，供 Auto 展示层排序）。 */
  byModel: ReadonlyMap<string, AutoUsageSourceStats>;
  /** 仅本机展示层使用的规范化模型相对优先级（0..1，不含原始 token 或次数）。 */
  modelPriorities: Record<string, number>;
  /** 近期活跃会话到路由位置的内存映射，供实时并发计数 O(1) 反查。 */
  sessionRoutes: ReadonlyMap<string, { providerId: string; agentDeviceId: string | null }>;
}

/**
 * 去掉常见渠道前缀（如 `byok-codex/`、`chatgpt/`、`openai/`），使同一模型跨来源共享展示与候选偏好。
 */
export function canonicalUsageModelId(model: string): string {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return '';
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
}

export function autoUsageSourceKey(agentDeviceId: string | null | undefined, providerId: string): string {
  return `${agentDeviceId ?? ''}\u0000${providerId}`;
}

export function autoUsageCandidateKey(
  agentDeviceId: string | null | undefined,
  providerId: string,
  model: string,
): string {
  return `${agentDeviceId ?? ''}\u0000${providerId}\u0000${canonicalUsageModelId(model)}`;
}

function recencyDecay(ageMs: number): number {
  const days = Math.max(0, ageMs / 86_400_000);
  if (days <= 3) return 1.0;
  if (days <= 7) return 0.7;
  if (days <= AUTO_USAGE_WINDOW_DAYS) return 0.4;
  return 0;
}

function sampleWeight(ageMs: number, tokens: number): number {
  const decay = recencyDecay(ageMs);
  if (decay <= 0) return 0;
  const safeTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  // 即使来源不报 token（如部分 ACP 插件/远端），单次会话也拥有基础权重 1.0 * decay；
  // 有 token 统计时按对数平滑增益（单条上限 4x），防止单次大上下文把长期习惯冲掉。
  const volumeBoost = safeTokens > 0 ? Math.min(3, Math.log10(1 + safeTokens / 10_000)) : 0;
  return decay * (1 + volumeBoost);
}

function addStats(
  map: Map<string, AutoUsageSourceStats>,
  key: string,
  weight: number,
  tokens: number,
  atMs: number,
): void {
  const existing = map.get(key);
  if (existing) {
    existing.weight += weight;
    existing.sessions += 1;
    existing.tokens += tokens;
    if (atMs > existing.lastActiveAt) existing.lastActiveAt = atMs;
  } else {
    map.set(key, { weight, sessions: 1, tokens, lastActiveAt: atMs });
  }
}

function computeModelPriorities(byModel: ReadonlyMap<string, AutoUsageSourceStats>): Record<string, number> {
  const modelEntries = [...byModel.entries()]
    .filter(([, stats]) => stats.weight > 0)
    .sort((a, b) => b[1].weight - a[1].weight || b[1].lastActiveAt - a[1].lastActiveAt)
    .slice(0, MAX_PRIORITY_MODELS);
  const topModelWeight = modelEntries[0]?.[1].weight ?? 0;
  const modelPriorities: Record<string, number> = {};
  if (topModelWeight > 0) {
    for (const [modelId, stats] of modelEntries) {
      modelPriorities[modelId] = Math.max(0.001, Math.round((stats.weight / topModelWeight) * 1000) / 1000);
    }
  }
  return modelPriorities;
}

/** 纯函数：把近 14 天本机样本聚合成内存用量画像。 */
export function buildAutoUsageProfile(
  samples: readonly AutoUsageSample[],
  nowMs: number,
): AutoUsageProfileSnapshot {
  const cutoffMs = nowMs - AUTO_USAGE_WINDOW_MS;
  const bySource = new Map<string, AutoUsageSourceStats>();
  const byCandidate = new Map<string, AutoUsageSourceStats>();
  const byModel = new Map<string, AutoUsageSourceStats>();
  const sessionRoutes = new Map<string, { providerId: string; agentDeviceId: string | null }>();
  const activeDayKeys = new Set<string>();
  const weekdayKeys = new Set<string>();
  const weekendKeys = new Set<string>();

  for (const sample of samples) {
    if (!sample.providerId || !Number.isFinite(sample.atMs)) continue;
    const providerId = sample.providerId.trim();
    const agentDeviceId = sample.agentDeviceId?.trim() || null;
    if (sample.sessionId) {
      sessionRoutes.set(sample.sessionId, { providerId, agentDeviceId });
    }
    if (sample.atMs < cutoffMs || sample.atMs > nowMs + 60_000) continue;
    const tokens = typeof sample.tokens === 'number' && Number.isFinite(sample.tokens) && sample.tokens > 0 ? sample.tokens : 0;
    const weight = sampleWeight(nowMs - sample.atMs, tokens);
    if (weight <= 0) continue;

    const dayKey = localDayKey(sample.atMs);
    activeDayKeys.add(dayKey);
    const dow = new Date(sample.atMs).getDay();
    if (dow === 0 || dow === 6) weekendKeys.add(dayKey);
    else weekdayKeys.add(dayKey);

    const srcKey = autoUsageSourceKey(agentDeviceId, providerId);
    addStats(bySource, srcKey, weight, tokens, sample.atMs);

    const canonicalModel = canonicalUsageModelId(sample.model);
    if (canonicalModel) {
      addStats(byCandidate, `${srcKey}\u0000${canonicalModel}`, weight, tokens, sample.atMs);
      addStats(byModel, canonicalModel, weight, tokens, sample.atMs);
    }
  }

  return {
    computedAtMs: nowMs,
    activeDays: activeDayKeys.size,
    weekdayActiveDays: weekdayKeys.size,
    weekendActiveDays: weekendKeys.size,
    bySource,
    byCandidate,
    byModel,
    modelPriorities: computeModelPriorities(byModel),
    sessionRoutes,
  };
}

/**
 * 某个候选在本机近 14 天用量画像里的综合使用权重：
 * 70% 看该来源 + 该模型精确历史，30% 融合该来源整体历史（尝试新模型时也保留你对该来源的习惯）。
 */
export function autoUsageCandidateWeight(
  profile: AutoUsageProfileSnapshot | null | undefined,
  candidate: { providerId: string; agentDeviceId?: string | null; model: string },
): number {
  if (!profile) return 0;
  const exact = profile.byCandidate.get(autoUsageCandidateKey(candidate.agentDeviceId, candidate.providerId, candidate.model))?.weight ?? 0;
  const source = profile.bySource.get(autoUsageSourceKey(candidate.agentDeviceId, candidate.providerId))?.weight ?? 0;
  if (exact <= 0 && source <= 0) return 0;
  return exact * 0.7 + source * 0.3;
}

/**
 * 结合用户近 14 天工作日/周末活跃比例，估算从 `nowMs` 到 `resetAtMs` 之间「有效活跃时间」占物理剩余时间的比例。
 * 返回值在 [0.75, 1.25]：
 * - 若剩余时间里多为周末而用户几乎不在周末活动 -> 有效剩余时间更短 -> 系数 < 1（剩余额度更急着用完）；
 * - 若样本不足（activeDays < 4）-> 返回 1.0（不做修正）。
 */
export function effectiveRemainingTimeFactor(
  profile: AutoUsageProfileSnapshot | null | undefined,
  nowMs: number,
  resetAtMs: number | null,
): number {
  if (!profile || profile.activeDays < 4 || resetAtMs === null || resetAtMs <= nowMs) return 1;
  const remainingDays = (resetAtMs - nowMs) / 86_400_000;
  // 只有剩余 6 小时到 7 天内的周期窗口才做工作日/周末节奏分析
  if (remainingDays < 0.25 || remainingDays > 7.5) return 1;
  const weekdayRate = profile.weekdayActiveDays / 10;
  const weekendRate = profile.weekendActiveDays / 4;
  const avgRate = (weekdayRate * 5 + weekendRate * 2) / 7;
  if (avgRate <= 0.05) return 1;

  // 按 6 小时步进估算剩余时段里的平均活跃度
  const steps = Math.max(1, Math.min(28, Math.ceil(remainingDays * 4)));
  const stepMs = (resetAtMs - nowMs) / steps;
  let expectedRateSum = 0;
  for (let i = 0; i < steps; i += 1) {
    const mid = nowMs + stepMs * (i + 0.5);
    const dow = new Date(mid).getDay();
    expectedRateSum += dow === 0 || dow === 6 ? weekendRate : weekdayRate;
  }
  const remainingAvgRate = expectedRateSum / steps;
  const ratio = remainingAvgRate / avgRate;
  return Math.max(0.75, Math.min(1.25, ratio));
}

/** 直接从本机 SQLite 读取近 14 天非删除会话与日用量样本（只读，不落盘，不记日志）。 */
export async function readLocalAutoUsageSamples(
  sinceMs: number,
  nowMs: number,
  client = getDbClient(),
): Promise<AutoUsageSample[]> {
  const db = client.drizzle;
  const sinceDay = localDayKey(sinceMs);
  const today = localDayKey(nowMs);
  const sourceColumns = {
    sessionId: sessions.id,
    providerId: sessions.providerId,
    agentDeviceId: sessions.agentDeviceId,
    model: sessions.model,
  };
  const [sessionRows, usageRows] = await Promise.all([
    db
      .select({ ...sourceColumns, userSendAt: sessions.userSendAt, updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(and(ne(sessions.status, 'deleted'), or(gte(sessions.updatedAt, sinceMs), gte(sessions.userSendAt, sinceMs))))
      .all(),
    db
      .select({ ...sourceColumns, day: dailySessionUsage.day, tokens: dailySessionUsage.tokens, atMs: dailySessionUsage.updatedAt })
      .from(dailySessionUsage)
      .innerJoin(sessions, eq(sessions.id, dailySessionUsage.sessionId))
      .where(and(gte(dailySessionUsage.day, sinceDay), lte(dailySessionUsage.day, today), ne(sessions.status, 'deleted')))
      .all(),
  ]);

  const samples: AutoUsageSample[] = [];
  const latestUsageDay = new Map<string, string>();
  for (const { sessionId, providerId, agentDeviceId, model, day, tokens, atMs } of usageRows) {
    if (!providerId) continue;
    // The day was recorded in local time. Keep it even if the user has changed time zones.
    const activityAt = localDayKey(atMs) === day ? atMs : new Date(`${day}T12:00:00`).getTime();
    if (!Number.isFinite(activityAt) || activityAt < sinceMs) continue;
    const previousDay = latestUsageDay.get(sessionId);
    if (!previousDay || day > previousDay) latestUsageDay.set(sessionId, day);
    samples.push({ sessionId, providerId, agentDeviceId, model: model ?? '', atMs: Math.min(activityAt, nowMs), tokens });
  }

  // Count unmetered sources, and a newer send whose token receipt has not arrived yet.
  for (const { sessionId, providerId, agentDeviceId, model, userSendAt, updatedAt } of sessionRows) {
    if (!providerId) continue;
    const meteredThrough = latestUsageDay.get(sessionId);
    const atMs = meteredThrough ? userSendAt : Math.max(userSendAt ?? 0, updatedAt);
    if (atMs == null || atMs < sinceMs || (meteredThrough && localDayKey(atMs) <= meteredThrough)) continue;
    samples.push({ sessionId, providerId, agentDeviceId, model: model ?? '', atMs });
  }
  return samples;
}

export interface AutoUsageProfileStorePorts {
  scope(): string;
  readSamples(sinceMs: number, nowMs: number): Promise<readonly AutoUsageSample[]>;
  now?(): number;
}

/**
 * 内存用量画像缓存：
 * - `peek()` 永远 0ms 同步返回，不阻塞选模型与发消息；
 * - 过期或标脏时在后台静默刷新，按 owner scope 严格隔离；
 * - `readForPreview(maxWaitMs)` 给「试一下」和冷启动的本机排序读取提供有上限的等待。
 */
export function createAutoUsageProfileStore(ports: AutoUsageProfileStorePorts) {
  const now = ports.now ?? Date.now;
  let cached: { scope: string; snapshot: AutoUsageProfileSnapshot; dirtyAt: number | null } | null = null;
  let inFlight: { scope: string; promise: Promise<AutoUsageProfileSnapshot | null> } | null = null;

  function triggerRefresh(scope: string): Promise<AutoUsageProfileSnapshot | null> {
    if (inFlight?.scope === scope) return inFlight.promise;
    const startedAt = now();
    const promise = Promise.resolve()
      .then(() => ports.readSamples(startedAt - AUTO_USAGE_WINDOW_MS, startedAt))
      .then((samples) => {
        if (ports.scope() !== scope || inFlight?.promise !== promise) return null;
        const snapshot = buildAutoUsageProfile(samples, now());
        cached = { scope, snapshot, dirtyAt: null };
        return snapshot;
      })
      .catch(() => (cached?.scope === scope ? cached.snapshot : null))
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { scope, promise };
    return promise;
  }

  function needsRefresh(entry: typeof cached, scope: string, currentMs: number): boolean {
    if (!entry || entry.scope !== scope) return true;
    if (currentMs - entry.snapshot.computedAtMs >= AUTO_USAGE_REFRESH_TTL_MS) return true;
    if (entry.dirtyAt !== null && currentMs - entry.dirtyAt >= AUTO_USAGE_DIRTY_THROTTLE_MS) return true;
    return false;
  }

  function peek(): AutoUsageProfileSnapshot | null {
    const scope = ports.scope();
    const currentMs = now();
    if (cached && cached.scope !== scope) {
      cached = null;
    }
    if (needsRefresh(cached, scope, currentMs)) {
      void triggerRefresh(scope);
    }
    return cached?.scope === scope ? cached.snapshot : null;
  }

  async function readForPreview(maxWaitMs = 200): Promise<AutoUsageProfileSnapshot | null> {
    const scope = ports.scope();
    const currentMs = now();
    if (cached && cached.scope !== scope) {
      cached = null;
    }
    const existing = cached?.scope === scope ? cached.snapshot : null;
    // 「试一下」是显式预览：若缓存超过 10 秒或冷启动，短等一次（SQLite 扫描通常 ~2ms，上限 maxWaitMs）确保立刻看到最新用量。
    const previewFresh = existing && currentMs - existing.computedAtMs < 10_000 && cached?.dirtyAt === null;
    if (previewFresh) return existing;
    const work = triggerRefresh(scope);
    if (maxWaitMs <= 0) return existing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([
        work,
        new Promise<AutoUsageProfileSnapshot | null>((resolve) => {
          timer = setTimeout(() => resolve(existing), maxWaitMs);
        }),
      ]);
      return ports.scope() === scope ? snapshot : null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function markDirty(): void {
    const scope = ports.scope();
    if (cached?.scope === scope && cached.dirtyAt === null) {
      cached.dirtyAt = now();
    }
  }

  function recordPick(candidate: { providerId: string; agentDeviceId?: string | null; model: string }): void {
    const scope = ports.scope();
    if (cached?.scope === scope) {
      if (cached.dirtyAt === null) cached.dirtyAt = now();
      // 立即在内存里增量反映本次采用，无需等下一次 SQLite 重读
      const currentMs = now();
      const srcKey = autoUsageSourceKey(candidate.agentDeviceId, candidate.providerId);
      const bySource = new Map(cached.snapshot.bySource);
      const byCandidate = new Map(cached.snapshot.byCandidate);
      const byModel = new Map(cached.snapshot.byModel);
      const prevSrc = bySource.get(srcKey);
      bySource.set(srcKey, prevSrc
        ? { ...prevSrc, weight: prevSrc.weight + 1, sessions: prevSrc.sessions + 1, lastActiveAt: currentMs }
        : { weight: 1, sessions: 1, tokens: 0, lastActiveAt: currentMs });
      const canonicalModel = canonicalUsageModelId(candidate.model);
      if (canonicalModel) {
        const candKey = `${srcKey}\u0000${canonicalModel}`;
        const prevCand = byCandidate.get(candKey);
        byCandidate.set(candKey, prevCand
          ? { ...prevCand, weight: prevCand.weight + 1, sessions: prevCand.sessions + 1, lastActiveAt: currentMs }
          : { weight: 1, sessions: 1, tokens: 0, lastActiveAt: currentMs });
        const prevModel = byModel.get(canonicalModel);
        byModel.set(canonicalModel, prevModel
          ? { ...prevModel, weight: prevModel.weight + 1, sessions: prevModel.sessions + 1, lastActiveAt: currentMs }
          : { weight: 1, sessions: 1, tokens: 0, lastActiveAt: currentMs });
      }
      cached = {
        ...cached,
        snapshot: {
          ...cached.snapshot,
          bySource,
          byCandidate,
          byModel,
          modelPriorities: computeModelPriorities(byModel),
        },
      };
    }
  }

  function dispose(): void {
    cached = null;
    inFlight = null;
  }

  return { peek, readForPreview, markDirty, recordPick, dispose };
}

export type AutoUsageProfileStore = ReturnType<typeof createAutoUsageProfileStore>;
