/**
 * 模型组：把模型供应商里已有的几个来源合成一个可选项（路线），可连同推理强度一起存。
 * 只决定新任务用哪个已连接的模型，不保存凭证，也不改变供应商、供应商组与账号池各自的规则。
 * 产品规则见 docs/product-rules/model-groups.md。
 */

export const MODEL_GROUPS_IPC = {
  GET: 'model-groups:get',
  SET: 'model-groups:set',
  RESOLVE: 'model-groups:resolve',
  COMMIT: 'model-groups:commit',
  /** 记下这个任务是经哪条路线建的、用着哪个候选(撞配额时据此提议换来源)。 */
  BIND_SESSION: 'model-groups:bind-session',
  /** 撞配额时同一条路线里还能接着用的下一个来源；没有为 null。 */
  SWITCH_OFFER: 'model-groups:switch-offer',
  /**
   * 手机或另一台电脑经这台电脑的模式建了任务后，请这台电脑在任务里写那一行说明(model-groups.md §6.3)。
   * 本机界面自己写库，不走这里；远程不能裸写消息，所以由这台电脑代写。
   */
  ROUTE_NOTE: 'model-groups:route-note',
} as const;

/**
 * 同账号本人控制的手机与电脑可以远程调用的模型组接口(model-groups.md §6.3)：读模式、按模式选来源、
 * 提交选路记录、记下任务用着哪个来源、写说明。改模式(SET)只在本机。
 * 协议约定见 docs/dev-rules/protocol-compatibility/model-groups-remote-pickers.md。
 */
export const MODEL_GROUPS_REMOTE_CHANNELS = [
  MODEL_GROUPS_IPC.GET,
  MODEL_GROUPS_IPC.RESOLVE,
  MODEL_GROUPS_IPC.COMMIT,
  MODEL_GROUPS_IPC.BIND_SESSION,
  MODEL_GROUPS_IPC.ROUTE_NOTE,
] as const;

export const MODEL_GROUP_STRATEGIES = ['expiring', 'order', 'rotate', 'cheapest', 'drain', 'headroom', 'weighted'] as const;
/**
 * expiring = 快作废的额度先用；order = 按顺序；rotate = 每个新任务换一个；
 * cheapest = 最省钱：还有配额的订阅不另外花钱，其余按该来源的标价从低到高；
 * drain = 用完再换：一直用上一次选中的，它用完或用不了才换列表里下一个；
 * headroom = 余量最多的先用：剩余配额占比最高的先用；
 * weighted = 按权重：新任务按各来源的权重比例交错分配。
 */
export type ModelGroupStrategy = (typeof MODEL_GROUP_STRATEGIES)[number];

/**
 * 2026-11-23 之前的手机与电脑只认识前四种选法：旧手机会整条不列认不出的模式，旧电脑把它当成「快作废的先用」。
 * 发给别的设备时 strategy 换成最接近的旧选法，真实选法放在 pick 里；新版读 pick。选路始终在模式所在的那台电脑上做，
 * 旧设备只是标签不准，模式照样能选。
 */
const LEGACY_STRATEGY: Record<ModelGroupStrategy, 'expiring' | 'order' | 'rotate' | 'cheapest'> = {
  expiring: 'expiring', order: 'order', rotate: 'rotate', cheapest: 'cheapest',
  drain: 'order', headroom: 'expiring', weighted: 'rotate',
};

/** 发给手机与另一台电脑的模式配置(model-groups:get 与伙伴设置里的模型组)：见 LEGACY_STRATEGY。 */
export function modelGroupsConfigForRemote(config: ModelGroupsConfig): ModelGroupsConfig {
  return {
    routes: config.routes.map((route) => (LEGACY_STRATEGY[route.strategy] === route.strategy
      ? route
      : { ...route, strategy: LEGACY_STRATEGY[route.strategy], pick: route.strategy } as ModelGroupRoute)),
  };
}

export type ModelGroupAgentKind = 'cc' | 'codex' | 'pi';

