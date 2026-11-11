/**
 * 模型组：把模型供应商里已有的几个来源合成一个可选项（路线），或把一条路线 / 一个模型连同思考深度
 * 存成模式。只决定新任务用哪个已连接的模型，不保存凭证，也不改变供应商、供应商组与账号池各自的规则。
 * 产品规则见 docs/product-rules/model-groups.md。
 */

export const MODEL_GROUPS_IPC = {
  GET: 'model-groups:get',
  SET: 'model-groups:set',
  RESOLVE: 'model-groups:resolve',
} as const;

export const MODEL_GROUP_STRATEGIES = ['expiring', 'order', 'rotate', 'cheapest'] as const;
/**
 * expiring = 快作废的额度先用；order = 按顺序；rotate = 每个新任务换一个；
 * cheapest = 最省钱：还有配额的订阅不另外花钱，其余按该来源的标价从低到高。
 */
export type ModelGroupStrategy = (typeof MODEL_GROUP_STRATEGIES)[number];

export type ModelGroupAgentKind = 'cc' | 'codex' | 'pi';

/** 一个已连接的模型：与新任务选择器选中一行时得到的组合相同。 */
export interface ModelGroupCandidate {
  agentKind: ModelGroupAgentKind;
  providerId: string;
  model: string;
  /** 用户暂时不让这条路线用它；保留在列表里。 */
  off?: boolean;
}

/**
 * 例外：在路线的选法之前先看一遍，按列表顺序。
 * image = 第一条消息带图片时只在能看图的来源里选(一个都没有就照常选)；
 * hours = 本机时间落在 [from, to) 内(可跨午夜)时改走另一条路线。
 */
export type ModelGroupException =
  | { when: { type: 'image' }; use: 'vision' }
  | { when: { type: 'hours'; from: number; to: number }; use: { type: 'route'; routeId: string } };

export interface ModelGroupRoute {
  id: string;
  name: string;
  strategy: ModelGroupStrategy;
  candidates: ModelGroupCandidate[];
  exceptions?: ModelGroupException[];
}

export type ModelGroupModeTarget =
  | { type: 'route'; routeId: string }
  | { type: 'model'; agentKind: ModelGroupAgentKind; providerId: string; model: string };

export interface ModelGroupMode {
  id: string;
  name: string;
  target: ModelGroupModeTarget;
  /** 思考深度；选中的模型不支持这一档时按该模型的默认档运行。 */
  effort?: string;
}

export interface ModelGroupsConfig {
  routes: ModelGroupRoute[];
  modes: ModelGroupMode[];
}

export const MODEL_GROUPS_DEFAULTS: ModelGroupsConfig = { routes: [], modes: [] };

export const MODEL_GROUP_LIMITS = { routes: 32, modes: 32, candidates: 16, exceptions: 8, name: 40, id: 64, field: 256 } as const;

/** 草稿与选择器里选中的那一项。 */
export interface ModelGroupSelection {
  type: 'route' | 'mode';
  id: string;
}

export type ModelGroupTraceState = 'picked' | 'standby' | 'skipped';
/**
 * picked：expiring / order / rotate / cheapest 对应选法(cheapestFree = 还有订阅配额，不另外花钱)；
 * only = 只有它能用；soonest = 全都用完了，选最早恢复的。
 * standby：这次没轮到。skipped：off = 已停用；unavailable = 没连接或模型已不可选；limited = 额度用完；
 * tight = 5 小时额度快满、离重置还早；noVision = 消息里有图片而它看不了图。
 */
export type ModelGroupTraceWhy =
  | 'expiring' | 'order' | 'rotate' | 'cheapest' | 'cheapestFree' | 'only' | 'soonest'
  | 'standby'
  | 'off' | 'unavailable' | 'limited' | 'tight' | 'noVision';

export interface ModelGroupTraceQuota {
  /** 0–100，已用。 */
  usedPercent: number;
  resetAtMs: number | null;
  windowMs: number;
}

