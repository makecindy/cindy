/**
 * 辅助模型与 Subagent 引用智能路由的纯 Node 核心(Desktop 与 Node Host 共用，architecture-invariants §5)。
 * - 展开：路由里本机、没停用的来源换成一次性请求用的目录钉，路由此刻会选的排第一，其余按路由先后兜底。
 * - 选项：把每条可用本机路由投影为 AuxiliaryModelOption 供设置页与云端设置共用。
 */
import { encodeAuxiliaryRouteRef } from '../../shared/auxiliaryModelChain.js';
import { OWN_ROUTES_PROVIDER_ID, type AuxiliaryModelOption } from '../../shared/auxiliaryModelSettings.js';
import { encodeCatalogModelPin, type CatalogModelPinRoute } from '../../shared/catalogModelPin.js';
import type {
  ModelGroupCandidate,
  ModelGroupResolveRequest,
  ModelGroupResolveResult,
  ModelGroupRoute,
} from '../../shared/modelGroups.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { modelGroupRouteFor } from '../model-groups/routeFor.js';
import { readModelGroupsConfig, readModelGroupsConfigForSelected } from '../model-groups/store.js';

const PREFERRED_TTL_MS = 30_000;
const MINE = OWN_ROUTES_PROVIDER_ID;

const agentOf = (kind: ModelGroupCandidate['agentKind']): CatalogModelPinRoute['agentKind'] =>
  (kind === 'cc' ? 'claude-code' : kind);

function pinOf(candidate: Pick<ModelGroupCandidate, 'agentKind' | 'providerId' | 'model'>): string {
  return encodeCatalogModelPin({ providerId: candidate.providerId, agentKind: agentOf(candidate.agentKind), model: candidate.model });
}

function localCandidates(route: ModelGroupRoute): ModelGroupCandidate[] {
  return route.candidates.filter((candidate) => !candidate.off && !candidate.agentDeviceId);
}

function readRoutesSafely(): ModelGroupRoute[] {
  try {
    return readModelGroupsConfig().routes;
  } catch {
    return [];
  }
}

export interface AuxiliaryRouteRefsPorts {
  resolveLocalRoute(request: ModelGroupResolveRequest): Promise<ModelGroupResolveResult>;
  scope?: () => string;
  now?: () => number;
}

export function createAuxiliaryRouteRefs(ports: AuxiliaryRouteRefsPorts) {
  const scopeOf = ports.scope ?? activeOwnerScopeKey;
  const now = ports.now ?? Date.now;
  const preferred = new Map<string, { scope: string; pin: string | null; at: number }>();
  const refreshing = new Set<string>();

  function refreshPreferred(routeId: string): void {
    const scope = scopeOf();
    const key = `${scope}\u0000${routeId}`;
    const known = preferred.get(key);
    if (refreshing.has(key) || (known && now() - known.at < PREFERRED_TTL_MS)) return;
    refreshing.add(key);
    void ports.resolveLocalRoute({
      selection: { type: 'route', id: routeId },
      dryRun: true,
      cachedQuota: true,
      location: { agentDeviceId: null },
    })
      .then((result) => {
        if (scopeOf() !== scope) return;
        preferred.set(key, {
          scope,
          pin: result.outcome === 'routed' && !result.route.agentDeviceId ? pinOf(result.route) : null,
          at: now(),
        });
      })
      .catch(() => {
        if (scopeOf() === scope) preferred.set(key, { scope, pin: null, at: now() });
      })
      .finally(() => refreshing.delete(key));
  }

  function localRouteCandidatesInPickOrder(routeId: string): ModelGroupCandidate[] {
    let config: ReturnType<typeof readModelGroupsConfigForSelected>;
    try {
      config = readModelGroupsConfigForSelected();
    } catch {
      return [];
    }
    const target = modelGroupRouteFor(config, { type: 'route', id: routeId }, now());
    if (target.outcome !== 'found') return [];
    const members = localCandidates(target.route);
    if (members.length === 0) return [];
    refreshPreferred(routeId);
    const first = preferred.get(`${scopeOf()}\u0000${routeId}`)?.pin;
    const at = first ? members.findIndex((candidate) => pinOf(candidate) === first) : -1;
    return at > 0 ? [members[at]!, ...members.filter((_, index) => index !== at)] : members;
  }

  function expandAuxiliaryRouteRef(routeId: string): string[] {
    return [...new Set(localRouteCandidatesInPickOrder(routeId).map(pinOf))];
  }

  function clear(): void {
    preferred.clear();
    refreshing.clear();
  }

  return {
    localRouteCandidatesInPickOrder,
    expandAuxiliaryRouteRef,
    buildAuxiliaryRouteOptions,
    clear,
  };
}

export function buildAuxiliaryRouteOptions(
  usable: ReadonlyMap<string, Pick<AuxiliaryModelOption, 'modelName' | 'subscription' | 'agentSuffix' | 'icon' | 'routing'>>,
  selected: readonly string[],
): AuxiliaryModelOption[] {
  const options: AuxiliaryModelOption[] = [];
  for (const route of readRoutesSafely()) {
    const id = encodeAuxiliaryRouteRef(route.id);
    if (route.hidden && !selected.includes(id)) continue;
    const members = localCandidates(route);
    const head = members[0] ?? route.candidates[0];
    if (!head) continue;
    const usableMembers = members.filter((candidate) => usable.has(pinOf(candidate)));
    const sample = usable.get(pinOf(usableMembers[0] ?? head));
    const agentKind = agentOf(head.agentKind);
    options.push({
      id,
      label: route.name,
      group: route.parent?.name ?? route.name,
      providerId: route.parent ? `sroute:${route.parent.id}` : MINE,
      agentKind,
      modelId: route.parent ? head.model : route.id,
      modelName: route.parent ? (sample?.modelName ?? head.model) : route.name,
      budget: false,
      subscription: usableMembers.length > 0 && usableMembers.every((candidate) => usable.get(pinOf(candidate))?.subscription),
      agentSuffix: sample?.agentSuffix ?? '',
      ...(sample?.icon ? { icon: sample.icon } : {}),
      ...(route.parent && sample?.routing ? { routing: sample.routing } : {}),
      available: usableMembers.length > 0,
      route: { kind: route.parent ? 'merged' : 'route', name: route.parent?.name ?? route.name, members: members.length },
    });
  }
  for (const ref of selected) {
    if (!ref.startsWith('route:') || options.some((option) => option.id === ref)) continue;
    options.push({
      id: ref, label: '', group: '', providerId: MINE, agentKind: 'codex', modelId: ref, modelName: '',
      budget: false, subscription: false, agentSuffix: '', available: false,
      route: { kind: 'route', name: '', members: 0 },
    });
  }
  return options;
}
