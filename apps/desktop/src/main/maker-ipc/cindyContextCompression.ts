/**
 * Cindy 保底压缩：一套流程，不是剥图 / 换窗两套功能。
 *
 * 问的只有一件事——当前任务还装不装得进约束。装得进就不动。
 * 字节预算破了（可剥的超大内联图）→ 剥图。
 * token 预算破了 → 交接重建。
 * 剥图失败或剥完仍装不进 → 交接重建。
 * 不确定 → 不动。
 *
 * 字节预算目前只有 Codex 能测量（本地 rollout）。Claude / Pi 没有生产者，
 * bytes 对它们只会是 unknown，决定结果只可能是 rebuild 或 none。
 * 工具输出不作为独立一档：官方 compact 会先清旧工具结果；官方失败后
 * 交接正文本来就不带 tool_result。纯文本把字节顶破时 token 一定早已破。
 * 混合型大尾巴（可剥图不足一半）有意不救，等证据再动比例阈值，不加新档。
 *
 * 切模型预检的数学仍在 assessModelSwitchContext。确认切小窗后，main 的统一
 * set-model 事务在目标压力线先走 context_rebuild，再落目标 route；不另造 handoff。
 */

export type CompressionBudgetState = 'ok' | 'violated' | 'unknown';

/**
 * tokens='violated' 只允许这些证据（普通 timeout / 网络 / 鉴权不算）：
 * - 终态 context-overflow（含 PI prompt RPC 超时）
 * - 本机占用 ≥ 100%
 * - 官方 compact 确定性失败（needsRollover：空摘要、compact 路径 invalid-request）
 *
 * bytes='violated'：Codex 活尾巴可剥超大内联图（>8MB 且可剥 ≥ 一半且剥完 ≤8MB）。
 * unknown = 没测到，不是「预算没破」。
 */
export type CindyCompressionAction = 'strip' | 'rebuild' | 'none';

export function decideCindyCompression(input: {
  /** false = SSH 等无法读本地历史 */
  local: boolean;
  bytes: CompressionBudgetState;
  tokens: CompressionBudgetState;
}): CindyCompressionAction {
  if (!input.local) return 'none';
  if (input.bytes === 'violated') return 'strip';
  if (input.tokens === 'violated') return 'rebuild';
  return 'none';
}

export type StripAttemptResult = 'recovered' | 'not-needed' | 'failed' | 'busy' | 'stale';

/** 剥图之后：成功结束；busy/stale 中止且不得重建；已健康则按更新后的字节预算再判；失败则重建。 */
export function afterStripAttempt(
  result: StripAttemptResult,
  rest: { local: boolean; tokens: CompressionBudgetState },
): 'done' | CindyCompressionAction {
  if (result === 'recovered') return 'done';
  if (result === 'busy' || result === 'stale') return 'none';
  if (result === 'failed') return 'rebuild';
  return decideCindyCompression({ local: rest.local, bytes: 'ok', tokens: rest.tokens });
}
