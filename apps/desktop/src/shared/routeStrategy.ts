/**
 * 选法：一条路由里这次用哪个成员。智能路由（用户排的路由与自动路由）、供应商内的订阅账号、
 * 插件引擎的账号、跨电脑的供应商组共用这一套名字和同一个选择函数
 * (main/provider-group/scheduler.ts 的 pickRouteMember)，不再各有一套。
 *
 * expiring = 快作废的额度先用：最急的那几个里选正在运行任务最少的；
 * order = 按顺序；rotate = 每个新任务换一个；
 * cheapest = 最省钱：还有配额的订阅不另外花钱，其余按标价从低到高；
 * drain = 用完再换：一直用上一次选中的，它用完或用不了才换列表里下一个；
 * headroom = 余量最多的先用；weighted = 按权重比例交错分配。
 */
export const ROUTE_STRATEGIES = ['expiring', 'order', 'rotate', 'cheapest', 'drain', 'headroom', 'weighted'] as const;
export type RouteStrategy = (typeof ROUTE_STRATEGIES)[number];

export const DEFAULT_ROUTE_STRATEGY: RouteStrategy = 'expiring';

/**
 * 选择框里主推的选法(2026-11-26，dash 建议做减法)：「自动」(expiring，面向用户不再叫「快作废的先用」)、「按顺序」，
 * 几个不同供应商之间再加「最省钱」。轮流、按权重、余量最多、用完再换收进「更多选法」一组，功能不删，存量配置照常显示。
 */
export const PRIMARY_ROUTE_STRATEGIES: readonly RouteStrategy[] = ['expiring', 'order', 'cheapest'];

/** 把能选的选法分成主推与「更多选法」两组，保持原来的先后。 */
export function splitRouteStrategies(available: readonly RouteStrategy[]): { primary: RouteStrategy[]; more: RouteStrategy[] } {
  return {
    primary: available.filter((value) => PRIMARY_ROUTE_STRATEGIES.includes(value)),
    more: available.filter((value) => !PRIMARY_ROUTE_STRATEGIES.includes(value)),
  };
}

/**
 * 成员都是同一个供应商的账号或电脑时能选的选法：它们价格相同，「最省钱」没有可比的，不列。
 */
export const SAME_SOURCE_ROUTE_STRATEGIES: readonly RouteStrategy[] = ['expiring', 'order', 'rotate', 'weighted', 'drain', 'headroom'];

/**
 * 2026-11-24 之前账号池与供应商组自己的四种分配方式。只在读旧配置、旧版电脑发来的值时出现：
 * least（最少占用）与更早的 usage（用量均衡）当时就是先比配额、再选最闲的，对应现在的 expiring。
 */
const FROM_LEGACY: Record<string, RouteStrategy> = {
  least: 'expiring', usage: 'expiring', round: 'rotate', order: 'order', weight: 'weighted',
};

/** 认新名字，也认旧名字；认不出为 null。 */
export function knownRouteStrategy(value: unknown): RouteStrategy | null {
  if (typeof value !== 'string') return null;
  if ((ROUTE_STRATEGIES as readonly string[]).includes(value)) return value as RouteStrategy;
  return Object.hasOwn(FROM_LEGACY, value) ? FROM_LEGACY[value] : null;
}

/** 读存储、IPC 与别的电脑发来的值：认不出按默认。 */
export function routeStrategyOf(value: unknown, fallback: RouteStrategy = DEFAULT_ROUTE_STRATEGY): RouteStrategy {
  return knownRouteStrategy(value) ?? fallback;
}

export type LegacyPoolStrategy = 'least' | 'round' | 'order' | 'weight';

const TO_LEGACY_POOL: Record<RouteStrategy, LegacyPoolStrategy> = {
  expiring: 'least', order: 'order', rotate: 'round', weighted: 'weight',
  cheapest: 'least', drain: 'order', headroom: 'least',
};

/**
 * 发给旧版电脑的账号池／供应商组摘要里 strategy 仍写旧名字（旧版认不出新名字时一律按最少占用）；
 * 真实选法另放在 pick，新版先读 pick。
 */
export function legacyPoolStrategy(strategy: RouteStrategy): LegacyPoolStrategy {
  return TO_LEGACY_POOL[strategy];
}
