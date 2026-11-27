/**
 * 模型组：把模型供应商里已有的几个来源合成一个可选项（路线），可连同推理强度一起存。
 * 只决定新任务用哪个已连接的模型，不保存凭证，也不改变供应商、供应商组与账号池各自的规则。
 * 产品规则见 docs/product-rules/model-groups.md。
 */

import { pluginEngineKeyFromProviderId } from './pluginEngines.js';
import { ROUTE_STRATEGIES, type RouteStrategy } from './routeStrategy.js';

export const MODEL_GROUPS_IPC = {
  GET: 'model-groups:get',
  SET: 'model-groups:set',
  RESOLVE: 'model-groups:resolve',
  COMMIT: 'model-groups:commit',
  /** 记下这个任务是经哪条路线建的、用着哪个候选(任务中间持续托管与故障接替都据此判断)。 */
  BIND_SESSION: 'model-groups:bind-session',
  /** 解除任务的智能路由托管绑定(保留任务当前模型与来源，不再自动换源)。 */
  UNBIND_SESSION: 'model-groups:unbind-session',
  /** 读取任务当前的智能路由托管状态(用于桌面、远程控制与手机 UI 展示)。 */
  GET_SESSION_BINDING: 'model-groups:get-session-binding',
  /** 撞配额或来源不可用时同一条路线里还能接着用的下一个来源；没有为 null。 */
  SWITCH_OFFER: 'model-groups:switch-offer',
  /**
   * 手机或另一台电脑经这台电脑的模式建了任务后，请这台电脑在任务里写那一行说明(model-groups.md §6.3)。
   * 本机界面自己写库，不走这里；远程不能裸写消息，所以由这台电脑代写。
   */
  ROUTE_NOTE: 'model-groups:route-note',
} as const;

/**
 * 同账号本人控制的手机与电脑可以远程调用的模型组接口(model-groups.md §6.3)：读模式、按模式选来源、
 * 提交选路记录、读写/解除任务托管绑定、查撞配额换源提议、写说明。改模式(SET)只在本机。
 * 协议约定见 docs/dev-rules/protocol-compatibility/model-groups-remote-pickers.md。
 */
export const MODEL_GROUPS_REMOTE_CHANNELS = [
  MODEL_GROUPS_IPC.GET,
  MODEL_GROUPS_IPC.RESOLVE,
  MODEL_GROUPS_IPC.COMMIT,
  MODEL_GROUPS_IPC.BIND_SESSION,
  MODEL_GROUPS_IPC.UNBIND_SESSION,
  MODEL_GROUPS_IPC.GET_SESSION_BINDING,
  MODEL_GROUPS_IPC.SWITCH_OFFER,
  MODEL_GROUPS_IPC.ROUTE_NOTE,
] as const;

/** model-groups:get 的可选参数；旧主机忽略额外参数，旧控制端不传此参数。 */
export interface ModelGroupGetOptions {
  /** 新版手机与远程控制端显式声明：需要以独立 append-only 字段附带按供应商合并的路由及其展开。 */
  includeSourceRoutes?: boolean;
}

/** 任务当前的智能路由托管投影，供桌面、远程控制与手机展示当前托管状态与一键退出。 */
export interface ModelGroupSessionBindingView {
  selection: ModelGroupSelection;
  /** 路由显示名(合并供应商路由取父路由名，普通路由取路由名)。 */
  routeName: string;
  /** 若为按供应商合并的展开路由，给出父供应商路由 id，供选择器高亮 sroute:<parentId>。 */
  parentId?: string;
  /** 若为按供应商合并的展开路由，给出父供应商路由显示名。 */
  parentName?: string;
  /** 是否为按供应商合并的路由展开项。 */
  isSourceRoute?: boolean;
  /** 出问题时是否自动换来源。 */
  autoSwitch: boolean;
  /** 命中待生效的切换意图而非当前已落库行。 */
  pendingSwitch?: boolean;
}

/** 供应商提示缓存默认有效期：未知供应商统一按 5 分钟(model-groups.md §7.1)。 */
export const DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60_000;

