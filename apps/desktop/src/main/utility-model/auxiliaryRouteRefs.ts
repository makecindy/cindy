/**
 * 辅助模型的一格选了智能路由(2026-11-26 用户裁决)时，这条路由在辅助模型里怎么用。只在 Desktop：Node Host 没有智能路由。
 *
 * - 展开：路由里本机、没停用的来源换成一次性请求用的目录钉，按路由里的先后排；路由此刻会选的那个(按它的选法与
 *   额度，dry run，不推进「轮流」、不记进「最近的选择」)排到最前。辅助请求是本机直接调 API，别的电脑与分享来的
 *   来源用不了，不列。
 * - 选项：设置里那几格的候选里，每条路由(自己排的，以及合并整个供应商的路由在每个模型上的展开)也是一项。
 *
 * 「此刻会选的」放在内存里，读链时同步给出、在后台更新(最多 30 秒一次)，读链本身不等任何读取。
 */
import { encodeCatalogModelPin, type CatalogModelPinRoute } from '../../shared/catalogModelPin.js';
import { encodeAuxiliaryRouteRef } from '../../shared/auxiliaryModelChain.js';
import { OWN_ROUTES_PROVIDER_ID, type AuxiliaryModelOption } from '../../shared/auxiliaryModelSettings.js';
import type { ModelGroupCandidate, ModelGroupRoute } from '../../shared/modelGroups.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { readModelGroupsConfig, readModelGroupsConfigForSelected } from '../model-groups/store.js';
import { modelGroupRouteFor } from '../model-groups/routeFor.js';

const PREFERRED_TTL_MS = 30_000;
const MINE = OWN_ROUTES_PROVIDER_ID;

/** 智能路由的配置读不出来时按没有路由处理：辅助模型的设置与请求不因它失败。 */
function routes(): ModelGroupRoute[] {
  try {
    return readModelGroupsConfig().routes;
  } catch {
    return [];
  }
}

const agentOf = (kind: ModelGroupCandidate['agentKind']): CatalogModelPinRoute['agentKind'] => (kind === 'cc' ? 'claude-code' : kind);

function pinOf(candidate: Pick<ModelGroupCandidate, 'agentKind' | 'providerId' | 'model'>): string {
  return encodeCatalogModelPin({ providerId: candidate.providerId, agentKind: agentOf(candidate.agentKind), model: candidate.model });
}

/** 路由里辅助请求能用的来源：本机、没停用。 */
function localCandidates(route: ModelGroupRoute): ModelGroupCandidate[] {
  return route.candidates.filter((candidate) => !candidate.off && !candidate.agentDeviceId);
}

/** 路由此刻会先用的本机来源；pin 为 null = 这次解析没选出本机来源或解析失败(同样等满刷新间隔再试)。 */
const preferred = new Map<string, { scope: string; pin: string | null; at: number }>();
const refreshing = new Set<string>();

function refreshPreferred(routeId: string): void {
  const scope = activeOwnerScopeKey();
  const key = `${scope}\u0000${routeId}`;
  const known = preferred.get(key);
  if (refreshing.has(key) || (known && Date.now() - known.at < PREFERRED_TTL_MS)) return;
  refreshing.add(key);
  // 按需取：解析器带着供应商目录与额度读取，不让辅助链的模块一加载就拉进来。
  void import('../model-groups/desktopResolver.js')
    .then(({ resolver }) => resolver.resolve({
      selection: { type: 'route', id: routeId }, dryRun: true, cachedQuota: true, location: { agentDeviceId: null },
    }))
    .then((result) => {
      if (activeOwnerScopeKey() !== scope) return;
      // 每次尝试都记下时间：选不出本机来源或失败时也等满刷新间隔，不随每次读辅助链重新解析。
      preferred.set(key, { scope, pin: result.outcome === 'routed' && !result.route.agentDeviceId ? pinOf(result.route) : null, at: Date.now() });
    })
    .catch(() => { if (activeOwnerScopeKey() === scope) preferred.set(key, { scope, pin: null, at: Date.now() }); })
    .finally(() => refreshing.delete(key));
}

/**
 * 一条路由里本机、没停用的来源，按「路由此刻会选的排第一、其余照路由里的先后」排好。路由不存在时为空。
 * 辅助模型与 Subagent 共用：它们都只能用本机的来源，也都不能等一次选路。
 */
export function localRouteCandidatesInPickOrder(routeId: string): ModelGroupCandidate[] {
  let config: ReturnType<typeof readModelGroupsConfigForSelected>;
  try {
    // 按已选的路由解析：合并路由只剩一个能用连接时照样展开到它。
    config = readModelGroupsConfigForSelected();
  } catch {
    return [];
  }
  // 按此刻生效的那条展开：时段例外把这条路由改走另一条时，用那一条的成员(与选路同一个判断)。
  const target = modelGroupRouteFor(config, { type: 'route', id: routeId }, Date.now());
  if (target.outcome !== 'found') return [];
  const members = localCandidates(target.route);
  if (members.length === 0) return [];
  refreshPreferred(routeId);
  const first = preferred.get(`${activeOwnerScopeKey()}\u0000${routeId}`)?.pin;
  const at = first ? members.findIndex((candidate) => pinOf(candidate) === first) : -1;
  return at > 0 ? [members[at]!, ...members.filter((_, index) => index !== at)] : members;
}

/** 一条路由在辅助模型里依次试的目录钉；路由不存在或本机没有能用的来源时为空。 */
export function expandAuxiliaryRouteRef(routeId: string): string[] {
  return [...new Set(localRouteCandidatesInPickOrder(routeId).map(pinOf))];
}

/**
 * 设置里那几格的路由候选。`usable` = 此刻能直接用的具体模型(同一份候选里的 id)：路由里至少有一个成员在其中才算能选。
 * 合并整个供应商的路由在每个模型上展开成一项，归在那条路由下面(界面按它画成一个带路由角标的「供应商」)；
 * 自己排的路由归在一起。用户隐藏的合并路由不列，除非已经选着它。
 */
export function buildAuxiliaryRouteOptions(usable: ReadonlyMap<string, AuxiliaryModelOption>, selected: readonly string[]): AuxiliaryModelOption[] {
  const options: AuxiliaryModelOption[] = [];
  for (const route of routes()) {
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
      // 合并整个供应商的路由：与选模型面板同一个格位标识(sroute:<id>)，模型行是那个模型；
      // 自己排的路由：都归在一格里(sroute:mine)，每条路由是一行。两种都带 sroute: 前缀，侧栏把它们排在最前；只有合并供应商的那种加路由角标。
      providerId: route.parent ? `sroute:${route.parent.id}` : MINE,
      agentKind,
      modelId: route.parent ? head.model : route.id,
      modelName: route.parent ? (sample?.modelName ?? head.model) : route.name,
      budget: false,
      subscription: usableMembers.length > 0 && usableMembers.every((candidate) => usable.get(pinOf(candidate))?.subscription),
      agentSuffix: sample?.agentSuffix ?? '',
      ...(sample?.icon ? { icon: sample.icon } : {}),
      // 品牌图形跟成员走：合并的 Anthropic 画 Anthropic 的图形。
      ...(route.parent && sample?.routing ? { routing: sample.routing } : {}),
      available: usableMembers.length > 0,
      route: { kind: route.parent ? 'merged' : 'route', name: route.parent?.name ?? route.name, members: members.length },
    });
  }
  // 选着的路由已经删掉了：留一项不可用的，界面能认出它、能换掉，不显示成一串 id。
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
