import type { RegionalMoney } from './regionalMoneyTypes.js';
export interface TurnUsageDetails {
  /** 新输入 token：未命中缓存、按输入价计费的部分。 */
  inputTokens: number;
  /** 输出 token：Codex 路径沿用现有口径，包含 reasoning 合并量。 */
  outputTokens: number;
  /** 从 prompt cache 读取的输入 token。 */
  cacheReadTokens: number;
  /** 写入 prompt cache 的输入 token。 */
  cacheCreateTokens: number;
  /** 展示用总 token：input + output + cacheRead + cacheCreate。 */
  totalTokens: number;
  /** 可证明的纯模型生成耗时；不含工具执行/用户等待，用于计算输出速率。 */
  durationMs?: number;
  /** 整轮 wall-clock 耗时，仅供诊断展示；绝不用于计算输出速率。 */
  turnDurationMs?: number;
  /** cacheRead / (input + cacheRead + cacheCreate)，无输入分母时为 null。 */
  cacheHitRate: number | null;
  /** 本轮主要模型；能确定时填写。 */
  model?: string;
  /** 本轮涉及多个模型时的分桶列表。 */
  models?: string[];
  /**
   * 本轮按模型拆分的费用 (model 已归一化为裸 id)。仅 claude-code 主路径有
   * (来自 resolveClaudeTurnCostSinks 的 perModel)，含 subagent (如 Task 工具
   * 跑的 Haiku) —— tooltip 据此展示「按模型成本明细」。老消息无此字段。
   */
  perModelCost?: Array<{ model: string; money: RegionalMoney }>;
}

