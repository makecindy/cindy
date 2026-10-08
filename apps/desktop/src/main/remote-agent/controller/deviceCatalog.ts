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
import type { ProviderView } from '@cindy/model-providers';

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
export async function readDeviceProviderViews(invoke: RemoteInvoke, deviceId: string): Promise<ProviderView[]> {
  const result = await invoke(deviceId, 'maker:provider:list', [
    { capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2] },
  ]);
  if (!result.ok) {
    throw Object.assign(new Error(result.error?.message ?? 'provider list unavailable'), { code: result.error?.code });
  }
  return parseDeviceProviderViews(result.result).filter((view) => view.remoteInvocationEnabled === true);
}
