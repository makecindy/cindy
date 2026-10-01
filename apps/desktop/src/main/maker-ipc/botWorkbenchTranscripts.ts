/**
 * 伙伴工作台的只读会话读取:候选发现、摘要(起始目的 + 最后几条)与有界摘录。
 *
 * 成本约束(用户 2026-10-01 实机反馈:扫描慢、不该全文读,只看近期):
 * - 转录是固定目录下的文件(见 `botWorkbenchSessionRoots.ts`,含多账号的 Codex home),按项目目录(cwd)过滤;
 * - 只看近期:最近 30 天内活动过的才读内容。Codex 只进最近 31 天的日期子目录,
 *   归档目录按文件名里的日期预筛;Claude Code 只进项目存储目录;
 * - 近期文件先只读开头 16KB 找 cwd;项目里最新的至多 30 条才读头部 64KB + 尾部 64KB
 *   (小文件整读一次;首行超长时跳过它再取头部,至多往后找 1MB),绝不全文;
 * - Cindy 任务用两条有界查询(第一条用户消息、最后 3 条);
 * - 摘要按 (文件 mtime, size) / (任务 updatedAt) 缓存。
 * 输出统一去掉 `<system-reminder>` 之类的指令块。不写库、不导入。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { and, asc, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { parseClaudeCodeMessageLine } from '../maker-host/claude-local-sessions.js';
import { parseCodexRolloutMessageLine } from '../maker-host/codex-local-sessions.js';
import {
  buildWorkbenchDigest,
  findWorkbenchProject,
  stripInstructionBlocks,
  type WorkbenchDigest,
  type WorkbenchTranscript,
  type WorkbenchTranscriptItem,
} from '../../shared/botWorkbench.js';
import type { WorkbenchSessionRoots } from './botWorkbenchSessionRoots.js';

export type WorkbenchExternalSource = 'claude' | 'codex' | 'pi';

export const WORKBENCH_TRANSCRIPT_MAX_CHARS = 4_000;
const PER_MESSAGE_MAX_CHARS = 1_200;
/** 每条转录头尾各最多读这么多字节。 */
export const WORKBENCH_HEAD_TAIL_BYTES = 64 * 1024;
const HEAD_SKIP_MAX_BYTES = 1024 * 1024;
const SESSION_MESSAGE_ROWS = 60;
const CACHE_MAX = 4_000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * 读文件头部与尾部各至多 `bytes` 字节,丢掉被截断的半行。文件不大于两段之和时整读一次,
 * head 与 tail 是同一份。`headText` 保留头部原文(半行也在),用于在超长首行里找 cwd。
 */
export async function readHeadTailLines(
  file: string,
  bytes = WORKBENCH_HEAD_TAIL_BYTES,
): Promise<{ head: string[]; tail: string[]; whole: boolean; headText: string }> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const read = async (start: number, length: number) => {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString('utf8');
    };
    if (size <= bytes * 2) {
      const text = await read(0, size);
      const lines = text.split(/\r?\n/).filter(Boolean);
      return { head: lines, tail: lines, whole: true, headText: text.slice(0, bytes) };
    }
    const headText = await read(0, bytes);
    let headStart = 0;
    let headChunk = headText;
    // 首行超长(如 Codex 的 session_meta 带整份 instructions):跳过它再取头部,
    // 至多往后找 1MB,找不到就只用尾部。
    if (!headText.includes('\n')) {
      headChunk = '';
      for (let offset = bytes; offset < Math.min(size, HEAD_SKIP_MAX_BYTES); offset += bytes) {
        const chunk = Buffer.alloc(Math.min(bytes, size - offset));
        await handle.read(chunk, 0, chunk.length, offset);
        const newline = chunk.indexOf(0x0a);
        if (newline >= 0) {
          headStart = offset + newline + 1;
          headChunk = await read(headStart, Math.min(bytes, size - headStart));
          break;
        }
      }
    }
    const head = headChunk.split(/\r?\n/);
    if (headStart + bytes < size) head.pop();
    const tail = (await read(size - bytes, bytes)).split(/\r?\n/);
    tail.shift();
    return { head: head.filter(Boolean), tail: tail.filter(Boolean), whole: false, headText };
  } finally {
    await handle.close();
  }
}