/**
 * 估算当前供应商/模型的提示缓存有效期，用于持续托管在任务中间判断是否值得留在原来源保缓存。
 * 已知供应商按已公布的标准缓存窗口，其余统一按 5 分钟。
 */
export function promptCacheTtlMsForProvider(provider?: {
  type?: string | null;
  id?: string | null;
  model?: string | null;
}): number {
  const id = (provider?.id ?? '').toLowerCase();
  const type = (provider?.type ?? '').toLowerCase();
  const model = (provider?.model ?? '').toLowerCase();
  // Anthropic / Claude、OpenAI / Codex、Gemini 默认瞬态提示缓存均为 ~5 分钟窗口。
  if (type === 'anthropic' || id.includes('anthropic') || id.includes('claude') || model.includes('claude')) {
    return 5 * 60_000;
  }
  if (type === 'openai' || id.includes('openai') || id.includes('codex') || model.includes('gpt-')) {
    return 5 * 60_000;
  }
  if (type === 'google' || type === 'gemini' || id.includes('gemini') || model.includes('gemini')) {
    return 5 * 60_000;
  }
  return DEFAULT_PROMPT_CACHE_TTL_MS;
}

/** 选法只有一套(shared/routeStrategy.ts)，账号池与供应商组也用它。 */
export const MODEL_GROUP_STRATEGIES = ROUTE_STRATEGIES;
export type ModelGroupStrategy = RouteStrategy;

/**
 * 2026-11-23 之前的手机与电脑只认识前四种选法：旧手机会整条不列认不出的模式，旧电脑把它当成「快作废的先用」。
 * 发给别的设备时 strategy 换成最接近的旧选法，真实选法放在 pick 里；新版读 pick。选路始终在模式所在的那台电脑上做，
 * 旧设备只是标签不准，模式照样能选。
 */
const LEGACY_STRATEGY: Record<ModelGroupStrategy, 'expiring' | 'order' | 'rotate' | 'cheapest'> = {
  expiring: 'expiring', order: 'order', rotate: 'rotate', cheapest: 'cheapest',
  drain: 'order', headroom: 'expiring', weighted: 'rotate',
};

/** 远程传输用的模式配置：routes 永远只放用户按模型排的路由，合并供应商路由及其展开走独立 append-only 字段。 */
export interface ModelGroupsRemoteConfig extends ModelGroupsConfig {
  /** 按供应商合并的路由在每个模型上的展开项(独立于 routes，防止旧端把展开项当普通路由平铺或截断)。 */
  expandedRoutes?: ModelGroupRoute[];
}

function legacyStrategyRoute<T extends { strategy: ModelGroupStrategy }>(route: T): T {
  return LEGACY_STRATEGY[route.strategy] === route.strategy
    ? route
    : { ...route, strategy: LEGACY_STRATEGY[route.strategy], pick: route.strategy };
}

/**
 * 发给手机与另一台电脑的模式配置(model-groups:get 与伙伴设置里的模型组)：见 LEGACY_STRATEGY。
 * `routes` 始终保持纯净(不含 hidden 与 parent 展开项)，确保旧手机与旧桌面零回归；
 * 仅当调用方显式传 `includeSourceRoutes: true` 时，通过独立 append-only 字段下发 `sourceRoutes` 与 `expandedRoutes`。
 */
export function modelGroupsConfigForRemote(
  config: ModelGroupsConfig,
  options?: ModelGroupGetOptions,
): ModelGroupsRemoteConfig {
  const routes = config.routes
    .filter((route) => !route.hidden && !route.parent)
    .map(legacyStrategyRoute);
  if (!options?.includeSourceRoutes) return { routes };
  const sourceRoutes = (config.sourceRoutes ?? [])
    .filter((route) => !route.hidden)
    .map(legacyStrategyRoute);
  const expandedRoutes = config.routes
    .filter((route) => !route.hidden && !!route.parent)
    .map(legacyStrategyRoute);
  return {
    routes,
    ...(sourceRoutes.length > 0 ? { sourceRoutes } : {}),
    ...(expandedRoutes.length > 0 ? { expandedRoutes } : {}),
  };
}

