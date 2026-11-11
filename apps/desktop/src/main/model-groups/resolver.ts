/**
 * 把选中的路线或模式解析成一个现在能用的具体模型。事实全部来自已有来源：供应商目录决定能不能选，
 * 额度总览给出订阅窗口；这里不发模型请求、不读凭证。读不到额度的来源按未知处理，不当作没用过。
 */
import type { ProviderView } from '@cindy/model-providers';

import {
  findModelGroupSelection,
  modelGroupCandidateKey,
  type ModelGroupCandidate,
  type ModelGroupResolveRequest,
  type ModelGroupResolveResult,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupTraceQuota,
} from '../../shared/modelGroups.js';
import { isPluginModelPickerRouteAvailable } from '../cindy-brain/ghostModelPicker.js';
import { pickModelGroupCandidate, type ModelGroupCandidateFacts } from './pick.js';

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
}

const agentOf = (kind: ModelGroupCandidate['agentKind']) => (kind === 'cc' ? 'claude-code' : kind);

export function createModelGroupResolver(deps: ModelGroupResolverDeps) {
  /** 「轮流」上一次选中的候选；只在内存里，重启后从第一个开始。 */
  const lastPicked = new Map<string, string>();

  async function facts(route: ModelGroupRoute, views: ProviderView[]): Promise<ModelGroupCandidateFacts[]> {
    const agents = deps.agents();
    const quota = await deps.quotaWindows().catch(() => new Map<string, never[]>());
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
        ?.filter((window) => !window.scopedTo || modelName.toLowerCase().includes(window.scopedTo.toLowerCase()))
        .map(({ usedPercent, resetAtMs, windowMs }) => ({ usedPercent, resetAtMs, windowMs }));
      return {
        available: installed.get(agent) === true
          && isPluginModelPickerRouteAvailable({ ...candidate, effort: '', fastMode: false }, views, agents),
        modelName,
        sourceName: view?.name ?? candidate.providerId,
        windows: windows && windows.length > 0 ? windows : null,
      };
    });
  }

  async function resolve(request: ModelGroupResolveRequest): Promise<ModelGroupResolveResult> {
    const scope = deps.scope();
    const config = deps.config();
    const found = findModelGroupSelection(config, request.selection);
    if (!found) return { outcome: 'missing', groupName: '', trace: [] };
    const groupName = found.type === 'route' ? found.route.name : found.mode.name;
    const effort = found.type === 'mode' ? found.mode.effort : undefined;
    let route: ModelGroupRoute;
    if (found.type === 'route') route = found.route;
    else if (found.mode.target.type === 'route') {
      const routeId = found.mode.target.routeId;
      const target = config.routes.find((item) => item.id === routeId);
      if (!target) return { outcome: 'missing', groupName, trace: [] };
      route = target;
    } else {
      const { agentKind, providerId, model } = found.mode.target;
      route = { id: found.mode.id, name: groupName, strategy: 'order', candidates: [{ agentKind, providerId, model }] };
    }

    const views = await deps.views();
    const picked = pickModelGroupCandidate(route, await facts(route, views), {
      now: deps.now(), lastPickedKey: lastPicked.get(`${scope}\u0000${route.id}`) ?? null,
    });
    if (scope !== deps.scope()) return { outcome: 'unavailable', groupName, trace: [] };
    if (picked.index === null) return { outcome: 'unavailable', groupName, trace: picked.trace };
    const candidate = route.candidates[picked.index];
    const entry = picked.trace[picked.index];
    if (!request.dryRun) lastPicked.set(`${scope}\u0000${route.id}`, modelGroupCandidateKey(candidate));
    const base = { agentKind: candidate.agentKind, providerId: candidate.providerId, model: candidate.model };
    const keepEffort = !!effort && isPluginModelPickerRouteAvailable({ ...base, effort, fastMode: false }, views, deps.agents());
    return {
      outcome: 'routed', groupName,
      route: { ...base, ...(keepEffort ? { effort } : {}) },
      modelName: entry.modelName, sourceName: entry.sourceName,
      why: entry.why, quota: entry.quota, trace: picked.trace,
    };
  }

  return { resolve };
}
