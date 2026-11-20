/**
 * 组策略：新任务选哪台组内电脑(docs/product-rules/provider-groups.md §5)。纯函数，不读任何状态。
 */
import type { ProviderGroupStrategy } from '../../shared/providerGroup.js';

export interface SchedulableMember {
  key: string;
  /** 在线、供应商可用、提供所选模型、不在冷却中。 */
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
  /** 5 小时配额快满、离重置还早(usage.ts)：先不分新任务，除非别的都不行。 */
  fiveHourTight?: boolean;
}

export interface PickOptions {
  /** 这一轮已经试过的组内电脑。 */
  exclude?: ReadonlySet<string>;
  /** 轮询游标：上一次选中的键。 */
  lastPicked?: string | null;
  /** Number of consecutive round picks already given to lastPicked. */
  roundPicks?: number;
  /** [0, 1) 随机数，按权重时使用。 */
  random?: () => number;
  /**
   * 读不到用量的成员是否与最急的那几台一起留给组策略。供应商组的电脑为 true(2026-11-19 用户裁决)；
   * 账号池等其他调用方不传，仍只在全部读不到时才交给组策略。
   */
  keepUnknownQuota?: boolean;
}

/** 不低于最急那台的这个比例算一样急，交给组策略挑：同时开的几个任务不全压到一台。 */
export const PROVIDER_GROUP_SIMILAR_URGENCY = 0.9;

/**
 * 只分给可用、未暂停、没试过、未达到并发上限的电脑(2026-11-11 用户裁决：满了就不再分，取代「并发上限只用来分摊」；
 * limit 传 effectiveConcurrencyLimit，不限制为 Infinity)。先按配额排(byQuota)，组策略只在剩下的几台里挑。
 * 没有可分的电脑返回 null；是否因为全部满载，用 providerGroupMembersFull 区分。
 */
export function pickProviderGroupMember(
  members: readonly SchedulableMember[],
  strategy: ProviderGroupStrategy,
  options: PickOptions = {},
): string | null {
  const candidates = providerGroupSchedulingCandidates(members, options);
  if (candidates.length === 0) return null;
  switch (strategy) {
    case 'order':
      return candidates[0].key;
    case 'round': {
      const lastIndex = options.lastPicked ? members.findIndex((m) => m.key === options.lastPicked) : -1;
      const last = candidates.find(m => m.key === options.lastPicked);
      if (last && (options.roundPicks ?? 1) < (last.roundSlots ?? 1)) return last.key;
      const next = candidates.find((m) => members.indexOf(m) > lastIndex) ?? candidates[0];
      return next.key;
    }
    case 'weight': {
      const total = candidates.reduce((sum, m) => sum + Math.max(1, m.weight), 0);
      let point = (options.random ?? Math.random)() * total;
      for (const member of candidates) {
        point -= Math.max(1, member.weight);
        if (point < 0) return member.key;
      }
      return candidates[candidates.length - 1].key;
    }
    // 旧的「用量均衡」(usage)：配额排序已对所有策略生效，剩下的按最少占用挑。
    case 'usage':
    case 'least':
    default:
      return leastBusy(candidates).key;
  }
}

/** The same admission/quota band used by actual selection and anonymous pool summaries. */
export function providerGroupSchedulingCandidates(members: readonly SchedulableMember[], options: PickOptions = {}) {
  return byQuota(eligibleMembers(members, options).filter(m => m.running < m.limit), options.keepUnknownQuota === true);
}

/**
 * 配额先比，对所有组策略生效(2026-10-21 用户裁决：快作废的额度最优先，其次各账号平均)：先避开 5 小时配额
 * 快满、离重置还早的(都是这样时不避开)，再在读得到用量的成员里只留最急的那几台(不低于最急那台的 90%)。
 * 读不到用量的成员：`keepUnknown` 时不筛掉，与留下的几台一起交给组策略(供应商组，2026-11-19 用户裁决：未开放额度的
 * 分享、尚未接入用量的订阅或 API 连接此前只要有一台读得到就分不到任务)；否则只有全部读不到时才原样交给组策略。
 * 保持组里的顺序。
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

/** 有能接的电脑(可用、未暂停、没试过)，但全部达到并发上限：调用方据此提示「已满载」，而不是「没有能用的」。 */
export function providerGroupMembersFull(
  members: readonly SchedulableMember[],
  options: Pick<PickOptions, 'exclude'> = {},
): boolean {
  const eligible = eligibleMembers(members, options);
  return eligible.length > 0 && eligible.every((m) => m.running >= m.limit);
}

/** 正在运行最少的一台；相同时按组里的顺序。 */
function leastBusy(members: readonly SchedulableMember[]): SchedulableMember {
  return members.reduce((best, m) => ((m.selectionRunning ?? m.running) < (best.selectionRunning ?? best.running) ? m : best));
}