/** 从另一台电脑收到的模式配置：将独立字段 `expandedRoutes` 安全合回 `routes` 供统一面板消费。 */
export function modelGroupsConfigFromRemote(raw: unknown): ModelGroupsConfig {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const baseRoutes = Array.isArray(value.routes) ? value.routes : [];
  const expandedRoutes = Array.isArray(value.expandedRoutes) ? value.expandedRoutes : [];
  if (expandedRoutes.length === 0) return normalizeModelGroupsConfig(raw);
  return normalizeModelGroupsConfig({
    ...value,
    routes: [...baseRoutes, ...expandedRoutes],
  });
}

/**
 * 选路结果里的原因同理：旧版不认识新原因，会把文案键原样写进任务。发给别的设备时 why 换成最接近的旧原因，
 * 真实原因放在 pickWhy；新版先读 pickWhy(modelGroupResolveResultFromRemote)。
 */
const LEGACY_WHY: Partial<Record<ModelGroupTraceWhy, ModelGroupTraceWhy>> = {
  drain: 'order', drainNext: 'order', headroom: 'expiring', weighted: 'rotate',
};

type WithPickWhy<T> = T & { pickWhy?: ModelGroupTraceWhy };

function legacyWhy<T extends { why: ModelGroupTraceWhy }>(entry: T): WithPickWhy<T> {
  const legacy = LEGACY_WHY[entry.why];
  return legacy ? { ...entry, why: legacy, pickWhy: entry.why } : entry;
}

function realWhy<T extends { why: ModelGroupTraceWhy }>(entry: WithPickWhy<T>): T {
  const { pickWhy, ...rest } = entry;
  const known = typeof pickWhy === 'string' && (Object.keys(LEGACY_WHY) as string[]).includes(pickWhy);
  return (known ? { ...rest, why: pickWhy } : rest) as unknown as T;
}

/** 发给手机与另一台电脑的选路结果(model-groups:resolve 经 device-link)。 */
export function modelGroupResolveResultForRemote(result: ModelGroupResolveResult): ModelGroupResolveResult {
  const trace = result.trace.map(legacyWhy);
  return result.outcome === 'routed' ? { ...legacyWhy(result), trace } : { ...result, trace };
}

/** 从另一台电脑收到的选路结果：有 pickWhy 时换回真实原因。 */
export function modelGroupResolveResultFromRemote(result: ModelGroupResolveResult): ModelGroupResolveResult {
  const trace = (result.trace ?? []).map((entry) => realWhy(entry as WithPickWhy<ModelGroupTraceEntry>));
  return result.outcome === 'routed'
    ? { ...realWhy(result as WithPickWhy<typeof result>), trace }
    : { ...result, trace };
}

export type ModelGroupAgentKind = 'cc' | 'codex' | 'pi' | 'acp';

export function isModelGroupAgentKind(value: unknown): value is ModelGroupAgentKind {
  return value === 'cc' || value === 'codex' || value === 'pi' || value === 'acp';
}

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
  /**
   * 「出问题时自动换来源」(model-groups.md §4.5)：默认开，只在用户关掉这个模式的开关时存 false。
   * 关掉后用这个模式的任务出问题不自动换，只在横幅里提议。
   */
  autoSwitch?: false;
  /**
   * 这条路由是某条供应商路由在一个模型上的展开(见 ModelGroupSourceRoute)：由这台电脑按目录生成，不存盘。
   * 界面把它列在那条供应商路由下面，不当作单独的一条路由。
   */
  parent?: { id: string; name: string };
  /** 所属的供应商路由被用户隐藏了：选择器不列，设置页里能找回。 */
  hidden?: true;
}

