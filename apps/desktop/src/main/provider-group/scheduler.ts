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
  /** [0, 1) 随机数，按权重时使用。 */
  random?: () => number;
}

/** 不低于最急那台的这个比例算一样急，交给组策略挑：同时开的几个任务不全压到一台。 */
export const PROVIDER_GROUP_SIMILAR_URGENCY = 0.9;

/**
 * 只分给可用、未暂停、没试过的电脑；优先未满载的，都满了时分给相对最空的一台(并发上限只用来
 * 分摊，不因满载拒绝用户的消息)。先按配额排(byQuota)，组策略只在剩下的几台里挑；都满了时同样先按配额排，
 * 再选最空的。没有可分的电脑返回 null。
 */
export function pickProviderGroupMember(
  members: readonly SchedulableMember[],
  strategy: ProviderGroupStrategy,
  options: PickOptions = {},
): string | null {
  const eligible = members.filter((m) => m.usable && !m.paused && !options.exclude?.has(m.key));
  if (eligible.length === 0) return null;
  const open = eligible.filter((m) => m.running < m.limit);
  if (open.length === 0) return leastBusy(byQuota(eligible)).key;
  const candidates = byQuota(open);
  switch (strategy) {
    case 'order':
      return candidates[0].key;
    case 'round': {
      const lastIndex = options.lastPicked ? members.findIndex((m) => m.key === options.lastPicked) : -1;
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

/**
 * 配额先比，对所有组策略生效(2026-10-21 用户裁决：快作废的额度最优先，其次各账号平均)：先避开 5 小时配额
 * 快满、离重置还早的(都是这样时不避开)，再只留最急的那几台(不低于最急那台的 90%)。读不到用量的电脑(别人分享的、
 * 尚未接入用量的订阅或 API 连接)排在读得到的后面；全部读不到时不筛，原样交给组策略。保持组里的顺序。
 */
function byQuota(open: readonly SchedulableMember[]): readonly SchedulableMember[] {
  const roomy = open.filter((member) => !member.fiveHourTight);
  const pool = roomy.length > 0 ? roomy : open;
  const known = pool.filter((member) => typeof member.urgency === 'number' && Number.isFinite(member.urgency));
  if (known.length === 0) return pool;
  const top = Math.max(...known.map((member) => member.urgency!));
  return known.filter((member) => member.urgency! >= top * PROVIDER_GROUP_SIMILAR_URGENCY);
}

/** 正在运行最少的一台；相同时按组里的顺序。 */
function leastBusy(members: readonly SchedulableMember[]): SchedulableMember {
  return members.reduce((best, m) => (m.running < best.running ? m : best));
}
