/**
 * Cindy 保底压缩：统一交接重建，不改写原生历史。
 *
 * 问的只有一件事——当前任务还装不装得进约束。装得进就不动。
 * 字节预算破了（可剥的超大内联图）或 token 预算破了 → 交接重建。
 * Codex 的索引历史归原生运行时所有，不再尝试原地剥图。
 * 不确定 → 不动。
 *
 * 字节预算目前只有 Codex 能主动测量（本地 rollout）。Pi 仅在真实 HTTP 413
 * 且原生压缩确定无法恢复时提供持久失败证据；不猜测上游上限或换算 token。
 * Claude 的 bytes 仍是 unknown。
 * 工具输出不作为独立一档；图片恢复交接仅保留有界的文本结果，不携带图片数据。
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
 * bytes='violated'：Codex 活尾巴可剥超大内联图（>8MB 且可剥 ≥ 一半且剥完 ≤8MB），
 * 或 Pi 的真实 413 经一次原生压缩仍无法恢复。
 * unknown = 没测到，不是「预算没破」。
 */
export type CindyCompressionAction = 'rebuild' | 'none';

export function decideCindyCompression(input: {
  /** false = SSH 等无法读本地历史 */
  local: boolean;
  bytes: CompressionBudgetState;
  tokens: CompressionBudgetState;
}): CindyCompressionAction {
  if (!input.local) return 'none';
  if (input.bytes === 'violated') return 'rebuild';
  if (input.tokens === 'violated') return 'rebuild';
  return 'none';
}