export interface ModelGroupTraceEntry {
  agentKind: ModelGroupAgentKind;
  providerId: string;
  model: string;
  modelName: string;
  sourceName: string;
  state: ModelGroupTraceState;
  why: ModelGroupTraceWhy;
  /** 排序所依据的额度窗口；读不到额度（API 密钥等）时为 null。 */
  quota: ModelGroupTraceQuota | null;
  /** 额度用完时的恢复时刻。 */
  limitedUntilMs?: number | null;
}

export interface ModelGroupResolvedRoute {
  agentKind: ModelGroupAgentKind;
  providerId: string;
  model: string;
  effort?: string;
}

/**
 * 例外决定了这次的结果：image = 只在能看图的来源里选了；imageFallback = 有图片但没有能看图的来源，照常选；
 * hours = 这个时段改走了另一条路线(viaRouteName)。
 */
export interface ModelGroupAppliedException {
  type: 'image' | 'imageFallback' | 'hours';
  viaRouteName?: string;
}

export type ModelGroupResolveResult =
  | {
      outcome: 'routed';
      groupName: string;
      route: ModelGroupResolvedRoute;
      modelName: string;
      sourceName: string;
      why: ModelGroupTraceWhy;
      quota: ModelGroupTraceQuota | null;
      trace: ModelGroupTraceEntry[];
      /** 起作用的例外，按发生顺序(先改走路线，再按图片筛)；没有就省略。 */
      exceptions?: ModelGroupAppliedException[];
    }
  /** missing = 这条路线或模式已被删除；unavailable = 里面没有现在能用的模型。两者都沿用用户原来选的模型。 */
  | { outcome: 'missing' | 'unavailable'; groupName: string; trace: ModelGroupTraceEntry[] };

export interface ModelGroupResolveRequest {
  selection: ModelGroupSelection;
  /** 只看会选谁：不推进「轮流」的顺序。 */
  dryRun?: boolean;
  /** 第一条消息的情况；时间由主进程自己取，不信界面传来的。 */
  context?: { hasImages?: boolean };
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function agentKind(value: unknown): ModelGroupAgentKind | null {
  return value === 'cc' || value === 'codex' || value === 'pi' ? value : null;
}

function candidate(raw: unknown): ModelGroupCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const kind = agentKind(value.agentKind);
  const providerId = text(value.providerId, MODEL_GROUP_LIMITS.field);
  const model = text(value.model, MODEL_GROUP_LIMITS.field);
  if (!kind || !providerId || !model) return null;
  return { agentKind: kind, providerId, model, ...(value.off === true ? { off: true } : {}) };
}

export function modelGroupCandidateKey(value: Pick<ModelGroupCandidate, 'agentKind' | 'providerId' | 'model'>): string {
  return `${value.agentKind}\u0000${value.providerId}\u0000${value.model}`;
}

function normalizeModelGroupRoute(raw: unknown): ModelGroupRoute | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = text(value.id, MODEL_GROUP_LIMITS.id);
  const name = text(value.name, MODEL_GROUP_LIMITS.name);
  if (!id || !name) return null;
  const seen = new Set<string>();
  const candidates = (Array.isArray(value.candidates) ? value.candidates : [])
    .map(candidate)
    .filter((item): item is ModelGroupCandidate => {
      if (!item) return false;
      const key = modelGroupCandidateKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MODEL_GROUP_LIMITS.candidates);
  const strategy = MODEL_GROUP_STRATEGIES.find((item) => item === value.strategy) ?? 'expiring';
  const exceptions = (Array.isArray(value.exceptions) ? value.exceptions : [])
    .map(exception)
    .filter((item): item is ModelGroupException => !!item)
    .slice(0, MODEL_GROUP_LIMITS.exceptions);
  return { id, name, strategy, candidates, ...(exceptions.length > 0 ? { exceptions } : {}) };
}

function hour(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23 ? value : null;
}

function exception(raw: unknown): ModelGroupException | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const when = value.when && typeof value.when === 'object' ? value.when as Record<string, unknown> : null;
  if (when?.type === 'image') return value.use === 'vision' ? { when: { type: 'image' }, use: 'vision' } : null;
  if (when?.type !== 'hours') return null;
  const from = hour(when.from);
  const to = hour(when.to);
  const use = value.use && typeof value.use === 'object' ? value.use as Record<string, unknown> : null;
  const routeId = use?.type === 'route' ? text(use.routeId, MODEL_GROUP_LIMITS.id) : '';
  // from === to 是一段空时间，不保存。
  if (from === null || to === null || from === to || !routeId) return null;
  return { when: { type: 'hours', from, to }, use: { type: 'route', routeId } };
}

