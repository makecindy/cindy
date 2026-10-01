/**
 * 伙伴工作台的只读转录读取:给伙伴判断一件候选任务、给工作台详情视图展示最近内容。
 *
 * - Cindy 任务:读数据库里最近的用户 / 助手消息(跳过工具调用、思考、错误等行);
 * - 本机 Claude Code / Codex 会话:只读转录文件尾部(有界字节),复用各自已有的单行解析,
 *   不写库、不导入。
 * 输出统一去掉 `<system-reminder>` 之类的指令块,整体有界(默认最多约 4000 字,保留最近的)。
 */
import { promises as fs } from 'node:fs';

import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import {
  findExternalClaudeCodeSessionFile,
  parseClaudeCodeMessageLine,
} from '../maker-host/claude-local-sessions.js';
import {
  findExternalCodexRolloutFile,
  parseCodexRolloutMessageLine,
} from '../maker-host/codex-local-sessions.js';
import { stripInstructionBlocks } from '../../shared/botWorkbench.js';
import type { WorkbenchTranscript, WorkbenchTranscriptItem } from '../../shared/botWorkbench.js';

export const WORKBENCH_TRANSCRIPT_MAX_CHARS = 4_000;
const PER_MESSAGE_MAX_CHARS = 1_200;
const TAIL_BYTES = 512 * 1024;
const SESSION_MESSAGE_ROWS = 60;

function cleanText(raw: string): string {
  return stripInstructionBlocks(raw)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 保留最近的消息,单条与总量都有界;顺序仍按时间正序。 */
export function boundTranscript(
  items: readonly WorkbenchTranscriptItem[],
  maxChars = WORKBENCH_TRANSCRIPT_MAX_CHARS,
): WorkbenchTranscript {
  const out: WorkbenchTranscriptItem[] = [];
  let used = 0;
  let truncated = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const cleaned = cleanText(items[index].text);
    if (!cleaned) continue;
    let text = cleaned.length > PER_MESSAGE_MAX_CHARS ? `${cleaned.slice(0, PER_MESSAGE_MAX_CHARS - 1)}…` : cleaned;
    if (used + text.length > maxChars) {
      const room = maxChars - used;
      truncated = true;
      if (room < 80) break;
      text = `…${text.slice(text.length - room + 1)}`;
    }
    out.push({ ...items[index], text });
    used += text.length;
    if (used >= maxChars) {
      truncated = truncated || index > 0;
      break;
    }
  }
  return { items: out.reverse(), truncated };
}

/** 读文件最后 `maxBytes` 字节,丢掉被截断的第一行。 */
export async function readTailLines(file: string, maxBytes = TAIL_BYTES): Promise<string[]> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } finally {
    await handle.close();
  }
}

export async function readExternalTranscript(
  source: 'claude' | 'codex',
  externalId: string,
): Promise<WorkbenchTranscript | null> {
  const file = source === 'claude'
    ? await findExternalClaudeCodeSessionFile(externalId)
    : findExternalCodexRolloutFile(externalId);
  if (!file) return null;
  const lines = await readTailLines(file);
  const items: WorkbenchTranscriptItem[] = [];
  lines.forEach((line, index) => {
    if (source === 'claude') {
      for (const row of parseClaudeCodeMessageLine(line, index + 1, externalId, '')) {
        if ((row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string') {
          items.push({ role: row.role, text: row.content, at: row.createdAt });
        }
      }
    } else {
      const row = parseCodexRolloutMessageLine(line, index + 1);
      if (row) items.push({ role: row.role, text: row.text, at: row.createdAt });
    }
  });
  return boundTranscript(items);
}

function messageText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const text = (parsed as { text?: unknown; content?: unknown }).text
        ?? (parsed as { content?: unknown }).content;
      if (typeof text === 'string') return text;
    }
    return '';
  } catch {
    return raw;
  }
}

export async function readSessionTranscript(sessionId: string): Promise<WorkbenchTranscript> {
  const db = getDbClient().drizzle;
  const [session] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = typeof session?.clearedAt === 'number' ? session.clearedAt : NaN;
  const where = [
    eq(messages.sessionId, sessionId),
    isNull(messages.rewindAt),
    inArray(messages.role, ['user', 'assistant']),
  ];
  if (Number.isFinite(clearedAt)) where.push(gt(messages.createdAt, clearedAt));
  const rows = await db
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(and(...where))
    .orderBy(desc(messages.createdAt))
    .limit(SESSION_MESSAGE_ROWS);
  const items = rows
    .reverse()
    .map((row) => ({ role: row.role as 'user' | 'assistant', text: messageText(row.content), at: row.createdAt }));
  return boundTranscript(items);
}
