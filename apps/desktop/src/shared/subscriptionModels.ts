/**
 * 「订阅直连」模型前缀 —— 带这些前缀的 model 经本地 anthropic-responses-bridge 走用户**个人订阅**
 * (ChatGPT / SuperGrok)的 OAuth 额度,而非公司 LiteLLM 网关计费:
 *   - `chatgpt/`(如 chatgpt/gpt-5.5)→ ChatGPT 订阅(codex 后端)
 *   - `xai/`(如 xai/grok-4.3)→ SuperGrok 订阅(api.x.ai)
 *
 * **单一入口**:compat-proxy 的路由判定(把这些前缀路由到 bridge)与 turn-cost 记账 gate
 * (把这些轮当订阅、真实计费恒 0)必须共用同一份前缀,否则会漂移 —— 路由当订阅直连、
 * 记账却当真实网关计费,就是「订阅用量算错进计费」。renderer 也用它判会话是否走订阅额度。
 */

/** ChatGPT 订阅直连前缀。 */
export const CHATGPT_MODEL_PREFIX = 'chatgpt/';
/** SuperGrok(xAI)订阅直连前缀。 */
export const XAI_MODEL_PREFIX = 'xai/';

/** 全部订阅直连前缀(compat-proxy 路由 + 记账 gate 共用)。 */
export const SUBSCRIPTION_DIRECT_MODEL_PREFIXES = [CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX] as const;

/**
 * model id 是否为「订阅直连」(bridge)模型。传归一化后或原始 id 均可(只看前缀)。
 * 归一化(normalizeModelIdForPricing)只剥尾部 `[..]`、保留前缀,故两者等价。
 */
export function isSubscriptionDirectModel(model: string | null | undefined): boolean {
  if (!model) return false;
  return SUBSCRIPTION_DIRECT_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

export {
  exclusiveXaiCatalogModelId,
  isExclusiveXaiModelId,
  isSubscriptionDirectRoute,
} from '@cindy/model-providers';