/** Pi 转录的最小解析:只取 `type: message` 行里 user / assistant 的文字块,拿不准的行跳过。 */
export function parsePiTranscriptLine(line: string): WorkbenchTranscriptItem | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const record = obj as { type?: unknown; timestamp?: unknown; message?: unknown };
  if (record.type !== 'message' || !record.message || typeof record.message !== 'object') return null;
  const message = record.message as { role?: unknown; content?: unknown };
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = typeof message.content === 'string'
    ? message.content
    : blocks
        .map((block) =>
          block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
            ? String((block as { text?: unknown }).text ?? '')
            : '',
        )
        .filter(Boolean)
        .join('\n');
  if (!text.trim()) return null;
  const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  return { role: message.role, text, at: Number.isFinite(at) ? at : 0 };
}

function parseLines(source: WorkbenchExternalSource, lines: readonly string[], externalId: string): WorkbenchTranscriptItem[] {
  const items: WorkbenchTranscriptItem[] = [];
  lines.forEach((line, index) => {
    if (source === 'claude') {
      for (const row of parseClaudeCodeMessageLine(line, index + 1, externalId, '')) {
        if ((row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string') {
          items.push({ role: row.role, text: row.content, at: row.createdAt });
        }
      }
    } else if (source === 'codex') {
      const row = parseCodexRolloutMessageLine(line, index + 1);
      if (row) items.push({ role: row.role, text: row.text, at: row.createdAt });
    } else {
      const row = parsePiTranscriptLine(line);
      if (row) items.push(row);
    }
  });
  return items;
}

/** 在头部原文里找第一个 `"cwd":"…"`(Codex 的首行可能超长被截断,不能整行解析)。 */
export function findCwdInHead(headText: string): string | null {
  const match = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(headText);
  if (!match) return null;
  try {
    const cwd = JSON.parse(match[1]) as unknown;
    return typeof cwd === 'string' && cwd ? cwd : null;
  } catch {
    return null;
  }
}

/** 找 cwd 只读文件开头这么多字节(Codex 的 session_meta 里 cwd 在 instructions 之前)。 */
const CWD_PROBE_BYTES = 16 * 1024;

const fileCwdCache = new Map<string, { mtimeMs: number; size: number; cwd: string | null }>();
const fileDigestCache = new Map<string, { mtimeMs: number; size: number; digest: WorkbenchDigest }>();

async function readFileCwd(file: string, stat: { mtimeMs: number; size: number }): Promise<string | null> {
  const cached = fileCwdCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.cwd;
  const handle = await fs.open(file, 'r');
  let cwd: string | null;
  try {
    const length = Math.min(stat.size, CWD_PROBE_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    cwd = findCwdInHead(buffer.toString('utf8'));
  } finally {
    await handle.close();
  }
  if (fileCwdCache.size >= CACHE_MAX) fileCwdCache.clear();
  fileCwdCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, cwd });
  return cwd;
}

async function readFileDigest(
  source: WorkbenchExternalSource,
  externalId: string,
  file: string,
  stat: { mtimeMs: number; size: number },
): Promise<WorkbenchDigest> {
  const cached = fileDigestCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.digest;
  const { head, tail } = await readHeadTailLines(file);
  const digest = buildWorkbenchDigest(parseLines(source, head, externalId), parseLines(source, tail, externalId));
  if (fileDigestCache.size >= CACHE_MAX) fileDigestCache.clear();
  fileDigestCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, digest });
  return digest;
}