/** 供应商路由的成员：一整个供应商(它提供的全部模型)，不指定模型。 */
export interface ModelGroupSource {
  providerId: string;
  /** 运行位置：另一台电脑的设备 id，或分享来的供应商(`share:<id>`)。省略 = 本机。与 ModelGroupCandidate 同义。 */
  agentDeviceId?: string;
  /** 用户暂时不让这条路由用它；保留在列表里。 */
  off?: boolean;
  /** 「按权重」时的权重，1–1000；不设为 1。 */
  weight?: number;
}

/**
 * 供应商路由(2026-11-24 用户裁决)：把几个供应商合成一条路由，用起来像一个合并后的供应商——照常选模型，
 * 由路由按选法决定这次用哪个供应商。它在每个模型上展开成一条普通路由(routes 里带 parent 的那些)，
 * 选路、任务里的说明、撞配额换来源都走普通路由已有的那一套，不另写。
 * auto = 同一家的几个供应商自动合成的：成员跟着连接增减，不存盘，只能改选法或隐藏。
 */
export interface ModelGroupSourceRoute {
  id: string;
  name: string;
  strategy: ModelGroupStrategy;
  sources: ModelGroupSource[];
  effort?: string;
  /** 「出问题时自动换来源」(model-groups.md §4.5)，与普通路由同一个开关：默认开，只在关掉时存 false；展开出来的每条路由沿用它。 */
  autoSwitch?: false;
  /** 例外(时段改走、带图只用能看图的来源)，与普通路由同一种；展开出来的每条路由沿用它。 */
  exceptions?: ModelGroupException[];
  auto?: true;
  hidden?: true;
}

/** 2026-11-11 起只有路线；旧版存下的 modes 读取时忽略。 */
export interface ModelGroupsConfig {
  /** 读取时：用户排的路由在前，供应商路由展开出来的(带 parent)在后。保存时只存用户排的。 */
  routes: ModelGroupRoute[];
  /** 读取时：用户建的供应商路由在前，自动合成的(auto)在后。保存时只存用户建的。 */
  sourceRoutes?: ModelGroupSourceRoute[];
  /** 用户隐藏的自动供应商路由 id。 */
  hiddenAuto?: string[];
  /** 用户给自动供应商路由改的选法；没改过的按默认「快作废的先用」。 */
  autoStrategy?: Record<string, ModelGroupStrategy>;
  /** 用户关掉了「出问题时自动换来源」的自动供应商路由 id。 */
  autoSwitchOff?: string[];
  /**
   * 用户给自动供应商路由的成员排的先后、填的权重、暂停了哪个：键是路由 id，值是按用户排的顺序列出的成员。
   * 成员本身仍跟着供应商的连接增减：这里没列到的新成员排在后面，已经不在的留着(重新连上时回到原来的位置)。
   */
  autoSources?: Record<string, ModelGroupSource[]>;
  /** 用户给自动供应商路由加的例外：键是路由 id。 */
  autoExceptions?: Record<string, ModelGroupException[]>;
}

/** 用了这个模式的任务出问题时是否自动换来源(默认开)。 */
export function modelGroupAutoSwitchOn(route: Pick<ModelGroupRoute, 'autoSwitch'>): boolean {
  return route.autoSwitch !== false;
}

/** 任务记下的模式此刻是否自动换来源；模式已删除时为 false(不再接替)。 */
export function modelGroupAutoSwitchFor(config: ModelGroupsConfig, selection: ModelGroupSelection | null | undefined): boolean {
  const route = findModelGroupRoute(config, selection);
  return !!route && modelGroupAutoSwitchOn(route);
}

/** 自动供应商路由的 id 前缀(后面是那一家的标识)，以及展开出来的路由的 id 前缀。用户建的都不用这两个前缀。 */
export const MODEL_GROUP_AUTO_PREFIX = 'auto:';
export const MODEL_GROUP_EXPANDED_PREFIX = 'src:';
export const isAutoModelGroupId = (id: string): boolean => id.startsWith(MODEL_GROUP_AUTO_PREFIX);
export const isExpandedModelGroupId = (id: string): boolean => id.startsWith(MODEL_GROUP_EXPANDED_PREFIX);

export const MODEL_GROUPS_DEFAULTS: ModelGroupsConfig = { routes: [] };

