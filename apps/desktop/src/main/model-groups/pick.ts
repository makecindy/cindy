/**
 * 模型组选路：一条路线里这次用哪个来源。纯函数，不读任何状态：「轮流」「用完再换」要的上一次选中、
 * 「按权重」的计数都由调用方传入；按权重这一步怎么改计数随结果返回，采用后由调用方记下。
 * 选法本身只有一份实现(provider-group/scheduler.ts 的 pickRouteMember，账号池与供应商组也用它)；这里只把候选的事实
 * 整理成它要的成员，并写出给用户看的选路说明。
 */
import type {
  ModelGroupRoute,
  ModelGroupTraceEntry,
  ModelGroupTraceQuota,
  ModelGroupTraceWhy,
} from '../../shared/modelGroups.js';
import { modelGroupCandidateKey, modelGroupWeight } from '../../shared/modelGroups.js';
import { pickRouteMember, PROVIDER_GROUP_SIMILAR_URGENCY, type RouteWeightStep } from '../provider-group/scheduler.js';
import { FIVE_HOURS_MS, quotaWindowsScheduleState } from '../provider-group/usage.js';
import {
  autoUsageCandidateWeight,
  effectiveRemainingTimeFactor,
  type AutoUsageProfileSnapshot,
} from './autoUsageProfile.js';

/** 一个候选此刻的事实，顺序与 route.candidates 一致。 */
/**
 * 内层(电脑组、几个账号的连接)按它自己的选法「下一个会接任务的」那台电脑或那个账号的额度事实(2026-11-26，dash 建议)：
 * 外层按它判断能不能用、快满没、急不急、余量，与内层实际会用的一致；只看本机那一份快照会和内层判断对不上。
 */
export interface ModelGroupInnerQuota {
  /** 内层一个能接的都没有，且不是因为都满载(满载只是忙，不算额度用完)。 */
  limited: boolean;
  urgency: number | null;
  fiveHourTight: boolean;
  headroom: number | null;
}

export interface ModelGroupCandidateFacts {
  /**
   * 供应商已连接、模型现在可为新任务选用、对应引擎已安装；不在本机的来源还要求那个位置此刻能选、
   * 模型在那里允许远程调用。
   */
  available: boolean;
  modelName: string;
  sourceName: string;
  /** 订阅额度窗口；读不到(API 密钥、尚未读到)为 null。 */
  windows: readonly ModelGroupTraceQuota[] | null;
  /** 来源背后是电脑组或几个账号时，内层下一个会接任务的那一个的额度事实；有它时选路按它判断。 */
  inner?: ModelGroupInnerQuota | null;
  /**
   * 「最省钱」用的标价：每百万输出 token 的美元价(人民币报价已折算)。订阅来源、没有标价时为 null。
   * 只在选法是 cheapest 时才读取，其余选法可省略。
   */
  price?: number | null;
  /** 这个模型能不能看图；读不到按不能。 */
  acceptsImage?: boolean;
  /** 模型上下文窗口大小(token)，用于任务中间切换时避免无意缩容。 */
  contextWindow?: number | null;
  /** 供应商类型(如 anthropic / openai / google)，用于估算提示缓存 TTL。 */
  providerType?: string | null;
  /** 本机按量付费来源（个人 API Key / 按量网关，非分享）：Auto 模式下归入兜底档，主力池健康时不误烧。 */
  payAsYouGo?: boolean;
  /** 该来源当前正在运行的本机任务数（内存实时读，0 表示空闲）。 */
  running?: number;
  /** Route effort supported by this exact provider, model and harness. */
  effort?: string;
  /** The Fast mode the user asked for, when this exact provider, model and harness supports it. */
  fastMode?: true | 'ultrafast';
}

export interface ModelGroupPick {
  index: number | null;
  trace: ModelGroupTraceEntry[];
  /** 要求能看图时：applied = 只在能看图的来源里选了；fallback = 一个能看图的都没有，照常选。 */
  image?: 'applied' | 'fallback';
  /** 「按权重」这一步：采用这次结果时用 applyModelGroupWeightStep 记到当时的计数上。别的选法省略。 */
  weightStep?: RouteWeightStep;
}

/**
 * 剩余配额占比(0–100)与算出它的窗口：有比 5 小时长的窗口(周额度)就看它们，只有短窗口时看短窗口；几个窗口取最紧的那个。
 * 已过重置时刻的旧窗口不算；读不到为 null。
 */
