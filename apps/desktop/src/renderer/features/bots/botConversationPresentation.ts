import { groupTeammateProcess, isSteerUserRow } from '@cindy/maker-shared/message-render';
import { isContinuationMessage } from '@cindy/maker-shared/synthetic-trigger';
import { hasRichAnswer } from '@cindy/maker-shared/rich-answer';
import { botTaskResultKey, readBotCollaborationMeta } from '@cindy/maker-shared/botCollaboration';
import { HISTORY_GAP_SPLIT_MS } from '@/lib/historyGap';
import type { ChatMessage } from '@/lib/makerChatStore';
import {
  isCompletedAssistantMessage,
  renderItemStartMs,
  renderItemEndMs,
  type MessageRenderItem,
  type RenderItem,
  type WorkGroupChildItem,
} from '@/components/chat/messageWorkGroups';

type WorkGroupItem = Extract<RenderItem, { type: 'work_group' }>;

function isProse(item: RenderItem): item is MessageRenderItem {
  return item.type === 'message' && item.message.role === 'assistant'
    && !item.message.systemCardType;
}

function hasAttachments(message: ChatMessage): boolean {
  return Boolean(message.images?.length || message.files?.length);
}

function expandWorkGroups(items: readonly RenderItem[]): RenderItem[] {
  return items.flatMap((item): RenderItem[] =>
    item.type === 'work_group' ? expandWorkGroups(item.children) : [item]);
}

/** Internal model prose stays in storage, not in the owner's companion chat.
 * Keep trace cards, errors and the existing expandable work records. */
function withoutPrivateProse<T extends RenderItem>(items: readonly T[]): T[] {
  return items.filter(item => !(isProse(item) && item.message.botPrivateReply))
    .map(item => {
      if (item.type !== 'work_group') return item;
      const children = withoutPrivateProse(item.children);
      return children.length === item.children.length && children.every((child, index) => child === item.children[index])
        ? item : { ...item, children };
    });
}

/** A presentation-only projection. Never mutate messages or infer intent from prose.
 * isFinal from the adapters closes a text block, not a turn (Pi/Claude can call
 * another tool afterwards). Normal task grouping owns progress visibility and
 * completion folds. Keep its prose and work history; only lift addressed replies
 * and remove companion-specific synthetic rows or duplicate result receipts.
 */
export function simplifyBotRenderItems(
  items: readonly RenderItem[],
  isStreaming: boolean,
  _visibleGeneratedFileKeys?: ReadonlySet<string>,
  tailReplyIds?: ReadonlySet<string>,
): RenderItem[] {
  // Preserve history-window boundaries while lifting addressed replies;
  // a later seal must not promote prose across an unloaded history gap.
  const result: RenderItem[] = [];
  let window: RenderItem[] = [];
  let previousEnd: number | null = null;
  for (const item of withoutPrivateProse(items)) {
    const start = renderItemStartMs(item);
    const end = renderItemEndMs(item);
    const userBoundary = item.type === 'message' && item.message.role === 'user';
    if (!userBoundary && previousEnd !== null && start !== null
      && start - previousEnd > HISTORY_GAP_SPLIT_MS) {
      result.push(...projectWindow(window, tailReplyIds));
      window = [];
    }
    window.push(item);
    if (userBoundary) previousEnd = end ?? previousEnd;
    else if (end !== null) previousEnd = previousEnd === null ? end : Math.max(previousEnd, end);
  }
  result.push(...projectWindow(window, tailReplyIds));
  const attached = new Set(result.flatMap(item => item.type === 'message'
    && item.message.role === 'assistant' && item.message.turnCompleted === true && item.message.content.trim()
    ? (item.message.botTaskResults ?? []).map(botTaskResultKey) : []));
  const lastSealedIndex = result.findLastIndex(item => isProse(item) && isCompletedAssistantMessage(item.message));
  const lastUserIndex = result.findLastIndex(item => item.type === 'message'
    && item.message.role === 'user' && item.message.delivery !== 'steer');
  const fallbackReceipts: RenderItem[] = [];
  const visible = result.filter((item, index) => {
    if (item.type !== 'message' || item.message.systemCardType !== 'bot-session-task-result') return true;
    const card = readBotCollaborationMeta(item.message.systemCardData);
    if (!card?.result) return true;
    if (attached.has(botTaskResultKey(card))) return false;
    // An unrelated later turn must not erase an already historical fallback link.
    if (index < Math.max(lastSealedIndex, lastUserIndex)) return true;
    if (!isStreaming) fallbackReceipts.push(item);
    return false;
  });
  // Unanswered/failed deliveries remain reachable without inserting ahead of a live reply.
  return [...visible, ...fallbackReceipts];
}

