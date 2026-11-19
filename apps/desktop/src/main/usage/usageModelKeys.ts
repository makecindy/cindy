/**
 * The usage model keys and the subscription estimate price, moved verbatim out of usageHistory.ts
 * (which imports Electron for its disk cache) so the turn usage recorders' cores (3c) and the Node
 * Host use the same functions. usageHistory.ts imports them back and re-exports its former exports.
 */
import type { ModelPricingMap } from './modelPricingCore.js';
import {
  getClaudeSubscriptionValuePrice,
  getCodexProviderSubscriptionValuePrice,
  getCodexSubscriptionValuePrice,
  getSubscriptionDirectValuePrice,
  type ModelPriceOverridesSnapshot,
} from './referenceModelPricingCore.js';
import type { ModelPriceQuote } from '../../shared/regionalMoney.js';

const CODEX_BILLING_MODEL_SUFFIX_RE = /#billing=(api|subscription)$/;

export function displayModelName(model: string): string {
  return model.replace(CODEX_BILLING_MODEL_SUFFIX_RE, '');
}

/** `#billing=subscription` 标记行 —— Claude / Codex 订阅共用同一后缀语义。 */
export function isSubscriptionUsageModel(model: string): boolean {
  return model.endsWith('#billing=subscription');
}

export function codexApiUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=api`;
}

export function codexSubscriptionUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=subscription`;
}

/** Claude 订阅轮的按模型记账 key(register.ts 消费)—— 与 codex 同一订阅标记后缀。 */
export function claudeSubscriptionUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=subscription`;
}

/** Pi 订阅轮与其它 agent 共用 billing 后缀，但保留独立 agentKind。 */
export function piSubscriptionUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=subscription`;
}

/**
 * 订阅行的估算价选取,按 agent 分流:
 *   - codex → 订阅直连(chatgpt/ / xai/)registry 参考价 → OpenAI registry 参考价
 *     → Anthropic registry 参考价(Codex 显式选内置 anthropic 的 Claude.ai 订阅轮;
 *     模型 id 只会命中各自 provider 的路由,依次尝试不会串价)
 *   - pi → 先按订阅直连估价(agent=pi,才能命中设置里的 Pi 价格覆盖),
 *     再依次回退 Codex(OpenAI)与 Anthropic registry 参考价
 *     (Pi 可跨三类 provider,按模型 id 路由,依次尝试不会串价)
 *   - claude-code → Anthropic registry 参考价
 * 各级都 miss → undefined(该行只显示 token,不臆造金额)。
 */
export function getSubscriptionValuePriceFor(
  agentKind: 'claude-code' | 'codex' | 'pi' | 'media' | 'auxiliary',
  model: string,
  pricing: ModelPricingMap | null,
  at?: string | Date,
  overrides?: ModelPriceOverridesSnapshot,
): ModelPriceQuote | undefined {
  if (agentKind === 'media' || agentKind === 'auxiliary') return undefined;
  if (agentKind === 'codex') {
    return (
      getSubscriptionDirectValuePrice(model, 'codex', pricing, at, overrides) ??
      getCodexSubscriptionValuePrice(model, pricing, at, overrides) ??
      getCodexProviderSubscriptionValuePrice('anthropic', model, pricing, at, overrides)
    );
  }
  if (agentKind === 'pi') {
    return (
      getSubscriptionDirectValuePrice(model, 'pi', pricing, at, overrides) ??
      getCodexSubscriptionValuePrice(model, pricing, at, overrides) ??
      getClaudeSubscriptionValuePrice(model, pricing, at, overrides)
    );
  }
  return (
    getSubscriptionDirectValuePrice(model, 'claude-code', pricing, at, overrides) ??
    getClaudeSubscriptionValuePrice(model, pricing, at, overrides)
  );
}
