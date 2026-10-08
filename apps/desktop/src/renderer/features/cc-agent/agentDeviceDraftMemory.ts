/**
 * 「Agent 在另一台电脑运行」草稿的模型选择记忆。
 *
 * 模型目录属于运行 Agent 的那台电脑，不能写进本机草稿记忆(lastByVendor / 模型预设)——
 * 否则回到本机任务时会带着本机没有的模型。这里按「电脑 + Agent」记住上一次的选择，
 * 只在本次运行内有效，与草稿里的 agentDeviceId 一样不跨重启。
 *
 * 每个模型各自的档位 / Fast 另由 agentDeviceModelMemory 按电脑持久化(跨重启);取回上一次
 * 选择时一并带上那台电脑的这份记忆，切到别的模型时据此还原该模型的档位。
 */
import { snapshotAgentDeviceModelMemory } from '@/state/agentDeviceModelMemory';

import type { DeviceLinkDraftSelection, RemoteDraftDefaults } from './deviceLinkDraftDefaults';

const memory = new Map<string, RemoteDraftDefaults>();

function key(deviceId: string, agentKind: string): string {
  return `${deviceId}:${agentKind}`;
}

export function rememberAgentDeviceSelection(
  deviceId: string,
  agentKind: string,
  selection: DeviceLinkDraftSelection,
): void {
  memory.set(key(deviceId, agentKind), {
    model: selection.model,
    modelChosenByUser: true,
    effort: selection.effort,
    fastMode: selection.fastMode,
    providerId: selection.providerId,
  });
}

export function recallAgentDeviceSelection(deviceId: string, agentKind: string): RemoteDraftDefaults | null {
  const last = memory.get(key(deviceId, agentKind));
  if (!last) return null;
  const providerModelMemory = snapshotAgentDeviceModelMemory(deviceId);
  return providerModelMemory ? { ...last, providerModelMemory } : last;
}

/** 测试用。 */
export function clearAgentDeviceSelectionMemory(): void {
  memory.clear();
}
