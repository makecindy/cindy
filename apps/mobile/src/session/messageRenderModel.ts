import {
  buildMessageRenderItems,
  extractTodosFromSourceMessage,
  formatDuration,
  type MessageRenderAgentTaskItem,
  type MessageRenderItem,
  type MessageRenderOptions,
  type MessageRenderMessageItem,
  type MessageRenderThinkingItem,
  type MessageRenderTodoCardItem,
  type MessageRenderTodoItem,
  type MessageRenderToolGroupItem,
  type MessageRenderToolMediaItem,
  type MessageRenderWorkChildItem,
  type MessageRenderWorkGroupItem,
} from '@cindy/maker-shared/message-render';
import type { AgentTaskUpdate } from '@cindy/maker-shared/agent-task';
import type { MobilePendingSendItem } from '@/session/pendingSendItems';
import { normalizeRemoteMessages, type NormalizedRemoteMessage } from '@/session/messageNormalize';
import type { RemoteMessage } from '@/session/types';
import {
  buildSubagentAwareRenderItems,
  buildSubagentResultMeta,
  hasSubagentMessages,
} from '@/session/subagentGrouping';

const MAX_VALID_DATE_MS = 8.64e15;
export type MobileTodoItem = MessageRenderTodoItem;
export type MobileMessageItem = MessageRenderMessageItem<NormalizedRemoteMessage>;
export type MobileThinkingItem = MessageRenderThinkingItem<NormalizedRemoteMessage>;
export type MobileToolGroupItem = MessageRenderToolGroupItem<NormalizedRemoteMessage>;
export type MobileToolMediaItem = MessageRenderToolMediaItem<NormalizedRemoteMessage>;
export type MobileTodoCardItem = MessageRenderTodoCardItem;
export type MobileAgentTaskItem = MessageRenderAgentTaskItem<NormalizedRemoteMessage>;
export type MobileWorkChildItem = MessageRenderWorkChildItem<NormalizedRemoteMessage>;
export type MobileWorkGroupItem = MessageRenderWorkGroupItem<NormalizedRemoteMessage>;

/**
 * 真·子 agent 嵌套卡片(手机端净新能力)。由 parentUuid 分桶构建(见 subagentGrouping),
 * 替换顶层那条 `Agent` tool_use、包住其内层 children(递归)、Agent 的 tool_result 作 summary。
 * 这是 mobile-only render item,shared 的 MessageRenderItem 类型不动。
 */
export interface MobileSubagentGroupItem {
  type: 'subagent_group';
  key: string;
  header: { description: string | null; subagentType: string | null };
  /** 子 agent 内层 render items(递归,可含更深 subagent_group)。 */
  childItems: MobileMessageRenderItem[];
  /** 子 agent 终稿(Agent 的 tool_result,经 tool_use_id 配对);无则 null。 */
  summary: string | null;
  // 不含 'failed':DB 无可靠失败信号(无 is_error 列、tool_result content 是纯总结字符串),
  // 绝不用正文关键词假阳性判失败(见 subagentGrouping.computeStatus)。
  status: 'running' | 'completed';
  durationMs?: number;
}

export interface MobileForkOriginItem {
  type: 'fork_origin';
  key: string;
  parentSessionId: string;
  forkedAtMessageId: string;
}

export interface MobileForkOrigin {
  parentSessionId: string;
  forkedAtMessageId: string;
  forkedSessionCreatedAt: string;
}

export type MobileMessageRenderItem =
  | MessageRenderItem<NormalizedRemoteMessage>
  | MobileSubagentGroupItem
  | MobileForkOriginItem
  // 待发送气泡(排队 / 落定 / 本地 outbox)也是消息流的一等项:与正式消息同容器同 key,
  // 回流时原地变实,不再跨 footer↔data 搬家(见 pendingSendItems.ts 的说明)。
  | MobilePendingSendItem;