export function modelGroupHeadroom(
  windows: readonly ModelGroupTraceQuota[] | null,
  now: number,
): { left: number; window: ModelGroupTraceQuota } | null {
  const live = (windows ?? []).filter((window) => window.resetAtMs === null || window.resetAtMs > now);
  const long = live.filter((window) => window.windowMs > FIVE_HOURS_MS);
  let tightest: { left: number; window: ModelGroupTraceQuota } | null = null;
  for (const window of long.length > 0 ? long : live) {
    const left = Math.max(0, 100 - window.usedPercent);
    if (!tightest || left < tightest.left) tightest = { left, window };
  }
  return tightest;
}

/** 还有配额的订阅不另外花钱；其余按标价，没有标价的排在有标价的后面。 */
function costOf(fact: ModelGroupCandidateFacts | undefined): number {
  if (fact?.windows) return 0;
  return typeof fact?.price === 'number' && Number.isFinite(fact.price) && fact.price >= 0
    ? fact.price
    : Number.POSITIVE_INFINITY;
}

/**
 * 剩余配额超出匀速消耗这么多(2.0 = 超出 2 倍，例如剩 50% 不足 1.75 天重置、或剩 30% 不足 24 小时重置)
 * 才判定为「真快过期有富余」，进入抢跑档优先消耗；刚重置不久的闲置个人号(1.0–1.5)留在主力池与平时常用源公平竞争。
 */
const AUTO_EXPIRING_SURPLUS_URGENCY = 2.0;
/** 读不到配额的非按量来源(如共享、远端、插件引擎)在主力池里的中性余量分。 */
const AUTO_UNKNOWN_QUOTA_SCORE = 0.85;
/** 近 14 天本机用量习惯在主力池里的最大加分。 */
const AUTO_USAGE_MAX_BONUS = 0.45;
/** 达到满置信度所需的近 14 天加权使用次数（约 2–3 次近期任务即满置信度）。 */
const AUTO_USAGE_FULL_CONFIDENCE = 2.5;
/** 每个正在运行的并发任务在主力池里的负载扣分。 */
const AUTO_RUNNING_PENALTY = 0.30;
/** 主力池候选与最高分的差在此范围内时，可以轮转分摊。 */
const AUTO_SOFT_ROTATE_GAP = 0.06;

interface AutoRowInput {
  candidate: ModelGroupRoute['candidates'][number];
  index: number;
  key: string;
  usable: boolean;
  limited: boolean;
  tight: boolean;
  urgency: number | null;
  quota: ModelGroupTraceQuota | null;
  payAsYouGo: boolean;
  running: number;
}

/** band 按优先级排列，从上次采用的位置接着选。 */
function nextAutoCandidate<T extends { row: AutoRowInput }>(band: readonly T[], lastPickedKey?: string | null): T {
  const previous = band.findIndex(({ row }) => row.key === lastPickedKey);
  return band[(previous + 1) % band.length];
}

/**
 * 「自动（expiring）」选路核心（纯函数，无 IO）：
 * 1. 分层：主力池（未 5h 快满且非按量付费） > 兜底池（5h 快满的非按量 > 按量付费 API Key/网关）。
 * 2. Tier 1（快过期富余抢跑）：结合工作日/周末活跃节奏修正有效急迫度；若存在达到 2.0 的订阅则优先消耗快过期额度，
 *    同档内按空闲并发 > 本机平时用量 > 软轮转 > 列表顺序决胜。
 * 3. Tier 2（主力池综合编排）：健康订阅与读不到配额的非按量来源同台竞争，按「余量健康度 + 近 14 天本机用量习惯 - 并发负载」
 *    综合排序，相近分数下结合 lastPickedKey 软轮转，避免死用偏紧个人号或永远冷落共享/远端源。
 */
