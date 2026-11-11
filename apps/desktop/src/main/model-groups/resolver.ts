/**
 * 把选中的路线解析成一个现在能用的具体模型。事实全部来自已有来源：供应商目录决定能不能选，
 * 额度总览给出订阅窗口；这里不发模型请求、不读凭证。读不到额度的来源按未知处理，不当作没用过。
 */
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
import { isPluginModelPickerRouteAvailable } from '../cindy-brain/ghostModelPicker.js';
import { pickModelGroupCandidate, type ModelGroupCandidateFacts } from './pick.js';
import { modelGroupRouteFor } from './routeFor.js';

export interface ModelGroupResolverDeps {
  config(): ModelGroupsConfig;
  /** 本机供应商目录的快照(不触发发现或登录)。 */
  views(): Promise<ProviderView[]>;
  /** 本机可用的引擎。 */
  agents(): readonly string[];
  harnessInstalled(agent: string): Promise<boolean>;
  /** 各订阅来源当前的额度窗口，按供应商连接 ID。 */
  quotaWindows(): Promise<ReadonlyMap<string, readonly (ModelGroupTraceQuota & { scopedTo?: string | null })[]>>;
  /** 账号范围：换账号后不沿用上一个账号的轮流位置。 */
  scope(): string;
  now(): number;
  /**
   * 「最省钱」用的报价目录，与模型选择器显示价格同一来源：Cindy AI(xd)取网关报价，其余取参考价
   * (注册表、连接自带价、用户自定价)。只在路线选法是 cheapest 时读取；没提供时一律按没有标价。
   */
  pricing?(): Promise<{ gateway: ModelPricingCatalog | null; reference: ModelPricingCatalog | null }>;
}

const agentOf = (kind: ModelGroupCandidate['agentKind']): AgentKind => (kind === 'cc' ? 'claude-code' : kind);

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

  async function facts(route: ModelGroupRoute, views: ProviderView[]): Promise<ModelGroupCandidateFacts[]> {
    const agents = deps.agents();
    const quota = await deps.quotaWindows().catch(() => new Map<string, never[]>());
    const pricing = route.strategy === 'cheapest' && deps.pricing ? await deps.pricing().catch(() => null) : null;
    const installed = new Map<string, boolean>();
    for (const candidate of route.candidates) {
      const agent = agentOf(candidate.agentKind);
      if (!installed.has(agent)) installed.set(agent, await deps.harnessInstalled(agent));
    }
    return route.candidates.map((candidate) => {
      const agent = agentOf(candidate.agentKind);
      const view = views.find((item) => item.id === candidate.providerId);
      const model = view?.models[agent]?.find((item) => item.id === candidate.model);
      const modelName = model?.name ?? candidate.model;
      const windows = quota.get(candidate.providerId)
        // 只对某个模型生效的窗口，只在候选就是那个模型时参与。
        ?.filter((window) => !window.scopedTo || scopedWindowApplies(window.scopedTo, candidate.model, modelName))
        .map(({ usedPercent, resetAtMs, windowMs }) => ({ usedPercent, resetAtMs, windowMs }));
      return {
        available: installed.get(agent) === true
          && isPluginModelPickerRouteAvailable({ ...candidate, effort: '', fastMode: false }, views, agents),
        modelName,
        sourceName: view?.name ?? candidate.providerId,
        windows: windows && windows.length > 0 ? windows : null,
        ...(route.strategy === 'cheapest' ? { price: listedPrice(view, agent, model, pricing) } : {}),
        // 与设置里「能看图」开关同一判断：用户改过就按用户的，否则按目录声明，再按模型名推断。
        acceptsImage: !!model && modelImageInputDefault({ ...model, imageInputDefault: undefined }, model.id) === true,
      };
    });
  }

  async function resolve(request: ModelGroupResolveRequest): Promise<ModelGroupResolveResult> {
    const scope = deps.scope();
    const now = deps.now();
    const target = modelGroupRouteFor(deps.config(), request.selection, now);
    if (target.outcome === 'missing') return { outcome: 'missing', groupName: target.groupName, trace: [] };
    const { groupName, route, via } = target;
    // 改走了另一条路线时，用那条路线自己的推理强度。
    const { effort } = route;
    const needsImage = request.context?.hasImages === true && !!route.exceptions?.some((item) => item.when.type === 'image');
    const views = await deps.views();
    const picked = pickModelGroupCandidate(route, await facts(route, views), {
      now, lastPickedKey: lastPicked.get(`${scope}\u0000${route.id}`) ?? null, needsImage,
    });
    const exceptions: ModelGroupAppliedException[] = [
      ...via,
      ...(picked.image ? [{ type: picked.image === 'applied' ? 'image' as const : 'imageFallback' as const }] : []),
    ];
    if (scope !== deps.scope()) return { outcome: 'unavailable', groupName, trace: [] };
    if (picked.index === null) return { outcome: 'unavailable', groupName, trace: picked.trace };
    const candidate = route.candidates[picked.index];
    const entry = picked.trace[picked.index];
    if (!request.dryRun) lastPicked.set(`${scope}\u0000${route.id}`, modelGroupCandidateKey(candidate));
    const chosen = { agentKind: candidate.agentKind, providerId: candidate.providerId, model: candidate.model };
    const keepEffort = !!effort && isPluginModelPickerRouteAvailable({ ...chosen, effort, fastMode: false }, views, deps.agents());
    return {
      outcome: 'routed', groupName,
      route: { ...chosen, ...(keepEffort ? { effort } : {}) },
      modelName: entry.modelName, sourceName: entry.sourceName,
      why: entry.why, quota: entry.quota, trace: picked.trace,
      ...(exceptions.length > 0 ? { exceptions } : {}),
    };
  }

  /** 一条路线每个候选此刻的事实(与新任务解析同一判断)；不推进「轮流」的位置。 */
  async function candidateFacts(route: ModelGroupRoute): Promise<ModelGroupCandidateFacts[]> {
    return facts(route, await deps.views());
  }

  return { resolve, candidateFacts };
}
