import {
  isExclusiveXaiModelId,
  isSubscriptionDirectModel,
} from '@cindy/model-providers';

/**
 * 父会话来源已知时,保存的 Claude Code 子代理覆写是否注入。
 * 订阅前缀(`xai/` / `chatgpt/`)由 proxy 按请求路由,与父来源无关;
 * 裸独占 Grok 不能跟着非 xAI 父会话注入。
 */
export function shouldKeepSubagentOverrideForParent(input: {
  saved: string;
  providerId: string | null;
  parentOffersSaved: boolean;
  parentCopyDisabled: boolean;
  anyOffering: boolean;
  allOfferingsDisabled: boolean;
}): boolean {
  if (input.parentOffersSaved) return !input.parentCopyDisabled;
  if (isSubscriptionDirectModel(input.saved)) return true;
  if (isExclusiveXaiModelId(input.saved) && input.providerId !== 'xai') return false;
  if (input.providerId && input.anyOffering) return false;
  if (!input.anyOffering) return true;
  return !input.allOfferingsDisabled;
}