function pickAutoCandidate<T extends AutoRowInput>(
  ready: readonly T[],
  usable: readonly T[],
  options: {
    now: number;
    lastPickedKey?: string | null;
    usageProfile?: AutoUsageProfileSnapshot | null;
  },
): { picked: T; why: ModelGroupTraceWhy } {
  const { now, lastPickedKey, usageProfile } = options;
  const nonPayg = ready.filter((row) => !row.payAsYouGo);
  const nonTightNonPayg = nonPayg.filter((row) => !row.tight);

  // 兜底池：所有主力（订阅/共享/插件）都不可用或 5h 快满
  if (nonTightNonPayg.length === 0) {
    if (nonPayg.length > 0) {
      // 还有非按量来源（只是 5h 快满）：先从非按量里挑，不轻易烧按量钱包
      const scored = nonPayg.map((row) => ({
        row,
        urgency: row.urgency ?? AUTO_UNKNOWN_QUOTA_SCORE,
      }));
      const best = scored.reduce((top, cur) => {
        if (cur.row.running !== top.row.running) return cur.row.running < top.row.running ? cur : top;
        return cur.urgency > top.urgency ? cur : top;
      });
      const why: ModelGroupTraceWhy = best.row.urgency !== null ? 'expiring' : 'autoBalance';
      return { picked: best.row, why };
    }
    // 只剩按量付费来源可用：若路由里原本存在非按量成员，明确标注兜底
    const bestPayg = ready.reduce((top, cur) => (cur.running < top.running ? cur : top));
    const hadNonPayg = usable.some((row) => !row.payAsYouGo);
    return { picked: bestPayg, why: hadNonPayg ? 'paygFallback' : 'order' };
  }

  const primary = nonTightNonPayg;
  const enriched = primary.map((row) => {
    const timeFactor = row.urgency !== null
      ? effectiveRemainingTimeFactor(usageProfile, now, row.quota?.resetAtMs ?? null)
      : 1;
    const effectiveUrgency = row.urgency !== null ? row.urgency / timeFactor : null;
    const isExpiringSurplus = effectiveUrgency !== null && effectiveUrgency >= AUTO_EXPIRING_SURPLUS_URGENCY;
    const usageWeight = autoUsageCandidateWeight(usageProfile, row.candidate);
    return { row, effectiveUrgency, isExpiringSurplus, usageWeight };
  });

  // Tier 1：真有快过期富余的订阅 -> 优先消耗，避免额度作废
  const expiring = enriched.filter((item) => item.isExpiringSurplus);
  if (expiring.length > 0) {
    const topUrgency = Math.max(...expiring.map((item) => item.effectiveUrgency!));
    const band = expiring.filter((item) => item.effectiveUrgency! >= topUrgency * PROVIDER_GROUP_SIMILAR_URGENCY);
    const minRunning = Math.min(...band.map((item) => item.row.running));
    const idleBand = band.filter((item) => item.row.running === minRunning);
    const byUrgency = [...band].sort((a, b) => b.effectiveUrgency! - a.effectiveUrgency! || a.row.index - b.row.index)[0];

    // 只在并发相同、用量权重接近的候选之间轮转。
    const topUsage = Math.max(...idleBand.map((item) => item.usageWeight));
    const rotationBand = idleBand
      .filter((item) => topUsage - item.usageWeight <= 0.05)
      .sort((a, b) => b.effectiveUrgency! - a.effectiveUrgency! || a.row.index - b.row.index);
    const winner = nextAutoCandidate(rotationBand, lastPickedKey);
    let why: ModelGroupTraceWhy = 'expiring';
    if (byUrgency.row !== winner.row && byUrgency.row.running > winner.row.running) {
      why = 'lessBusy';
    } else if (
      idleBand.length > 1
      && winner.usageWeight >= 0.5
      && topUsage - byUrgency.usageWeight > 0.05
    ) {
      why = 'usageHabit';
    }
    return { picked: winner.row, why };
  }

  // Tier 2：主力池综合编排（余量健康度 + 近 14 天本机用量习惯 - 并发负载）
  const totalUsageWeight = enriched.reduce((sum, item) => sum + item.usageWeight, 0);
  const confidence = totalUsageWeight > 0 ? Math.min(1, totalUsageWeight / AUTO_USAGE_FULL_CONFIDENCE) : 0;
  const scored = enriched.map((item) => {
    const quotaScore = item.effectiveUrgency !== null
      ? item.effectiveUrgency <= 1.0
        ? Math.max(0.05, item.effectiveUrgency)
        : 1.0 + Math.min(1.0, item.effectiveUrgency - 1.0) * 0.12
      : AUTO_UNKNOWN_QUOTA_SCORE;
    const usageShare = totalUsageWeight > 0 ? item.usageWeight / totalUsageWeight : 0;
    const usageBonus = AUTO_USAGE_MAX_BONUS * confidence * usageShare;
    const busyPenalty = item.row.running * AUTO_RUNNING_PENALTY;
    const baseScore = quotaScore + usageBonus;
    const totalScore = baseScore - busyPenalty;
    return { ...item, quotaScore, usageBonus, busyPenalty, baseScore, totalScore };
  });

  const sorted = [...scored].sort((a, b) => b.totalScore - a.totalScore || a.row.index - b.row.index);
  const [leader] = sorted;
  const rotationBand = sorted.filter((item) => leader.totalScore - item.totalScore <= AUTO_SOFT_ROTATE_GAP
    && item.row.running <= leader.row.running);
  const winner = nextAutoCandidate(rotationBand, lastPickedKey);
  const rotated = winner !== leader;
  const bestWithoutBusy = scored.reduce((top, cur) => (cur.baseScore > top.baseScore ? cur : top));
  const bestWithoutUsage = scored.reduce((top, cur) =>
    (cur.quotaScore - cur.busyPenalty) > (top.quotaScore - top.busyPenalty) ? cur : top);
  const secondUsageBonus = Math.max(0, ...scored.filter((item) => item !== winner).map((item) => item.usageBonus));

  let why: ModelGroupTraceWhy;
  if (bestWithoutBusy !== winner && bestWithoutBusy.row.running > winner.row.running) {
    why = 'lessBusy';
  } else if (
    winner.usageBonus >= 0.08
    && (bestWithoutUsage !== winner || winner.usageBonus >= secondUsageBonus + 0.05)
  ) {
    why = 'usageHabit';
  } else if (
    rotated
    || (winner.effectiveUrgency === null && scored.some((item) => item.effectiveUrgency !== null && item.effectiveUrgency < AUTO_UNKNOWN_QUOTA_SCORE))
  ) {
    why = 'autoBalance';
  } else if (scored.every((item) => item.effectiveUrgency === null) && totalUsageWeight === 0) {
    why = 'order';
  } else if (winner.effectiveUrgency === null) {
    why = 'autoBalance';
  } else {
    why = 'expiring';
  }
  return { picked: winner.row, why };
}