export function buildMobileMessageRenderItems(
  messages: readonly RemoteMessage[],
  options: MessageRenderOptions & { autoResumePending?: Record<string, unknown> | null; sessionId?: string } = {},
  taskUpdates?: ReadonlyMap<string, AgentTaskUpdate>,
): MobileMessageRenderItem[] {
  const normalized = normalizeRemoteMessages(messages);
  scopeUnsettledToolsToActiveTail(normalized);
  markTurnFinalAssistants(normalized, options.isSessionStreaming === true);
  if (options.autoResumePending) {
    const pendingCreatedAtMs = messageCreatedMs(normalized.at(-1));
    normalized.push(...normalizeRemoteMessages([{
      id: 'mobile:auto-resume-pending',
      clientId: 'mobile:auto-resume-pending',
      sessionId: options.sessionId ?? messages[0]?.sessionId ?? '',
      role: 'user',
      content: '',
      toolUseId: null,
      agentMeta: { autoResume: true, autoResumeInfo: { ...options.autoResumePending, live: true } },
      createdAt: pendingCreatedAtMs === null || pendingCreatedAtMs >= MAX_VALID_DATE_MS ? '' : new Date(pendingCreatedAtMs + 1).toISOString(),
    }]));
  }
  collapseConsecutiveAutoResumeCards(normalized);
  // 无子 agent(Claude `Agent` 嵌套)→ 走原始线性路径,并接上 live agent_task 卡:
  // Task / collab:* 工具调用按 toolUseId→clientId 链接;无对应工具调用的孤儿更新兜底
  // 仅在会话运行中(isSessionStreaming)生效——空闲时孤儿是 stale 残留(工具调用已滑出
  // 分页窗口),渲染会把旧子 agent 卡重放到消息流末尾(收口在 shared buildLinearItems)。
  if (!hasSubagentMessages(normalized)) {
    return dropSyntheticTriggerItems(buildMessageRenderItems(normalized, options, taskUpdates));
  }
  // 有 Claude `Agent` 嵌套 → 走 #311 的子 agent 分组路径:Agent 调用已被表达成更丰富的 subagent_group
  // 卡(嵌套 children + 终稿 summary + 状态)。此路径内部按 run 多次调用 buildMessageRenderItems,若再
  // 灌入 taskUpdates,孤儿兜底会在每个 run 重复追加同一张卡;且 agent_task_update 是 live-only、在该
  // 路径触发的历史/持久化场景下通常为空。故此处不另渲染 agent_task,避免重复(Agent 状态由 subagent_group 表达)。
  return dropSyntheticTriggerItems(
    buildSubagentAwareRenderItems(normalized, buildSubagentResultMeta(messages), options),
  );
}

/**
 * 剔除合成 UI 指令行(桌面「失败后继续」等隐藏续跑 prompt,对齐桌面 MessageStream
 * 渲染 null 的口径)。必须在 render items 构建**之后**过滤而不是在 normalize 时丢弃:
 * turn 边界判定(markTurnFinalAssistants / scopeUnsettledToolsToActiveTail)需要这条
 * user 行作为新一轮的边界,提前丢弃会让上一轮被中断的历史工具行在续跑时重新转圈。
 * 消息搜索走过滤后的 render items,自然搜不到隐藏指令。
 */
function dropSyntheticTriggerItems(items: MobileMessageRenderItem[]): MobileMessageRenderItem[] {
  return items.filter(
    (item) => !(item.type === 'message' && item.message.isSyntheticTrigger === true && !item.message.systemCardType),
  );
}

/** 同一次中断只展示最新状态；旧行仍作为 turn boundary 留在 normalized 流中。 */
function collapseConsecutiveAutoResumeCards(messages: NormalizedRemoteMessage[]): void {
  let hasNewerCard = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.systemCardType === 'auto-resume') {
      if (hasNewerCard) delete message.systemCardType;
      hasNewerCard = true;
    } else if (
      message.systemCardType
      || (message.isSyntheticTrigger !== true && message.kind !== 'thinking'
        && (message.kind === 'tool' || !!message.attachments?.length || /[^\s\p{Cf}\p{Cc}]/u.test(message.body)))
    ) hasNewerCard = false;
  }
}

export function extractTodosFromMessage(message: RemoteMessage): MobileTodoItem[] | null {
  return extractTodosFromSourceMessage(message);
}

/**
 * 标注每轮收尾正文(对齐桌面 #456:操作行只挂在每轮任务结束的最后一句正文上)。
 * 口径:真实用户消息(kind='user' 且 label='user',排除 orca worker report)为 turn 边界;
 * 每 turn 取最后一条 body 非空的 assistant 正文;子 agent 内层消息(agentMeta.parentUuid)
 * 不参与——内层是过程内容,不挂操作行。尾部 turn 流式中恒不标,避免操作行随流式输出跳动。
 */
export function markTurnFinalAssistants(
  normalized: readonly NormalizedRemoteMessage[],
  isSessionStreaming: boolean,
): void {
  const suppressTailFinalAssistant = isSessionStreaming && hasActiveLoadedTail(normalized);
  let lastCandidate: NormalizedRemoteMessage | null = null;
  let sealedAnswerFound = false;
  for (const message of normalized) {
    if (message.kind === 'user' && message.label === 'user' && !isSubagentChildMessage(message)) {
      if (!sealedAnswerFound && lastCandidate) lastCandidate.isTurnFinalAssistant = true;
      lastCandidate = null;
      sealedAnswerFound = false;
      continue;
    }
    if (
      message.kind === 'assistant'
      && message.body.trim().length > 0
      && !isSubagentChildMessage(message)
    ) {
      lastCandidate = message;
      if (message.turnCompleted === true) {
        message.isTurnFinalAssistant = true;
        sealedAnswerFound = true;
      }
    }
  }
  if (!sealedAnswerFound && lastCandidate && !suppressTailFinalAssistant) {
    lastCandidate.isTurnFinalAssistant = true;
  }
}

