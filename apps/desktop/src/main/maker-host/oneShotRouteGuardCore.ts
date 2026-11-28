import { isProviderDisabled, nativeDefaultSourceId, type AgentKind, type ProviderView } from '@cindy/model-providers';
import { readModelDisableOverrides } from './model-disable-store.js';
import { staticNativeDefaults } from './model-route-guard-catalog.js';
import type { ModelRouteVerdict } from './model-route-guard.js';

/**
 * agent one-shot 不带 model 时各 agent 的内部默认模型(与 maker-core base-agent
 * OneShotOptions 文档口径一致)。裁决要落到具体默认模型上:只查来源级 suspended
 * 会漏掉「恰好停用了这一个模型」的 override(PR #744 review 第十五轮)。
 *
 * Codex 不在表里:它的 one-shot 不写死型号,默认模型由 app-server 按账号与配置
 * 现选,派发前拿不到。Codex 在 thread/start 之后、turn/start 之前把实际选中的模型
 * 经 `beforeDispatch(route)` 交回,调用方用 `route.model` 再调一次本函数,模型级
 * 停用仍在 prompt 发出前拦住。
 */
const DEFAULT_ONESHOT_MODEL: Partial<Record<AgentKind, string>> = {
  'claude-code': 'claude-haiku-4-5',
  // pi oneShot 未实现(BaseAgent 默认抛 NotSupported);占位与 claude 同款网关小模型。
  pi: 'claude-haiku-4-5',
};

/**
 * agent one-shot 兜底(help / 会话摘要 / 快照标签)是否被停用轴挡住。
 * 带具体模型时走完整裁决;不带模型(agent 默认一击)按**该 agent 的内部默认模型**
 * 走同一裁决(没有固定默认模型的 agent 跳过这一步),再叠加原生默认来源 suspended
 * 检查(默认模型不在目录时裁决 pass,来源级停用仍要拦)。
 */
export function createOneShotRouteGuard({ listRouteGuardProviders, verdictForModelRoute }: {
  listRouteGuardProviders(): Promise<ProviderView[]>;
  verdictForModelRoute(agent: AgentKind, model: string, providerId: string | null): Promise<ModelRouteVerdict>;
}) {
  return async function isAgentOneShotRouteDisabled(
    agent: AgentKind,
    model?: string,
  ): Promise<boolean> {
    if (model) {
      // reroute 同样视为不可发:one-shot 无法携带显式 providerId,实际派发仍会落在
      // 被停用的隐式默认来源上 —— 只有 pass 才允许(PR #744 review 第五轮)。
      return (await verdictForModelRoute(agent, model, null)).kind !== 'pass';
    }
    const defaultModel = DEFAULT_ONESHOT_MODEL[agent];
    if (defaultModel && (await verdictForModelRoute(agent, defaultModel, null)).kind !== 'pass') {
      return true;
    }
    let views: ProviderView[];
    try {
      views = await listRouteGuardProviders();
    } catch {
      // 目录故障降级:静态原生默认来源被 override 停用即视为不可发(同
      // overrideOnlyVerdict 的隐式近似;override 也读不了则按无停用证据放行)。
      try {
        const overrides = readModelDisableOverrides();
        return staticNativeDefaults(agent).some((id) => isProviderDisabled(overrides, id));
      } catch {
        return false;
      }
    }
    const rail = views.filter((p) => p.connected && p.agents.includes(agent));
    const defaultId = nativeDefaultSourceId(rail, agent);
    if (!defaultId) return false;
    return rail.find((p) => p.id === defaultId)?.suspended === true;
  };
}
