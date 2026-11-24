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
import { pickRouteMember, type RouteWeightStep } from '../provider-group/scheduler.js';
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
  let weightStep: RouteWeightStep | undefined;
  /** 选法自己的理由；只有一个能用时仍写 only。 */
  let strategyWhy: ModelGroupTraceWhy = route.strategy;
  if (ready.length > 0) {
    const last = rows.findIndex((row) => row.key === options.lastPickedKey);
    const result = pickRouteMember(rows.map((row) => {
      const cost = costOf(facts[row.index]);
      return {
        key: row.key, usable: row.usable && !row.limited, paused: false, running: 0,
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