/** 供应商路由最多展开出这么多条(每条供应商路由的每个模型一条)，以及最多记这么多条隐藏。 */
export const MODEL_GROUP_EXPANDED_LIMIT = 512;
export const MODEL_GROUP_HIDDEN_AUTO_LIMIT = 128;

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
  /** 用户要的 Fast，且选中的来源支持；否则省略。 */
  fastMode?: true | 'ultrafast';
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

/** 撞配额或来源不可用时「换到下一个来源继续」的提议(model-groups.md §6.1)；支持跨本地、分享与远程位置。 */
export interface ModelGroupSwitchOffer {
  groupName: string;
  /** 换过去之后记回去时用：任务仍属于同一个组。 */
  selection: ModelGroupSelection;
  agentKind: ModelGroupAgentKind;
  providerId: string;
  model: string;
  /** 目标运行位置：另一台电脑或分享来的供应商(`share:<id>`)；本机省略。 */
  agentDeviceId?: string;
  /** 路由指定的推理强度(若目标模型支持)。 */
  effort?: string;
  /** 目标模型的 Fast 档位(若支持)。 */
  fastMode?: boolean | 'ultrafast';
  modelName: string;
  sourceName: string;
  /** 换到另一个引擎：要走选择器的跨引擎切换(含它的确认)。 */
  crossEngine: boolean;
  /** 换到另一个运行位置(本机 ↔ 分享 / 另一台电脑)：走统一交接流程。 */
  crossLocation?: boolean;
}

export interface ModelGroupResolveRequest {
  selection: ModelGroupSelection;
  /** 只看会选谁：不推进「轮流」的顺序。 */
  dryRun?: boolean;
  /**
   * 只用手头已有的额度读数，不等一份新的：给界面显示余量用(设置里的关系图)，打开就要有数。
   * 真正给任务选来源时不传——那时宁可等一下(有上限)也要按新读数选。旧版本不认识这个字段，照常等。
   */
  cachedQuota?: boolean;
  /**
   * 本轮消息的情况；时间由主进程自己取，不信界面传来的。
   * effort / fastMode = 用户在选择器里给这个模型选的思考深度与 Fast：只对供应商路由展开出来的路由生效
   * (它们在选择器里就是普通模型行，这两项用户照常能调)，选中的来源不支持时不带。
   */
  context?: { hasImages?: boolean; effort?: string; fastMode?: true | 'ultrafast' };
  /**
   * 只在这个运行位置的来源里选(agentDeviceId null = 本机)。省略 = 不限(含跨本地、分享与远程位置)。
   */
  location?: { agentDeviceId: string | null };
  /**
   * 另一台电脑的本机选择器「其他电脑」那一段选了这台的模式：Agent 将在这台为那台运行，
   * 只能用这台开了「允许被远程调用」的来源(model-groups.md §3.1、§6.3)。其余来源按用不了处理。
   */
  remoteInvocableOnly?: boolean;
  /**
   * SSH 远程主机 id：存在时强制按 SSH 可用边界过滤候选(仅限本机直传源与该 SSH 主机原生 Codex，
   * 禁止跨 agentDeviceId、禁止订阅直连与本机桥接源)。
   */
  sshHostId?: string;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function agentKind(value: unknown): ModelGroupAgentKind | null {
  return isModelGroupAgentKind(value) ? value : null;
}

function candidate(raw: unknown): ModelGroupCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const kind = agentKind(value.agentKind);
  const providerId = text(value.providerId, MODEL_GROUP_LIMITS.field);
  const model = text(value.model, MODEL_GROUP_LIMITS.field);
  if (!kind || !providerId || !model) return null;
  // 插件执行引擎(acp)必须配有效的 acp-plugin: 来源标识(acp-plugin-harness.md §2.2)。
  if (kind === 'acp' && !pluginEngineKeyFromProviderId(providerId)) return null;
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
  // 展开出来的路由只凭 id 前缀认：用户排的路由 id 不带这个前缀，带了 parent 也不算。
  const parentRaw = isExpandedModelGroupId(id) && value.parent && typeof value.parent === 'object' ? value.parent as Record<string, unknown> : null;
  const parent = parentRaw ? { id: text(parentRaw.id, MODEL_GROUP_LIMITS.id), name: text(parentRaw.name, MODEL_GROUP_LIMITS.name) } : null;
  return {
    id, name, strategy, candidates, ...(exceptions.length > 0 ? { exceptions } : {}), ...(effort ? { effort } : {}),
    ...(value.autoSwitch === false ? { autoSwitch: false as const } : {}),
    ...(parent?.id && parent.name ? { parent } : {}),
    ...(parent?.id && value.hidden === true ? { hidden: true as const } : {}),
  };
}