/** 一件外部会话的有界摘录:头部 + 尾部,不全文。 */
export async function readExternalTranscriptFile(
  source: WorkbenchExternalSource,
  externalId: string,
  file: string,
): Promise<WorkbenchTranscript | null> {
  const parts = await readHeadTailLines(file).catch(() => null);
  if (!parts) return null;
  const items = parts.whole
    ? parseLines(source, parts.head, externalId)
    : [...parseLines(source, parts.head, externalId).slice(0, 2), ...parseLines(source, parts.tail, externalId)];
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

async function sessionMessageWhere(sessionId: string) {
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
  return { db, where: and(...where) };
}

export async function readSessionTranscript(sessionId: string): Promise<WorkbenchTranscript> {
  const { db, where } = await sessionMessageWhere(sessionId);
  const rows = await db
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(where)
    .orderBy(desc(messages.createdAt))
    .limit(SESSION_MESSAGE_ROWS);
  const items = rows
    .reverse()
    .map((row) => ({ role: row.role as 'user' | 'assistant', text: messageText(row.content), at: row.createdAt }));
  return boundTranscript(items);
}

const sessionDigestCache = new Map<string, { updatedAt: number; digest: WorkbenchDigest }>();

/** Cindy 任务的摘要:第一条用户消息 + 最后 3 条,两条有界查询;按 updatedAt 缓存。 */
export async function readSessionDigest(sessionId: string, updatedAt: number): Promise<WorkbenchDigest> {
  const cached = sessionDigestCache.get(sessionId);
  if (cached && cached.updatedAt === updatedAt) return cached.digest;
  const { db, where } = await sessionMessageWhere(sessionId);
  const [first, last] = await Promise.all([
    db
      .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(and(where, eq(messages.role, 'user')))
      .orderBy(asc(messages.createdAt))
      .limit(1),
    db
      .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(where)
      .orderBy(desc(messages.createdAt))
      .limit(3),
  ]);
  const toItem = (row: { role: string; content: string; createdAt: number }): WorkbenchTranscriptItem => ({
    role: row.role as 'user' | 'assistant',
    text: messageText(row.content),
    at: row.createdAt,
  });
  const digest = buildWorkbenchDigest(first.map(toItem), last.reverse().map(toItem));
  if (sessionDigestCache.size >= CACHE_MAX) sessionDigestCache.clear();
  sessionDigestCache.set(sessionId, { updatedAt, digest });
  return digest;
}

// ─── 发现:按项目目录找近期的本机转录 ───────────────────────────────

interface TranscriptFile {
  source: WorkbenchExternalSource;
  file: string;
  /** 文件名能看出来的 id;Pi 以首行 session id 为准时在读取后覆盖。 */
  id: string;
  mtimeMs: number;
  size: number;
}

async function readdirSafe(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statFile(source: WorkbenchExternalSource, file: string, id: string): Promise<TranscriptFile | null> {
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() ? { source, file, id, mtimeMs: stat.mtimeMs, size: stat.size } : null;
}

/**
 * Claude Code 的项目存储名:路径分隔符(含 Windows 的 `\\`)与盘符冒号换成 `-`,另一种写法把所有
 * 非字母数字都换成 `-`(与 CLI 的转码一致),两种都试。
 */
export function claudeStorageNames(projectDir: string): string[] {
  return [...new Set([projectDir.replace(/[\\/:]/g, '-'), projectDir.replace(/[^A-Za-z0-9]/g, '-')])];
}

const CODEX_ROLLOUT_ID = /rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_ROLLOUT_DATE = /^rollout-(\d{4})-(\d{2})-(\d{2})T/;

/** Codex sessions/ 下最近 `days` 天的 `YYYY/MM/DD` 子目录。 */
export function recentCodexDayDirs(root: string, now: number, days: number): string[] {
  const out: string[] = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const date = new Date(now - offset * DAY_MS);
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    out.push(path.join(root, yyyy, mm, dd));
  }
  return [...new Set(out)];
}

async function collectTranscriptFiles(
  roots: WorkbenchSessionRoots,
  projectDirs: readonly string[],
  since: number,
  now: number,
): Promise<{ recent: TranscriptFile[]; olderCount: number }> {
  const recent: TranscriptFile[] = [];
  let olderCount = 0;
  const windowDays = Math.ceil((now - since) / DAY_MS) + 1;

  // Claude Code:只进与项目存储名相同或以它为前缀(worktree 等)的文件夹。
  const prefixes = projectDirs.flatMap(claudeStorageNames);
  for (const root of roots.claude) {
    for (const entry of await readdirSafe(root)) {
      if (!entry.isDirectory()) continue;
      if (!prefixes.some((prefix) => entry.name === prefix || entry.name.startsWith(`${prefix}-`))) continue;
      const folder = path.join(root, entry.name);
      for (const file of await readdirSafe(folder)) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const found = await statFile('claude', path.join(folder, file.name), path.basename(file.name, '.jsonl'));
        if (!found) continue;
        if (found.mtimeMs >= since) recent.push(found);
        else olderCount += 1;
      }
    }
  }

  // Codex:多账号目录下每个供应商子目录是一个 home,先展开。
  const accountRoots: string[] = [];
  for (const accounts of roots.codexAccounts) {
    for (const provider of await readdirSafe(accounts)) {
      if (!provider.isDirectory()) continue;
      accountRoots.push(path.join(accounts, provider.name, 'sessions'), path.join(accounts, provider.name, 'archived_sessions'));
    }
  }
  // Codex:sessions/ 只进最近的日期子目录;archived_sessions/ 按文件名日期预筛。
  for (const root of [...roots.codex, ...accountRoots]) {
    const isArchive = path.basename(root) === 'archived_sessions';
    const dirs = isArchive ? [root] : recentCodexDayDirs(root, now, windowDays);
    for (const dir of dirs) {
      for (const file of await readdirSafe(dir)) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const id = CODEX_ROLLOUT_ID.exec(file.name)?.[1];
        if (!id) continue;
        const date = CODEX_ROLLOUT_DATE.exec(file.name);
        // 文件名日期是创建日;归档目录里明显早于窗口一个月以上的直接跳过,不 stat。
        if (isArchive && date && Date.UTC(+date[1], +date[2] - 1, +date[3]) < since - windowDays * DAY_MS) continue;
        const found = await statFile('codex', path.join(dir, file.name), id);
        if (found && found.mtimeMs >= since) recent.push(found);
      }
    }
  }

  // Pi:平铺的 `<时间>_<id>.jsonl`,按 mtime 取近期。
  for (const root of roots.pi) {
    for (const file of await readdirSafe(root)) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const id = /_([^_]+)\.jsonl$/.exec(file.name)?.[1] ?? path.basename(file.name, '.jsonl');
      const found = await statFile('pi', path.join(root, file.name), id);
      if (found && found.mtimeMs >= since) recent.push(found);
    }
  }
  return { recent, olderCount };
}