/** 一个已连接的模型：与新任务选择器选中一行时得到的组合相同。 */
export interface ModelGroupCandidate {
  agentKind: ModelGroupAgentKind;
  providerId: string;
  model: string;
  /**
   * 运行位置：另一台电脑的设备 id，或分享来的供应商(`share:<id>`)。省略 = 本机。
   * 选中它的新任务，Agent 在这个位置运行；供应商与模型属于那里的目录。
   */
  agentDeviceId?: string;
  /** 用户暂时不让这条路线用它；保留在列表里。 */
  off?: boolean;
  /** 「按权重」时这个来源的权重，1–1000；不设为 1。别的选法下保留不用。 */
  weight?: number;
}

/**
 * 例外：在路线的选法之前先看一遍，按列表顺序。
 * image = 第一条消息带图片时只在能看图的来源里选(一个都没有就照常选)；
 * hours = 本机时间落在 [from, to) 内(可跨午夜)时改走另一条路线；days 是一周里生效的那几天
 * (0 = 星期日 … 6 = 星期六，与 Date#getDay 相同)，省略 = 每天，跨午夜的时段按开始那一天算。
 */
export type ModelGroupException =
  | { when: { type: 'image' }; use: 'vision' }
  | { when: { type: 'hours'; from: number; to: number; days?: number[] }; use: { type: 'route'; routeId: string } };

export interface ModelGroupRoute {
  id: string;
  name: string;
  strategy: ModelGroupStrategy;
  candidates: ModelGroupCandidate[];
  exceptions?: ModelGroupException[];
  /** 推理强度；不设或选中的模型不支持这一档时不带，按该模型的默认档运行。 */
  effort?: string;
}

/** 2026-11-11 起只有路线；旧版存下的 modes 读取时忽略。 */
export interface ModelGroupsConfig {
  routes: ModelGroupRoute[];
}

export const MODEL_GROUPS_DEFAULTS: ModelGroupsConfig = { routes: [] };

export const MODEL_GROUP_LIMITS = { routes: 32, candidates: 16, exceptions: 8, name: 40, id: 64, field: 256, effort: 32, weight: 1000 } as const;

/** 草稿与选择器里选中的那一项。旧版的 type: 'mode' 读取时按没有选处理。 */
export interface ModelGroupSelection {
  type: 'route';
  id: string;
  /**
   * 这个模式属于另一台电脑(在本机选择器「其他电脑」那一段选的)：由那台电脑按自己的规则选，任务在那里运行。
   * 省略 = 本机(或远程控制时被控的那台)的模式。发给那台电脑时去掉，那边按自己的模式解析。
   */
  deviceId?: string;
}

/** 任务里那一行说明，与插件选路的说明卡同形(source 固定为 model-group)。 */
export interface ModelGroupRouteNote {
  pluginName: string;
  outcome: 'routed' | 'kept';
  modelName: string;
  effort?: string;
  reason?: string;
  why?: 'unavailable-route';
  source: 'model-group';
}

export type ModelGroupTraceState = 'picked' | 'standby' | 'skipped';
/**
 * picked：expiring / order / rotate / cheapest / drain / headroom / weighted 对应选法(cheapestFree = 还有订阅配额，不另外花钱；
 * drainNext = 上一个用完或用不了，换到了它)；
 * only = 只有它能用；soonest = 全都用完了，选最早恢复的。
 * standby：这次没轮到。skipped：off = 已停用；unavailable = 没连接或模型已不可选；limited = 额度用完；
 * tight = 5 小时额度快满、离重置还早；noVision = 消息里有图片而它看不了图。
 */
export type ModelGroupTraceWhy =
  | 'expiring' | 'order' | 'rotate' | 'cheapest' | 'cheapestFree' | 'only' | 'soonest'
  | 'drain' | 'drainNext' | 'headroom' | 'weighted'
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
  /** 运行位置；本机省略。 */
  agentDeviceId?: string;
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
  /** 选中的来源在另一台电脑或是分享来的：新任务的 Agent 在那里运行。本机省略。 */
  agentDeviceId?: string;
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

export type ModelGroupResolveResult = {
  /** 本机选路凭据：实际采用后提交；预览没有凭据。 */
  decisionId?: string;
} & (
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
  /** missing = 这条路线已被删除；unavailable = 里面没有现在能用的模型。两者都沿用用户原来选的模型。 */
  | { outcome: 'missing' | 'unavailable'; groupName: string; trace: ModelGroupTraceEntry[] });