/** 本机时刻 hour(0–23) 是否落在 [from, to) 内；from > to 时跨午夜。 */
export function modelGroupHoursMatch(when: { from: number; to: number }, localHour: number): boolean {
  return when.from < when.to
    ? localHour >= when.from && localHour < when.to
    : localHour >= when.from || localHour < when.to;
}

/** 去掉指向自己或已不存在路线的时段例外，以及重复的图片例外。 */
function pruneExceptions(route: ModelGroupRoute, routeIds: ReadonlySet<string>): ModelGroupRoute {
  if (!route.exceptions) return route;
  let image = false;
  const exceptions = route.exceptions.filter((item) => {
    if (item.when.type === 'image') return !image && (image = true);
    return item.use !== 'vision' && item.use.routeId !== route.id && routeIds.has(item.use.routeId);
  });
  if (exceptions.length > 0) return { ...route, exceptions };
  const rest = { ...route };
  delete rest.exceptions;
  return rest;
}

function mode(raw: unknown, routeIds: ReadonlySet<string>): ModelGroupMode | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = text(value.id, MODEL_GROUP_LIMITS.id);
  const name = text(value.name, MODEL_GROUP_LIMITS.name);
  const rawTarget = value.target && typeof value.target === 'object' ? value.target as Record<string, unknown> : null;
  if (!id || !name || !rawTarget) return null;
  let target: ModelGroupModeTarget | null = null;
  if (rawTarget.type === 'route') {
    const routeId = text(rawTarget.routeId, MODEL_GROUP_LIMITS.id);
    // 指向已删除路线的模式一并去掉：保存路线与模式是同一次写入，留下它只会在选择器里出现一个必然失败的项。
    if (routeId && routeIds.has(routeId)) target = { type: 'route', routeId };
  } else if (rawTarget.type === 'model') {
    const model = candidate(rawTarget);
    if (model) target = { type: 'model', agentKind: model.agentKind, providerId: model.providerId, model: model.model };
  }
  if (!target) return null;
  const effort = text(value.effort, 32);
  return { id, name, target, ...(effort ? { effort } : {}) };
}

function uniqueById<T extends { id: string }>(items: readonly T[], max: number): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && !!seen.add(item.id)).slice(0, max);
}

/** 磁盘与 IPC 的同一道归一：坏条目丢弃，不让一条坏数据使整份配置读不出来。 */
export function normalizeModelGroupsConfig(raw: unknown): ModelGroupsConfig {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const routes = uniqueById(
    (Array.isArray(value.routes) ? value.routes : []).map(normalizeModelGroupRoute).filter((item): item is ModelGroupRoute => !!item),
    MODEL_GROUP_LIMITS.routes,
  );
  const routeIds = new Set(routes.map((route) => route.id));
  const prunedRoutes = routes.map((route) => pruneExceptions(route, routeIds));
  const modes = uniqueById(
    (Array.isArray(value.modes) ? value.modes : []).map((item) => mode(item, routeIds)).filter((item): item is ModelGroupMode => !!item),
    MODEL_GROUP_LIMITS.modes,
  );
  return { routes: prunedRoutes, modes };
}

export function findModelGroupSelection(
  config: ModelGroupsConfig,
  selection: ModelGroupSelection | null | undefined,
): { type: 'route'; route: ModelGroupRoute } | { type: 'mode'; mode: ModelGroupMode } | null {
  if (!selection) return null;
  if (selection.type === 'route') {
    const route = config.routes.find((item) => item.id === selection.id);
    return route ? { type: 'route', route } : null;
  }
  const found = config.modes.find((item) => item.id === selection.id);
  return found ? { type: 'mode', mode: found } : null;
}

export function sanitizeModelGroupSelection(raw: unknown): ModelGroupSelection | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = text(value.id, MODEL_GROUP_LIMITS.id);
  return id && (value.type === 'route' || value.type === 'mode') ? { type: value.type, id } : null;
}