export function pickModelGroupCandidate(
  route: ModelGroupRoute,
  facts: readonly ModelGroupCandidateFacts[],
  options: {
    now: number;
    /** 上一次采用的候选(「轮流」「用完再换」「自动」软轮转用)。 */
    lastPickedKey?: string | null;
    needsImage?: boolean;
    /** 「按权重」上一次采用后的计数。 */
    weightCounters?: ReadonlyMap<string, number>;
    /** 「自动」模式用的近 14 天本机用量画像（纯内存快照，省略时自动退化为中性规则）。 */
    usageProfile?: AutoUsageProfileSnapshot | null;
  },
): ModelGroupPick {
  const { now } = options;
  const anyVision = !!options.needsImage && route.candidates.some((candidate, index) =>
    !candidate.off && facts[index]?.available === true && facts[index]?.acceptsImage === true);
  const rows = route.candidates.map((candidate, index) => {
    const fact = facts[index];
    const state = fact?.windows ? quotaWindowsScheduleState(fact.windows, now) : null;
    // 「余量最多的先用」按剩余占比排：说明里写的余量与排序用的是同一个窗口。
    const headroom = route.strategy === 'headroom' ? modelGroupHeadroom(fact?.windows ?? null, now) : null;
    const quota = headroom?.window ?? state?.quota ?? null;
    const running = typeof fact?.running === 'number' && Number.isFinite(fact.running) && fact.running > 0
      ? Math.floor(fact.running)
      : 0;
    return {
      candidate, index, key: modelGroupCandidateKey(candidate),
      noVision: anyVision && fact?.acceptsImage !== true,
      usable: !candidate.off && fact?.available === true && !(anyVision && fact?.acceptsImage !== true),
      // 内层(电脑组、几个账号)按它下一个会接任务的那一个判断；说明里写的额度窗口仍是读到的那一份。
      limited: fact?.inner ? fact.inner.limited : state?.limited ?? false,
      limitedUntilMs: fact?.inner ? null : state?.resetAtMs ?? null,
      tight: fact?.inner ? fact.inner.fiveHourTight : state?.fiveHourTight ?? false,
      urgency: fact?.inner ? fact.inner.urgency : state?.urgency ?? null,
      quota,
      headroom: fact?.inner && route.strategy === 'headroom' ? fact.inner.headroom : headroom?.left ?? null,
      weight: modelGroupWeight(candidate.weight),
      payAsYouGo: fact?.payAsYouGo === true && quota === null && !fact?.inner,
      running,
    };
  });
  const usable = rows.filter((row) => row.usable);
  const ready = usable.filter((row) => !row.limited);

  let picked: (typeof rows)[number] | null = null;
  let why: ModelGroupTraceWhy = 'only';
  let weightStep: RouteWeightStep | undefined;
  /** 选法自己的理由；只有一个能用时仍写 only。 */
  let strategyWhy: ModelGroupTraceWhy = route.strategy;
  if (ready.length > 0) {
    if (route.strategy === 'expiring') {
      const auto = pickAutoCandidate(ready, usable, {
        now,
        lastPickedKey: options.lastPickedKey,
        usageProfile: options.usageProfile,
      });
      picked = auto.picked;
      strategyWhy = auto.why;
      why = usable.length === 1 ? 'only' : strategyWhy;
    } else {
      const last = rows.findIndex((row) => row.key === options.lastPickedKey);
      const result = pickRouteMember(rows.map((row) => {
        const cost = costOf(facts[row.index]);
        return {
          key: row.key, usable: row.usable && !row.limited, paused: false, running: row.running,
          limit: Number.POSITIVE_INFINITY, weight: row.weight,
          urgency: row.urgency, fiveHourTight: row.tight, headroom: row.headroom,
          cost: Number.isFinite(cost) ? cost : null,
        };
      }), route.strategy, { lastPicked: options.lastPickedKey ?? null, weightCounters: options.weightCounters });
      picked = ready.find((row) => row.key === result.key) ?? ready[0];
      weightStep = result.weightStep;
      // 谁都读不到额度／谁都没有标价时只是按列表顺序取了第一个，不说它余量最多、最省钱。
      if (result.plain) strategyWhy = 'order';
      else if (route.strategy === 'drain' && last >= 0 && picked.index !== last) strategyWhy = 'drainNext';
      why = usable.length === 1 ? 'only' : strategyWhy;
      if (why === 'cheapest') {
        const cost = costOf(facts[picked.index]);
        // 谁都没有标价时只是按列表顺序取了第一个，不说它最省钱。
        why = cost === 0 && facts[picked.index]?.windows ? 'cheapestFree' : Number.isFinite(cost) ? 'cheapest' : 'order';
      }
    }
  } else if (usable.length > 0) {
    // 全都撞了上限：选最早恢复的那个，任务照常建立，由现有的「等额度恢复后自动继续」接手。
    picked = usable.reduce((best, row) =>
      (row.limitedUntilMs ?? Number.POSITIVE_INFINITY) < (best.limitedUntilMs ?? Number.POSITIVE_INFINITY) ? row : best);
    why = usable.length === 1 ? 'only' : 'soonest';
  }

  const trace = rows.map((row): ModelGroupTraceEntry => {
    const fact = facts[row.index];
    const base = {
      agentKind: row.candidate.agentKind, providerId: row.candidate.providerId, model: row.candidate.model,
      ...(row.candidate.agentDeviceId ? { agentDeviceId: row.candidate.agentDeviceId } : {}),
      modelName: fact?.modelName || row.candidate.model, sourceName: fact?.sourceName || row.candidate.providerId,
      quota: row.quota,
    };
    if (row === picked) return { ...base, state: 'picked', why, ...(row.limited ? { limitedUntilMs: row.limitedUntilMs } : {}) };
    if (row.candidate.off) return { ...base, state: 'skipped', why: 'off' };
    if (fact?.available !== true) return { ...base, state: 'skipped', why: 'unavailable' };
    if (row.noVision) return { ...base, state: 'skipped', why: 'noVision' };
    if (row.limited) return { ...base, state: 'skipped', why: 'limited', limitedUntilMs: row.limitedUntilMs };
    // 只有自动选法时，5 小时快满与按量付费兜底才是没选它的原因；别的选法下它只是没轮到。
    if (row.tight && route.strategy === 'expiring' && ready.some((other) => !other.tight)) return { ...base, state: 'skipped', why: 'tight' };
    if (row.payAsYouGo && route.strategy === 'expiring' && ready.some((other) => !other.payAsYouGo)) return { ...base, state: 'standby', why: 'paygReserve' };
    return { ...base, state: 'standby', why: 'standby' };
  });
  return {
    index: picked?.index ?? null,
    trace,
    ...(options.needsImage ? { image: anyVision ? 'applied' as const : 'fallback' as const } : {}),
    ...(weightStep ? { weightStep } : {}),
  };
}