/** 本机外部会话候选(当前 Cindy 库里已有同一条的除外,避免重复显示),近期的带摘要。 */
export interface WorkbenchExternalSession {
  source: WorkbenchExternalSource;
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  file: string;
  digest: WorkbenchDigest | null;
}

const AGENT_KIND: Record<WorkbenchExternalSource, string> = { claude: 'cc', codex: 'codex', pi: 'pi' };

async function sessionsAlreadyInCindy(files: readonly TranscriptFile[]): Promise<Set<string>> {
  const ids = [...new Set(files.map((file) => file.id))];
  if (ids.length === 0) return new Set();
  const rows = await getDbClient()
    .drizzle.select({ sdkSessionId: sessions.sdkSessionId, agentKind: sessions.agentKind })
    .from(sessions)
    .where(and(inArray(sessions.sdkSessionId, ids), ne(sessions.status, 'deleted')));
  return new Set(rows.flatMap((row) => (row.sdkSessionId ? [`${row.agentKind}:${row.sdkSessionId}`] : [])));
}

export const WORKBENCH_EXTERNAL_MAX = 30;

/**
 * 按已接手项目找本机 Claude Code / Codex / Pi 会话。两步都有界:
 * 1. 近期文件只读开头 16KB 找 cwd,不在项目里的直接丢掉;
 * 2. 项目里最新的至多 30 条才读头尾 64KB 算摘要。
 * 更早的只计数,不读。当前 Cindy 库里已有的同一条只在任务里显示一次,不再当外部候选。
 * `overflowCount` 是近期、在项目里但排在 30 条之外的条数。
 */
export async function listExternalSessionsForProjects(input: {
  roots: WorkbenchSessionRoots;
  projectDirs: readonly string[];
  caseInsensitive: boolean;
  since: number;
  now: number;
  max?: number;
}): Promise<{ sessions: WorkbenchExternalSession[]; olderCount: number; overflowCount: number }> {
  if (input.projectDirs.length === 0) return { sessions: [], olderCount: 0, overflowCount: 0 };
  const { recent, olderCount } = await collectTranscriptFiles(input.roots, input.projectDirs, input.since, input.now);
  const inCindy = await sessionsAlreadyInCindy(recent);
  const byKey = new Map<string, TranscriptFile & { cwd: string }>();
  for (const file of recent.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    const key = `${file.source}:${file.id}`;
    if (byKey.has(key) || inCindy.has(`${AGENT_KIND[file.source]}:${file.id}`)) continue;
    const cwd = await readFileCwd(file.file, file).catch(() => null);
    if (!cwd || !findWorkbenchProject(cwd, input.projectDirs, input.caseInsensitive)) continue;
    byKey.set(key, { ...file, cwd });
  }
  const matched = [...byKey.values()];
  const max = input.max ?? WORKBENCH_EXTERNAL_MAX;
  const sessions = await Promise.all(
    matched.slice(0, max).map(async (file): Promise<WorkbenchExternalSession> => {
      const digest = await readFileDigest(file.source, file.id, file.file, file).catch(() => null);
      return {
        source: file.source,
        id: file.id,
        title: digest?.purpose ?? '',
        cwd: file.cwd,
        updatedAt: file.mtimeMs,
        file: file.file,
        digest,
      };
    }),
  );
  return { sessions, olderCount, overflowCount: Math.max(0, matched.length - max) };
}
