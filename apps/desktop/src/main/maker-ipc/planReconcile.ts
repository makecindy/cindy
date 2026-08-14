/**
 * 计划对账注入(plan reconcile)。
 *
 * 用户抱怨的另一半:泡泡退场(终态章)解决了"看得见的残留",但那份没做完的
 * 清单本身还躺在会话里——下一轮 agent 被叫醒时没人要求它交代旧清单的下落,
 * 清单内容就烂在那里(Codex 的 update_plan 是纯自述,引擎层没有回收机制)。
 *
 * 机制:每轮用户消息发送时(makerSendTransaction 的 wire 注入点,与
 * agentHandoff / mobileClientNote 同一条搭车通道),若会话里最新的顶层计划
 * 仍有未完成步骤,就在用户消息前注入一段"顺手收拾"指示:接着干就更新进度,
 * 方向变了就改条目,不相干了就清掉。
 *
 * 三条纪律:
 *  - 只搭车,不烧独立轮次——"没在干了"的那一刻没人可问,叫醒它就又在干了,
 *    所以对账只能发生在"本来就要叫醒它"的时机(用户的设计决策);
 *  - 措辞是顺手性质,不是任务——否则用户问"X 是什么",agent 先一本正经整理
 *    清单,答案排到后面;
 *  - 归属判定复用 maker-shared 的所有权边界(跨轮不串号、子代理不算数),
 *    这也是先修归属再开对账的原因:对着一份不存在或别人的清单唠叨,污染的
 *    是用户下一轮的真正问题。
 */

import {
  findLatestMessageTodoInsertion,
  type MessageRenderSourceMessageLike,
} from '@cindy/maker-shared/message-render';

export interface PlanReconcileCandidateRow {
  clientId: string;
  role: string;
  content: unknown;
  createdAt: number;
  agentMeta?: Record<string, unknown> | null;
}

