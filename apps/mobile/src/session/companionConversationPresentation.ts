import { groupTeammateProcess } from '@cindy/maker-shared/message-render';
import { hasRichAnswer } from '@cindy/maker-shared/rich-answer';
import { botTaskResultKey, readBotTaskResults } from '@cindy/maker-shared/botCollaboration';
import { HISTORY_GAP_SPLIT_MS } from '@cindy/maker-shared/history-gap';
import type { MobileMessageRenderItem, MobileWorkGroupItem, MobileWorkChildItem } from './messageRenderModel';

const expandWorkGroups = (items: readonly MobileMessageRenderItem[]): MobileMessageRenderItem[] =>
  items.flatMap(item => item.type === 'work_group' ? expandWorkGroups(item.children) : [item]);

/** Lift addressed replies without destroying the process tree or its lazy loader. */
function liftReplies(group: MobileWorkGroupItem, isReply: (item: MobileMessageRenderItem) => boolean): MobileMessageRenderItem[] {
  if (!group.children.some(isReply)) return [group];
  const result: MobileMessageRenderItem[] = [];
  let pending: MobileWorkChildItem[] = [];
  let chunk = 0;
  let start = group.startedAtMs;
  const groupEnd = start !== undefined && group.durationMs !== undefined ? start + group.durationMs : undefined;
  const flush = (end: number | undefined) => {
    if (!pending.length) return;
    if (!group.deferred && pending.length === 1 && pending[0].type === 'work_group') result.push(pending[0]);
    else result.push({
      ...group, key: chunk === 0 ? group.key : `${group.key}~${pending[0].key}`,
      children: pending, startedAtMs: start,
      durationMs: start !== undefined && end !== undefined && end >= start ? end - start : undefined,
      deferred: chunk === 0 ? group.deferred : undefined,
    });
    pending = [];
    chunk++;
  };
  for (const child of group.children) {
    if (isReply(child) && child.type === 'message') {
      const time = Date.parse(child.message.createdAt);
      const at = Number.isFinite(time) ? time : undefined;
      flush(at);
      result.push(child);
      start = at;
    } else pending.push(child);
  }
  flush(groupEnd);
  return result;
}

/** Presentation only. The host's persisted messages and lazy history remain intact. */
export function companionConversationItems(items: readonly MobileMessageRenderItem[]): MobileMessageRenderItem[] {
  // The main timeline folds earlier background-wake seals into work groups; teammate chats
  // still show every sealed reply, so find sealed runs with tools/thinking as boundaries.
  const sealed = new Set<string>();
  let sealedRun = false;
  let nextAssistantAt: number | null = null;
  for (const item of expandWorkGroups(items).reverse()) {
    if (item.type !== 'message' || item.message.kind !== 'assistant' || item.message.failedSamplingAttempt || !item.message.body.trim() || item.message.systemCardType
      || item.message.source.agentMeta?.assistantPhase === 'commentary') {
      sealedRun = false;
      nextAssistantAt = null;
    } else {
      const createdAt = Date.parse(item.message.createdAt);
      if (Number.isFinite(createdAt)) {
        // Missing history may hide the user boundary between these messages.
        // A newer final marker can only seal prose in the same loaded window.
        if (nextAssistantAt !== null && nextAssistantAt - createdAt > HISTORY_GAP_SPLIT_MS) sealedRun = false;
        nextAssistantAt = createdAt;
      }
      sealedRun ||= item.message.turnCompleted === true;
      if (sealedRun) sealed.add(item.key);
    }
  }
  const isAddressedReply = (item: MobileMessageRenderItem) => item.type === 'message'
    && item.message.kind === 'assistant' && !item.message.failedSamplingAttempt
    && !!item.message.body.trim()
    && (item.message.source.agentMeta?.assistantPhase !== 'commentary' || item.message.explicitDelivery || hasRichAnswer(item.message.body))
    && (item.message.source.agentMeta?.assistantPhase === 'final_answer' || item.message.turnCompleted
      || sealed.has(item.key) || Boolean(item.message.sourceGroup) || item.message.explicitDelivery || hasRichAnswer(item.message.body));
  const flattened = items.flatMap(item => item.type === 'work_group' ? liftReplies(item, isAddressedReply) : [item]);
  const attached = new Set(flattened.flatMap(item => item.type === 'message'
    && item.message.kind === 'assistant' && !item.message.failedSamplingAttempt && item.message.turnCompleted === true && item.message.body.trim()
    ? readBotTaskResults(item.message.source.agentMeta?.botTaskResults).map(botTaskResultKey) : []));
  const visible = flattened.filter(item => {
    if (item.type === 'message' && item.message.companion?.kind === 'task'
      && item.message.companion.meta.role === 'delegation-result'
      && attached.has(botTaskResultKey(item.message.companion.meta))) return false;
    if (item.type === 'thinking') return false;
    if (item.type !== 'message') return true;
    const message = item.message;
    // Failed samples remain available inside the preserved work group, never as replies.
    if (message.kind === 'assistant' && message.failedSamplingAttempt) return false;
    // Desktop drops persisted synthetic resume separators from teammate chats; only the live
    // reconnect card (still in progress) remains. The composer status carries recovery copy.
    if (message.isSyntheticTrigger && message.systemCardType === 'auto-resume') {
      return message.systemCardData?.live === true;
    }
    if (message.systemCardType) return true;
    if (message.kind === 'thinking' || message.kind === 'tool') return false;
    // Ordinary task grouping owns when prose enters the completed work fold.
    // Metadata arriving after a text delta must not hide a still-visible row.
    return true;
  });
  return visible;
}

