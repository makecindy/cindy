/**
 * modelMismatch —— 「用户所选模型 vs 本轮实际模型」的降级判定纯函数。
 *
 * 背景:Anthropic 侧可能在高负载时把请求静默路由到低一档的模型(例如
 * claude-fable-5 → claude-opus-4-8)。SDK 会在 done 事件的 modelUsage 里如实
 * 上报本轮实际跑过的模型集合,但 UI 一直只显示用户所选模型,降级完全无感。
 * 本模块提供确定性的判定逻辑(规则 9:判定用代码不用 prompt),由 main 在
 * turn 结束时调用,命中后把结果 patch 进该轮收尾 assistant 的 agent_meta。
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

/** 判定结果:selected / actual 均为原始 raw id(展示层再折算短标签)。 */
export interface ModelMismatchInfo {
  /** 用户为该会话所选的模型 raw id(turn start 时快照)。 */
  selected: string;
  /** 本轮实际承接主要输出的 Anthropic 模型 raw id。 */
  actual: string;
}

/** detectClaudeModelMismatch 的实际模型入参:模型 id + 该模型本轮输出 token 数。 */
export interface ActualModelEntry {
  model: string;
  /** Catalog family when the caller can resolve it; id canonicalization remains the fallback. */
  family?: string;
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
  id = id.replace(/^us\.anthropic\./, '').replace(/^eu\.anthropic\./, '').replace(/^anthropic\./, '').replace(/^codex\//, '');
  id = id.replace(/\./g, '-');
  id = id.replace(/^claude-/, '');
  return id;
}

/** family 字段存在时优先；缺失时才从 raw id 规范化，保留旧安全判定。 */
function modelFamilyKey(entry: Pick<ActualModelEntry, 'model' | 'family'>): string {
  const family = entry.family?.trim();
  return family ? canonicalModelFamilyKey(family) : canonicalModelFamilyKey(entry.model);
}

/** canonical key 是否属于 Anthropic 家族(claude- 前缀已剥,按家族词判)。 */
function isAnthropicFamilyKey(key: string): boolean {
  return /^(opus|sonnet|haiku|fable)(-|$)/.test(key);
}

/**
 * 判定本轮是否发生了「所选模型被降级 / 替换」。
 *
 * @param selectedModel 会话所选模型 raw id(turn start 快照;'unknown' / 空跳过)
 * @param actualEntries 本轮 modelUsage delta 里出现过的模型条目
 * @returns 命中返回 { selected, actual };未命中或无法判定返回 null
 */
export function detectClaudeModelMismatch(
  selectedModel: string | null | undefined,
  actualEntries: readonly ActualModelEntry[],
): ModelMismatchInfo | null {
  const selectedKey = canonicalModelFamilyKey(selectedModel);
  if (!selectedKey || selectedKey === 'unknown' || !isAnthropicFamilyKey(selectedKey)) return null;

  const anthropicEntries = actualEntries.filter((e) =>
    isAnthropicFamilyKey(modelFamilyKey(e)),
  );
  if (anthropicEntries.length === 0) return null;
  if (anthropicEntries.some((e) => modelFamilyKey(e) === selectedKey)) return null;

  // 所选家族整轮缺席 → 主线被替换。挑输出 token 最多的条目当「实际承接者」
  // (subagent 输出通常远小于主线,取 max 基本就是主线实际模型)。
  let picked = anthropicEntries[0];
  for (const e of anthropicEntries) {
    if ((e.outputTokens ?? 0) > (picked.outputTokens ?? 0)) picked = e;
  }
  return { selected: (selectedModel ?? '').trim(), actual: picked.model.trim() };
}
