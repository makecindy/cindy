/**
 * 把选中的路线解析成一个现在能用的具体模型。事实全部来自已有来源：供应商目录决定能不能选，
 * 额度总览给出订阅窗口；这里不发模型请求、不读凭证。读不到额度的来源按未知处理，不当作没用过。
 * 在另一台电脑或分享来的来源按它自己那个位置的目录判断(与插件卡片里的远程模型同一判断)，
 * 读位置与远程目录有时限，读不到就算这个来源不可用；路线里没有这种来源时不读。
 */
import { randomUUID } from 'node:crypto';
import { isByokProviderId, type AgentKind, type CatalogModel, type ProviderView } from '@cindy/model-providers';

import { claudeModelFamily, scopedWindowBelongsToFamily } from '@cindy/maker-shared/subscription-usage';
import { modelImageInputDefault } from '../../shared/modelImageInputOverride.js';
import { getModelPriceQuote } from '../../shared/modelPriceQuote.js';
import { USD_TO_CNY_FIXED_RATE, type ModelPricingCatalog } from '../../shared/regionalMoney.js';
import {
  modelGroupCandidateKey,
  modelGroupWeight,
  type ModelGroupAppliedException,
  type ModelGroupCandidate,
  type ModelGroupResolveRequest,
  type ModelGroupResolveResult,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupTraceQuota,
} from '../../shared/modelGroups.js';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  isPluginEngineEffort,
  isPluginEngineOfferedRemotely,
  pluginEngineKeyFromProviderId,
  type PluginEngineView,
} from '../../shared/pluginEngines.js';
import { GHOST_REMOTE_AGENT_MODELS } from '../cindy-brain/ghostAgentModels.js';
import { isGhostCardModelRouteAvailable, isPluginModelPickerRouteAvailable } from '../cindy-brain/ghostModelPicker.js';
import { applyRouteWeightStep, type RouteWeightStep } from '../provider-group/scheduler.js';
import {
  pickModelGroupCandidate,
  type ModelGroupCandidateFacts,
  type ModelGroupInnerQuota,
} from './pick.js';
import { modelGroupRouteFor } from './routeFor.js';

export interface ModelGroupResolverDeps {
  config(): ModelGroupsConfig;
  /** 本机供应商目录的快照(不触发发现或登录)。 */
  views(): Promise<ProviderView[]>;
  /** 本机插件引擎列表(不触发刷新)。 */
  pluginEngines?(): readonly PluginEngineView[];
  /** 另一台电脑或分享位置允许远程调用的插件引擎列表。 */
  remotePluginEngines?(agentDeviceId: string): Promise<readonly PluginEngineView[]>;
  /**
   * 这台电脑的连接是否开了「允许被远程调用」。主进程的供应商列表不带这个开关(它在下发界面时才合进去)，
   * 由调用方注入；不注入时看列表自带的字段。
   */
  remoteInvocable?(providerId: string): boolean;
  /** 本机可用的引擎。 */
  agents(): readonly string[];
  /**
   * 引擎是否就绪：本机看本机安装；传了 agentDeviceId 时看那台电脑(与插件选路同一判断，读不到时按就绪)。
   * 目录里列着模型不代表那台装了对应引擎。
   */
  harnessInstalled(agent: string, agentDeviceId?: string): Promise<boolean>;
  /**
   * 各订阅来源当前的额度窗口，键是 modelGroupQuotaKey：本机的按供应商连接 ID，别的电脑上的再加那台的设备 id。
   * 本机连接的额度不会拿去给别的电脑上同 ID 的连接用。
   */
  quotaWindows(options?: { cached?: boolean }): Promise<ReadonlyMap<string, readonly (ModelGroupTraceQuota & { scopedTo?: string | null })[]>>;
  /**
   * 本机来源背后是电脑组或几个账号时，内层按它自己的选法下一个会接任务的那一个的额度事实(pick.ts 的
   * ModelGroupInnerQuota)；不是这种来源、读不到时为 null。别的电脑与分享来的来源不问(只用对方开放的额度)。
   */
  innerQuota?(source: { providerId: string; model: string; agentKind: ModelGroupCandidate['agentKind'] }): Promise<ModelGroupInnerQuota | null>;
  /**
   * 其他电脑与分享来的位置里此刻能选的那些(插件卡片的远程模型用的同一份名单)。只在路线里有不在本机的来源时读；
   * 没提供时这些来源一律不可用。
   */
  locations?(): Promise<{ locations: readonly { agentDeviceId: string }[] }>;
  /**
   * 那个位置允许远程调用的供应商目录(只读，不触发发现或登录)。stale = 这次没读到、给的是上次留下的目录：
   * 不能据此判断现在能用，按读不到处理。
   */
  remoteViews?(agentDeviceId: string): Promise<{ views: ProviderView[]; stale: boolean }>;
  /** 读位置与远程目录最多等这么久；等不到按这些来源不可用。默认 MODEL_GROUP_REMOTE_WAIT_MS。 */
  remoteWaitMs?: number;
  /** 账号范围：换账号后不沿用上一个账号的轮流位置。 */
  scope(): string;
  recordDecision?(selection: ModelGroupResolveRequest['selection'], result: ModelGroupResolveResult): void;
  now(): number;
  /**
   * 「最省钱」用的报价目录，与模型选择器显示价格同一来源：Cindy AI(xd)取网关报价，其余取参考价
   * (注册表、连接自带价、用户自定价)。只在路线选法是 cheapest 时读取；没提供时一律按没有标价。
   */
  pricing?(): Promise<{ gateway: ModelPricingCatalog | null; reference: ModelPricingCatalog | null }>;
}

