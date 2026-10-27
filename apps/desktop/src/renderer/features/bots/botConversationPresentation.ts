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
): RenderItem[] {
  // Preserve history-window boundaries while lifting addressed replies;
  // a later seal must not promote prose across an unloaded history gap.
  const result: RenderItem[] = [];
  let window: RenderItem[] = [];
  let previousEnd: number | null = null;
  for (const item of items) {
    const start = renderItemStartMs(item);
    const end = renderItemEndMs(item);
    const userBoundary = item.type === 'message' && item.message.role === 'user';
    if (!userBoundary && previousEnd !== null && start !== null
      && start - previousEnd > HISTORY_GAP_SPLIT_MS) {
      result.push(...projectWindow(window));
      window = [];
    }
    window.push(item);
    if (userBoundary) previousEnd = end ?? previousEnd;
    else if (end !== null) previousEnd = previousEnd === null ? end : Math.max(previousEnd, end);
  }
  result.push(...projectWindow(window));
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

function projectWindow(
  items: readonly RenderItem[],
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
  const isAddressedReply = (message: ChatMessage) => Boolean(message.content.trim())
    && !message.failedSamplingAttempt
    && !(message.assistantPhase === 'commentary' && !message.explicitDelivery && !hasRichAnswer(message.content))
    && (hasRichAnswer(message.content) || message.assistantPhase === 'final_answer' || Boolean(message.sourceGroup)
      || Boolean(message.explicitDelivery) || isCompletedAssistantMessage(message) || sealedAnswers.has(message));
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
