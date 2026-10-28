/**
 * 运行 Agent 的另一台电脑的模型目录(本机主进程读取)。
 *
 * 那台电脑经设备互联的 `maker:provider:list` 给出去敏后的供应商视图；Agent 在那台运行的任务
 * (以及它的协同 Worker)按这份目录选模型与来源。与渲染端 useDeviceProviders 同一个通道、同一份
 * 投影；只做最小校验，缺少 routing 的 Agent 补空 entry(与渲染端解析边界一致)。
 * 读取时只留那台电脑开了「允许被远程调用」的供应商(`remoteInvocationEnabled === true`)：
 * 换模型、协同 Worker、定时任务的默认来源都只能落在这些供应商上。
 */
import { CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2 } from '@cindy/device-link';
import { effectiveSourceIdForModel, getModel, isModelSelectableForNewRoute, isModelVisible, remoteInvocationModels, type ProviderView, type AgentKind } from '@cindy/model-providers';

type RemoteInvoke = (
  deviceId: string,
  channel: string,
  args: unknown[],
) => Promise<{ ok: boolean; result?: unknown; error?: { code?: string; message?: string } }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isModel(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0;
}

/** 解析那台电脑的供应商视图；格式不对时抛错(调用方按「目录不可用」处理)。 */
export function parseDeviceProviderViews(value: unknown): ProviderView[] {
  if (!isRecord(value) || !Array.isArray(value.providers)) throw new Error('Invalid provider list response');
  return value.providers.flatMap((item): ProviderView[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') return [];
    if (!Array.isArray(item.agents) || !item.agents.every((agent) => typeof agent === 'string')) return [];
    if (typeof item.connected !== 'boolean' || !isRecord(item.models)) return [];
    const models: Record<string, unknown[]> = {};
    for (const [agent, entries] of Object.entries(item.models)) {
      if (!Array.isArray(entries)) return [];
      models[agent] = entries.filter(isModel).map((entry) => ({
        efforts: [],
        defaultEffort: null,
        ...(entry as Record<string, unknown>),
      }));
    }
    const routing: Record<string, unknown> = isRecord(item.routing) ? { ...item.routing } : {};
    for (const agent of item.agents as string[]) {
      if (routing[agent] === undefined) routing[agent] = {};
    }
    return [{ ...item, models, routing } as unknown as ProviderView];
  });
}

/** 读那台电脑允许被远程调用的供应商视图。 */
export async function readDeviceProviderViews(invoke: RemoteInvoke, deviceId: string, options: { visibleOnly?: boolean } = {}): Promise<ProviderView[]> {
  const result = await invoke(deviceId, 'maker:provider:list', [
    { capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2] },
  ]);
  if (!result.ok) {
    throw Object.assign(new Error(result.error?.message ?? 'provider list unavailable'), { code: result.error?.code });
  }
  const providers = parseDeviceProviderViews(result.result).filter((view) => view.remoteInvocationEnabled === true).map(remoteInvocationModels);
  if (!options.visibleOnly) return providers;
  const visibility = isRecord(result.result) && isRecord(result.result.modelVisibilityOverrides)
    ? result.result.modelVisibilityOverrides : {};
  return providers.map((provider) => ({ ...provider, models: {
    ...provider.models,
    ...Object.fromEntries(provider.agents.map((agent) => [agent,
      (provider.models[agent] ?? []).filter((model) => {
        const override = visibility[`${agent}:${provider.id}:${model.id}`];
        return isModelVisible(typeof override === 'boolean' ? override : undefined, model.defaultEnabled);
      }).map((model) => ({ ...model, defaultEnabled: true }))])),
  } }));
}

/** 与普通任务共用授权目录；失败不回落到本机的同名供应商。 */
export async function readRemoteProviderRoute(route: {
  agentDeviceId: string;
  agentKind: AgentKind;
  providerId: string | null;
  model: string;
}) {
  const { remoteBackgroundInvoke } = await import('../../device-link');
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
