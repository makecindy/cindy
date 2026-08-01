/**
 * main/im/messagePersistence.ts
 * ---------------------------------------------------------------------------
 * IM-channel agnostic helper for writing user / assistant messages to the
 * local SQLite messages table.
 *
 * 背景:
 *   - desktop renderer 通过 IPC `local-db:messages:create` 调用 createMessage,
 *     这是 desktop session 消息流写库的现有路径
 *   - feishu main (在主进程内) 没有 IPC 自调自的概念, 直接 import createMessage
 *     函数即可 — 这就是这俩 helper 的事
 *
 * 为什么不直接到处调 createMessage:
 *   - clientId 生成、错误吞掉策略、content shape (text-only vs attachment object)
 *     等样板逻辑在多个调用点会重复, 抽出来集中
 *   - B' (feishu_* session 写库) 和 C (接管 desktop session 时 feishu main 写库)
 *     共用同一个 helper, 任何 schema 变更只改一处
 *
 * 失败策略: 写库失败仅 log.warn, 不抛错 — IM 用户的消息不能因为本地存储失败
 * 而被吞掉, agent 仍然要正常响应。可观测性: 后续若需要可以加 metric。
 */

import { createId } from '@paralleldrive/cuid2';

import type { IMAttachment } from '@cindy/im';

import { createMessage } from '../localDb/ipc/messages';
import { createLogger } from '../logger';

const log = createLogger('im:msg-persist');

/**
 * Persist a feishu (or future IM) user message to the local messages table.
 *
 * content shape 对齐 desktop renderer 写 user 的方式:
 *   - 纯文本: content = string
 *   - 带附件: content = { text, images: [...], files: [...] }
 *
 * 返回 clientId 让调用方有可能后续 update (如 SDK echo 回 uuid 时), MVP 阶段
 * 调用方可以无视。
 */
export async function persistUserMessage(args: {
  sessionId: string;
  text: string;
  attachments?: readonly IMAttachment[];
}): Promise<{ clientId: string } | null> {
  const { sessionId, text, attachments = [] } = args;
  const clientId = createId();
  const content = buildPersistedUserContent(text, attachments);

  try {
    await createMessage(sessionId, {
      clientId,
      role: 'user',
      content,
    });
    return { clientId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      `persistUserMessage failed (non-fatal) sessionId=...${sessionId.slice(-8)}: ${msg}`,
    );
    return null;
  }
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
