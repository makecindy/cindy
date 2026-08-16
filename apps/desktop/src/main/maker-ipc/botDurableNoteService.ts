import { randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { normalizeBotDurableNoteNamespace } from '../../shared/botAutomation.js';

import { getDbClient } from '../localDb/client/current.js';
import {
  botAutomationLinks,
  botAutomationRuns,
  botDurableNotes,
  botSessionLinks,
  sessions,
} from '../localDb/schema.js';

const MAX_KEY_CHARS = 128;
const MAX_VALUE_BYTES = 32 * 1024;
const MAX_LIST_LIMIT = 200;
const SAFE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u;

export type BotDurableNoteResult<T extends Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; errorCode: string; message: string };

function validateName(value: string, field: string, max: number): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || !SAFE_NAME.test(trimmed)) return null;
  return trimmed;
}

async function resolveBotContext(callerSessionId: string): Promise<{
  ok: true;
  context: {
    botId: string;
    defaultNamespace: string | null;
  };
} | {
  ok: false;
  errorCode: 'NOT_A_BOT_SESSION' | 'BOT_SESSION_INACTIVE' | 'BOT_SESSION_READ_ONLY';
  message: string;
}> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      botId: botSessionLinks.botId,
      role: botSessionLinks.role,
      sessionStatus: sessions.status,
      defaultNamespace: botAutomationLinks.durableNoteNamespace,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .leftJoin(botAutomationRuns, eq(botAutomationRuns.sessionId, sessions.id))
    .leftJoin(
      botAutomationLinks,
      eq(botAutomationLinks.id, botAutomationRuns.automationLinkId),
    )
    .where(and(eq(botSessionLinks.sessionId, callerSessionId), eq(sessions.source, 'bot')))
    .limit(1);
  if (!row) {
    return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于 Cindy Bot' };
  }
  if (row.sessionStatus !== 'active') {
    return { ok: false, errorCode: 'BOT_SESSION_INACTIVE', message: '已归档的 Bot 任务不能修改长期状态' };
  }
  if (row.role !== 'canonical' && row.role !== 'route') {
    return { ok: false, errorCode: 'BOT_SESSION_READ_ONLY', message: '当前 Bot 历史任务为只读状态' };
  }
  return {
    ok: true,
    context: { botId: row.botId, defaultNamespace: row.defaultNamespace },
  };
}

function resolveNamespace(
  requested: string | undefined,
  defaultNamespace: string | null,
  allowAll: boolean,
): { ok: true; namespace: string | undefined } | {
  ok: false;
  errorCode: 'INVALID_ARGS' | 'NAMESPACE_SCOPE_MISMATCH';
  message: string;
} {
  const boundNamespace = defaultNamespace
    ? normalizeBotDurableNoteNamespace(defaultNamespace)
    : null;
  if (defaultNamespace && !boundNamespace) {
    return { ok: false, errorCode: 'INVALID_ARGS', message: '绑定的 namespace 格式无效' };
  }
  const requestedNamespace = requested === undefined
    ? undefined
    : normalizeBotDurableNoteNamespace(requested);
  if (requested !== undefined && !requestedNamespace) {
    return { ok: false, errorCode: 'INVALID_ARGS', message: 'namespace 格式无效' };
  }
  if (boundNamespace) {
    if (requestedNamespace && requestedNamespace !== boundNamespace) {
      return {
        ok: false,
        errorCode: 'NAMESPACE_SCOPE_MISMATCH',
        message: '当前 Automation 只能访问其绑定的 Durable Note namespace',
      };
    }
    return { ok: true, namespace: boundNamespace };
  }
  if (allowAll && requestedNamespace === undefined) return { ok: true, namespace: undefined };
  if (!requestedNamespace) {
    return { ok: false, errorCode: 'INVALID_ARGS', message: 'namespace 格式无效' };
  }
  return { ok: true, namespace: requestedNamespace };
}

function parseValue(valueJson: string): unknown {
  try {
    return JSON.parse(valueJson) as unknown;
  } catch {
    return null;
  }
}