/** 撞配额时「换到下一个来源继续」的提议(model-groups.md §6.1)。只提议与任务同一运行位置(本机)的来源。 */
export interface ModelGroupSwitchOffer {
  groupName: string;
  /** 换过去之后记回去时用：任务仍属于同一个组。 */
  selection: ModelGroupSelection;
  agentKind: ModelGroupAgentKind;
  providerId: string;
  model: string;
  modelName: string;
  sourceName: string;
  /** 换到另一个引擎：要走选择器的跨引擎切换(含它的确认)。 */
  crossEngine: boolean;
}

export interface ModelGroupResolveRequest {
  selection: ModelGroupSelection;
  /** 只看会选谁：不推进「轮流」的顺序。 */
  dryRun?: boolean;
  /** 第一条消息的情况；时间由主进程自己取，不信界面传来的。 */
  context?: { hasImages?: boolean };
  /**
   * 只在这个运行位置的来源里选(agentDeviceId null = 本机)：进行中的任务里选模式时用，任务换不了电脑。
   * 省略 = 不限(新任务)。
   */
  location?: { agentDeviceId: string | null };
  /**
   * 另一台电脑的本机选择器「其他电脑」那一段选了这台的模式：Agent 将在这台为那台运行，
   * 只能用这台开了「允许被远程调用」的来源(model-groups.md §3.1、§6.3)。其余来源按用不了处理。
   */
  remoteInvocableOnly?: boolean;
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
  // 运行位置截断后会指到别处：格式不对的整条丢弃，不悄悄变成本机。
  let agentDeviceId: string | undefined;
  if (value.agentDeviceId !== undefined && value.agentDeviceId !== null) {
    agentDeviceId = modelGroupAgentDeviceId(value.agentDeviceId) ?? undefined;
    if (!agentDeviceId) return null;
  }
  const weight = modelGroupWeight(value.weight);
  return {
    agentKind: kind, providerId, model,
    ...(agentDeviceId ? { agentDeviceId } : {}),
    ...(value.off === true ? { off: true } : {}),
    ...(weight !== 1 ? { weight } : {}),
  };
}

/** 权重：1–1000 的整数；没设、格式不对按 1，超出范围的收到边界。 */
export function modelGroupWeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(MODEL_GROUP_LIMITS.weight, Math.max(1, Math.round(value)));
}

/** 运行位置 id：非空、不超过与供应商 id 相同的长度上限；否则为 null。 */
export function modelGroupAgentDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && id.length <= MODEL_GROUP_LIMITS.field ? id : null;
}

/**
 * 候选的身份：引擎 + 供应商连接 + 模型，在另一台电脑或分享来的再加上运行位置——同一个模型在两台电脑上是两个来源。
 * 本机的键不带位置，与旧版存下的轮流位置和任务记录一致。
 */
export function modelGroupCandidateKey(
  value: Pick<ModelGroupCandidate, 'agentKind' | 'providerId' | 'model'> & { agentDeviceId?: string | null },
): string {
  const base = `${value.agentKind}\u0000${value.providerId}\u0000${value.model}`;
  return value.agentDeviceId ? `${base}\u0000${value.agentDeviceId}` : base;
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
  // 别的设备发来的配置里，真实选法在 pick(见 modelGroupsConfigForRemote)。
  const strategy = MODEL_GROUP_STRATEGIES.find((item) => item === value.pick)
    ?? MODEL_GROUP_STRATEGIES.find((item) => item === value.strategy) ?? 'expiring';
  const exceptions = (Array.isArray(value.exceptions) ? value.exceptions : [])
    .map(exception)
    .filter((item): item is ModelGroupException => !!item)
    .slice(0, MODEL_GROUP_LIMITS.exceptions);
  const effort = text(value.effort, MODEL_GROUP_LIMITS.effort);
  return { id, name, strategy, candidates, ...(exceptions.length > 0 ? { exceptions } : {}), ...(effort ? { effort } : {}) };
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
  const days = weekdays(when.days);
  return { when: { type: 'hours', from, to, ...(days ? { days } : {}) }, use: { type: 'route', routeId } };
}

