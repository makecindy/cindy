/**
 * 控制端出方向会话引用解析。
 *
 * queued item 中的 deviceId 是相对控制端 renderer 的地址，不能交给被控端
 * 再解释。这里在越过 device-link 前由控制端 main 读取权威历史并固化快照。
 */
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { createLogger } from '../logger.js';
import { resolveSessionReferences } from '../maker-ipc/sessionReferenceResolver.js';

const QUEUED_CHANNELS = new Set(['maker:input:enqueue', 'maker:input:steer', 'maker:input:update-content']);
const log = createLogger('device-link:session-reference');

function usesTargetStoredSnapshot(channel: string, args: unknown[], item: AgentInputQueuedMessage): boolean {
  if (channel !== 'maker:input:steer') return false;
  const opts = args[2];
  return (
    !!opts &&
    typeof opts === 'object' &&
    !Array.isArray(opts) &&
    (opts as { removeFromQueue?: unknown }).removeFromQueue === true &&
    item.sessionRefs !== undefined &&
    item.trustedSessionReferenceContexts === undefined
  );
}

/** 是否需要在发送前确认目标端能消费可信引用快照。 */
export function outboundSessionReferencesRequested(channel: string, args: unknown[]): boolean {
  if (channel === 'maker:input:update-text') {
    return Array.isArray(args[3]) && args[3].length > 0;
  }
  if (!QUEUED_CHANNELS.has(channel)) return false;
  const itemIndex = channel === 'maker:input:update-content' ? 2 : 1;
  const item = args[itemIndex];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const queued = item as AgentInputQueuedMessage;
  if (usesTargetStoredSnapshot(channel, args, queued)) return false;
  const refs = queued.sessionRefs;
  return Array.isArray(refs) && refs.length > 0;
}

/** Preserve user-authored text while removing every trusted-reference side channel. */
export function stripOutboundSessionReferenceSideChannels(
  channel: string,
  args: unknown[],
): unknown[] {
  if (channel === 'maker:input:update-text') {
    if (!Array.isArray(args[3])) return args;
    const next = [...args];
    next[3] = [];
    next[4] = [];
    return next;
  }
  if (!QUEUED_CHANNELS.has(channel)) return args;
  const itemIndex = channel === 'maker:input:update-content' ? 2 : 1;
  const item = args[itemIndex];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return args;
  const nextItem: AgentInputQueuedMessage = { ...(item as AgentInputQueuedMessage) };
  delete nextItem.sessionRefs;
  delete nextItem.trustedSessionReferenceContexts;
  delete nextItem.sessionReferencesRequireTrustedSnapshot;
  const next = [...args];
  next[itemIndex] = nextItem;
  return next;
}

export async function rewriteOutboundSessionReferences(
  channel: string,
  args: unknown[],
): Promise<unknown[]> {
  if (channel === 'maker:input:update-text') {
    if (!Array.isArray(args[3])) return args;
    const refs = args[3] as AgentInputQueuedMessage['sessionRefs'];
    const next = [...args];
    try {
      next[4] = refs && refs.length > 0 ? await resolveSessionReferences(refs) : [];
    } catch (error) {
      // Preserve the edited text, but do not ask the target to trust an
      // unresolved controller-side reference or reject the whole edit.
      log.warn('session reference enrichment skipped; sending raw link text', {
        channel,
        referenceCount: refs?.length ?? 0,
        error: error instanceof Error ? error.message : String(error),
      });
      return stripOutboundSessionReferenceSideChannels(channel, args);
    }
    return next;
  }
  if (!QUEUED_CHANNELS.has(channel)) return args;
  const itemIndex = channel === 'maker:input:update-content' ? 2 : 1;
  const item = args[itemIndex];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return args;
  const queued = item as AgentInputQueuedMessage;
  if (usesTargetStoredSnapshot(channel, args, queued)) return args;
  const nextItem: AgentInputQueuedMessage = { ...queued };
  // renderer 永远不能夹带可信正文；无论是否有 refs 都先清掉。
  delete nextItem.trustedSessionReferenceContexts;
  if (queued.sessionRefs && queued.sessionRefs.length > 0) {
    try {
      nextItem.trustedSessionReferenceContexts = await resolveSessionReferences(queued.sessionRefs);
    } catch (error) {
      // The raw deep link remains in `text`.  Dropping both side-channel
      // fields keeps the target from reinterpreting a foreign session id in
      // its own account while still letting the Agent handle the link.
      log.warn('session reference enrichment skipped; sending raw link text', {
        channel,
        referenceCount: queued.sessionRefs.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return stripOutboundSessionReferenceSideChannels(channel, args);
    }
  }
  const next = [...args];
  next[itemIndex] = nextItem;
  return next;
}
