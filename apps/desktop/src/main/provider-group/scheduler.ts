/**
 * 选路：一条路由里这次用哪个成员。纯函数，不读任何状态。
 *
 * 这是全应用唯一的一套选法实现(shared/routeStrategy.ts)：智能路由、供应商内的订阅账号、插件引擎的账号、
 * 跨电脑的供应商组(docs/product-rules/provider-groups.md §5)都调用 pickRouteMember。「轮流」「用完再换」要的
 * 上一次选中、「按权重」的计数由调用方传入；按权重这一步怎么改计数随结果返回，采用后由调用方记下。
 */
import type { RouteStrategy } from '../../shared/routeStrategy.js';

export interface SchedulableMember {
  key: string;
  /** 在线、供应商可用、提供所选模型、不在冷却中、配额没有用完。 */
  usable: boolean;
  paused: boolean;
  running: number;
  /** Account-level comparison only. `running` still enforces the physical member limit. */
  selectionRunning?: number;
  /** One turn per currently eligible account. Omitted on single-account/old peers. */
  roundSlots?: number;
  /** 实际并发上限(effectiveConcurrencyLimit)；不限制为 Infinity。 */
  limit: number;
  weight: number;
  /**
   * 额度有多急着用(usage.ts：剩下的额度 ÷ 剩下的时间)。1 = 正好按时间用完，越大越该先用；读不到为 null。
   */
  urgency?: number | null;
  /** 5 小时配额快满、离重置还早(usage.ts)：「快作废的先用」先不分新任务，除非别的都不行。 */
  fiveHourTight?: boolean;
  /** 剩余配额占比(0–100)，「余量最多的先用」用；读不到为 null。 */
  headroom?: number | null;
  /** 「最省钱」用的花费：还有配额的订阅为 0，其余为标价；没有标价为 null。 */
  cost?: number | null;
}

export interface PickOptions {
  /** 这一轮已经试过的成员。 */
  exclude?: ReadonlySet<string>;
  /** 上一次采用的成员(「轮流」「用完再换」用)。 */
  lastPicked?: string | null;
  /** Number of consecutive round picks already given to lastPicked. */
  roundPicks?: number;
  /** 「按权重」上一次采用后的计数(键是成员的 key)。 */
  weightCounters?: ReadonlyMap<string, number>;
  /**
   * 成员是同一个供应商的几个账号或几台电脑(账号池、供应商组)时为 true：它们可以互相替代，不论选法都先按配额收窄到
   * 最急的那几个，选法只在这几个里挑(2026-10-21 用户裁决：快作废的额度最优先，对所有选法生效)。用户自己排的路由不传：
   * 成员可以是不同的模型，列表顺序本身就是用户的意思，只有选「快作废的先用」时才按配额排。
   */
  quotaFirst?: boolean;
  /**
   * 按配额收窄时，读不到用量的成员是否与最急的那几个一起留下。供应商组的电脑为 true(2026-11-19 用户裁决)；
   * 其他调用方不传，只在全部读不到时才都留下。
   */
  keepUnknownQuota?: boolean;
}

/** 按权重选一次对计数的改动：参与的成员各加自己的权重，选中的减去总权重。 */
export interface RouteWeightStep {
  participants: { key: string; weight: number }[];
  pickedKey: string;
}

export interface RoutePick {
  /** 没有可分的成员为 null；是否因为全部满载，用 routeMembersFull 区分。 */
  key: string | null;
  /** 「按权重」这一步：采用这次结果时用 applyRouteWeightStep 记到当时的计数上。别的选法省略。 */
  weightStep?: RouteWeightStep;
  /** 选法没有可比的依据(谁都读不到余量、谁都没有标价)，只是按列表顺序取了第一个。 */
  plain?: true;
}

/** 不低于最急那个的这个比例算一样急：同时开的几个任务不全压到一个成员上。 */
export const PROVIDER_GROUP_SIMILAR_URGENCY = 0.9;

/**
 * 把一步记到计数上。采用时才记、且记到那一刻的计数上：两个新任务先后选路再先后采用，两步都算进去。
 */
