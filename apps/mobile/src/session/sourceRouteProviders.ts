/**
 * 手机端解析被控电脑的供应商合并路由(`sourceRoutes` + `expandedRoutes`)并合成面板中的虚拟供应商条目
 * (与桌面端 `apps/desktop/src/renderer/features/model-groups/sourceRouteProviders.ts` 同口径)。
 *
 * 所有远程数据均按不可信输入逐字段校验、设上限，不信任任意键或类型。旧电脑不返回 `sourceRoutes` /
 * `expandedRoutes` 时自然退化为空数组，不影响已有自定义路由列表。
 */
import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';
import { resolveProviderLogoKind } from '@cindy/model-providers/branding';
import { parseCompanionModelGroups, type CompanionModelGroup } from './companionProfileData';

export const MOBILE_SOURCE_ROUTE_PROVIDER_PREFIX = 'sroute:';

export function isMobileSourceRouteProviderId(providerId: string | null | undefined): boolean {
  return !!providerId && providerId.startsWith(MOBILE_SOURCE_ROUTE_PROVIDER_PREFIX);
}

export interface HostSourceRouteMember {
  providerId: string;
  agentDeviceId?: string;
  off?: boolean;
}

export interface HostSourceRoute {
  id: string;
  name: string;
  hidden?: boolean;
  sources: HostSourceRouteMember[];
}

export interface HostExpandedCandidate {
  agentKind: 'cc' | 'codex' | 'pi';
  providerId: string;
  model: string;
  agentDeviceId?: string;
  off?: boolean;
}

export interface HostExpandedRoute {
  id: string;
  name: string;
  hidden?: boolean;
  parent: { id: string; name: string };
  candidates: HostExpandedCandidate[];
}

export interface HostModelGroupsPayload {
  groups: CompanionModelGroup[];
  sourceRoutes: HostSourceRoute[];
  expandedRoutes: HostExpandedRoute[];
}

const rec = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const str = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/** 校验并裁剪被控电脑返回的可选 `sourceRoutes` / `expandedRoutes`，与自定义路由 `routes` 合为一份载荷。 */
export function parseHostModelGroupsPayload(raw: unknown): HostModelGroupsPayload | null {
  const data = rec(raw);
  if (!data) return null;
  const groups = parseCompanionModelGroups(raw);
  if (groups === undefined) return null;

  const sourceRoutes: HostSourceRoute[] = Array.isArray(data.sourceRoutes)
    ? data.sourceRoutes.slice(0, 32).flatMap((item): HostSourceRoute[] => {
        const entry = rec(item);
        const id = str(entry?.id, 64);
        const name = str(entry?.name, 40);
        if (!id || !name || !Array.isArray(entry?.sources)) return [];
        const sources = entry.sources.slice(0, 16).flatMap((s): HostSourceRouteMember[] => {
          const member = rec(s);
          const providerId = str(member?.providerId, 256);
          if (!providerId) return [];
          const agentDeviceId = str(member?.agentDeviceId, 256);
          return [{
            providerId,
            ...(agentDeviceId ? { agentDeviceId } : {}),
            ...(member?.off === true ? { off: true } : {}),
          }];
        });
        if (sources.length === 0) return [];
        return [{
          id,
          name,
          ...(entry.hidden === true ? { hidden: true } : {}),
          sources,
        }];
      })
    : [];

  const expandedRoutes: HostExpandedRoute[] = Array.isArray(data.expandedRoutes)
    ? data.expandedRoutes.slice(0, 128).flatMap((item): HostExpandedRoute[] => {
        const entry = rec(item);
        const id = str(entry?.id, 128);
        const name = str(entry?.name, 80);
        const parent = rec(entry?.parent);
        const parentId = str(parent?.id, 64);
        const parentName = str(parent?.name, 40);
        if (!id || !name || !parentId || !parentName || !Array.isArray(entry?.candidates)) return [];
        const candidates = entry.candidates.slice(0, 16).flatMap((c): HostExpandedCandidate[] => {
          const cand = rec(c);
          const agentKind = cand?.agentKind;
          const providerId = str(cand?.providerId, 256);
          const model = str(cand?.model, 256);
          if ((agentKind !== 'cc' && agentKind !== 'codex' && agentKind !== 'pi') || !providerId || !model) return [];
          const agentDeviceId = str(cand?.agentDeviceId, 256);
          return [{
            agentKind,
            providerId,
            model,
            ...(agentDeviceId ? { agentDeviceId } : {}),
            ...(cand?.off === true ? { off: true } : {}),
          }];
        });
        if (candidates.length === 0) return [];
        return [{
          id,
          name,
          ...(entry.hidden === true ? { hidden: true } : {}),
          parent: { id: parentId, name: parentName },
          candidates,
        }];
      })
    : [];

  return { groups, sourceRoutes, expandedRoutes };
}

export interface MobileSourceRouteHit {
  route: HostExpandedRoute;
  candidate: HostExpandedCandidate;
}

export interface MobileSourceRouteProviders {
  providers: ProviderView[];
  hit(providerId: string | null | undefined, modelId: string): MobileSourceRouteHit | null;
  shownAs(providerId: string | null | undefined, activeRouteId?: string | null, agentDeviceId?: string | null): string | null;
  hidesRemote(agentDeviceId: string, providerId: string): boolean;
  usageMember(providerId: string): { provider: ProviderView; agentDeviceId: string | null } | null;
}