export function botProcessItems(
  items: readonly RenderItem[],
  isStreaming: boolean,
  tailReplyIds?: ReadonlySet<string>,
): RenderItem[] {
  const projected = simplifyBotRenderItems(items, isStreaming, undefined, tailReplyIds);
  const addressed = new Set<RenderItem>();
  let sealed = false;
  for (let i = projected.length - 1; i >= 0; i--) {
    const item = projected[i]!;
    if (!isProse(item) || item.message.assistantPhase === 'commentary') { sealed = false; continue; }
    sealed ||= isCompletedAssistantMessage(item.message) || item.message.assistantPhase === 'final_answer';
    if (sealed) addressed.add(item);
  }
  const lastUser = projected.findLastIndex(item => item.type === 'message' && item.message.role === 'user'
    && !item.message.isSyntheticTrigger && !item.message.systemCardType);
  const lastCompleted = projected.findLastIndex(item => isProse(item) && isCompletedAssistantMessage(item.message));
  const liveItems = new Set(isStreaming ? projected.slice(Math.max(lastUser, lastCompleted) + 1) : []);
  return groupTeammateProcess(projected, {
    children: item => item.type === 'work_group' ? item.children : undefined,
    isProgress: item => !addressed.has(item) && isProse(item) && !isCompletedAssistantMessage(item.message)
      && item.message.assistantPhase !== 'final_answer' && !item.message.explicitDelivery
      && !item.message.sourceGroup && !hasRichAnswer(item.message.content)
      && (item.message.assistantPhase === 'commentary' || (liveItems.has(item))),
    isRecovery: item => item.type === 'message' && ['agent-switch', 'auto-resume', 'context-rebuild'].includes(item.message.systemCardType ?? ''),
    start: renderItemStartMs, end: renderItemEndMs,
    streaming: item => item.type === 'work_group' ? item.isStreaming === true
      : liveItems.has(item),
    create: (children, key, streaming, start, end) => ({ type: 'work_group', teammateJournal: true, key,
      children: children as WorkGroupChildItem[], isStreaming: streaming,
      ...(start !== null ? { startedAtMs: start } : {}),
      ...(start !== null && end !== null ? { durationMs: Math.max(0, end - start) } : {}) }),
  });
}

/**
 * Latest settled companion reply the user can actually see: top-level prose only.
 *
 * 读位不能数折叠里的内容。完成态时间线会把同轮的正文折进 `work_group`，而
 * `TeammateProcessBlock` 对已结束的组默认折叠，`Collapse` 不挂载关闭状态的子项
 * （`WorkGroupBlock.tsx`）—— 那些正文从未真正显示。按 #5185 / #4141 与
 * `docs/product-rules/cindy-bots-runtime.md` 的「读到尾部并完成内容同步后，读位才
 * 推进到实际显示的回复时间」，只能统计真正渲染在流里的顶层正文；对应地，主进程
 * 会算作回复的收尾正文由 `simplifyBotRenderItems` 提升为可见正文（#8629），不再
 * 需要向下挖折叠。
 */
export function latestSettledAssistantMs(items: readonly RenderItem[]): number {
  let latest = 0;
  for (const item of items) {
    if (item.type !== 'message') continue;
    const { message } = item;
    if (message.role !== 'assistant' || message.isStreaming) continue;
    const stamp = Date.parse(message.createdAt ?? '');
    if (Number.isFinite(stamp) && stamp > latest) latest = stamp;
  }
  return latest;
}

/** Empty avatar rows never make a fold on their own; unloaded history still does. */
function hasWorkContent(item: RenderItem): boolean {
  if (item.type === 'work_group') return Boolean(item.deferred) || item.children.some(hasWorkContent);
  if (isProse(item)) return Boolean(item.message.content.trim()) || hasAttachments(item.message);
  return true;
}

/**
 * Work groups pass through like a normal session, except that a reply the bot
 * deliberately addressed to the user (an earlier background-wake seal, provider
 * final, group delivery or explicit delivery) never hides inside the fold. The
 * group is split around such replies; inner activity groups keep their keys.
 */
