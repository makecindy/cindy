/**
 * Goal 裁决解析 —— 纯函数,零依赖,可独立单测。
 *
 * GoalController 每轮结束后,从 agent 的"最终 assistant 文本"里**用代码确定性**
 * 解析出一个裁决(complete / continue / blocked),决定要不要再续一轮。
 * 这是"裁决机制 = Agent 自评 + 代码解析"方案的代码侧:模型只负责按约定吐一个
 * JSON 块(自由发挥的部分),是否续跑、何时停由本文件 + controller 的代码保证
 * (规则 9:能用代码做确定性判断就别甩给 prompt)。
 *
 * 约定:agent 在回复末尾输出一个 fenced JSON 块:
 *   ```json
 *   {"goal_status":"complete"|"continue"|"blocked","reason":"<short>"}
 *   ```
 * 解析策略对"模型没完全照格式"做了容错(见 parseVerdict 注释)。
 */

/** 合法的裁决状态(与 directive.ts 里写给模型的约定一致)。 */
export type GoalVerdictStatus = 'complete' | 'continue' | 'blocked' | 'waiting';

export interface GoalVerdict {
  status: GoalVerdictStatus;
  /** 模型给出的简短理由;缺失时为空串。 */
  reason: string;
  /**
   * 可选:模型澄清含糊目标后(经 AskUserQuestion 与用户确认)给出的**具体目标**。
   * 仅在模型主动改写目标时出现(首轮 directive 才指导它填),controller 据此确定性
   * 改写存储的 objective(chip 更新)。缺失 / 空串 = 不改写。
   */
  refinedObjective?: string;
}

const VALID_STATUS = new Set<GoalVerdictStatus>(['complete', 'continue', 'blocked', 'waiting']);

/** 提取所有 fenced code block 的内部文本(```json 或裸 ```),保持出现顺序。 */
function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  // 非贪婪匹配每一对围栏;语言标记 json 可选。
  const re = /```(?:json|jsonc)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] != null) blocks.push(m[1].trim());
  }
  return blocks;
}

/** 把一个候选字符串尝试解析成 GoalVerdict;失败 / 非法 status 返回 null。 */
function tryParseVerdict(candidate: string): GoalVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const status = obj.goal_status;
  if (typeof status !== 'string' || !VALID_STATUS.has(status as GoalVerdictStatus)) {
    return null;
  }
  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  // 可选 refined_objective:非空字符串才采纳(模型澄清后改写目标用)。
  const refinedRaw = typeof obj.refined_objective === 'string' ? obj.refined_objective.trim() : '';
  const refinedObjective = refinedRaw !== '' ? refinedRaw : undefined;
  return { status: status as GoalVerdictStatus, reason, ...(refinedObjective ? { refinedObjective } : {}) };
}

/**
 * 从一轮 turn 的最终 assistant 文本里解析裁决。
 *
 * 策略(从最规范到最宽松,**取最后一个有效命中** —— 续轮里历史裁决可能也出现在
 * 文本里,最后一个才是本轮结论):
 *   1. 所有 fenced JSON 块,逐个 parse,保留最后一个 status 合法的;
 *   2. 没有 fenced 命中时,正则抓裸的 `{...goal_status...}` 对象再 parse;
 *   3. 都没有 → null(调用方按"无有效裁决"处理:视作 continue 但累计 noProgress)。
 *
 * 注意:**不**做任何语义推断(不去猜"看起来像完成了"),只认结构化裁决 —— 避免
 * 把不可复现的 LLM 判断混进确定性逻辑。
 */
export function parseVerdict(finalText: string | null | undefined): GoalVerdict | null {
  if (!finalText || typeof finalText !== 'string') return null;

  // 1) fenced 块,取最后一个有效的
  const fenced = extractFencedBlocks(finalText);
  let last: GoalVerdict | null = null;
  for (const block of fenced) {
    const v = tryParseVerdict(block);
    if (v) last = v;
  }
  if (last) return last;

  // 2) 裸 JSON 对象兜底:抓包含 goal_status 的、不含嵌套花括号的简单对象
  const bareRe = /\{[^{}]*"goal_status"[^{}]*\}/gi;
  let m: RegExpExecArray | null;
  let lastBare: GoalVerdict | null = null;
  while ((m = bareRe.exec(finalText)) !== null) {
    const v = tryParseVerdict(m[0]);
    if (v) lastBare = v;
  }
  return lastBare;
}
