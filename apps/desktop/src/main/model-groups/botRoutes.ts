/**
 * 伙伴模型链里的模型组(model-groups.md §6.2)。存下来的一项带 `modelGroup`(组 id)和一个具体模型。
 * 应用首选时链保持原样(组用不了就按存下的具体模型)，由组的规则另行挑一个来源；
 * 故障接替时才把这一项展开成候选：此刻生效的组(时段例外改走的那条)的来源、原组的来源、存下的具体模型，
 * 每项带同一个组 id，接替先在这一段里往后、再绕回前面的，都试过才轮到备用链。
 * 保存、云同步与设置界面看到的始终是存下来的那一项。
 */
import type { BotModelRoute } from '../../shared/botModelChain.js';
import { modelRouteLocationKey } from '@cindy/maker-shared/model-route';
import type { ModelGroupCandidate, ModelGroupRoute, ModelGroupsConfig } from '../../shared/modelGroups.js';
import { modelGroupRouteFor } from './routeFor.js';

const harnessOf = (kind: ModelGroupCandidate['agentKind']): BotModelRoute['harness'] => (kind === 'cc' ? 'claude' : kind);

const runtimeKey = (route: BotModelRoute) =>
  `${route.harness}\u0000${route.providerId ?? ''}\u0000${route.model}${modelRouteLocationKey(route.agentDeviceId)}`;

/** 一个组来源作为伙伴路由：带上组的推理强度(应用时按模型支持再核对)，组不存 Fast。 */
export function modelGroupCandidateRoute(
  candidate: Pick<ModelGroupCandidate, 'agentKind' | 'providerId' | 'model' | 'agentDeviceId'>,
  groupId: string,
  effort: string | undefined,
): BotModelRoute {
  return {
    harness: harnessOf(candidate.agentKind),
    model: candidate.model,
    providerId: candidate.providerId,
    effort: effort ?? '',
    fastMode: false,
    ...(candidate.agentDeviceId ? { agentDeviceId: candidate.agentDeviceId } : {}),
    modelGroup: groupId,
  };
}

const members = (route: ModelGroupRoute | undefined, groupId: string) =>
  (route?.candidates ?? []).filter((candidate) => !candidate.off)
    .map((candidate) => modelGroupCandidateRoute(candidate, groupId, route?.effort));

/** 从这些组出发，经时段例外能走到的组 id(含自身，按先后)。 */
function reachableGroupIds(start: readonly string[], config: ModelGroupsConfig): string[] {
  const ids: string[] = [];
  const queue = [...start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (ids.includes(id)) continue;
    ids.push(id);
    for (const item of config.routes.find((route) => route.id === id)?.exceptions ?? []) {
      if (item.use !== 'vision') queue.push(item.use.routeId);
    }
  }
  return ids;
}

/**
 * 故障接替用的候选链。时段例外按 `now` 取此刻生效的组放在最前，接着原组、再是时段例外能改走到的其他组
 * (选的时候可能还在另一个时段)，最后是存下的具体模型。同一个来源只留第一次出现的位置
 * (重试同一个端点救不回来)。组已删除时这一项就是存下的具体模型。
 */
export function expandBotModelGroups(chain: readonly BotModelRoute[], config: ModelGroupsConfig, now: number): BotModelRoute[] {
  const seen = new Set<string>();
  const out: BotModelRoute[] = [];
  const push = (route: BotModelRoute) => {
    const key = runtimeKey(route);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(route);
  };
  for (const entry of chain) {
    const { modelGroup, ...plain } = entry;
    const target = modelGroup ? modelGroupRouteFor(config, { type: 'route', id: modelGroup }, now) : null;
    if (!modelGroup || !target || target.outcome === 'missing') {
      push(plain);
      continue;
    }
    const others = reachableGroupIds([modelGroup], config).filter((id) => id !== target.route.id);
    const segment = [
      ...members(target.route, modelGroup),
      ...others.flatMap((id) => members(config.routes.find((route) => route.id === id), modelGroup)),
      { ...plain, modelGroup },
    ];
    for (const route of segment) push(route);
  }
  return out;
}

/**
 * 影响伙伴选路的组配置：链里每个组，以及经时段例外能走到的组的完整定义(来源、选法、例外、推理强度)。
 * 进套用判断的配置键：改了这些，伙伴下一轮重新按组的规则选。链里没有组时为 undefined，配置键与原来一致。
 * 只看配置不看时间：到了时段边界不会自己换。
 */
export function botModelGroupsSignature(chain: readonly BotModelRoute[], config: ModelGroupsConfig): string | undefined {
  const start = chain.flatMap((route) => (route.modelGroup ? [route.modelGroup] : []));
  if (start.length === 0) return undefined;
  return JSON.stringify(reachableGroupIds(start, config).sort()
    .map((id) => config.routes.find((route) => route.id === id) ?? { id, missing: true }));
}
