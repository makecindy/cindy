/**
 * 供应商路由在选模型面板里的样子(2026-11-24 用户裁决)：合并后的路由就是一个普通供应商——占侧栏一格，模型行与普通行
 * 完全一样(思考深度、Fast、收藏照常能用)，它合并的那几个成员不再各占一格。
 *
 * 做法：按主进程已经展开好的路由(每个模型一条，带 parent)拼出一个只在面板里用的供应商条目，放在第一个成员原来的位置；
 * 选中其中一行时，草稿里记的仍是一个真实成员的模型(显示名、思考深度、Fast 都按它来)，另外记下那条展开的路由——
 * 开任务时由路由按选法决定这次到底用哪个成员。面板外的代码看不到这个拼出来的条目。
 */
import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';
import { resolveProviderLogoKind } from '@cindy/model-providers/branding';

import type { ModelGroupCandidate, ModelGroupRoute, ModelGroupsConfig, ModelGroupSelection } from '../../../shared/modelGroups';

export const SOURCE_ROUTE_PROVIDER_PREFIX = 'sroute:';

/** 面板里这一格是不是合并了整个供应商的路由(不是一个真实的供应商)。 */
export function isSourceRouteProviderId(providerId: string | null | undefined): boolean {
  return !!providerId && providerId.startsWith(SOURCE_ROUTE_PROVIDER_PREFIX);
}

export interface SourceRouteHit {
  /** 这个模型对应的那条展开的路由：选中后记到草稿的 modelGroup。 */
  route: ModelGroupRoute;
  /** 草稿里记的那个真实成员的模型。 */
  candidate: ModelGroupCandidate;
}

export interface SourceRouteProviders {
  providers: ProviderView[];
  /** 面板里选中了拼出来的供应商的一行：对应哪条路由、记哪个真实成员。不是这种行返回 null。 */
  hit(providerId: string | null | undefined, modelId: string): SourceRouteHit | null;
  /**
   * 草稿里记着的真实成员(或选着的那条展开的路由)在面板里显示成哪个条目；不在任何供应商路由里返回 null。
   * agentDeviceId = 那个成员所在的位置(另一台电脑或分享)，本机省略。
   */
  shownAs(providerId: string | null | undefined, activeRouteId?: string | null, agentDeviceId?: string | null): string | null;
  /** 别的位置上的这个供应商已经并进某个合并后的条目：面板里不再单列它那一格。 */
  hidesRemote(agentDeviceId: string, providerId: string): boolean;
}

const agentOf = (kind: ModelGroupCandidate['agentKind']): AgentKind => (kind === 'cc' ? 'claude-code' : kind);
const memberKey = (agentDeviceId: string | null | undefined, providerId: string) => `${agentDeviceId ?? ''}\u0000${providerId}`;

