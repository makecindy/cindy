/**
 * modelMismatch —— 「用户所选模型 vs 本轮实际模型」的不一致判定纯函数。
 *
 * 背景:模型供应商侧可能因内容安全拒答回退(refusal_fallback / serverRefusalFallback)、
 * 高负载临时切流或网关路由映射,把请求交给另一个模型响应(例如 claude-fable-5-2 →
 * claude-opus-4-8)。SDK 会在 done 事件的 modelUsage 里如实上报本轮实际跑过的模型集合,
 * 本模块提供确定性的判定逻辑(规则 9:判定用代码不用 prompt),由 main 在 turn 结束时
 * 调用,命中后把结果 patch 进该轮收尾 assistant 的 agent_meta。
 *
 * 判定口径(保守,宁可漏报不误报):
 *   - 只在「所选模型是 Anthropic 家族」时判定;网关 / 订阅直连模型(gpt-5.5、
 *     chatgpt/ 前缀等)的路由语义不同,不参与。
 *   - 本轮实际模型集合里只看 Anthropic 条目;subagent(Task)按设计就会跑
 *     别的模型(如 Haiku),所以判定条件是「所选家族在集合里完全缺席」,
 *     而不是「出现了别的模型」。
 *   - 家族比较用 canonical key:去 [1m] 等方括号后缀、去 -YYYYMMDD 日期、
 *     去 vendor 路由前缀、点横等价、去 claude- 前缀,大小写不敏感。
 */

import { stripCodexGatewayWirePrefix } from '@cindy/model-providers';

/** 判定结果:selected / actual 均为原始 raw id(展示层再折算短标签)。 */
export interface ModelMismatchInfo {
  /** 本轮实际下发给引擎的所选模型 raw id(turn start 快照,含 runtime override)。 */
  selected: string;
  /** 本轮实际承接主要输出的 Anthropic 模型 raw id。 */
  actual: string;
  /**
   * 可明确归因到外部模型供应商时的展示名(如 'Anthropic'、'OpenRouter')。
   * Cindy AI 网关(xd)或来源不明时省略,UI 回退为通用「模型供应商」文案。
   * append-only 可选字段,旧端自动忽略。
   */
  providerName?: string;
}

/** 判定外部模型供应商展示名所需的最小路由上下文。 */
export interface ModelMismatchProviderContext {
  providerId?: string | null;
  providerName?: string | null;
  subscriptionKind?: 'claude' | 'codex' | 'xai' | null;
  observedClaudeRoute?: 'subscription' | 'gateway' | null;
  officialAnthropicApi?: boolean;
  billingRoute?: 'subscription' | 'xd-gateway' | 'provider-api' | 'unknown';
}

/**
 * 解析适合直接展示给用户的外部模型供应商名称。
 *
 * - Cindy AI / XD 网关(xd)一律返回 undefined,UI 走通用「模型供应商」保底,
 *   避免把上游模型回退误导成 Cindy 自行更换模型。
 * - Claude 官方订阅或官方 Anthropic API 统一返回 'Anthropic',不泄露本机自定义账号别名。
 * - 显式第三方供应商(如 OpenRouter、自建网关)返回其展示名;若名字本身是 Cindy 品牌则回退。
 */
export function resolveModelMismatchProviderName(
  ctx: ModelMismatchProviderContext,
): string | undefined {
  const providerId = ctx.providerId?.trim() || null;
  if (providerId === 'xd' || ctx.billingRoute === 'xd-gateway') {
    return undefined;
  }
  if (
    ctx.subscriptionKind === 'claude' ||
    ctx.billingRoute === 'subscription' ||
    ctx.officialAnthropicApi === true ||
    providerId === 'anthropic' ||
    (providerId === null && ctx.observedClaudeRoute === 'subscription')
  ) {
    return 'Anthropic';
  }
  const name = ctx.providerName?.trim();
  if (!name || /^cindy(\s+ai)?$/i.test(name)) {
    return undefined;
  }
  return name;
}

/** detectClaudeModelMismatch 的实际模型入参:模型 id + 该模型本轮输出 token 数。 */
export interface ActualModelEntry {
  model: string;
  /** 本轮该模型的输出 token 增量;用于在多模型时挑「主要承接者」。缺省按 0。 */
  outputTokens?: number;
}

/**
 * raw model id → canonical 家族 key。
 * 清洗顺序与 renderer 的 formatModelShortLabel 对齐:
 * trim → 小写 → 去尾部 [..] 段 → 去 -YYYYMMDD / -latest 尾缀 → 去 vendor
 * 路由前缀(us.anthropic. / anthropic. / codex/)→ 点转横 → 去 claude- 前缀。
 * 例:'claude-fable-5[1m]' / 'us.anthropic.claude-fable-5-20260115' → 'fable-5'。
 */
export function canonicalModelFamilyKey(modelId: string | null | undefined): string {
  if (typeof modelId !== 'string') return '';
  let id = modelId.trim().toLowerCase();
  if (!id) return '';
  id = id.replace(/\[[^\]]*\]\s*$/, '').trim();
  id = id.replace(/-\d{8}$/, '').replace(/-latest$/, '');
  id = stripCodexGatewayWirePrefix(
    id.replace(/^us\.anthropic\./, '').replace(/^eu\.anthropic\./, '').replace(/^anthropic\./, ''),
  );
  id = id.replace(/\./g, '-');
  id = id.replace(/^claude-/, '');
  return id;
}

/** canonical key 是否属于 Anthropic 家族(claude- 前缀已剥,按家族词判)。 */
function isAnthropicFamilyKey(key: string): boolean {
  return /^(opus|sonnet|haiku|fable|mythos)(-|$)/.test(key);
}

/**
 * 判定本轮是否发生了「所选模型被供应商改派 / 回退」。
 *
 * @param selectedModel 本轮下发给引擎的所选模型 raw id(turn start 快照;'unknown' / 空跳过)
 * @param actualEntries 本轮 modelUsage delta 里出现过的模型条目
 * @param providerName 可选:能明确归因到的外部模型供应商名(如 'Anthropic')
 * @returns 命中返回 { selected, actual, providerName? };未命中或无法判定返回 null
 */
export function detectClaudeModelMismatch(
  selectedModel: string | null | undefined,
  actualEntries: readonly ActualModelEntry[],
  providerName?: string,
): ModelMismatchInfo | null {
  const selectedKey = canonicalModelFamilyKey(selectedModel);
  if (!selectedKey || selectedKey === 'unknown' || !isAnthropicFamilyKey(selectedKey)) return null;

  const anthropicEntries = actualEntries.filter((e) =>
    isAnthropicFamilyKey(canonicalModelFamilyKey(e.model)),
  );
  if (anthropicEntries.length === 0) return null;
  if (anthropicEntries.some((e) => canonicalModelFamilyKey(e.model) === selectedKey)) return null;

  // 所选家族整轮缺席 → 主线被替换。挑输出 token 最多的条目当「实际承接者」
  // (subagent 输出通常远小于主线,取 max 基本就是主线实际模型)。
  let picked = anthropicEntries[0];
  for (const e of anthropicEntries) {
    if ((e.outputTokens ?? 0) > (picked.outputTokens ?? 0)) picked = e;
  }
  const trimmedProvider = providerName?.trim();
  return {
    selected: (selectedModel ?? '').trim(),
    actual: picked.model.trim(),
    ...(trimmedProvider ? { providerName: trimmedProvider } : {}),
  };
}
