/**
 * 模型组选路：一条路线里这次用哪个来源。纯函数，不读任何状态：「轮流」「用完再换」要的上一次选中、
 * 「按权重」的计数都由调用方传入；按权重这一步怎么改计数随结果返回，采用后由调用方记下。
 * 「快作废的先用」直接复用供应商组的排序(provider-group/scheduler.ts 与 usage.ts)，两处不会各算各的。
 */
import type {
  ModelGroupRoute,
  ModelGroupTraceEntry,
  ModelGroupTraceQuota,
  ModelGroupTraceWhy,
} from '../../shared/modelGroups.js';
import { modelGroupCandidateKey, modelGroupWeight } from '../../shared/modelGroups.js';
import { pickProviderGroupMember } from '../provider-group/scheduler.js';
import { FIVE_HOURS_MS, quotaWindowsScheduleState } from '../provider-group/usage.js';

/** 一个候选此刻的事实，顺序与 route.candidates 一致。 */
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
  /**
   * 「最省钱」用的标价：每百万输出 token 的美元价(人民币报价已折算)。订阅来源、没有标价时为 null。
   * 只在选法是 cheapest 时才读取，其余选法可省略。
   */
  price?: number | null;
  /** 这个模型能不能看图；读不到按不能。 */
  acceptsImage?: boolean;
  /** Route effort supported by this exact provider, model and harness. */
  effort?: string;
}

export interface ModelGroupPick {
  index: number | null;
  trace: ModelGroupTraceEntry[];
  /** 要求能看图时：applied = 只在能看图的来源里选了；fallback = 一个能看图的都没有，照常选。 */
  image?: 'applied' | 'fallback';
  /** 「按权重」这一步：采用这次结果时用 applyModelGroupWeightStep 记到当时的计数上。别的选法省略。 */
  weightStep?: ModelGroupWeightStep;
}

/** 按权重选一次对计数的改动：参与的来源各加自己的权重，选中的减去总权重。 */
export interface ModelGroupWeightStep {
  participants: { key: string; weight: number }[];
  pickedKey: string;
}

/**
 * 把一步记到计数上(键是候选身份)。采用时才记、且记到那一刻的计数上：两个新任务先后选路再先后采用，两步都算进去。
 */