/** 从 DB 行还原 maker-shared 扫描所需的最小形状(与 renderer 的 hydrate 同口径)。 */
function toRenderSourceMessage(row: PlanReconcileCandidateRow): MessageRenderSourceMessageLike {
  const content =
    row.content && typeof row.content === 'object' && !Array.isArray(row.content)
      ? (row.content as Record<string, unknown>)
      : null;
  const toolName = typeof content?.toolName === 'string' ? content.toolName : undefined;
  const toolInput = content?.input;
  const toolUseId = typeof content?.toolUseId === 'string' ? content.toolUseId : undefined;
  // 子代理归属:显式 parentToolUseId 才提升为 parentToolUseId 字段。裸
  // agent_meta.parentUuid 原样带过去,由 maker-shared 的 hasSubagentParent 按
  // SDK tool-parent 形态(toolu_ / call_)判定——legacy Claude 导入把 transcript
  // 链边(preceding-user-uuid 这类非 RFC 串)也存在这个键上,一律提升会把顶层
  // 计划误判成子代理并从对账里过滤掉,还与保留裸字段的 mobile 分叉(review P2)。
  const meta = row.agentMeta ?? null;
  const parentToolUseId =
    typeof content?.parentToolUseId === 'string' ? content.parentToolUseId : undefined;
  return {
    clientId: row.clientId,
    role: row.role,
    content: row.content,
    createdAt: new Date(row.createdAt).toISOString(),
    ...(meta ? { agentMeta: meta } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(parentToolUseId ? { parentToolUseId } : {}),
    ...(content?.terminalPlanSnapshot === true ? { terminalPlanSnapshot: true } : {}),
    ...(content?.turnCompleted === false ? { turnCompleted: false as const } : {}),
  };
}

export interface OpenPlanSummary {
  /** 未完成步骤(pending / in_progress)的内容,注入文本引用它。 */
  openSteps: string[];
  totalSteps: number;
}

/**
 * 找出会话里仍未收口的顶层计划。
 *
 * 返回 null 的情况就是不注入的情况:没有计划、计划全部完成、计划已被终态章
 * 收口(成功收尾的清单不需要对账——它的生命周期已经结束,下一轮是新的开始)。
 * 未盖章 + 有未完成步骤 = 中断/失败/被打断后遗留的清单,才值得让 agent 交代。
 */
export function summarizeOpenPlan(
  rows: readonly PlanReconcileCandidateRow[],
): OpenPlanSummary | null {
  const insertion = findLatestMessageTodoInsertion(rows.map(toRenderSourceMessage));
  if (!insertion) return null;
  if (insertion.sealed === true) return null;
  const openSteps = insertion.todos
    .filter((todo) => todo.status !== 'completed')
    .map((todo) => todo.content);
  // 全勾完但 turn 以失败/中断收尾(turnCompleted:false 印记):面板按设计不走
  // 全勾完兜底退场,这份计划的唯一收口通道就是下一轮对账——不给对账机会,
  // 全绿胶囊会永久钉住。openSteps 为空照样生成摘要,注入文案对空清单有专门
  // 分支(确认完成或清掉)。
  if (openSteps.length === 0 && insertion.turnFailed !== true) return null;
  return { openSteps, totalSteps: insertion.todos.length };
}

/** 最多列出的未完成步骤数,其余折成计数。 */
const MAX_LISTED_STEPS = 6;
/**
 * 单条步骤文本的上限。步骤内容由模型自由生成、没有任何长度约束,原样注入会让
 * 一份异常(或被提示诱导生成)的计划显著占用下一轮上下文,极端情况把用户的真正
 * 问题挤过输入上限(review P2)。同时把步骤内换行折成空格——注入段用换行分隔
 * 条目,步骤自带换行会把清单结构撑散。
 */
const MAX_STEP_TEXT_CHARS = 160;

function clampStepText(step: string): string {
  const collapsed = step.replace(/\s+/gu, ' ').trim();
  return collapsed.length > MAX_STEP_TEXT_CHARS
    ? `${collapsed.slice(0, MAX_STEP_TEXT_CHARS)}…`
    : collapsed;
}

/**
 * 对账指示文本。三个出口穷尽所有情况(继续 / 修订 / 清掉),且明确授权删除——
 * 不授权的话模型倾向于"计划不能丢",会把不相干的旧清单硬拖进新话题。
 * 结尾用与 agentHandoff 同款的"以下是用户的新消息"边界,让正文归位。
 *
 * 注入段整体有界:最多 MAX_LISTED_STEPS 条 × MAX_STEP_TEXT_CHARS 字符 + 固定文案,
 * 与计划本身的大小无关。
 */
export function buildPlanReconcileNote(summary: OpenPlanSummary): string {
  // 全勾完但 turn 失败收尾的清单:没有未完成步骤可列,让 agent 确认后收口
  // (重发全完成的计划即产生新终态,或清掉)。
  if (summary.openSteps.length === 0) {
    return [
      '[计划对账]上一轮的计划步骤已全部标记完成,但该轮以失败或中断结束,计划尚未收口。',
      '处理用户消息时顺手确认:若这些工作确已完成,重新提交一次完整的已完成计划把它收口;',
      '若实际未完成或已与当前任务无关,修订条目或用空计划清掉它。不要让它先于用户的问题。',
    '== 对账说明结束,以下是用户的新消息 ==',
    ].join('\n');
  }
  const steps = summary.openSteps
    .slice(0, MAX_LISTED_STEPS)
    .map((step) => `- ${clampStepText(step)}`)
    .join('\n');
  const more =
    summary.openSteps.length > MAX_LISTED_STEPS
      ? `\n(另有 ${summary.openSteps.length - MAX_LISTED_STEPS} 项未列出)`
      : '';
  return [
    '[计划对账]上一轮留有未完成的计划步骤:',
    `${steps}${more}`,
    '处理用户消息时顺手收拾这份计划,不要让它先于用户的问题:若继续这些工作,',
    '推进时更新计划状态;若方向已变,修订条目;若已与当前任务无关,用空计划清掉它。',
    '== 对账说明结束,以下是用户的新消息 ==',
  ].join('\n');
}
