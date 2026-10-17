/**
 * 后台任务终态回执:发给发起伙伴模型的隐藏指令正文。
 *
 * 完整结果(最多 MAX_RESULT_CHARS)已经作为独立的 assistant 回执行持久化在时间线里
 * (botDelegationService 的 persistResultReceipt),模型随时能用 `check_session_task`
 * 或任务卡读到全文。回执正文只需要让伙伴接得上工作:长期对话里这类回执会累积几十条
 * 并一直留在原生上下文中,正文每多一千字,之后每一轮都要重复付这笔 token。
 */

export interface DelegationCompletionMessageInput {
  id: string;
  objective: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timed-out';
  resultSummary?: string | null;
  artifacts?: ReadonlyArray<{ absolutePath: string }>;
  lastError?: string | null;
}

/** 回执正文里结果摘要的上限(字符);超出部分留在持久回执,按需读取。 */
export const COMPLETION_RESULT_WIRE_CHARS = 1_500;
/** 回执正文里列出的交付文件上限;其余在任务卡里。 */
export const COMPLETION_ARTIFACTS_WIRE_LIMIT = 10;
const OBJECTIVE_WIRE_CHARS = 400;
const ERROR_WIRE_CHARS = 600;

function clip(text: string, cap: number, omittedHint: string): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…(${omittedHint})`;
}

export function buildDelegationCompletionMessage(params: DelegationCompletionMessageInput): string {
  const statusLine =
    params.status === 'completed'
      ? '已完成'
      : params.status === 'cancelled'
        ? '已取消'
        : params.status === 'timed-out' || params.lastError?.startsWith('TIMEOUT')
          ? '已超时'
          : '失败了';
  const artifacts = params.artifacts ?? [];
  const listed = artifacts.slice(0, COMPLETION_ARTIFACTS_WIRE_LIMIT);
  const omittedArtifacts = artifacts.length - listed.length;
  return [
    `[任务回执] 后台任务${statusLine}。task_id: ${params.id}`,
    `目标事项: ${params.objective.slice(0, OBJECTIVE_WIRE_CHARS)}`,
    params.resultSummary
      ? `结果:\n${clip(params.resultSummary, COMPLETION_RESULT_WIRE_CHARS, '后续内容见任务卡或 check_session_task')}`
      : '',
    listed.length
      ? `交出的文件(${artifacts.length}):\n${listed.map((item) => `- ${item.absolutePath}`).join('\n')}${
          omittedArtifacts > 0 ? `\n- …另有 ${omittedArtifacts} 个,见任务卡` : ''
        }`
      : '',
    params.lastError ? `失败原因: ${clip(params.lastError, ERROR_WIRE_CHARS, '已截断')}` : '',
    '据此接手继续当前工作;要让执行者接着做,用 `message_session_task`(带 task_id),不必重新发起。回复用户时不要复述本条回执或提及内部编号。',
  ]
    .filter(Boolean)
    .join('\n\n');
}
