import type { AgentKind } from '@cindy/maker-core';
import { effectiveSourceIdForModel, getModel, isModelSelectableForNewRoute } from '@cindy/model-providers';

import { readDeviceProviderViews } from '../remote-agent/controller/deviceCatalog';

/** 与普通任务共用授权目录；失败不回落到本机的同名供应商。 */
export async function readImRemoteProviderRoute(route: {
  agentDeviceId: string;
  agentKind: AgentKind;
  providerId: string | null;
  model: string;
}) {
  const { remoteBackgroundInvoke } = await import('../device-link');
  const providers = await readDeviceProviderViews(remoteBackgroundInvoke, route.agentDeviceId);
  // 已有远程任务可以未指定来源；只在执行端授权目录内按原生默认规则解析。
  // 显式来源失效仍拒绝，不换到另一个同名模型账号。
  const providerId = route.providerId ?? effectiveSourceIdForModel(providers, null, route.model, route.agentKind);
  const provider = providers.find((p) => p.id === providerId && p.connected && !p.suspended && p.agents.includes(route.agentKind));
  const model = provider && getModel(provider, route.model, route.agentKind);
  if (!provider || !model || !isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })) {
    throw new Error('[REMOTE_AGENT_UNAVAILABLE] Selected remote provider or model is unavailable.');
  }
  return { provider, model };
}

/** 权限档也取执行端能力，发起电脑可能没有安装该引擎。 */
export async function readImRemotePermissionModes(agentDeviceId: string, agentKind: AgentKind): Promise<string[]> {
  const { remoteBackgroundInvoke } = await import('../device-link');
  const response = await remoteBackgroundInvoke(agentDeviceId, 'maker:get-capabilities', [agentKind]);
  if (!response.ok) throw new Error(response.error?.message ?? 'Remote agent capabilities unavailable');
  const modes = (response.result as { permissionModes?: unknown } | null)?.permissionModes;
  if (!Array.isArray(modes) || !modes.length || !modes.every((mode) =>
    mode && typeof mode === 'object' && typeof mode.id === 'string' && mode.id.length > 0)) {
    throw new Error('Invalid remote agent permission modes');
  }
  return modes.map((mode) => mode.id);
}
