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
  type ModelGroupAppliedException,
  type ModelGroupCandidate,
  type ModelGroupResolveRequest,
  type ModelGroupResolveResult,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupTraceQuota,
} from '../../shared/modelGroups.js';
import { GHOST_REMOTE_AGENT_MODELS } from '../cindy-brain/ghostAgentModels.js';
import { isGhostCardModelRouteAvailable, isPluginModelPickerRouteAvailable } from '../cindy-brain/ghostModelPicker.js';
import { pickModelGroupCandidate, type ModelGroupCandidateFacts } from './pick.js';
import { modelGroupRouteFor } from './routeFor.js';

export interface ModelGroupResolverDeps {
  config(): ModelGroupsConfig;
  /** 本机供应商目录的快照(不触发发现或登录)。 */
  views(): Promise<ProviderView[]>;
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
  quotaWindows(): Promise<ReadonlyMap<string, readonly (ModelGroupTraceQuota & { scopedTo?: string | null })[]>>;
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

const agentOf = (kind: ModelGroupCandidate['agentKind']): AgentKind => (kind === 'cc' ? 'claude-code' : kind);

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

export function createModelGroupResolver(deps: ModelGroupResolverDeps) {
  /** 「轮流」上一次选中的候选；只在内存里，重启后从第一个开始。 */
  const lastPicked = new Map<string, string>();
  const pending = new Map<string, { scope: string; at: number; selection: ModelGroupResolveRequest['selection']; result: ModelGroupResolveResult; routeId?: string }>();

  function prepare(request: ModelGroupResolveRequest, scope: string, result: ModelGroupResolveResult, routeId?: string): ModelGroupResolveResult {
    if (request.dryRun || scope !== deps.scope()) return result;
    // 未采用的结果不写盘；限制暂存数量和生命周期，避免取消操作不断积累。
    for (const [id, item] of pending) {
      if (item.scope !== scope || deps.now() - item.at > 60 * 60_000) pending.delete(id);
    }
    while (pending.size >= 128) pending.delete(pending.keys().next().value!);
    const decisionId = randomUUID();
    pending.set(decisionId, { scope, at: deps.now(), selection: { ...request.selection }, result, routeId });
    return { ...result, decisionId };
  }

  function commit(decisionId: string): boolean {
    const item = pending.get(decisionId);
    pending.delete(decisionId);
    if (!item || item.scope !== deps.scope() || deps.now() - item.at > 60 * 60_000) return false;
    deps.recordDecision?.(item.selection, item.result);
    if (item.result.outcome === 'routed' && item.routeId) {
      lastPicked.set(`${item.scope}\u0000${item.routeId}`, modelGroupCandidateKey(item.result.route));
    }
    return true;
  }

  /**
   * 路线里不在本机的来源要用的位置名单与各位置目录：同时开始读，各自有时限，读不到为 null。
   * 路线里没有这种来源(或都已停用)时不读。
   */
  function remoteReads(route: ModelGroupRoute) {
    const ids = [...new Set(route.candidates.flatMap((candidate) =>
      (candidate.agentDeviceId && !candidate.off ? [candidate.agentDeviceId] : [])))];
    if (ids.length === 0) return null;
    const wait = deps.remoteWaitMs ?? MODEL_GROUP_REMOTE_WAIT_MS;
    const read = <T>(start: (() => Promise<T>) | null): Promise<T | null> =>
      (start ? within(Promise.resolve().then(start), wait).catch(() => null) : Promise.resolve(null));
    const { locations, remoteViews } = deps;
    // 别的位置上的引擎看那台自己的状态，不看本机装没装；与目录同时读、同一时限，读不到按就绪(那台执行时还会再拦)。
    const harness = new Map<string, Promise<boolean>>();
    for (const candidate of route.candidates) {
      if (!candidate.agentDeviceId || candidate.off) continue;
      const agent = agentOf(candidate.agentKind);
      const key = remoteHarnessKey(candidate.agentDeviceId, agent);
      const agentDeviceId = candidate.agentDeviceId;
      if (!harness.has(key)) {
        harness.set(key, within(Promise.resolve().then(() => deps.harnessInstalled(agent, agentDeviceId)), wait).catch(() => true));
      }
    }
    return {
      harness,
      locations: read(locations ? () => locations() : null),
      views: new Map(ids.map((id) => [id, read(remoteViews
        ? () => remoteViews(id).then((catalog) => (catalog.stale ? null : catalog.views))
        : null)] as const)),
    };
  }

  async function inspect(route: ModelGroupRoute, views: ProviderView[]): Promise<{ facts: ModelGroupCandidateFacts[]; catalogs: Catalog[] }> {
    const agents = deps.agents();
    // 远程读取与读额度同时进行，整体仍在额度等待的时限内。
    const remote = remoteReads(route);
    const quota = await deps.quotaWindows().catch(() => new Map<string, never[]>());
    const pricing = route.strategy === 'cheapest' && deps.pricing ? await deps.pricing().catch(() => null) : null;
    const installed = new Map<string, boolean>();
    for (const candidate of route.candidates) {
      const agent = agentOf(candidate.agentKind);
      if (!candidate.agentDeviceId && !installed.has(agent)) installed.set(agent, await deps.harnessInstalled(agent));
    }
    const locations = remote ? await remote.locations : null;
    const catalogs: Catalog[] = [];
    const facts = await Promise.all(route.candidates.map(async (candidate, index) => {
      const agent = agentOf(candidate.agentKind);
      const { agentDeviceId } = candidate;
      const remoteViews = agentDeviceId ? (await remote?.views.get(agentDeviceId)) ?? null : null;
      const catalog: Catalog = agentDeviceId
        ? { views: remoteViews ?? [], agents: GHOST_REMOTE_AGENT_MODELS }
        : { views, agents };
      catalogs[index] = catalog;
      const view = catalog.views.find((item) => item.id === candidate.providerId);
      const model = view?.models[agent]?.find((item) => item.id === candidate.model);
      const modelName = model?.name ?? candidate.model;
      const windows = quota.get(modelGroupQuotaKey(agentDeviceId, candidate.providerId))
        // 只对某个模型生效的窗口，只在候选就是那个模型时参与。
        ?.filter((window) => !window.scopedTo || scopedWindowApplies(window.scopedTo, candidate.model, modelName))
        .map(({ usedPercent, resetAtMs, windowMs }) => ({ usedPercent, resetAtMs, windowMs }));
      const exact = { agentKind: candidate.agentKind, providerId: candidate.providerId, model: candidate.model, effort: '', fastMode: false as const };
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
        modelName,
        sourceName: view?.name ?? candidate.providerId,
        windows: windows && windows.length > 0 ? windows : null,
        ...(route.strategy === 'cheapest'
          ? { price: agentDeviceId ? remoteListedPrice(view, model) : listedPrice(view, agent, model, pricing) }
          : {}),
        // 与设置里「能看图」开关同一判断：用户改过就按用户的，否则按目录声明，再按模型名推断。
        acceptsImage: !!model && modelImageInputDefault({ ...model, imageInputDefault: undefined }, model.id) === true,
      };
    }));
    return { facts, catalogs };
  }