function liftRepliesFromWorkGroup(
  group: WorkGroupItem,
  isReply: (message: ChatMessage) => boolean,
): RenderItem[] {
  if (!group.children.some((child) => isProse(child) && isReply(child.message))) return [group];
  const out: RenderItem[] = [];
  let pending: WorkGroupChildItem[] = [];
  let chunk = 0;
  let previousReplyEnd: number | null = null;
  const groupEnd = group.startedAtMs !== undefined && group.durationMs !== undefined
    ? group.startedAtMs + group.durationMs : null;
  const flush = (nextReply: MessageRenderItem | null) => {
    if (pending.length === 0) return;
    // Deferred history owns loading/retry state on the outer group, even with one inner group.
    if (!group.deferred && pending.length === 1 && pending[0].type === 'work_group') {
      out.push(pending[0]);
    } else {
      const starts = pending.map(renderItemStartMs).filter((ms): ms is number => ms !== null);
      const ends = pending.map(renderItemEndMs).filter((ms): ms is number => ms !== null);
      const start = chunk === 0
        ? group.startedAtMs ?? (starts.length ? Math.min(...starts) : null)
        : previousReplyEnd ?? (starts.length ? Math.min(...starts) : null);
      const end = nextReply
        ? renderItemStartMs(nextReply)
        : groupEnd ?? (ends.length ? Math.max(...ends) : null);
      const durationMs = start !== null && end !== null && end >= start ? end - start : undefined;
      out.push({
        type: 'work_group',
        // The first chunk keeps the original key so its expansion memory survives.
        key: chunk === 0 ? group.key : `${group.key}~${pending[0].key}`,
        children: pending,
        isStreaming: group.isStreaming,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(start !== null ? { startedAtMs: start } : {}),
        ...(chunk === 0 && group.deferred ? { deferred: group.deferred } : {}),
      });
    }
    chunk += 1;
    pending = [];
  };
  for (const child of group.children) {
    if (isProse(child) && isReply(child.message)) {
      flush(child);
      out.push(child);
      previousReplyEnd = renderItemEndMs(child);
    } else {
      pending.push(child);
    }
  }
  flush(null);
  return out;
}

/**
 * 主进程会算作「未封口收尾回复」的正文（#8629 的另一半判据）。
 *
 * 与 `apps/desktop/src/main/localDb/ipc/bots.ts` 的 `canonicalReplyVisibility` 同口径：
 * 未封口、非 commentary、非子代理 / 私聊回执，且它之后到下一个真实用户轮次之间没有
 * 任何工具 / 思考动作（`steer` 插话与续跑行不算新轮）。
 *
 * 必须在**消息**层算：展示层会整条删掉 `AskUserQuestion` / `ExitPlanMode` 与单步计划
 * 工具，计划卡还会替掉原工具行，按渲染项判断会把仍有后续工具的过程旁白当成收尾；
 * 同一轮跨 `HISTORY_GAP_SPLIT_MS` 分窗时，前一个窗口也看不到后一个窗口里的工具。
 */
export function tailReplyClientIds(messages: readonly ChatMessage[]): ReadonlySet<string> {
  const ids = new Set<string>();
  let activityAfter = false;
  // 续跑行开启的是「新的一次尝试」:它之前的正文属于被取代的那次尝试,
  // `groupWorkRuns` 的 resumed 分支已经把这部分折进工作过程,不能再提升成正式回复。
  let superseded = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    // 历史恢复时被过滤掉的隐藏 thinking 行(redacted / omitted 占位)在映射阶段已经
    // 从 `displayMessages` 消失,但主进程仍把 thinking 行算作后续活动;边界以相邻
    // 消息上的标记保留(`mapServerMessages`),这里按同样的语义处理。
    const hiddenBefore = message.hiddenThinkingBefore === true;
    const hiddenAfter = message.hiddenThinkingAfter === true;
    if (message.role === 'user') {
      // 用户行自身仍然要处理边界:`hiddenThinkingAfter` 的思考属于**新**轮次
      // (例如新轮还没输出就被停掉),不能让它反过来否掉上一轮的收尾回复;主进程
      // 的后续活动扫描同样以真实用户输入为界。
      if (isContinuationMessage(message)) {
        superseded = true;
      } else if (!isSteerUserRow(message)) {
        activityAfter = false;
        superseded = false;
      }
      if (hiddenBefore) activityAfter = true;
      continue;
    }
    if (hiddenAfter) {
      activityAfter = true;
      continue;
    }
    if (message.role === 'thinking' || message.role === 'tool_use' || message.role === 'tool_result') {
      activityAfter = true;
      continue;
    }
    if (message.role === 'assistant' && !activityAfter && !superseded
      && !message.parentToolUseId && !message.botPrivateReply && !message.systemCardType
      && message.content.trim() && !message.failedSamplingAttempt && !message.samplingAttemptPending
      && !(message.assistantPhase === 'commentary' && !message.explicitDelivery
        && !hasRichAnswer(message.content))) {
      ids.add(message.clientId);
    }
    if (hiddenBefore) activityAfter = true;
  }
  return ids;
}

