/**
 * Route-guard verdicts shared by Desktop and the Node Host. Moved verbatim from
 * model-route-guard-live.ts; only the provider view list arrives as a port
 * (Desktop: getDesktopProviderService().listProviders({ catalog })).
 */

import {
  isModelDisabled,
  isProviderDisabled,
  nativeDefaultSourceId,
  type AgentKind,
  type ModelDisableOverrides,
  type ProviderView,
} from '@cindy/model-providers';

import {
  getActiveCatalog,
  isXdGatewayPaymentRequiredRoute,
} from './active-catalog.js';
import { readModelDisableOverrides } from './model-disable-store.js';
import {
  isRegistryTombstoneForConsumer,
  MODEL_PLANE_POLICIES,
} from './model-plane/modelPlanePolicy.js';
import {
  checkModelRoute,
  type ModelRouteGuardOptions,
  type ModelRouteVerdict,
} from './model-route-guard.js';

/** Provider views the guard judges against (Desktop: the provider service). */
export interface ModelRouteGuardPorts {
  listRouteGuardProviders(catalog?: ReturnType<typeof getActiveCatalog>): Promise<ProviderView[]>;
}

export function tombstoneGuardOptions(
  catalog: ReturnType<typeof getActiveCatalog>,
): ModelRouteGuardOptions {
  return {
    isPaymentRequiredTombstone: (providerId, modelId, agent) =>
      (providerId === null || providerId === 'xd') &&
      isXdGatewayPaymentRequiredRoute(modelId, agent),
    isRetiredTombstone: (providerId, modelId, agent) => {
      const providerIds = providerId ? [providerId] : MODEL_PLANE_POLICIES.keys();
      return [...providerIds].some((id) =>
        isRegistryTombstoneForConsumer(catalog.modelRegistry, id, modelId, agent),
      );
    },
  };
}

/** 该 agent 的静态原生默认来源偏好(nativeDefaultSourceId 的无 rail 近似)。 */
export function staticNativeDefaults(agent: AgentKind): readonly string[] {
  return agent === 'codex' ? ['openai', 'xd'] : ['xd'];
}

/**
 * 目录读取失败时的保守降级裁决:只凭本地 override 文件判(它不依赖钥匙串 / OAuth /
 * 网络,readModelDisableOverrides 是纯文件读)。原则:没配置过任何停用的用户
 * (绝大多数)不受目录故障影响照常放行;配置过的用户按「无法证明落点安全即拒」——
 * 目录故障时不能把停用当没发生(PR #744 review 第七轮):
 *   - 显式来源:override 直接命中(供应商级 / 该 (来源, 模型) 条目)⇒ reject;
 *   - 隐式来源:该模型在**任何**来源被停用、或该 agent 的静态原生默认来源被停用
 *     ⇒ 无法用真实 rail 证明实际落点是启用拷贝,保守 reject。
 * 近似性说明:rail 不可得,rail[0] 兜底落点无从判断 —— 宁可对配置过停用的用户在
 * 目录故障窗口内多拦,不漏放。
 */
export function overrideOnlyVerdict(
  agent: AgentKind,
  model: string,
  providerId: string | null,
): ModelRouteVerdict {
  let overrides: ModelDisableOverrides;
  try {
    overrides = readModelDisableOverrides();
  } catch {
    // override 文件都读不了:没有任何停用证据,放行(与「从未配置」不可区分)。
    return { kind: 'pass' };
  }
  if (providerId) {
    return isProviderDisabled(overrides, providerId) ||
      isModelDisabled(overrides, providerId, model)
      ? { kind: 'reject', reason: 'explicit-source-disabled' }
      : { kind: 'pass' };
  }
  const modelMentioned = Object.keys(overrides.disabledModels ?? {}).some((key) =>
    key.endsWith(`:${model}`),
  );
  const defaultSuspended = staticNativeDefaults(agent).some((id) =>
    isProviderDisabled(overrides, id),
  );
  return modelMentioned || defaultSuspended
    ? { kind: 'reject', reason: 'model-disabled' }
    : { kind: 'pass' };
}

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

/** The verdicts that read live provider views, bound to the host view list. */
export function createModelRouteGuard(ports: ModelRouteGuardPorts) {
  async function verdictForModelRoute(
    agent: AgentKind,
    model: string,
    providerId: string | null,
  ): Promise<ModelRouteVerdict> {
    const catalog = getActiveCatalog();
    const guardOptions = tombstoneGuardOptions(catalog);
    let views: ProviderView[];
    try {
      views = await ports.listRouteGuardProviders(catalog);
    } catch {
      const tombstoneVerdict = checkModelRoute([], agent, model, providerId, guardOptions);
      if (tombstoneVerdict.kind === 'reject') return tombstoneVerdict;
      return overrideOnlyVerdict(agent, model, providerId);
    }
    return checkModelRoute(views, agent, model, providerId, guardOptions);
  }

  /**
   * agent one-shot 兜底(help / 会话摘要 / 快照标签)是否被停用轴挡住。
   * 带具体模型时走完整裁决;不带模型(agent 默认一击)按**该 agent 的内部默认模型**
   * 走同一裁决(没有固定默认模型的 agent 跳过这一步),再叠加原生默认来源 suspended
   * 检查(默认模型不在目录时裁决 pass,来源级停用仍要拦)。
   */
  async function isAgentOneShotRouteDisabled(
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
      views = await ports.listRouteGuardProviders();
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
  }

  return { verdictForModelRoute, isAgentOneShotRouteDisabled };
}
