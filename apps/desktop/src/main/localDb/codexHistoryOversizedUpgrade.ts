/**
 * 打开本地 Codex 会话时，把旧的 `codex_reconnect_stalled` 错误行单向升格为
 * `codex_history_oversized`。不新增 IPC：messages:list 返回后 fire-and-forget，
 * 命中后再用既有 messages:created 广播刷新已打开的横幅。
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import {
  CODEX_HISTORY_OVERSIZED_REASON,
} from '@cindy/maker-core';

import { createLogger } from '../logger';
import {
  classifyCodexHistoryOversized,
  type CodexHistoryOversizedClass,
} from '../maker-host/codex-local-sessions';
import { getDbClient } from './client/current';
import { messageToCamel, safeStringify } from './mapper';
import { messages, sessions } from './schema';
import type { Message } from '../../renderer/lib/ccAgent.types';

const log = createLogger('localDb/codexHistoryOversizedUpgrade');
const CODEX_RECONNECT_STALLED_REASON = 'codex_reconnect_stalled';
const inFlight = new Set<string>();

export function parsePersistedErrorContent(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function canUpgradeStalledErrorContent(content: Record<string, unknown> | null): boolean {
  return content?.reason === CODEX_RECONNECT_STALLED_REASON;
}

export function mergeOversizedHistoryReason(
  content: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...content,
    reason: CODEX_HISTORY_OVERSIZED_REASON,
    message:
      'Codex remote compaction cannot finish because this thread\'s live history is oversized. ' +
      'Fork and strip oversized inline images to continue.',
  };
}

export type HistoryOversizedUpgradeResult =
  | 'upgraded'
  | 'skipped'
  | 'in-flight';

export interface HistoryOversizedUpgradeDeps {
  classify?: (threadId: string) => Promise<CodexHistoryOversizedClass>;
}

export async function maybeUpgradeCodexHistoryOversizedError(
  sessionId: string,
  deps: HistoryOversizedUpgradeDeps = {},
): Promise<{ result: HistoryOversizedUpgradeResult; message?: Message }> {
  if (!sessionId || inFlight.has(sessionId)) return { result: 'in-flight' };
  inFlight.add(sessionId);
  try {
    const db = getDbClient().drizzle;
    const [session] = await db
      .select({
        agentKind: sessions.agentKind,
        remoteHostId: sessions.remoteHostId,
        sdkSessionId: sessions.sdkSessionId,
        clearedAt: sessions.clearedAt,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!session || session.agentKind !== 'codex' || session.remoteHostId || !session.sdkSessionId) {
      return { result: 'skipped' };
    }

    const conds = [
      eq(messages.sessionId, sessionId),
      eq(messages.role, 'error'),
      isNull(messages.rewindAt),
    ];
    if (session.clearedAt != null) conds.push(sql`${messages.createdAt} > ${session.clearedAt}`);
    const [row] = await db
      .select({
        clientId: messages.clientId,
        content: messages.content,
      })
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.createdAt), desc(sql<number>`rowid`))
      .limit(1);
    if (!row) return { result: 'skipped' };

    const parsed = parsePersistedErrorContent(row.content);
    if (!canUpgradeStalledErrorContent(parsed) || !parsed) return { result: 'skipped' };

    const classify = deps.classify ?? classifyCodexHistoryOversized;
    const classified = await classify(session.sdkSessionId);
    if (classified !== 'oversized') return { result: 'skipped' };

    const nextContent = mergeOversizedHistoryReason(parsed);
    const nextSerialized = safeStringify(nextContent);
    const write = await db
      .update(messages)
      .set({ content: nextSerialized })
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.clientId, row.clientId),
          eq(messages.role, 'error'),
          isNull(messages.rewindAt),
          eq(messages.content, row.content),
        ),
      )
      .run();
    if (write.changes === 0) return { result: 'skipped' };

    const [narrow] = await db
      .select({
        id: messages.id,
        clientId: messages.clientId,
        sessionId: messages.sessionId,
        role: messages.role,
        toolUseId: messages.toolUseId,
        agentMeta: messages.agentMeta,
        agentKind: messages.agentKind,
        createdAt: messages.createdAt,
        rewindAt: messages.rewindAt,
      })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, row.clientId)))
      .limit(1);
    log.info('upgraded stalled Codex error to oversized history', {
      sessionId,
      clientId: row.clientId,
      threadId: session.sdkSessionId,
    });
    return {
      result: 'upgraded',
      ...(narrow
        ? { message: messageToCamel({ ...narrow, content: nextSerialized }) }
        : {}),
    };
  } catch (error) {
    log.warn('codex oversized history upgrade skipped', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { result: 'skipped' };
  } finally {
    inFlight.delete(sessionId);
  }
}