function hasActiveLoadedTail(normalized: readonly NormalizedRemoteMessage[]): boolean {
  let lastUserIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index--) {
    const message = normalized[index];
    if (message.kind === 'user' && message.label === 'user' && !isSubagentChildMessage(message)) {
      lastUserIndex = index;
      break;
    }
  }
  const tail = lastUserIndex < 0 ? normalized : normalized.slice(lastUserIndex + 1);
  if (tail.length === 0) return lastUserIndex >= 0;
  if (tail.some((message) => message.isStreaming === true)) return true;
  if (tail.some((message) => message.kind === 'tool' && message.toolSettled === false)) return true;
  // 忽略尾部本地 system card(/pwd、/context、compact/status 等经 appendLocalSystemCard
  // 追加的卡片):它们挂在已完成回答之后、不代表进行中的工作。用最后一条非 system
  // 内容项判定——若它是已完成的 assistant 终稿则不算 active(否则 send 起流时上一条
  // 回答的操作行会被误抑制,直到下一条 user 行到达才恢复)。
  let lastContent: NormalizedRemoteMessage | undefined;
  for (let index = tail.length - 1; index >= 0; index--) {
    if (tail[index].kind !== 'system') {
      lastContent = tail[index];
      break;
    }
  }
  if (!lastContent) return false;
  return lastContent.kind !== 'assistant';
}

function isSubagentChildMessage(message: NormalizedRemoteMessage): boolean {
  const parent = message.source.agentMeta?.parentUuid;
  return typeof parent === 'string' && parent.length > 0;
}

/**
 * 历史 turn 的未完成工具按已完成收敛(对齐桌面 #454「历史 turn 恒 done」口径):
 * 被中断的旧 turn 会永久缺 tool_result,若不收敛,会话后续流式时这些历史行会
 * 重新转圈。running 状态只允许出现在最后一条真实用户消息之后的 active tail。
 */
export function scopeUnsettledToolsToActiveTail(
  normalized: readonly NormalizedRemoteMessage[],
): void {
  let lastUserIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index--) {
    const message = normalized[index];
    if (message.kind === 'user' && message.label === 'user' && !isSubagentChildMessage(message)) {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return;
  let settleBeforeIndex = lastUserIndex;
  for (let index = normalized.length - 1; index > lastUserIndex; index--) {
    const message = normalized[index];
    if (
      message.kind === 'assistant'
      && message.body.trim().length > 0
      && message.isStreaming !== true
      && !isSubagentChildMessage(message)
    ) {
      settleBeforeIndex = index;
      break;
    }
  }
  for (let index = 0; index < settleBeforeIndex; index++) {
    const message = normalized[index];
    if (message.kind === 'tool' && message.toolSettled === false) {
      message.toolSettled = true;
    }
  }
}

export function insertMobileForkOriginItem(
  items: MobileMessageRenderItem[],
  forkOrigin: MobileForkOrigin | null | undefined,
): MobileMessageRenderItem[] {
  if (!forkOrigin) return items;
  const forkCreatedMs = Date.parse(forkOrigin.forkedSessionCreatedAt);
  if (Number.isNaN(forkCreatedMs)) return items;

  let hasLoadedItemBeforeFork = false;
  const insertAt = items.findIndex((item) => {
    const itemMs = mobileRenderItemStartMs(item);
    if (itemMs !== null && itemMs < forkCreatedMs) {
      hasLoadedItemBeforeFork = true;
      return false;
    }
    return itemMs !== null && itemMs >= forkCreatedMs;
  });
  if (!hasLoadedItemBeforeFork || insertAt < 0) return items;

  const marker: MobileForkOriginItem = {
    type: 'fork_origin',
    key: `fork-origin-${forkOrigin.parentSessionId}-${forkOrigin.forkedAtMessageId}`,
    parentSessionId: forkOrigin.parentSessionId,
    forkedAtMessageId: forkOrigin.forkedAtMessageId,
  };
  return [...items.slice(0, insertAt), marker, ...items.slice(insertAt)];
}

function mobileRenderItemStartMs(item: MobileMessageRenderItem | MobileWorkChildItem): number | null {
  if (item.type === 'message' || item.type === 'thinking') return messageCreatedMs(item.message);
  if (item.type === 'tool_group' || item.type === 'tool_media') return messageCreatedMs(item.tools[0]);
  if (item.type === 'todo' || item.type === 'agent_task') return parseCreatedMs(item.createdAt);
  if (item.type === 'work_group') {
    for (const child of item.children) {
      const childMs = mobileRenderItemStartMs(child);
      if (childMs !== null) return childMs;
    }
  }
  if (item.type === 'subagent_group') {
    for (const child of item.childItems) {
      const childMs = mobileRenderItemStartMs(child);
      if (childMs !== null) return childMs;
    }
  }
  return null;
}

function messageCreatedMs(message: NormalizedRemoteMessage | undefined): number | null {
  return parseCreatedMs(message?.createdAt);
}

function parseCreatedMs(createdAt: string | undefined): number | null {
  if (!createdAt) return null;
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) ? ms : null;
}

export { formatDuration };