export function withSourceRouteProviders(
  providers: ProviderView[],
  config: ModelGroupsConfig | null | undefined,
  /** 草稿当前记着的模型：它直接指着某个成员、而合并后的条目里没有这个写法的模型时，那个成员照旧单列，不让当前选择消失。 */
  current?: { providerId?: string | null; modelId: string; agentDeviceId?: string | null },
  /** 其他电脑与分享来的位置上的供应商(成员可以在那里)；没读到的位置不在里面，那里的成员这次不算。 */
  remote?: ReadonlyMap<string, readonly ProviderView[]>,
  /**
   * 合并后的条目在面板里叫什么(2026-11-25 用户反馈：与普通供应商混在一起分不出来)：调用方给出带「路由、几个来源」
   * 的写法，侧栏提示、模型行下面那一行、「全部」里的分组标题都用它。不给就用路由自己的名字。
   */
  label?: (name: string, members: number) => string,
): SourceRouteProviders {
  const routes = (config?.sourceRoutes ?? []).filter((route) => !route.hidden);
  const none: SourceRouteProviders = { providers, hit: () => null, shownAs: () => null, hidesRemote: () => false };
  if (!config || routes.length === 0) return none;
  const viewsAt = (agentDeviceId: string | undefined) => (agentDeviceId ? remote?.get(agentDeviceId) ?? [] : providers);
  const hits = new Map<string, SourceRouteHit>();
  const memberOf = new Map<string, string>();
  const byRoute = new Map<string, string>();
  const virtual: { entry: ProviderView }[] = [];
  for (const route of routes) {
    const members = route.sources.flatMap((source) => viewsAt(source.agentDeviceId)
      .filter((provider) => provider.id === source.providerId)
      .map((provider) => ({ provider, agentDeviceId: source.agentDeviceId })));
    const id = `${SOURCE_ROUTE_PROVIDER_PREFIX}${route.id}`;
    const models: Partial<Record<AgentKind, CatalogModel[]>> = {};
    for (const child of config.routes) {
      if (child.parent?.id !== route.id || child.hidden) continue;
      // 草稿里记的那个真实成员：第一个没停用、目录读得到的来源。
      for (const candidate of child.candidates) {
        if (candidate.off) continue;
        const agent = agentOf(candidate.agentKind);
        const model = members.find((member) => member.provider.id === candidate.providerId && (member.agentDeviceId ?? null) === (candidate.agentDeviceId ?? null))
          ?.provider.models?.[agent]?.find((item) => item.id === candidate.model);
        if (!model) continue;
        (models[agent] ??= []).push({ ...model, name: child.name });
        hits.set(`${id}\u0000${model.id}`, { route: child, candidate });
        byRoute.set(child.id, id);
        break;
      }
    }
    const agents = Object.keys(models) as AgentKind[];
    if (members.length === 0 || agents.length === 0) continue;
    const base = members[0].provider;
    // 以第一个成员为底：品牌、接入方式、图标都沿用它；模型与各引擎的路由信息取全部成员的。
    virtual.push({
      entry: {
        ...base,
        id, name: label ? label(route.name, members.length) : route.name, agents,
        // 合并后的条目自己的 id 认不出品牌：明确沿用第一个成员的品牌图标。
        logoKind: base.logoKind ?? resolveProviderLogoKind(base.id, base.routing) ?? undefined,
        models: models as ProviderView['models'],
        routing: Object.assign({}, ...members.map((member) => member.provider.routing)) as ProviderView['routing'],
        connected: true,
        // 这些说的是某一个成员自己的账号、组与别名，不属于合并后的条目。
        subscriptionAccountKeys: undefined, subscriptionPoolAlias: undefined, subscriptionAccount: undefined, openAiAccount: undefined,
        ...({ group: undefined, runLocation: undefined } as object),
      },
    });
    for (const member of members) {
      const isCurrent = member.provider.id === current?.providerId && (member.agentDeviceId ?? null) === (current.agentDeviceId ?? null);
      if (isCurrent && !hits.has(`${id}\u0000${current!.modelId}`)) continue;
      memberOf.set(memberKey(member.agentDeviceId, member.provider.id), id);
    }
  }
  if (virtual.length === 0) return none;
  return {
    // 合并后的条目排在普通供应商前面(侧栏里紧跟「智能路由」那一格，自成一组)，成员不再单列。
    providers: [
      ...virtual.map((item) => item.entry),
      ...providers.filter((provider) => !memberOf.has(memberKey(null, provider.id))),
    ],
    hit: (providerId, modelId) => (providerId ? hits.get(`${providerId}\u0000${modelId}`) ?? null : null),
    shownAs: (providerId, activeRouteId, agentDeviceId) =>
      (activeRouteId && byRoute.get(activeRouteId)) || (providerId ? memberOf.get(memberKey(agentDeviceId, providerId)) ?? null : null),
    hidesRemote: (agentDeviceId, providerId) => memberOf.has(memberKey(agentDeviceId, providerId)),
  };
}

/**
 * 草稿里记的是某条供应商路由成员的模型、却没记路由(升级前留下的草稿、从「最近」或收藏里直接点到成员)：开任务时仍按
 * 那条路由选成员。成员在面板里已经不单列，面板把这个模型显示在合并后的条目下，用户选的只能是合并后的条目——
 * 不能出现「看着是合并的，实际固定用一个成员、出问题也不换」。隐藏了的供应商路由不算，那时成员照旧单列。
 */
export function implicitSourceRouteSelection(
  config: ModelGroupsConfig,
  current: { providerId?: string | null; model: string; agentDeviceId?: string | null },
): ModelGroupSelection | null {
  if (!current.providerId) return null;
  const route = config.routes.find((item) => item.parent && !item.hidden && item.candidates.some((candidate) =>
    (candidate.agentDeviceId ?? null) === (current.agentDeviceId ?? null)
    && candidate.providerId === current.providerId && candidate.model === current.model));
  return route ? { type: 'route', id: route.id } : null;
}