export function companionProcessItems(items: readonly MobileMessageRenderItem[], isStreaming: boolean): MobileMessageRenderItem[] {
  const visible = companionConversationItems(items);
  const addressed = new Set<MobileMessageRenderItem>();
  let sealed = false;
  for (let i = visible.length - 1; i >= 0; i--) {
    const item = visible[i]!;
    if (item.type !== 'message' || item.message.kind !== 'assistant' || item.message.systemCardType
      || item.message.source.agentMeta?.assistantPhase === 'commentary') { sealed = false; continue; }
    sealed ||= item.message.turnCompleted === true || item.message.source.agentMeta?.assistantPhase === 'final_answer';
    if (sealed || item.message.sourceGroup || item.message.explicitDelivery || hasRichAnswer(item.message.body)) addressed.add(item);
  }
  const lastUser = visible.findLastIndex(item => item.type === 'message' && item.message.kind === 'user'
    && !item.message.isSyntheticTrigger && !item.message.systemCardType);
  const time = (item: MobileMessageRenderItem): number | null => {
    if (item.type === 'work_group') return item.startedAtMs ?? null;
    const at = 'message' in item ? Date.parse(item.message.createdAt) : 'createdAt' in item && typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : NaN;
    return Number.isFinite(at) ? at : null;
  };
  const lastCompleted = visible.findLastIndex(item => item.type === 'message' && item.message.turnCompleted === true);
  const liveItems = new Set(isStreaming ? visible.slice(Math.max(lastUser, lastCompleted) + 1) : []);
  return groupTeammateProcess(visible, {
    children: item => item.type === 'work_group' ? item.children : undefined,
    isProgress: item => item.type === 'message' && item.message.kind === 'assistant' && !item.message.systemCardType
      && !addressed.has(item) && (item.message.source.agentMeta?.assistantPhase === 'commentary'
        || (liveItems.has(item))),
    isRecovery: item => item.type === 'message' && ['agent-switch', 'auto-resume', 'context-rebuild'].includes(item.message.systemCardType ?? ''),
    start: time,
    end: item => item.type === 'work_group' && item.startedAtMs !== undefined
      ? item.startedAtMs + (item.durationMs ?? 0) : time(item),
    streaming: item => item.type === 'work_group' ? item.isStreaming === true : liveItems.has(item),
    create: (children, key, streaming, start, end) => ({ type: 'work_group', teammateJournal: true, key,
      children: children as MobileWorkChildItem[], isStreaming: streaming,
      ...(start !== null ? { startedAtMs: start } : {}),
      ...(start !== null && end !== null ? { durationMs: Math.max(0, end - start) } : {}) }),
  });
}