export function applyModelGroupWeightStep(
  counters: ReadonlyMap<string, number> | undefined,
  step: ModelGroupWeightStep,
): Map<string, number> {
  const next = new Map(counters);
  let total = 0;
  for (const { key, weight } of step.participants) {
    next.set(key, (next.get(key) ?? 0) + weight);
    total += weight;
  }
  next.set(step.pickedKey, (next.get(step.pickedKey) ?? 0) - total);
  return next;
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

/**
 * 平滑加权轮转：每次每个参与者的计数加上自己的权重，选计数最大的(一样大时取列表靠前的)，它的计数减去总权重。
 * 权重 3:1 时分到 A A B A …，不会连着发一批给同一个。不参与的来源计数不变。
 */
function weightedPick<T extends { key: string; weight: number }>(rows: readonly T[], counters: ReadonlyMap<string, number> | undefined) {
  const score = (row: T) => (counters?.get(row.key) ?? 0) + row.weight;
  let best: T = rows[0];
  for (const row of rows) if (score(row) > score(best)) best = row;
  return { picked: best, step: { participants: rows.map(({ key, weight }) => ({ key, weight })), pickedKey: best.key } };
}

/** 还有配额的订阅不另外花钱；其余按标价，没有标价的排在有标价的后面。 */
function costOf(fact: ModelGroupCandidateFacts | undefined): number {
  if (fact?.windows) return 0;
  return typeof fact?.price === 'number' && Number.isFinite(fact.price) && fact.price >= 0
    ? fact.price
    : Number.POSITIVE_INFINITY;
}

export function pickModelGroupCandidate(
  route: ModelGroupRoute,
  facts: readonly ModelGroupCandidateFacts[],
  options: {
    now: number;
    /** 上一次采用的候选(「轮流」「用完再换」用)。 */
    lastPickedKey?: string | null;
    needsImage?: boolean;
    /** 「按权重」上一次采用后的计数。 */
    weightCounters?: ReadonlyMap<string, number>;
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
    return {
      candidate, index, key: modelGroupCandidateKey(candidate),
      noVision: anyVision && fact?.acceptsImage !== true,
      usable: !candidate.off && fact?.available === true && !(anyVision && fact?.acceptsImage !== true),
      limited: state?.limited ?? false,
      limitedUntilMs: state?.resetAtMs ?? null,
      tight: state?.fiveHourTight ?? false,
      urgency: state?.urgency ?? null,
      quota: headroom?.window ?? state?.quota ?? null,
      headroom: headroom?.left ?? null,
      weight: modelGroupWeight(candidate.weight),
    };
  });
  const usable = rows.filter((row) => row.usable);
  const ready = usable.filter((row) => !row.limited);

  let picked: (typeof rows)[number] | null = null;
  let why: ModelGroupTraceWhy = 'only';
  let weightStep: ModelGroupWeightStep | undefined;
  /** 选法自己的理由；只有一个能用时仍写 only。 */
  let strategyWhy: ModelGroupTraceWhy = route.strategy;
  if (ready.length > 0) {
    const last = rows.findIndex((row) => row.key === options.lastPickedKey);
    if (route.strategy === 'order') {
      picked = ready[0];
    } else if (route.strategy === 'rotate') {
      picked = ready.find((row) => row.index > last) ?? ready[0];
    } else if (route.strategy === 'drain') {
      // 上一次用的还能用就接着用；用完或用不了才往下，前面的恢复了也不换回去(绕到开头再从头找)。
      picked = ready.find((row) => row.index === last)
        ?? ready.find((row) => row.index > last) ?? ready[0];
      if (last >= 0 && picked.index !== last) strategyWhy = 'drainNext';
    } else if (route.strategy === 'headroom') {
      // 严格大于才换：一样多时保留列表里靠前的；读不到额度的排在读得到的后面。
      const known = ready.filter((row) => row.headroom !== null);
      picked = known.length > 0
        ? known.reduce((best, row) => (row.headroom! > best.headroom! ? row : best))
        : ready[0];
      // 谁都读不到额度时只是按列表顺序取了第一个，不说它余量最多。
      if (known.length === 0) strategyWhy = 'order';
    } else if (route.strategy === 'weighted') {
      const result = weightedPick(ready, options.weightCounters);
      picked = result.picked;
      weightStep = result.step;
    } else if (route.strategy === 'cheapest') {
      // 严格小于才换：一样便宜时保留列表里靠前的。
      picked = ready.reduce((best, row) => (costOf(facts[row.index]) < costOf(facts[best.index]) ? row : best));
    } else {
      const key = pickProviderGroupMember(ready.map((row) => ({
        key: row.key, usable: true, paused: false, running: 0, limit: 1, weight: 1,
        urgency: row.urgency, fiveHourTight: row.tight,
      })), 'order');
      picked = ready.find((row) => row.key === key) ?? ready[0];
    }
    why = usable.length === 1 ? 'only' : strategyWhy;
    if (why === 'cheapest') {
      const cost = costOf(facts[picked.index]);
      // 谁都没有标价时只是按列表顺序取了第一个，不说它最省钱。
      why = cost === 0 && facts[picked.index]?.windows ? 'cheapestFree' : Number.isFinite(cost) ? 'cheapest' : 'order';
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
    // 只有按额度排时，5 小时快满才是没选它的原因；别的选法下它只是没轮到。
    if (row.tight && route.strategy === 'expiring' && ready.some((other) => !other.tight)) return { ...base, state: 'skipped', why: 'tight' };
    return { ...base, state: 'standby', why: 'standby' };
  });
  return {
    index: picked?.index ?? null,
    trace,
    ...(options.needsImage ? { image: anyVision ? 'applied' as const : 'fallback' as const } : {}),
    ...(weightStep ? { weightStep } : {}),
  };
}
