/**
 * 伙伴模型链里的模型组(model-groups.md §6.2)。存下来的一项带 `modelGroup`(组 id)和一个具体模型；
 * 运行时把它展开成这个组里没停用的来源(每项带同一个组 id，按组里的顺序)，伙伴的故障接替按展开后的链走：
 * 组内换完(从当前往后，再绕回前面的)才轮到备用链。组已删除或里面没有可用的来源时按存下的具体模型运行。
 * 只在应用首选与故障接替两处展开；保存、云同步与设置界面看到的始终是存下来的那一项。
 */
import type { BotModelRoute } from '../../shared/botModelChain.js';
import { modelRouteLocationKey } from '@cindy/maker-shared/model-route';
import type { ModelGroupCandidate, ModelGroupsConfig } from '../../shared/modelGroups.js';

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

/** 展开链里的模型组；同一个来源只留第一次出现的位置(重试同一个端点救不回来)。 */
export function expandBotModelGroups(chain: readonly BotModelRoute[], config: ModelGroupsConfig): BotModelRoute[] {
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
    const group = modelGroup ? config.routes.find((route) => route.id === modelGroup) : undefined;
    const members = group?.candidates.filter((candidate) => !candidate.off) ?? [];
    if (!group || members.length === 0) {
      push(plain);
      continue;
    }
    for (const candidate of members) push(modelGroupCandidateRoute(candidate, group.id, group.effort));
  }
  return out;
}
