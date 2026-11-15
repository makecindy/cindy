/**
 * Model route decisions that read only the catalog and the local overrides, not the desktop provider
 * service: model-route-guard-live.ts loads that service (and, through it, Electron), so these live here
 * and the live file re-exports or wraps them. The Node Host imports this file and passes its own
 * provider listing to verdictForModelRouteWithProviders.
 */
import {
  isModelDisabled,
  isProviderDisabled,
  type AgentKind,
  type ModelDisableOverrides,
  type ProviderView,
} from '@cindy/model-providers';
import { getActiveCatalog, isXdGatewayPaymentRequiredRoute } from './active-catalog.js';
import { readModelDisableOverrides } from './model-disable-store.js';
import { isRegistryTombstoneForConsumer, MODEL_PLANE_POLICIES } from './model-plane/modelPlanePolicy.js';
import {
  checkModelRoute,
  shouldApplyExclusiveProviderReroute,
  type ModelRouteGuardOptions,
  type ModelRouteVerdict,
} from './model-route-guard.js';

/**
 * The exclusive-provider reroute decision against the live catalog. Kept apart from
 * model-route-guard-live.ts (which loads the desktop provider service and, through it, Electron) so
 * that sessionAgentSwitchHandler.ts loads in the Node Host; model-route-guard-live.ts re-exports it.
 */
export function shouldApplyExclusiveProviderRerouteLive(
  providerId: string | null | undefined,
): boolean {
  return shouldApplyExclusiveProviderReroute(providerId, getActiveCatalog().providers);
}

// Moved verbatim from model-route-guard-live.ts (exported for its remaining users there).
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
 * verdictForModelRoute (model-route-guard-live.ts) with the provider listing passed in: the desktop
 * passes its provider service, the Node Host its own.
 */
export async function verdictForModelRouteWithProviders(
  listRouteGuardProviders: (catalog: ReturnType<typeof getActiveCatalog>) => Promise<ProviderView[]>,
  agent: AgentKind,
  model: string,
  providerId: string | null,
): Promise<ModelRouteVerdict> {
  const catalog = getActiveCatalog();
  const guardOptions = tombstoneGuardOptions(catalog);
  let views: ProviderView[];
  try {
    views = await listRouteGuardProviders(catalog);
  } catch {
    const tombstoneVerdict = checkModelRoute([], agent, model, providerId, guardOptions);
    if (tombstoneVerdict.kind === 'reject') return tombstoneVerdict;
    return overrideOnlyVerdict(agent, model, providerId);
  }
  return checkModelRoute(views, agent, model, providerId, guardOptions);
}
