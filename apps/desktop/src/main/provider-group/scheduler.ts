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
  /** Higher of the current 5-hour / weekly usage percentages; unknown stays null. */
  usagePercent?: number | null;
  /** 总周额度还没用完时的重置时刻(unix ms)；未知、已重置或已用完为 null。 */
  weeklyResetAtMs?: number | null;
  /** 5 小时额度还没用完时的重置时刻(unix ms)；口径同上。 */
  fiveHourResetAtMs?: number | null;
}

export interface PickOptions {
  /** 这一轮已经试过的组内电脑。 */
  exclude?: ReadonlySet<string>;
  /** 轮询游标：上一次选中的键。 */
  lastPicked?: string | null;
  /** [0, 1) 随机数，按权重时使用。 */
  random?: () => number;
  /** 现在(unix ms)，判断配额快到期时使用；不给时跳过快到期优先。 */
  now?: number;
}

/**
 * 「快到期先用」(2026-10-15 用户裁决)：配额一重置，没用完的部分就浪费了。按顺序看两档，
 * 每周的优先，然后是 5 小时的；同一档里先用重置最早的。
 */
export const PROVIDER_GROUP_WEEKLY_EXPIRING_MS = 5 * 60 * 60_000;
export const PROVIDER_GROUP_FIVE_HOUR_EXPIRING_MS = 60 * 60_000;
/** 重置时刻相差不到这么多算同时到期，再比已用百分比，同时开的任务不全压到一台。 */
export const PROVIDER_GROUP_SAME_RESET_MS = 10 * 60_000;
/** 已用百分比与最低值相差不超过这么多算用量相近，交给组策略挑。 */
export const PROVIDER_GROUP_SIMILAR_USAGE_PERCENT = 5;

const EXPIRING_TIERS: ReadonlyArray<readonly [(m: SchedulableMember) => number | null | undefined, number]> = [
  [(m) => m.weeklyResetAtMs, PROVIDER_GROUP_WEEKLY_EXPIRING_MS],
  [(m) => m.fiveHourResetAtMs, PROVIDER_GROUP_FIVE_HOUR_EXPIRING_MS],
];

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
  if (open.length === 0) return leastBusy(byQuota(eligible, options.now)).key;
  const candidates = byQuota(open, options.now);
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
 * 配额先比(2026-10-15 用户裁决：目的是尽快把快重置的配额用掉)，对所有组策略生效：
 * 先留快到期的那一批，再留已用百分比最低的(相差 5 个百分点以内都算)。读不到用量的电脑(别人分享的、
 * 非 Claude 订阅的)排在读得到的后面；全部读不到时不筛，原样交给组策略。保持组里的顺序。
 */
function byQuota(open: readonly SchedulableMember[], now: number | undefined): readonly SchedulableMember[] {
  const known = open.filter((member) => typeof member.usagePercent === 'number' && Number.isFinite(member.usagePercent));
  if (known.length === 0) return open;
  const pool = expiringFirst(known, now) ?? known;
  const lowest = Math.min(...pool.map((member) => member.usagePercent!));
  // Small quota differences should not send every simultaneous task to the same computer.
  return pool.filter((member) => member.usagePercent! <= lowest + PROVIDER_GROUP_SIMILAR_USAGE_PERCENT);
}

/**
 * 未满载的电脑里，额度快到期的那一批：先看每周的，没有再看 5 小时的；只留重置最早的(及与它几乎同时的)。
 * 都不快到期返回 null。
 */
function expiringFirst(open: readonly SchedulableMember[], now: number | undefined): SchedulableMember[] | null {
  if (now === undefined) return null;
  for (const [resetAt, within] of EXPIRING_TIERS) {
    const soon = open.filter((m) => {
      const at = resetAt(m);
      return typeof at === 'number' && at > now && at - now <= within;
    });
    if (soon.length === 0) continue;
    const earliest = Math.min(...soon.map((m) => resetAt(m)!));
    return soon.filter((m) => resetAt(m)! - earliest <= PROVIDER_GROUP_SAME_RESET_MS);
  }
  return null;
}

/** 正在运行最少的一台；相同时按组里的顺序。 */
function leastBusy(members: readonly SchedulableMember[]): SchedulableMember {
  return members.reduce((best, m) => (m.running < best.running ? m : best));
}
