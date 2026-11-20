import { isModelDisabled, isProviderDisabled } from '@cindy/model-providers';
import { readModelDisableOverrides } from './model-disable-store.js';

/**
 * 供应商级停用的直查入口(voice ASR / embedding 等非目录模型消费方用):这些链路
 * 的模型不在 chat/media 目录里,逐模型停用无从谈起,但「供应商整体停用」必须生效
 * —— 它们同样是经该供应商凭证的新付费调用(PR #744 review 第十六轮)。
 */
export function isProviderRouteSuspended(providerId: string): boolean {
  return isProviderDisabled(readModelDisableOverrides(), providerId);
}

/**
 * (供应商, 模型) 组合判定:供应商级停用或该模型条目被点名停用任一命中即真。
 * embedding 等「模型 id 可被逐条停用但不在 chat 目录」的消费方用
 * (PR #744 review 第十九轮)。
 */
export function isProviderModelRouteDisabled(providerId: string, modelId: string): boolean {
  const overrides = readModelDisableOverrides();
  return (
    isProviderDisabled(overrides, providerId) ||
    isModelDisabled(overrides, providerId, modelId)
  );
}
