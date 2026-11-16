import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { isSyntheticTriggerText } from '../../shared/interruptedTurn.js';
import { getDbClient } from './client/current.js';
import { messages, sessions } from './schema.js';

/**
 * The reads context recovery makes before it rebuilds a task, moved unchanged from
 * ipc/messages.ts (which keeps exporting them) so the Node Host can load them without Electron.
 */

const messageRowid = sql<number>`rowid`;

export async function findLatestContextRebuildMeta(sessionId: string): Promise<{
  reason?: string;
  sourceUserClientId?: string | null;
  sourceAgentKind?: 'cc' | 'codex' | 'pi';
  sourceModel?: string | null;
  sourceProviderId?: string | null;
} | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'context_rebuild')))
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.content) as {
      reason?: unknown;
      sourceUserClientId?: unknown;
      sourceAgentKind?: unknown;
      sourceModel?: unknown;
      sourceProviderId?: unknown;
    };
    return {
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      sourceUserClientId:
        typeof parsed.sourceUserClientId === 'string' ? parsed.sourceUserClientId : null,
      ...(parsed.sourceAgentKind === 'cc' ||
      parsed.sourceAgentKind === 'codex' ||
      parsed.sourceAgentKind === 'pi'
        ? { sourceAgentKind: parsed.sourceAgentKind }
        : {}),
      ...(typeof parsed.sourceModel === 'string' ? { sourceModel: parsed.sourceModel } : {}),
      ...(typeof parsed.sourceProviderId === 'string'
        ? { sourceProviderId: parsed.sourceProviderId }
        : {}),
    };
  } catch {
    return null;
  }
}

/** 换窗身份用：不受 handoff 400 行窗口限制，找最近一条非 rewind 的 user。 */
export async function findLatestUserMessageForRebuild(sessionId: string): Promise<{
  clientId: string;
  role: string;
  content: unknown;
  createdAt: number;
  agentMeta: Record<string, unknown> | null;
  toolUseId: string | null;
} | null> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessRow?.clearedAt ?? null;
  const afterClear = clearedAt === null ? undefined : gt(messages.createdAt, clearedAt);
  const rows = await db
    .select({
      clientId: messages.clientId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      agentMeta: messages.agentMeta,
      toolUseId: messages.toolUseId,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
        afterClear,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(30);
  for (const r of rows) {
    let content: unknown = r.content;
    try {
      content = JSON.parse(r.content);
    } catch {
      // 与 messageToCamel 同口径
    }
    let agentMeta: Record<string, unknown> | null = null;
    if (r.agentMeta) {
      try {
        const parsed: unknown = JSON.parse(r.agentMeta);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          agentMeta = parsed as Record<string, unknown>;
        }
      } catch {
        // 非法 JSON 视为无 meta
      }
    }
    const text =
      typeof content === 'string'
        ? content
        : content && typeof content === 'object' && !Array.isArray(content)
          ? typeof (content as { text?: unknown }).text === 'string'
            ? (content as { text: string }).text
            : ''
          : '';
    if (isSyntheticTriggerText(text)) continue;
    return {
      clientId: r.clientId,
      role: r.role,
      content,
      createdAt: r.createdAt,
      agentMeta,
      toolUseId: r.toolUseId ?? null,
    };
  }
  return null;
}