  async function resolve(request: ModelGroupResolveRequest): Promise<ModelGroupResolveResult> {
    const scope = deps.scope();
    const now = deps.now();
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
    // 改走了另一条路线时，用那条路线自己的推理强度。
    const { effort } = route;
    const needsImage = request.context?.hasImages === true && !!route.exceptions?.some((item) => item.when.type === 'image');
    const views = await deps.views();
    const { facts, catalogs } = await inspect(route, views);
    const picked = pickModelGroupCandidate(route, facts, {
      now, lastPickedKey: lastPicked.get(`${scope}\u0000${route.id}`) ?? null, needsImage,
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
    const catalog = catalogs[picked.index];
    const keepEffort = !!effort && isPluginModelPickerRouteAvailable({ ...chosen, effort, fastMode: false }, catalog.views, catalog.agents);
    return prepare(request, scope, {
      outcome: 'routed', groupName,
      route: {
        ...chosen,
        ...(candidate.agentDeviceId ? { agentDeviceId: candidate.agentDeviceId } : {}),
        ...(keepEffort ? { effort } : {}),
      },
      modelName: entry.modelName, sourceName: entry.sourceName,
      why: entry.why, quota: entry.quota, trace: picked.trace,
      ...(exceptions.length > 0 ? { exceptions } : {}),
    }, route.id);
  }

  /** 一条路线每个候选此刻的事实(与新任务解析同一判断)；不推进「轮流」的位置。 */
  async function candidateFacts(route: ModelGroupRoute): Promise<ModelGroupCandidateFacts[]> {
    return (await inspect(route, await deps.views())).facts;
  }

  return { resolve, commit, candidateFacts };
}