/** 供应商路由的成员在配置里的身份：运行位置 + 供应商连接。 */
export function modelGroupSourceKey(source: Pick<ModelGroupSource, 'providerId' | 'agentDeviceId'>): string {
  return `${source.agentDeviceId ?? ''}\u0000${source.providerId}`;
}

function normalizeSources(raw: unknown): ModelGroupSource[] {
  const seen = new Set<string>();
  return (Array.isArray(raw) ? raw : []).flatMap((item): ModelGroupSource[] => {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    const providerId = entry ? text(entry.providerId, MODEL_GROUP_LIMITS.field) : '';
    // 运行位置格式不对的整条丢弃，不悄悄变成本机。
    const location = entry && entry.agentDeviceId !== undefined && entry.agentDeviceId !== null
      ? modelGroupAgentDeviceId(entry.agentDeviceId) : undefined;
    const key = `${location ?? ''}\u0000${providerId}`;
    if (!entry || !providerId || location === null || seen.has(key)) return [];
    seen.add(key);
    const weight = modelGroupWeight(entry.weight);
    return [{
      providerId, ...(location ? { agentDeviceId: location } : {}),
      ...(entry.off === true ? { off: true } : {}), ...(weight !== 1 ? { weight } : {}),
    }];
  }).slice(0, MODEL_GROUP_LIMITS.candidates);
}

function normalizeExceptions(raw: unknown): ModelGroupException[] {
  return (Array.isArray(raw) ? raw : []).map(exception)
    .filter((item): item is ModelGroupException => !!item)
    .slice(0, MODEL_GROUP_LIMITS.exceptions);
}

function normalizeSourceRoute(raw: unknown): ModelGroupSourceRoute | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = text(value.id, MODEL_GROUP_LIMITS.id);
  const name = text(value.name, MODEL_GROUP_LIMITS.name);
  if (!id || !name || isExpandedModelGroupId(id)) return null;
  const sources = normalizeSources(value.sources);
  const strategy = MODEL_GROUP_STRATEGIES.find((item) => item === value.pick)
    ?? MODEL_GROUP_STRATEGIES.find((item) => item === value.strategy) ?? 'expiring';
  const effort = text(value.effort, MODEL_GROUP_LIMITS.effort);
  const auto = isAutoModelGroupId(id);
  const exceptions = normalizeExceptions(value.exceptions);
  return {
    id, name, strategy, sources, ...(effort ? { effort } : {}),
    ...(value.autoSwitch === false ? { autoSwitch: false as const } : {}),
    ...(exceptions.length > 0 ? { exceptions } : {}),
    ...(auto ? { auto: true as const } : {}),
    ...(auto && value.hidden === true ? { hidden: true as const } : {}),
  };
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
function pruneExceptionList(list: readonly ModelGroupException[], selfId: string, routeIds: ReadonlySet<string>): ModelGroupException[] {
  let image = false;
  return list.filter((item) => {
    if (item.when.type === 'image') return !image && (image = true);
    return item.use !== 'vision' && item.use.routeId !== selfId && routeIds.has(item.use.routeId);
  });
}