const agentOf = (kind: HostExpandedCandidate['agentKind']): AgentKind =>
  (kind === 'cc' ? 'claude-code' : kind);
const memberKey = (agentDeviceId: string | null | undefined, providerId: string) =>
  `${agentDeviceId ?? ''}\u0000${providerId}`;

export function withMobileSourceRouteProviders(
  providers: readonly ProviderView[],
  payload: HostModelGroupsPayload | null | undefined,
  current?: { providerId?: string | null; modelId: string; agentDeviceId?: string | null },
  remote?: ReadonlyMap<string, readonly ProviderView[]>,
  label?: (name: string, members: number) => string,
): MobileSourceRouteProviders {
  const routes = (payload?.sourceRoutes ?? []).filter((route) => !route.hidden);
  const none: MobileSourceRouteProviders = {
    providers: [...providers],
    hit: () => null,
    shownAs: () => null,
    hidesRemote: () => false,
    usageMember: () => null,
  };
  if (!payload || routes.length === 0 || payload.expandedRoutes.length === 0) return none;
  const viewsAt = (agentDeviceId: string | undefined) => (agentDeviceId ? remote?.get(agentDeviceId) ?? [] : providers);
  const hits = new Map<string, MobileSourceRouteHit>();
  const memberOf = new Map<string, string>();
  const byRoute = new Map<string, string>();
  const virtual: ProviderView[] = [];
  const usageMembers = new Map<string, { provider: ProviderView; agentDeviceId: string | null }>();

  for (const route of routes) {
    const members = route.sources.flatMap((source) =>
      viewsAt(source.agentDeviceId)
        .filter((provider) => provider.id === source.providerId)
        .map((provider) => ({ provider, agentDeviceId: source.agentDeviceId })),
    );
    const id = `${MOBILE_SOURCE_ROUTE_PROVIDER_PREFIX}${route.id}`;
    const models: Partial<Record<AgentKind, CatalogModel[]>> = {};
    for (const child of payload.expandedRoutes) {
      if (child.parent.id !== route.id || child.hidden) continue;
      for (const candidate of child.candidates) {
        if (candidate.off) continue;
        const agent = agentOf(candidate.agentKind);
        const model = members
          .find((member) => member.provider.id === candidate.providerId && (member.agentDeviceId ?? null) === (candidate.agentDeviceId ?? null))
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
    const lead = members.find((member) => !route.sources.find((source) =>
      source.providerId === member.provider.id && (source.agentDeviceId ?? null) === (member.agentDeviceId ?? null),
    )?.off);
    if (lead) usageMembers.set(id, { provider: lead.provider, agentDeviceId: lead.agentDeviceId ?? null });
    virtual.push({
      ...base,
      id,
      name: label ? label(route.name, members.length) : route.name,
      agents,
      logoKind: base.logoKind ?? resolveProviderLogoKind(base.id, base.routing) ?? undefined,
      models: models as ProviderView['models'],
      routing: Object.assign({}, ...members.map((member) => member.provider.routing)) as ProviderView['routing'],
      connected: true,
      subscriptionAccountKeys: undefined,
      subscriptionPoolAlias: undefined,
      subscriptionAccount: undefined,
      openAiAccount: undefined,
      ...({ group: undefined, runLocation: undefined } as object),
    });
    for (const member of members) {
      const isCurrent = member.provider.id === current?.providerId && (member.agentDeviceId ?? null) === (current.agentDeviceId ?? null);
      if (isCurrent && !hits.has(`${id}\u0000${current!.modelId}`)) continue;
      memberOf.set(memberKey(member.agentDeviceId, member.provider.id), id);
    }
  }
  if (virtual.length === 0) return none;
  return {
    providers: [
      ...virtual,
      ...providers.filter((provider) => !memberOf.has(memberKey(null, provider.id))),
    ],
    hit: (providerId, modelId) => (providerId ? hits.get(`${providerId}\u0000${modelId}`) ?? null : null),
    shownAs: (providerId, activeRouteId, agentDeviceId) =>
      (activeRouteId && byRoute.get(activeRouteId)) || (providerId ? memberOf.get(memberKey(agentDeviceId, providerId)) ?? null : null),
    hidesRemote: (agentDeviceId, providerId) => memberOf.has(memberKey(agentDeviceId, providerId)),
    usageMember: (providerId) => usageMembers.get(providerId) ?? null,
  };
}

/**
 * 草稿里记的是合并供应商成员的模型、却没显式记路由(升级前旧草稿或收藏)：开任务时仍按那条展开路由挑源。
 */
export function implicitMobileSourceRouteSelection(
  payload: HostModelGroupsPayload | null | undefined,
  current: { providerId?: string | null; model: string; agentDeviceId?: string | null },
): { type: 'route'; id: string } | null {
  if (!payload || !current.providerId) return null;
  const route = payload.expandedRoutes.find((item) =>
    !item.hidden && item.candidates.some((candidate) =>
      !candidate.off
      && (candidate.agentDeviceId ?? null) === (current.agentDeviceId ?? null)
      && candidate.providerId === current.providerId
      && candidate.model === current.model,
    ),
  );
  return route ? { type: 'route', id: route.id } : null;
}