export function applyRouteWeightStep(
  counters: ReadonlyMap<string, number> | undefined,
  step: RouteWeightStep,
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
 * 只分给可用、未暂停、没试过、未达到并发上限的成员(2026-11-11 用户裁决：满了就不再分；limit 传
 * effectiveConcurrencyLimit，不限制为 Infinity)，再按选法挑一个。
 */
export function pickRouteMember(
  members: readonly SchedulableMember[],
  strategy: RouteStrategy,
  options: PickOptions = {},
): RoutePick {
  const open = routeSchedulingCandidates(members, strategy, options);
  if (open.length === 0) return { key: null };
  const lastIndex = options.lastPicked ? members.findIndex((m) => m.key === options.lastPicked) : -1;
  const after = () => open.find((m) => members.indexOf(m) > lastIndex) ?? open[0];
  switch (strategy) {
    case 'order':
      return { key: open[0].key };
    case 'rotate': {
      const last = open.find((m) => m.key === options.lastPicked);
      if (last && (options.roundPicks ?? 1) < (last.roundSlots ?? 1)) return { key: last.key };
      return { key: after().key };
    }
    case 'drain': {
      // 上一次用的还能用就接着用；用完或用不了才往下，前面的恢复了也不换回去(绕到开头再从头找)。
      const last = open.find((m) => m.key === options.lastPicked);
      return { key: (last ?? after()).key };
    }
    case 'weighted': {
      // 平滑加权轮转：每个参与者的计数加上自己的权重，选计数最大的(一样大时取靠前的)，它的计数减去总权重。
      // 权重 3:1 时分到 甲 甲 乙 甲 …，不会连着发一批给同一个。
      const rows = open.map((m) => ({ key: m.key, weight: Math.max(1, m.weight) }));
      const score = (row: (typeof rows)[number]) => (options.weightCounters?.get(row.key) ?? 0) + row.weight;
      const best = rows.reduce((top, row) => (score(row) > score(top) ? row : top));
      return { key: best.key, weightStep: { participants: rows, pickedKey: best.key } };
    }
    case 'headroom': {
      // 严格大于才换：一样多时保留靠前的；读不到额度的排在读得到的后面。
      const known = open.filter((m) => typeof m.headroom === 'number' && Number.isFinite(m.headroom));
      if (known.length === 0) return { key: open[0].key, plain: true };
      return { key: known.reduce((best, m) => (m.headroom! > best.headroom! ? m : best)).key };
    }
    case 'cheapest': {
      // 严格小于才换：一样便宜时保留靠前的；没有标价的排在有标价的后面。
      const best = open.reduce((top, m) => (costOf(m) < costOf(top) ? m : top));
      return Number.isFinite(costOf(best)) ? { key: best.key } : { key: best.key, plain: true };
    }
    case 'expiring':
    default:
      // 已经收窄到最急的那几个：其中正在运行任务最少的先用，同时开的几个任务不全压到一个成员上。
      return { key: leastBusy(open).key };
  }
}

/**
 * 这一次真正在比的那几个成员：能接的；「快作废的先用」或 quotaFirst 时再收窄到最急的那几个。
 * 实际选择与不暴露账号的池摘要共用。
 */
export function routeSchedulingCandidates(
  members: readonly SchedulableMember[],
  strategy: RouteStrategy,
  options: PickOptions = {},
): readonly SchedulableMember[] {
  const open = openMembers(members, options);
  return strategy === 'expiring' || options.quotaFirst ? byQuota(open, options.keepUnknownQuota === true) : open;
}

/**
 * 按配额收窄(2026-10-21 用户裁决：快作废的额度最优先，其次各成员平均)：先避开 5 小时配额快满、离重置还早的
 * (都是这样时不避开)，再在读得到用量的成员里只留最急的那几个(不低于最急那个的 90%)。读不到用量的成员：
 * `keepUnknown` 时与留下的几个一起比(供应商组，2026-11-19 用户裁决：未开放额度的分享、尚未接入用量的订阅或 API 连接
 * 此前只要有一台读得到就分不到任务)；否则只有全部读不到时才都留下。保持列表顺序。
 */
function byQuota(open: readonly SchedulableMember[], keepUnknown: boolean): readonly SchedulableMember[] {
  const roomy = open.filter((member) => !member.fiveHourTight);
  const pool = roomy.length > 0 ? roomy : open;
  const known = (member: SchedulableMember) => typeof member.urgency === 'number' && Number.isFinite(member.urgency);
  const urgencies = pool.filter(known).map((member) => member.urgency!);
  if (urgencies.length === 0) return pool;
  const top = Math.max(...urgencies);
  return pool.filter((member) => known(member) ? member.urgency! >= top * PROVIDER_GROUP_SIMILAR_URGENCY : keepUnknown);
}

function eligibleMembers(members: readonly SchedulableMember[], options: Pick<PickOptions, 'exclude'>) {
  return members.filter((m) => m.usable && !m.paused && !options.exclude?.has(m.key));
}

function openMembers(members: readonly SchedulableMember[], options: Pick<PickOptions, 'exclude'>) {
  return eligibleMembers(members, options).filter((m) => m.running < m.limit);
}

/** 有能接的成员(可用、未暂停、没试过)，但全部达到并发上限：调用方据此提示「已满载」，而不是「没有能用的」。 */
export function routeMembersFull(
  members: readonly SchedulableMember[],
  options: Pick<PickOptions, 'exclude'> = {},
): boolean {
  const eligible = eligibleMembers(members, options);
  return eligible.length > 0 && eligible.every((m) => m.running >= m.limit);
}

/** 正在运行最少的一个；相同时按列表顺序。 */
function leastBusy(members: readonly SchedulableMember[]): SchedulableMember {
  return members.reduce((best, m) => ((m.selectionRunning ?? m.running) < (best.selectionRunning ?? best.running) ? m : best));
}

function costOf(member: SchedulableMember): number {
  return typeof member.cost === 'number' && Number.isFinite(member.cost) && member.cost >= 0
    ? member.cost
    : Number.POSITIVE_INFINITY;
}
