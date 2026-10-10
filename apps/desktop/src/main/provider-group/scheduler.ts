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
}

export interface PickOptions {
  /** 这一轮已经试过的组内电脑。 */
  exclude?: ReadonlySet<string>;
  /** 轮询游标：上一次选中的键。 */
  lastPicked?: string | null;
  /** [0, 1) 随机数，按权重时使用。 */
  random?: () => number;
}

/**
 * 只分给可用、未暂停、没试过的电脑；优先未满载的，都满了时分给相对最空的一台(并发上限只用来
 * 分摊，不因满载拒绝用户的消息)。没有可分的电脑返回 null。
 */
export function pickProviderGroupMember(
  members: readonly SchedulableMember[],
  strategy: ProviderGroupStrategy,
  options: PickOptions = {},
): string | null {
  const eligible = members.filter((m) => m.usable && !m.paused && !options.exclude?.has(m.key));
  if (eligible.length === 0) return null;
  const open = eligible.filter((m) => m.running < m.limit);
  if (open.length === 0) return leastBusy(eligible).key;
  switch (strategy) {
    case 'order':
      return open[0].key;
    case 'round': {
      const lastIndex = options.lastPicked ? members.findIndex((m) => m.key === options.lastPicked) : -1;
      const next = open.find((m) => members.indexOf(m) > lastIndex) ?? open[0];
      return next.key;
    }
    case 'weight': {
      const total = open.reduce((sum, m) => sum + Math.max(1, m.weight), 0);
      let point = (options.random ?? Math.random)() * total;
      for (const member of open) {
        point -= Math.max(1, member.weight);
        if (point < 0) return member.key;
      }
      return open[open.length - 1].key;
    }
    case 'least':
    default:
      return leastBusy(open).key;
  }
}

/** 正在运行最少的一台；相同时按组里的顺序。 */
function leastBusy(members: readonly SchedulableMember[]): SchedulableMember {
  return members.reduce((best, m) => (m.running < best.running ? m : best));
}
