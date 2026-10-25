import { createId } from '@paralleldrive/cuid2';
import type { ImTurnHost } from '@cindy/im-runtime/turnHost';
import type { ImMessageSource } from '@cindy/maker-shared/im-message-source';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { createMessageService } from './messageService.js';
import type { createMessagePersistence } from './messagePersistBroadcaster.js';
type IMAttachment = NonNullable<Parameters<ImTurnHost['persistUserMessage']>[0]['attachments']>[number];
export interface ImMessagePersistenceHost extends Pick<ReturnType<typeof createMessageService>,
  'createMessage' | 'patchMessageAgentMeta' | 'broadcastMessageAgentMetaUpdate'> {
  enqueueDurableWrite: ReturnType<typeof createMessagePersistence>['enqueueDurableWrite'];
  logger: Pick<DbLogger, 'warn'>;
}

/** Build the durable content shape while retaining cindy-media URLs for ledger pinning. */
export function buildPersistedUserContent(
  text: string,
  attachments: readonly IMAttachment[],
): unknown {
  if (attachments.length === 0) {
    return text;
  }
  // Keep durable content aligned with renderer/lib/imageRef.ts. Media URLs
  // remain embedded so createMessage can pin every blob to this session.
  return {
    text,
    images: attachments
      .filter((att) => att.kind === 'image')
      .map((att) => ({
        originalName: att.originalName,
        mimeType: att.mimeType,
        ...(att.url ? { url: att.url } : {}),
      })),
    files: attachments
      .filter((att) => att.kind === 'file')
      .map((att) => ({
        name: att.originalName,
        path: att.absPath,
        ...(att.url ? { url: att.url } : {}),
      })),
  };
}

// 注: assistant 消息不在本模块落库 — IM 会话统一经 wireSessionToIpcExternal
// 接入 desktop 事件管线, assistant / tool_use / tool_result / thinking 由
// messagePersistBroadcaster 单点落库(原 persistAssistantMessage 已随之移除)。

export function createImMessagePersistence(host: ImMessagePersistenceHost) {
const { createMessage, patchMessageAgentMeta, broadcastMessageAgentMetaUpdate, enqueueDurableWrite, logger: log } = host;
/**
 * Persist any local IM user message, or enrich its already-visible early row.
 *
 * content shape 对齐 desktop renderer 写 user 的方式:
 *   - 纯文本: content = string
 *   - 带附件: content = { text, images: [...], files: [...] }
 *
 * 返回 clientId 让调用方有可能后续 update (如 SDK echo 回 uuid 时), MVP 阶段
 * 调用方可以无视。
 */
async function persistUserMessage(args: {
  sessionId: string;
  text: string;
  attachments?: readonly IMAttachment[];
  source?: ImMessageSource;
  /** Only use a pre-persisted row belonging to this session. Never reinsert it. */
  existingClientId?: string;
}): Promise<{ clientId: string } | null> {
  const { sessionId, text, attachments = [] } = args;
  const clientId = args.existingClientId ?? createId();
  const content = buildPersistedUserContent(text, attachments);

  try {
    if (args.existingClientId) {
      if (args.source) {
        return await enqueueDurableWrite('im-context-snapshot', async (ownerScope) => {
          const patched = await patchMessageAgentMeta(sessionId, clientId, {
            imSource: args.source,
          });
          // A confirmed deletion is different from a failed enrichment: never
          // recreate the row or start a turn change set against a missing row.
          if (!patched) return null;
          await broadcastMessageAgentMetaUpdate(sessionId, clientId, ownerScope);
          return { clientId };
        });
      }
      return { clientId };
    }
    await createMessage(sessionId, {
      clientId,
      role: 'user',
      content,
      ...(args.source ? { agentMeta: { imSource: args.source } } : {}),
    });
    return { clientId };
  } catch (err) {
    // The queue cancels old-owner work at an account boundary. Unlike an
    // enrichment failure, cancellation must not resume old-owner side effects.
    if (err && typeof err === 'object' && 'code' in err && err.code === 'OWNER_SCOPE_SUPERSEDED') {
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`persistUserMessage failed (non-fatal) sessionId=...${sessionId.slice(-8)}: ${msg}`);
    // Enrichment (including its broadcast) cannot undo an earlier durable
    // insert. Keep its identity for attachment promotion and the turn anchor.
    return args.existingClientId ? { clientId } : null;
  }
}


return { persistUserMessage };
}
