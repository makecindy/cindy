import { extractRenderedMarkdownImageTargets } from '@/components/chat/markdownImageTargets';
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

function isProse(item: RenderItem): item is MessageRenderItem {
  return item.type === 'message' && item.message.role === 'assistant'
    && !item.message.systemCardType;
}

function hasAttachments(message: ChatMessage): boolean {
  return Boolean(message.images?.length || message.files?.length);
}

/** Unwrap local groups, but preserve lazy history ownership and its load/retry API.
 * Thinking is deliberately excluded: this disclosure is public execution history.
 */
function publicItems(items: readonly RenderItem[]): RenderItem[] {
  return items.flatMap((item): RenderItem[] => {
    if (item.type === 'message' && item.message.role === 'thinking') return [];
    if (item.type !== 'work_group') return [item];
    const children = publicItems(item.children) as WorkGroupChildItem[];
    return item.deferred ? [{ ...item, children }] : children;
  });
}

/** A presentation-only projection. Never mutate messages or infer intent from prose.
 * isFinal from the adapters closes a text block, not a turn (Pi/Claude can call
 * another tool afterwards). Reuse the normal work-group turn seal, keeping all
 * unsealed prose in the disclosure while running. The composer owns live action
 * feedback. On stop/error or old history without a seal, expose the last useful
 * prose so an answer or plain-text question cannot disappear permanently.
 */
export function simplifyBotRenderItems(
  items: readonly RenderItem[],
  isStreaming: boolean,
  visibleGeneratedFileKeys?: ReadonlySet<string>,
): RenderItem[] {
  // Preserve the shared grouping's history-window boundary before unwrapping
  // groups or removing thinking (both can carry timestamp anchors). Only the
  // final window is active; earlier legacy answers retain their own fallback.
  const result: RenderItem[] = [];
  let window: RenderItem[] = [];
  let previousEnd: number | null = null;
  for (const item of items) {
    const start = renderItemStartMs(item);
    const end = renderItemEndMs(item);
    const userBoundary = item.type === 'message' && item.message.role === 'user';
    if (!userBoundary && previousEnd !== null && start !== null
      && start - previousEnd > HISTORY_GAP_SPLIT_MS) {
      result.push(...projectWindow(window, false, visibleGeneratedFileKeys));
      window = [];
    }
    window.push(item);
    if (userBoundary) previousEnd = end ?? previousEnd;
    else if (end !== null) previousEnd = previousEnd === null ? end : Math.max(previousEnd, end);
  }
  result.push(...projectWindow(window, isStreaming, visibleGeneratedFileKeys));
  return result;
}

function projectWindow(
  items: readonly RenderItem[],
  isStreaming: boolean,
  visibleGeneratedFileKeys?: ReadonlySet<string>,
): RenderItem[] {
  // groupWorkRuns leaves every contiguous block of a sealed answer outside its
  // work group. Only the last block carries the seal. Capture that run before
  // unwrapping groups/removing thinking, which must remain answer boundaries.
  const sealedAnswers = new Set<ChatMessage>();
  let sealedRun = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isProse(item) || !item.message.content.trim()) {
      sealedRun = false;
      continue;
    }
    sealedRun ||= isCompletedAssistantMessage(item.message);
    if (sealedRun) sealedAnswers.add(item.message);
  }
  const result: RenderItem[] = [];
  let turn: RenderItem[] = [];
  const flushTurn = (active: boolean) => {
    let lastProse = -1;
    let lastDelivery = -1;
    for (let index = 0; index < turn.length; index += 1) {
      const item = turn[index];
      if (isProse(item) && item.message.content.trim()) lastProse = index;
      if ((isProse(item) && (hasAttachments(item.message)
        || extractRenderedMarkdownImageTargets(item.message.content).length > 0))
        || (item.type === 'generated_files' && visibleGeneratedFileKeys?.has(item.key))
        || (item.type === 'tool_media' && item.items.length > 0)
        || (item.type === 'ghost_card' && (item.settled || Boolean(item.media?.length)))) {
        lastDelivery = index;
      }
    }
    // Only the card's checked visible files count, never unverified candidates.
    // A later attachment/card is already the result; do not resurrect its preamble.
    // Keep later explanatory text after a partial delivery on stop/error/history.
    const fallbackProse = !active && lastProse > lastDelivery ? lastProse : -1;
    let work: WorkGroupChildItem[] = [];
    const flushWork = () => {
      if (!work.length) return;
      // Do not wrap an existing lazy group: it owns expansion and historical ids.
      result.push(work.length === 1 && work[0].type === 'work_group' ? work[0] : {
        type: 'work_group',
        key: `work-bot-${work[0].key}`,
        children: work,
        isStreaming: active,
      });
      work = [];
    };
    turn.forEach((item, index) => {
      if (item.type === 'agent_plan' || item.type === 'turn_changes') return;
      if (item.type === 'message' && item.message.isSyntheticTrigger) return;
      if (isProse(item)) {
        if (!item.message.content.trim() && !hasAttachments(item.message)) return;
        if (!isCompletedAssistantMessage(item.message) && !sealedAnswers.has(item.message)
          && !hasAttachments(item.message) && index !== fallbackProse
          && extractRenderedMarkdownImageTargets(item.message.content).length === 0) {
          work.push(item);
          return;
        }
      }
      if (item.type === 'tool_segment' || item.type === 'agent_task' || item.type === 'work_group') {
        work.push(item);
        return;
      }
      flushWork();
      // Includes authorization, answered questions, errors and all delivery cards.
      result.push(item);
    });
    flushWork();
    turn = [];
  };

  for (const item of publicItems(items)) {
    if (item.type === 'message' && item.message.role === 'user'
      && item.message.delivery !== 'steer') {
      flushTurn(false);
      if (!item.message.isSyntheticTrigger) result.push(item);
    } else {
      turn.push(item);
    }
  }
  flushTurn(isStreaming);
  return result;
}