function pruneExceptions<T extends { id: string; exceptions?: ModelGroupException[] }>(route: T, routeIds: ReadonlySet<string>): T {
  if (!route.exceptions) return route;
  const exceptions = pruneExceptionList(route.exceptions, route.id, routeIds);
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
  const all = (Array.isArray(value.routes) ? value.routes : []).map(normalizeModelGroupRoute).filter((item): item is ModelGroupRoute => !!item);
  // 展开出来的路由不存盘，数量由生成方封顶；用户排的路由仍按上限截断。
  const routes = [
    ...uniqueById(all.filter((route) => !route.parent), MODEL_GROUP_LIMITS.routes),
    ...uniqueById(all.filter((route) => route.parent), MODEL_GROUP_EXPANDED_LIMIT),
  ];
  const routeIds = new Set(routes.map((route) => route.id));
  const sourceRoutes = uniqueById(
    (Array.isArray(value.sourceRoutes) ? value.sourceRoutes : []).map(normalizeSourceRoute).filter((item): item is ModelGroupSourceRoute => !!item),
    MODEL_GROUP_LIMITS.routes * 2,
  );
  const hiddenAuto = [...new Set((Array.isArray(value.hiddenAuto) ? value.hiddenAuto : [])
    .map((id) => text(id, MODEL_GROUP_LIMITS.id)).filter(isAutoModelGroupId))].slice(0, MODEL_GROUP_HIDDEN_AUTO_LIMIT);
  const autoStrategy = Object.fromEntries(Object.entries(value.autoStrategy && typeof value.autoStrategy === 'object' ? value.autoStrategy : {})
    .filter(([id, strategy]) => isAutoModelGroupId(id) && id.length <= MODEL_GROUP_LIMITS.id && MODEL_GROUP_STRATEGIES.includes(strategy as ModelGroupStrategy))
    .slice(0, MODEL_GROUP_HIDDEN_AUTO_LIMIT)) as Record<string, ModelGroupStrategy>;
  const autoSwitchOff = [...new Set((Array.isArray(value.autoSwitchOff) ? value.autoSwitchOff : [])
    .map((id) => text(id, MODEL_GROUP_LIMITS.id)).filter(isAutoModelGroupId))].slice(0, MODEL_GROUP_HIDDEN_AUTO_LIMIT);
  const autoSources = Object.fromEntries(Object.entries(value.autoSources && typeof value.autoSources === 'object' ? value.autoSources : {})
    .filter(([id]) => isAutoModelGroupId(id) && id.length <= MODEL_GROUP_LIMITS.id)
    .map(([id, sources]) => [id, normalizeSources(sources)] as const)
    .filter(([, sources]) => sources.length > 0)
    .slice(0, MODEL_GROUP_HIDDEN_AUTO_LIMIT)) as Record<string, ModelGroupSource[]>;
  // 时段例外只能改走用户排的路由(展开出来的不存盘，没有稳定的目标)；目标删了一并去掉。
  const autoExceptions = Object.fromEntries(Object.entries(value.autoExceptions && typeof value.autoExceptions === 'object' ? value.autoExceptions : {})
    .filter(([id]) => isAutoModelGroupId(id) && id.length <= MODEL_GROUP_LIMITS.id)
    .map(([id, list]) => [id, pruneExceptionList(normalizeExceptions(list), id, routeIds)] as const)
    .filter(([, list]) => list.length > 0)
    .slice(0, MODEL_GROUP_HIDDEN_AUTO_LIMIT)) as Record<string, ModelGroupException[]>;
  return {
    routes: routes.map((route) => pruneExceptions(route, routeIds)),
    ...(sourceRoutes.length > 0 ? { sourceRoutes: sourceRoutes.map((route) => pruneExceptions(route, routeIds)) } : {}),
    ...(hiddenAuto.length > 0 ? { hiddenAuto } : {}),
    ...(autoSwitchOff.length > 0 ? { autoSwitchOff } : {}),
    ...(Object.keys(autoStrategy).length > 0 ? { autoStrategy } : {}),
    ...(Object.keys(autoSources).length > 0 ? { autoSources } : {}),
    ...(Object.keys(autoExceptions).length > 0 ? { autoExceptions } : {}),
  };
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
