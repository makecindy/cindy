/**
 * 控制端出方向会话引用解析。
 *
 * queued item 中的 deviceId 是相对控制端 renderer 的地址，不能交给被控端
 * 再解释。这里在越过 device-link 前由控制端 main 读取权威历史并固化快照。
 */
import type { AgentInputQueuedMessage, AgentInputSessionRef, AgentInputSessionReferenceContext } from '../../shared/agentInputQueue.js';
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

function alignOutboundSessionReferences(
  refs: readonly AgentInputSessionRef[],
  contexts: readonly AgentInputSessionReferenceContext[],
): {
  sessionRefs: AgentInputSessionRef[];
  trustedSessionReferenceContexts: AgentInputSessionReferenceContext[];
} {
  const sessionRefs: AgentInputSessionRef[] = [];
  const trustedSessionReferenceContexts: AgentInputSessionReferenceContext[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const context = contexts[i];
    if (!context) {
      sessionRefs.push(ref);
      continue;
    }
    const alignedRef: AgentInputSessionRef =
      context.source === 'local' && ref.deviceId !== undefined
        ? {
            sessionId: ref.sessionId,
            ...(ref.messageClientId !== undefined ? { messageClientId: ref.messageClientId } : {}),
          }
        : ref;
    const key = `${alignedRef.deviceId ?? ''}\u0000${alignedRef.sessionId}\u0000${alignedRef.messageClientId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessionRefs.push(alignedRef);
    trustedSessionReferenceContexts.push(context);
  }
  return { sessionRefs, trustedSessionReferenceContexts };
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
      if (refs && refs.length > 0) {
        const contexts = await resolveSessionReferences(refs);
        const aligned = alignOutboundSessionReferences(refs, contexts);
        next[3] = aligned.sessionRefs;
        next[4] = aligned.trustedSessionReferenceContexts;
      } else {
        next[4] = [];
      }
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
      const contexts = await resolveSessionReferences(queued.sessionRefs);
      const aligned = alignOutboundSessionReferences(queued.sessionRefs, contexts);
      nextItem.sessionRefs = aligned.sessionRefs;
      nextItem.trustedSessionReferenceContexts = aligned.trustedSessionReferenceContexts;
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
