/**
 * 智谱 GLM Coding Plan 的来源判定 ——「Coding Plan 默认不采信报错原文里的时刻」的唯一例外。
 *
 * 判据是**本机目录里的供应商信息**，不是报错文案：只有真正指向智谱 / Z.ai 的 Coding Plan
 * 接入端点(`/api/anthropic` 或 `/api/coding/*`)的来源才算数。按量付费的 GLM 连接走
 * `/api/paas/*`，不在其中——那种来源的 429 是分钟级速率限制，不能当周期额度。
 *
 * 判定沿用设置页「查看套餐用量」那套同一份逻辑(`isZhipuCodingPlanProvider`)，避免两处
 * 对「什么是 GLM Coding Plan」各说各话。
 */

import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { isZhipuCodingPlanProvider } from '../maker-host/provider-account-usage.js';

/**
 * 会话实际使用的来源是不是智谱 GLM Coding Plan。
 *
 * @param providerId 会话路由里的来源 id（本机目录里的 provider id）。
 */
export function isGlmCodingPlanProviderId(providerId: string | null | undefined): boolean {
  if (!providerId) return false;
  const provider = getActiveCatalog().providers.find(entry => entry.id === providerId);
  return isZhipuCodingPlanProvider(provider);
}