/** 真正开新轮次的用户行：`steer` 插话与恢复续跑不算新轮（与主进程 next_input 同口径）。 */
function startsNewTurn(message: ChatMessage): boolean {
  return message.role === 'user' && !isSteerUserRow(message) && !isContinuationMessage(message);
}

function projectWindow(
  items: readonly RenderItem[],
  tailReplyIds?: ReadonlySet<string>,
): RenderItem[] {
  // A sealed answer may span several contiguous prose blocks; only the last carries
  // the seal. groupWorkRuns folds earlier background-wake seals into work groups, so
  // scan the expanded sequence while tools and thinking still act as boundaries.
  const expanded = expandWorkGroups(items);
  const sealedAnswers = new Set<ChatMessage>();
  let sealedRun = false;
  for (let index = expanded.length - 1; index >= 0; index -= 1) {
    const item = expanded[index];
    if (!isProse(item) || !item.message.content.trim() || item.message.failedSamplingAttempt
      || item.message.assistantPhase === 'commentary') {
      sealedRun = false;
      continue;
    }
    sealedRun ||= isCompletedAssistantMessage(item.message);
    if (sealedRun) sealedAnswers.add(item.message);
  }
  // 收尾回复的归属由消息层 `tailReplyClientIds` 判定（见该函数注释）：展示层会删行、
  // 会把同轮切成多个窗口，只有消息层与主进程的未读口径完全一致。
  //
  // 例外是还没加载的历史：`deferred` 工作组之后什么都没有时无法断言「后面没有工具」，
  // 此时消息层也可能尚未拿到那些行，不能提升。
  const unloadedAfter = new Set<string>();
  let unknownAfter = false;
  const scanUnknown = (list: readonly RenderItem[]): void => {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const item = list[index]!;
      if (item.type === 'message' && startsNewTurn(item.message)) {
        unknownAfter = false;
        continue;
      }
      if (item.type === 'work_group') {
        if (item.deferred) {
          unknownAfter = true;
          continue;
        }
        scanUnknown(item.children);
        continue;
      }
      if (unknownAfter && item.type === 'message' && item.message.role === 'assistant') {
        unloadedAfter.add(item.message.clientId);
      }
    }
  };
  scanUnknown(items);
  const isAddressedReply = (message: ChatMessage) => Boolean(message.content.trim())
    && !message.failedSamplingAttempt
    && !(message.assistantPhase === 'commentary' && !message.explicitDelivery && !hasRichAnswer(message.content))
    && (hasRichAnswer(message.content) || message.assistantPhase === 'final_answer' || Boolean(message.sourceGroup)
      || Boolean(message.explicitDelivery) || isCompletedAssistantMessage(message) || sealedAnswers.has(message)
      || (tailReplyIds?.has(message.clientId) === true && !unloadedAfter.has(message.clientId)));
  const result: RenderItem[] = [];
  const lifted = items.flatMap((item) => item.type !== 'work_group' ? [item]
    : hasWorkContent(item) ? liftRepliesFromWorkGroup(item, isAddressedReply) : []);
  lifted.forEach((item) => {
    // Bots never produce change cards; keep them out like before. Thinking is
    // always folded into a work group by the shared grouping, never top level.
    if (item.type === 'turn_changes') return;
    if (item.type === 'message' && item.message.role === 'thinking') return;
    if (item.type === 'message' && item.message.isSyntheticTrigger) return;
    if (isProse(item)) {
      if (!item.message.content.trim() && !hasAttachments(item.message) && !hasRichAnswer(item.message.content)) return;
      if (item.message.failedSamplingAttempt) return;
    }
    // Normal task grouping owns progress visibility and completed work folds.
    result.push(item);
  });
  return result;
}