export async function listBotDurableNotes(input: {
  callerSessionId: string;
  namespace?: string;
  limit?: number;
}): Promise<BotDurableNoteResult<{ notes: unknown[] }>> {
  const context = await resolveBotContext(input.callerSessionId);
  if (!context.ok) return context;
  const resolvedNamespace = resolveNamespace(
    input.namespace,
    context.context.defaultNamespace,
    true,
  );
  if (!resolvedNamespace.ok) return resolvedNamespace;
  const namespace = resolvedNamespace.namespace;
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), MAX_LIST_LIMIT));
  const db = getDbClient().drizzle;
  const rows = await db
    .select()
    .from(botDurableNotes)
    .where(
      namespace
        ? and(eq(botDurableNotes.botId, context.context.botId), eq(botDurableNotes.namespace, namespace))
        : eq(botDurableNotes.botId, context.context.botId),
    )
    .orderBy(desc(botDurableNotes.updatedAt), desc(botDurableNotes.id))
    .limit(limit);
  return {
    ok: true,
    notes: rows.map((row) => ({
      namespace: row.namespace,
      key: row.noteKey,
      value: parseValue(row.valueJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  };
}

export async function getBotDurableNote(input: {
  callerSessionId: string;
  namespace?: string;
  key: string;
}): Promise<BotDurableNoteResult<{ note: unknown }>> {
  const context = await resolveBotContext(input.callerSessionId);
  if (!context.ok) return context;
  const resolvedNamespace = resolveNamespace(input.namespace, context.context.defaultNamespace, false);
  if (!resolvedNamespace.ok) return resolvedNamespace;
  const namespace = resolvedNamespace.namespace;
  const key = validateName(input.key, 'key', MAX_KEY_CHARS);
  if (!namespace || !key) return { ok: false, errorCode: 'INVALID_ARGS', message: 'namespace 或 key 格式无效' };
  const db = getDbClient().drizzle;
  const [row] = await db
    .select()
    .from(botDurableNotes)
    .where(
      and(
        eq(botDurableNotes.botId, context.context.botId),
        eq(botDurableNotes.namespace, namespace),
        eq(botDurableNotes.noteKey, key),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, errorCode: 'NOT_FOUND', message: 'Durable note 不存在' };
  return {
    ok: true,
    note: {
      namespace: row.namespace,
      key: row.noteKey,
      value: parseValue(row.valueJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  };
}

export async function setBotDurableNote(input: {
  callerSessionId: string;
  namespace?: string;
  key: string;
  value: unknown;
}): Promise<BotDurableNoteResult<{ note: unknown }>> {
  const context = await resolveBotContext(input.callerSessionId);
  if (!context.ok) return context;
  const resolvedNamespace = resolveNamespace(input.namespace, context.context.defaultNamespace, false);
  if (!resolvedNamespace.ok) return resolvedNamespace;
  const namespace = resolvedNamespace.namespace;
  const key = validateName(input.key, 'key', MAX_KEY_CHARS);
  if (!namespace || !key) return { ok: false, errorCode: 'INVALID_ARGS', message: 'namespace 或 key 格式无效' };
  let valueJson: string;
  try {
    valueJson = JSON.stringify(input.value);
  } catch {
    return { ok: false, errorCode: 'INVALID_ARGS', message: 'value 必须是可序列化 JSON' };
  }
  if (valueJson === undefined || Buffer.byteLength(valueJson, 'utf8') > MAX_VALUE_BYTES) {
    return { ok: false, errorCode: 'VALUE_TOO_LARGE', message: `value 最大 ${MAX_VALUE_BYTES} bytes` };
  }
  const db = getDbClient().drizzle;
  const now = Date.now();
  const id = randomUUID();
  await db
    .insert(botDurableNotes)
    .values({ id, botId: context.context.botId, namespace, noteKey: key, valueJson, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [botDurableNotes.botId, botDurableNotes.namespace, botDurableNotes.noteKey],
      set: { valueJson, updatedAt: now },
    });
  return getBotDurableNote({ callerSessionId: input.callerSessionId, namespace, key });
}

export async function deleteBotDurableNote(input: {
  callerSessionId: string;
  namespace?: string;
  key: string;
}): Promise<BotDurableNoteResult<{ deleted: boolean }>> {
  const context = await resolveBotContext(input.callerSessionId);
  if (!context.ok) return context;
  const resolvedNamespace = resolveNamespace(input.namespace, context.context.defaultNamespace, false);
  if (!resolvedNamespace.ok) return resolvedNamespace;
  const namespace = resolvedNamespace.namespace;
  const key = validateName(input.key, 'key', MAX_KEY_CHARS);
  if (!namespace || !key) return { ok: false, errorCode: 'INVALID_ARGS', message: 'namespace 或 key 格式无效' };
  const rows = await getDbClient().drizzle
    .delete(botDurableNotes)
    .where(
      and(
        eq(botDurableNotes.botId, context.context.botId),
        eq(botDurableNotes.namespace, namespace),
        eq(botDurableNotes.noteKey, key),
      ),
    )
    .returning({ id: botDurableNotes.id });
  return { ok: true, deleted: rows.length > 0 };
}
