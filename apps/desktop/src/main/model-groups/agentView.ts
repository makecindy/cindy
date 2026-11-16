/**
 * 给 Agent 看的模型组：只列这台电脑当前账号建的模式及其来源(稳定 id、名称、选法、推理强度、例外)，
 * 不含额度、凭证或别的电脑上的配置。创建 Worker 时用 routes[].id 作为 model_group_id(model-groups.md §6.2)。
 */
import type { ModelGroupsConfig } from '../../shared/modelGroups.js';

const AGENT = { cc: 'claude-code', codex: 'codex', pi: 'pi' } as const;

export function modelGroupsAgentView(config: ModelGroupsConfig) {
  return {
    scope: 'local' as const,
    routes: config.routes.map((route) => ({
      id: route.id,
      name: route.name,
      strategy: route.strategy,
      ...(route.effort ? { effort: route.effort } : {}),
      candidates: route.candidates.map((candidate) => ({
        agent: AGENT[candidate.agentKind],
        model: candidate.model,
        provider_id: candidate.providerId,
        // 与 create_worker / list_available_models 同一写法："local" = 这台电脑。
        agent_device_id: candidate.agentDeviceId ?? 'local',
        ...(candidate.off ? { off: true } : {}),
      })),
      ...(route.exceptions?.length ? {
        exceptions: route.exceptions.map((item) => (item.when.type === 'hours' && typeof item.use === 'object'
          ? { when: 'hours' as const, from: item.when.from, to: item.when.to, use_route_id: item.use.routeId }
          : { when: 'image' as const, use: 'vision' as const })),
      } : {}),
    })),
  };
}
