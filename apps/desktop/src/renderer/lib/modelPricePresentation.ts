/**
 * 按「行来源 + 行引擎」解析出这一行该显示的报价 —— 模型选择器与设置页 → 模型列表共用。
 *
 * 为什么必须共用而不是各写一份：这段逻辑里有三条**看不出来但错了就会显示假价**的判断，
 * 复制一份必然漂：
 *   1. XD 实际报价与非 XD 的 Catalog 参考价是**两份独立快照**，只按行来源选快照，
 *      相同 modelId 不跨 provider 复用或兜底。
 *   2. XD 且报价来自 gateway 时要叠 `CatalogModel.cost`（服务端下发的折后展示价），
 *      由 `modelPricePresentation` 与标准价跑比例一致性校验后才认定为折扣。
 *   3. 非 XD 的 `approximate` 报价在展示时抹掉近似标记（`displayQuote`）——
 *      参考价本身就是估算，再挂一次「近似」是重复表达。
 *
 * device-link 远程与「行来源未知需回溯解析」这两件事留在调用方：前者是选择器特有的
 * 协议缺口（控制端价格不能与被控端 cost 拼成一个结果），后者需要面板级的当前来源上下文。
 * 设置页两者都不涉及——它永远知道自己在哪个供应商面板、哪个引擎。
 */

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { modelPricePresentation, type ModelPricePresentation } from '@/lib/modelPriceFormat';

import { getModel, type ProviderView } from '@cindy/model-providers';

import { getModelPriceQuote } from '../../shared/modelPriceQuote';
import type { ModelPricingCatalog } from '../../shared/regionalMoney';

export interface ModelPricePresentationInput {
  /** 该行的来源供应商 id；已由调用方解析完毕（null = 无供应商概念的 flat 列表）。 */
  providerId: string | null;
  /** 查报价用的模型 id：有 wire id 就传 wire id（同一逻辑模型换引擎可能换一条报价）。 */
  modelId: string;
  /** 该行的**生效引擎**，不是面板级的当前引擎。 */
  agent: AgentKind | null;
  providers: ProviderView[];
  gatewayPricing: ModelPricingCatalog | null;
  referencePricing: ModelPricingCatalog | null;
}

export function resolveModelPricePresentation({
  providerId,
  modelId,
  agent,
  providers,
  gatewayPricing,
  referencePricing,
}: ModelPricePresentationInput): ModelPricePresentation | null {
  const pricing = providerId === 'xd' ? gatewayPricing : referencePricing;
  const quote = getModelPriceQuote(pricing, providerId, modelId, agent ?? undefined);
  if (providerId === 'xd' && (!quote || quote.source === 'gateway')) {
    // 网关快照还没到（null）且这一行也没有 quote：什么都不画，别先画一个错的。
    if (!quote && gatewayPricing == null) return null;
    const provider = providers.find((item) => item.id === providerId);
    const effectiveCost = provider && agent ? getModel(provider, modelId, agent)?.cost : undefined;
    return modelPricePresentation(quote ?? null, effectiveCost);
  }
  if (!quote) return null;
  const displayQuote = quote.approximate ? { ...quote, approximate: false } : quote;
  return modelPricePresentation(displayQuote, undefined);
}
