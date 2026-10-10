import { botTaskResultKey, readBotTaskResults } from '@cindy/maker-shared/botCollaboration';
import { HISTORY_GAP_SPLIT_MS } from '@cindy/maker-shared/history-gap';
import { collectMobileMarkdownImages } from './messageMarkdown';
import type { MobileMessageRenderItem } from './messageRenderModel';

const isDelivery = (item: MobileMessageRenderItem) => item.type === 'tool_media' && item.tools.some(tool => !!tool.media?.length || !!tool.files?.length)
  || item.type === 'message' && (item.message.companion?.kind === 'task' && item.message.companion.meta.role === 'delegation-result'
    || !!item.message.attachments?.length || !!item.message.media?.length
    || !!item.message.files?.length || collectMobileMarkdownImages(item.message.body).length > 0);

const expandWorkGroups = (items: readonly MobileMessageRenderItem[]): MobileMessageRenderItem[] =>
  items.flatMap(item => item.type === 'work_group' ? expandWorkGroups(item.children) : [item]);

/** Presentation only. The host's persisted messages and lazy history remain intact. */
export function companionConversationItems(items: readonly MobileMessageRenderItem[]): MobileMessageRenderItem[] {
  // The main timeline folds earlier background-wake seals into work groups; teammate chats
  // still show every sealed reply, so find sealed runs with tools/thinking as boundaries.
  const sealed = new Set<string>();
  let sealedRun = false;
  let nextAssistantAt: number | null = null;
  for (const item of expandWorkGroups(items).reverse()) {
    if (item.type !== 'message' || item.message.kind !== 'assistant' || !item.message.body.trim() || item.message.systemCardType) {
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
  const flattened = items.flatMap(item => item.type === 'work_group' ? companionConversationItems(item.children) : [item]);
  // A later delivery is already the result. Do not restore its unsealed preamble.
  const deliveredAfter = new Set<string>();
  let delivery = false;
  let nextMessageAt: number | null = null;
  for (const item of [...flattened].reverse()) {
    if (item.type === 'message') {
      const createdAt = Date.parse(item.message.createdAt);
      if (Number.isFinite(createdAt)) {
        // A receipt in a newer loaded window cannot suppress an older reply.
        if (nextMessageAt !== null && nextMessageAt - createdAt > HISTORY_GAP_SPLIT_MS) delivery = false;
        nextMessageAt = createdAt;
      }
    }
    if (item.type === 'message' && item.message.kind === 'user') delivery = false;
    else if (isDelivery(item)) delivery = true;
    else if (delivery) deliveredAfter.add(item.key);
  }
  const attached = new Set(flattened.flatMap(item => item.type === 'message'
    && item.message.kind === 'assistant' && item.message.turnCompleted === true && item.message.body.trim()
    ? readBotTaskResults(item.message.source.agentMeta?.botTaskResults).map(botTaskResultKey) : []));
  return flattened.filter(item => {
    if (item.type === 'message' && item.message.companion?.kind === 'task'
      && item.message.companion.meta.role === 'delegation-result'
      && attached.has(botTaskResultKey(item.message.companion.meta))) return false;
    if (item.type === 'thinking' || item.type === 'tool_group' || item.type === 'agent_task'
      || item.type === 'subagent_group' || item.type === 'todo') return false;
    if (item.type !== 'message') return true;
    const message = item.message;
    // Desktop drops persisted synthetic resume separators from teammate chats; only the live
    // reconnect card (still in progress) remains. The composer status carries recovery copy.
    if (message.isSyntheticTrigger && message.systemCardType === 'auto-resume') {
      return message.systemCardData?.live === true;
    }
    if (message.systemCardType) return true;
    if (message.kind === 'thinking' || message.kind === 'tool') return false;
    return message.kind !== 'assistant' || Boolean(message.sourceGroup) || message.explicitDelivery || message.turnCompleted || sealed.has(item.key) || isDelivery(item)
      || message.isTurnFinalAssistant && !deliveredAfter.has(item.key);
  });
}
