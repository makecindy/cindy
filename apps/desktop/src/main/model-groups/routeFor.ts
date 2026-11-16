/**
 * 选中的路线此刻实际要走哪条路线。纯函数：新任务解析(resolver.ts)与撞配额时的提议(switchOffer.ts)共用。
 */
import {
  findModelGroupRoute,
  modelGroupHoursMatch,
  type ModelGroupAppliedException,
  type ModelGroupRoute,
  type ModelGroupSelection,
  type ModelGroupsConfig,
} from '../../shared/modelGroups.js';

function hoursTarget(route: ModelGroupRoute, localHour: number): string | null {
  for (const item of route.exceptions ?? []) {
    if (item.when.type === 'hours' && item.use !== 'vision' && modelGroupHoursMatch(item.when, localHour)) return item.use.routeId;
  }
  return null;
}

/**
 * 时段例外：落在时段里就改走另一条路线，那条路线自己的时段例外接着看。指向的路线不存在或绕回走过的路线时，
 * 整条改道作废，按原路线照常选。
 */
function followHours(start: ModelGroupRoute, config: ModelGroupsConfig, localHour: number) {
  const visited = new Set([start.id]);
  const via: ModelGroupAppliedException[] = [];
  let route = start;
  for (let targetId = hoursTarget(route, localHour); targetId; targetId = hoursTarget(route, localHour)) {
    const next = config.routes.find((item) => item.id === targetId);
    if (!next || visited.has(next.id)) return { route: start, via: [] };
    visited.add(next.id);
    via.push({ type: 'hours', viaRouteName: next.name });
    route = next;
  }
  return { route, via };
}

/**
 * 选中的路线此刻实际要走的路线：先看时段例外，推理强度取最后走的那条路线的。组已删除为 missing。
 * 新任务解析与撞配额时的「换来源继续」共用这一份。
 */
export function modelGroupRouteFor(
  config: ModelGroupsConfig,
  selection: ModelGroupSelection,
  now: number,
):
  | { outcome: 'missing'; groupName: string }
  | { outcome: 'found'; groupName: string; route: ModelGroupRoute; via: ModelGroupAppliedException[] } {
  const base = findModelGroupRoute(config, selection);
  if (!base) return { outcome: 'missing', groupName: '' };
  const { route, via } = followHours(base, config, new Date(now).getHours());
  return { outcome: 'found', groupName: base.name, route, via };
}