const builtinAgentOf = (kind: Exclude<ModelGroupCandidate['agentKind'], 'acp'>): AgentKind =>
  (kind === 'cc' ? 'claude-code' : kind);

/** 与新任务等额度的上限一致：读不到别处的目录不让新任务多等。 */
export const MODEL_GROUP_REMOTE_WAIT_MS = 2_000;

/** 额度窗口的键：本机按供应商连接 ID；别的电脑上的连接再加那台的设备 id，两者不会混用。 */
export function modelGroupQuotaKey(agentDeviceId: string | null | undefined, providerId: string): string {
  return agentDeviceId ? `${agentDeviceId}\u0000${providerId}` : providerId;
}

/** 超时按失败处理；计时器在结果出来后清掉。 */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('model group remote read timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const remoteHarnessKey = (agentDeviceId: string, agent: AgentKind) => `${agentDeviceId}\u0000${agent}`;

/** 一个候选所在位置的目录：本机目录与本机可用的引擎，或那个位置允许远程调用的目录。 */
interface Catalog { views: ProviderView[]; agents: readonly string[] }

type Pricing = Awaited<ReturnType<NonNullable<ModelGroupResolverDeps['pricing']>>>;

const validPrice = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * 这个来源下这个模型的标价：每百万输出 token 的美元价。订阅来源的「价值估算」不是要付的钱，按没有标价；
 * Cindy AI 与企业 BYOK 的目录 cost 是折后的实际售价，有报价时以它为准(选择器同样如此)。
 */
function listedPrice(view: ProviderView | undefined, agent: AgentKind, model: CatalogModel | undefined, pricing: Pricing | null): number | null {
  if (!view || !model || !pricing || view.access?.kind === 'subscription') return null;
  const quote = getModelPriceQuote(view.id === 'xd' ? pricing.gateway : pricing.reference, view.id, model.id, agent);
  if (!quote || quote.source === 'subscription-reference') return null;
  const effective = (view.id === 'xd' || isByokProviderId(view.id)) && validPrice(model.cost?.output) ? model.cost.output : quote.outputPerMtok;
  if (!validPrice(effective)) return null;
  return quote.currency === 'CNY' ? effective / USD_TO_CNY_FIXED_RATE : effective;
}

/**
 * 别的电脑上或分享来的来源的标价：只看那个位置目录里这个模型自带的价格(人民币按固定汇率折算)，不借本机同 ID 连接的
 * 参考价或自定价；订阅、没有价格时按没有标价。
 */
function remoteListedPrice(view: ProviderView | undefined, model: CatalogModel | undefined): number | null {
  if (!view || !model || view.access?.kind === 'subscription') return null;
  const output = model.cost?.output;
  if (!validPrice(output)) return null;
  return model.currency === 'CNY' ? output / USD_TO_CNY_FIXED_RATE : output;
}

/**
 * 只对某个模型生效的配额窗口是否管这个候选。与用量 chip 同一口径(scopedWindowBelongsToFamily)：
 * 按模型 id 归家族，不看用户改过的显示名；额度总览这一层只留了窗口的显示名，所以窗口一侧按显示名归类。
 * 认不出家族的模型退回按名字包含判断。
 */
function scopedWindowApplies(scopedTo: string, modelId: string, modelName: string): boolean {
  const family = claudeModelFamily(modelId) ?? claudeModelFamily(modelName);
  if (family) return scopedWindowBelongsToFamily({ modelId: null, modelDisplayName: scopedTo } as Parameters<typeof scopedWindowBelongsToFamily>[0], family);
  return modelName.toLowerCase().includes(scopedTo.toLowerCase());
}

/** 「按权重」计数对应的那份权重：来源或权重变了，旧计数按新比例算不对，从头开始。 */
function weightSignature(route: ModelGroupRoute): string {
  return route.candidates.map((candidate) => `${modelGroupCandidateKey(candidate)}=${modelGroupWeight(candidate.weight)}`).join('\u0001');
}

export function createModelGroupResolver(deps: ModelGroupResolverDeps) {
  /** 「轮流」「用完再换」上一次选中的候选；只在内存里，重启后从第一个开始。 */
  const lastPicked = new Map<string, string>();
  /** 「按权重」每条路线的计数与当时的权重；只在内存里，重启或改了来源、权重后重新开始。 */
  const weightCounters = new Map<string, { signature: string; counters: ReadonlyMap<string, number> }>();
  const countersFor = (key: string, signature: string) => {
    const stored = weightCounters.get(key);
    return stored?.signature === signature ? stored.counters : undefined;
  };
  const pending = new Map<string, {
    scope: string; at: number; selection: ModelGroupResolveRequest['selection']; result: ModelGroupResolveResult; routeId?: string;
    weightStep?: { step: RouteWeightStep; signature: string };
  }>();

  function prepare(
    request: ModelGroupResolveRequest, scope: string, result: ModelGroupResolveResult, routeId?: string,
    weightStep?: { step: RouteWeightStep; signature: string },
  ): ModelGroupResolveResult {
    if (request.dryRun || scope !== deps.scope()) return result;
    // 未采用的结果不写盘；限制暂存数量和生命周期，避免取消操作不断积累。
    for (const [id, item] of pending) {
      if (item.scope !== scope || deps.now() - item.at > 60 * 60_000) pending.delete(id);
    }
    while (pending.size >= 128) pending.delete(pending.keys().next().value!);
    const decisionId = randomUUID();
    pending.set(decisionId, {
      scope, at: deps.now(), selection: { ...request.selection }, result, routeId,
      ...(weightStep ? { weightStep } : {}),
    });
    return { ...result, decisionId };
  }

  function commit(decisionId: string): boolean {
    const item = pending.get(decisionId);
    pending.delete(decisionId);
    if (!item || item.scope !== deps.scope() || deps.now() - item.at > 60 * 60_000) return false;
    deps.recordDecision?.(item.selection, item.result);
    if (item.result.outcome === 'routed' && item.routeId) {
      lastPicked.set(`${item.scope}\u0000${item.routeId}`, modelGroupCandidateKey(item.result.route));
      const key = `${item.scope}\u0000${item.routeId}`;
      // 选路之后改了来源或权重：这一步是按旧比例算的，不记，按新配置从头开始。
      const routeNow = item.weightStep && deps.config().routes.find((route) => route.id === item.routeId);
      if (item.weightStep && routeNow && weightSignature(routeNow) === item.weightStep.signature) {
        const { signature, step } = item.weightStep;
        weightCounters.set(key, { signature, counters: applyRouteWeightStep(countersFor(key, signature), step) });
      }
    }
    return true;
  }

  /**
   * 路线里不在本机的来源要用的位置名单与各位置目录：同时开始读，各自有时限，读不到为 null。
   * 路线里没有这种来源(或都已停用)时不读。
   */
  function remoteReads(route: ModelGroupRoute) {
    const builtinIds = [...new Set(route.candidates.flatMap((candidate) =>
      (candidate.agentDeviceId && !candidate.off && candidate.agentKind !== 'acp' ? [candidate.agentDeviceId] : [])))];
    const pluginIds = [...new Set(route.candidates.flatMap((candidate) =>
      (candidate.agentDeviceId && !candidate.off && candidate.agentKind === 'acp' ? [candidate.agentDeviceId] : [])))];
    if (builtinIds.length === 0 && pluginIds.length === 0) return null;
    const wait = deps.remoteWaitMs ?? MODEL_GROUP_REMOTE_WAIT_MS;
    const read = <T>(start: (() => Promise<T>) | null): Promise<T | null> =>
      (start ? within(Promise.resolve().then(start), wait).catch(() => null) : Promise.resolve(null));
    const { locations, remoteViews, remotePluginEngines } = deps;
    // 别的位置上的引擎看那台自己的状态，不看本机装没装；与目录同时读、同一时限，读不到按就绪(那台执行时还会再拦)。
    const harness = new Map<string, Promise<boolean>>();
    for (const candidate of route.candidates) {
      if (!candidate.agentDeviceId || candidate.off || candidate.agentKind === 'acp') continue;
      const agent = builtinAgentOf(candidate.agentKind);
      const key = remoteHarnessKey(candidate.agentDeviceId, agent);
      const agentDeviceId = candidate.agentDeviceId;
      if (!harness.has(key)) {
        harness.set(key, within(Promise.resolve().then(() => deps.harnessInstalled(agent, agentDeviceId)), wait).catch(() => true));
      }
    }
    return {
      harness,
      locations: read(locations ? () => locations() : null),
      views: new Map(builtinIds.map((id) => [id, read(remoteViews
        ? () => remoteViews(id).then((catalog) => (catalog.stale ? null : catalog.views))
        : null)] as const)),
      pluginEngines: new Map(pluginIds.map((id) => [id, read(remotePluginEngines
        ? () => remotePluginEngines(id)
        : null)] as const)),
    };
  }

  async function inspect(
    route: ModelGroupRoute,
    views: ProviderView[],
    context?: ModelGroupResolveRequest['context'],
    cachedQuota = false,
    remoteInvocableOnly = false,
  ): Promise<ModelGroupCandidateFacts[]> {
    const agents = deps.agents();
    // 供应商路由展开出来的路由在选择器里是普通模型行：思考深度与 Fast 用用户在那里选的；路由自己设了思考深度时以它为准。
    const wantedEffort = route.effort ?? (route.parent ? context?.effort : undefined);
    const wantedFast = route.parent ? context?.fastMode : undefined;
    // 远程读取与读额度同时进行，整体仍在额度等待的时限内。
    const remote = remoteReads(route);
    // cachedQuota(只为显示)：用手头的读数，不等一份新的。
    const quota = await deps.quotaWindows(cachedQuota ? { cached: true } : undefined).catch(() => new Map<string, never[]>());
    const pricing = route.strategy === 'cheapest' && deps.pricing ? await deps.pricing().catch(() => null) : null;
    const installed = new Map<string, boolean>();
    for (const candidate of route.candidates) {
      if (candidate.agentKind === 'acp') continue;
      const agent = builtinAgentOf(candidate.agentKind);
      if (!candidate.agentDeviceId && !installed.has(agent)) installed.set(agent, await deps.harnessInstalled(agent));
    }
    const localPluginEngines = route.candidates.some((c) => c.agentKind === 'acp' && !c.agentDeviceId)
      ? (deps.pluginEngines?.() ?? [])
      : [];
    const locations = remote ? await remote.locations : null;
    return Promise.all(route.candidates.map(async (candidate) => {
      const { agentDeviceId } = candidate;
      if (candidate.agentKind === 'acp') {
        const key = pluginEngineKeyFromProviderId(candidate.providerId);
        const remoteEngines = agentDeviceId ? (await remote?.pluginEngines.get(agentDeviceId)) ?? null : null;
        const engineList = agentDeviceId ? remoteEngines : localPluginEngines;
        const engine = key && engineList ? engineList.find((item) => item.key === key) : undefined;
        const modelEntry = engine?.models.find((item) => item.id === candidate.model);
        const modelName = modelEntry?.displayName ?? candidate.model;
        const sourceName = engine?.name ?? candidate.providerId;
        const windows = quota.get(modelGroupQuotaKey(agentDeviceId, candidate.providerId))
          ?.filter((window) => !window.scopedTo || scopedWindowApplies(window.scopedTo, candidate.model, modelName))
          .map(({ usedPercent, resetAtMs, windowMs }) => ({ usedPercent, resetAtMs, windowMs }));
        const locationAllowed = !agentDeviceId
          || (!!locations && locations.locations.some((item) => item.agentDeviceId === agentDeviceId));
        const engineAvailable = !!engine
          && !engine.suspended
          && engine.availability.state !== 'unavailable'
          && (!agentDeviceId || isPluginEngineOfferedRemotely(engine))
          && (!remoteInvocableOnly || !!agentDeviceId || isPluginEngineOfferedRemotely(engine));
        const modelDisabled = !!engine?.disabledModels?.some((item) => item.id === candidate.model);
        const modelAllowed = !!engine
          && !modelDisabled
          && !(engine.defaultModelAllowed === false
            && (candidate.model === PLUGIN_ENGINE_DEFAULT_MODEL || !modelEntry))
          && (candidate.model === PLUGIN_ENGINE_DEFAULT_MODEL || engine.models.length === 0 || !!modelEntry);
        const available = locationAllowed && engineAvailable && modelAllowed;
        const effortSupported = available
          && !!wantedEffort
          && isPluginEngineEffort(wantedEffort)
          && !!modelEntry?.efforts?.includes(wantedEffort);
        const detail = engine?.reportedModelDetails?.find((item) => item.modelId === candidate.model);
        const acceptsImage = detail?.imageInput === true;
        return {
          available,
          ...(effortSupported ? { effort: wantedEffort } : {}),
          modelName,
          sourceName,
          windows: windows && windows.length > 0 ? windows : null,
          ...(route.strategy === 'cheapest' ? { price: null } : {}),
          acceptsImage,
        };
      }
      const agent = builtinAgentOf(candidate.agentKind);
      const remoteViews = agentDeviceId ? (await remote?.views.get(agentDeviceId)) ?? null : null;
      const catalog: Catalog = agentDeviceId
        ? { views: remoteViews ?? [], agents: GHOST_REMOTE_AGENT_MODELS }
        : { views, agents };
      const view = catalog.views.find((item) => item.id === candidate.providerId);
      const model = view?.models[agent]?.find((item) => item.id === candidate.model);
      const modelName = model?.name ?? candidate.model;
      const windows = quota.get(modelGroupQuotaKey(agentDeviceId, candidate.providerId))
        // 只对某个模型生效的窗口，只在候选就是那个模型时参与。
        ?.filter((window) => !window.scopedTo || scopedWindowApplies(window.scopedTo, candidate.model, modelName))
        .map(({ usedPercent, resetAtMs, windowMs }) => ({ usedPercent, resetAtMs, windowMs }));
      const exact = { agentKind: candidate.agentKind, providerId: candidate.providerId, model: candidate.model, effort: '', fastMode: false as const };
      const inner = !agentDeviceId && deps.innerQuota
        ? await deps.innerQuota({ providerId: candidate.providerId, model: candidate.model, agentKind: candidate.agentKind }).catch(() => null)
        : null;
      const available = agentDeviceId
        // 与插件卡片里的远程模型同一判断：位置此刻能选，模型也在那里允许远程调用的目录里。
        ? !!locations && !!remoteViews && await isGhostCardModelRouteAvailable({ ...exact, agentDeviceId }, {
            localViews: async () => views,
            localAgents: () => agents,
            locations: async () => locations,
            remoteViews: async () => remoteViews,
          }) && (await remote?.harness.get(remoteHarnessKey(agentDeviceId, agent))) !== false
        : installed.get(agent) === true && isPluginModelPickerRouteAvailable(exact, views, agents);
      return {
        available,
        ...(available && wantedEffort && isPluginModelPickerRouteAvailable(
          { ...exact, effort: wantedEffort }, catalog.views, catalog.agents,
        ) ? { effort: wantedEffort } : {}),
        ...(available && wantedFast && isPluginModelPickerRouteAvailable(
          { ...exact, fastMode: wantedFast }, catalog.views, catalog.agents,
        ) ? { fastMode: wantedFast } : {}),
        modelName,
        sourceName: view?.name ?? candidate.providerId,
        windows: windows && windows.length > 0 ? windows : null,
        ...(inner ? { inner } : {}),
        ...(route.strategy === 'cheapest'
          ? { price: agentDeviceId ? remoteListedPrice(view, model) : listedPrice(view, agent, model, pricing) }
          : {}),
        // 与设置里「能看图」开关同一判断：用户改过就按用户的，否则按目录声明，再按模型名推断。
        acceptsImage: !!model && modelImageInputDefault({ ...model, imageInputDefault: undefined }, model.id) === true,
      };
    }));
  }

  async function resolve(request: ModelGroupResolveRequest): Promise<ModelGroupResolveResult> {
    const scope = deps.scope();
    const now = deps.now();
    // 先读目录再读配置：自动路由是按目录生成的，配置要与这次用的目录是同一时刻的。
    const allViews = await deps.views();
    const target = modelGroupRouteFor(deps.config(), request.selection, now);
    if (target.outcome === 'missing') return prepare(request, scope, { outcome: 'missing', groupName: target.groupName, trace: [] });
    const { groupName, via } = target;
    // 限定运行位置时(进行中的任务)，别的位置上的来源按停用处理：不选它们，也不为它们去读别处的目录。
    const location = request.location;
    const route = location
      ? {
          ...target.route,
          candidates: target.route.candidates.map((candidate) => ((candidate.agentDeviceId ?? null) === location.agentDeviceId
            ? candidate
            : { ...candidate, off: true })),
        }
      : target.route;
    const needsImage = request.context?.hasImages === true && !!route.exceptions?.some((item) => item.when.type === 'image');
    // 为另一台电脑跑 Agent 时只认允许被远程调用的连接：别的连接在这次选路里按没有连接处理。
    const remoteInvocable = (view: ProviderView) => (deps.remoteInvocable ? deps.remoteInvocable(view.id) : view.remoteInvocationEnabled === true);
    const views = request.remoteInvocableOnly ? allViews.filter(remoteInvocable) : allViews;
    const facts = await inspect(route, views, request.context, request.cachedQuota === true, request.remoteInvocableOnly === true);
    const picked = pickModelGroupCandidate(route, facts, {
      now, lastPickedKey: lastPicked.get(`${scope}\u0000${route.id}`) ?? null, needsImage,
      weightCounters: countersFor(`${scope}\u0000${route.id}`, weightSignature(target.route)),
    });
    const exceptions: ModelGroupAppliedException[] = [
      ...via,
      ...(picked.image ? [{ type: picked.image === 'applied' ? 'image' as const : 'imageFallback' as const }] : []),
    ];
    if (scope !== deps.scope()) return { outcome: 'unavailable', groupName, trace: [] };
    if (picked.index === null) return prepare(request, scope, { outcome: 'unavailable', groupName, trace: picked.trace });
    const candidate = route.candidates[picked.index];
    const entry = picked.trace[picked.index];
    const chosen = { agentKind: candidate.agentKind, providerId: candidate.providerId, model: candidate.model };
    // 推理强度按选中来源所在位置的目录看支不支持。
    const { effort, fastMode } = facts[picked.index];
    return prepare(request, scope, {
      outcome: 'routed', groupName,
      route: {
        ...chosen,
        ...(candidate.agentDeviceId ? { agentDeviceId: candidate.agentDeviceId } : {}),
        ...(effort ? { effort } : {}),
        ...(fastMode ? { fastMode } : {}),
      },
      modelName: entry.modelName, sourceName: entry.sourceName,
      why: entry.why, quota: entry.quota, trace: picked.trace,
      ...(exceptions.length > 0 ? { exceptions } : {}),
    }, route.id, picked.weightStep ? { step: picked.weightStep, signature: weightSignature(target.route) } : undefined);
  }

  /** 一条路线每个候选此刻的事实(与新任务解析同一判断)；不推进「轮流」的位置与「按权重」的计数。 */
  async function candidateFacts(route: ModelGroupRoute, context?: ModelGroupResolveRequest['context']): Promise<ModelGroupCandidateFacts[]> {
    return inspect(route, await deps.views(), context);
  }

  return { resolve, commit, candidateFacts };
}