/** 星期：去重排序；一天都没选或七天都选了等于每天，不存。 */
function weekdays(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days = [...new Set(value.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
  return days.length > 0 && days.length < 7 ? days : undefined;
}

/**
 * 本机时刻是否落在 [from, to) 内；from > to 时跨午夜。限定了星期时，跨午夜那一段的后半夜算开始那一天
 * (周五 23:00–08:00 包括周六凌晨，不包括周五凌晨)。localDay 与 Date#getDay 相同。
 */
export function modelGroupHoursMatch(when: { from: number; to: number; days?: readonly number[] }, localHour: number, localDay?: number): boolean {
  const afterMidnight = when.from > when.to && localHour < when.to;
  const inHours = when.from < when.to
    ? localHour >= when.from && localHour < when.to
    : localHour >= when.from || afterMidnight;
  if (!inHours || !when.days || when.days.length === 0 || localDay === undefined) return inHours;
  const startDay = afterMidnight ? (localDay + 6) % 7 : localDay;
  return when.days.includes(startDay);
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

function uniqueById<T extends { id: string }>(items: readonly T[], max: number): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && !!seen.add(item.id)).slice(0, max);
}

/**
 * 磁盘与 IPC 的同一道归一：坏条目丢弃，不让一条坏数据使整份配置读不出来。
 * 旧版的 modes(2026-11-11 并入路线)不读，下次保存时随之去掉。
 */
export function normalizeModelGroupsConfig(raw: unknown): ModelGroupsConfig {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const routes = uniqueById(
    (Array.isArray(value.routes) ? value.routes : []).map(normalizeModelGroupRoute).filter((item): item is ModelGroupRoute => !!item),
    MODEL_GROUP_LIMITS.routes,
  );
  const routeIds = new Set(routes.map((route) => route.id));
  return { routes: routes.map((route) => pruneExceptions(route, routeIds)) };
}

export function findModelGroupRoute(
  config: ModelGroupsConfig,
  selection: ModelGroupSelection | null | undefined,
): ModelGroupRoute | null {
  if (selection?.type !== 'route') return null;
  return config.routes.find((item) => item.id === selection.id) ?? null;
}

/** 草稿、任务记录与 IPC 里的选择；旧版的模式(type: 'mode')按没有选处理。 */
export function sanitizeModelGroupSelection(raw: unknown): ModelGroupSelection | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = text(value.id, MODEL_GROUP_LIMITS.id);
  if (!id || value.type !== 'route') return null;
  // 位置格式不对时整条作废：不能悄悄变成本机的同名模式。
  if (value.deviceId === undefined || value.deviceId === null) return { type: 'route', id };
  const deviceId = modelGroupAgentDeviceId(value.deviceId);
  return deviceId ? { type: 'route', id, deviceId } : null;
}

/** 发给模式所在那台电脑的选择：那边只认自己的模式，不带位置。 */
export function modelGroupSelectionForOwner(selection: ModelGroupSelection): ModelGroupSelection {
  return { type: 'route', id: selection.id };
}

const ROUTE_NOTE_LIMITS = { name: MODEL_GROUP_LIMITS.name, text: 512, effort: MODEL_GROUP_LIMITS.effort } as const;

/** 远程送来的说明按不可信数据收：只留说明卡认识的字段，限长；不对就整条不写。 */
export function sanitizeModelGroupRouteNote(raw: unknown): ModelGroupRouteNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const pluginName = text(value.pluginName, ROUTE_NOTE_LIMITS.name);
  const modelName = text(value.modelName, ROUTE_NOTE_LIMITS.text);
  if (!pluginName || !modelName || (value.outcome !== 'routed' && value.outcome !== 'kept')) return null;
  const effort = text(value.effort, ROUTE_NOTE_LIMITS.effort);
  const reason = text(value.reason, ROUTE_NOTE_LIMITS.text);
  return {
    pluginName,
    outcome: value.outcome,
    modelName,
    ...(effort ? { effort } : {}),
    ...(reason ? { reason } : {}),
    ...(value.outcome === 'kept' ? { why: 'unavailable-route' as const } : {}),
    source: 'model-group',
  };
}
