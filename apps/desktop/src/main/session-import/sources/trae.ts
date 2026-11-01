/**
 * Trae 来源适配器（换引擎续做，摘要级导入）。
 *
 * - Trae 的完整对话存在本地 SQLCipher 加密库（ModularData/ai-agent/database.db）里，
 *   密钥没有公开的导出方式，第三方读不到逐字记录；能稳定读到的是 Trae 自己写出的
 *   记忆摘要：`~/.trae[-cn|-aicc]/memory/projects/<目录转码>/<日期>/session_memory_<编号>.jsonl`，
 *   每行一轮 `{ intent, actions, outcome, learned, message_summary_time, message_id }`；
 * - 导入产物是逐轮摘要（assistant 消息），不是逐字对话；换引擎续做的交接文本由这些
 *   摘要组成，足够交代「每轮想做什么、做了什么、学到什么」；
 * - 同一轮的 `compact_summary_meta.created_at_ms`（epoch 毫秒）比
 *   `message_summary_time`（本地时间）更准，有则优先；
 * - 一个会话可能跨多个日期目录，按会话编号聚合、按日期目录排序后顺序读取；
 * - 项目目录名是「路径分隔符换成 -」的转码，新版末尾带 `--p2-<编号>` 后缀；SOLO 工作模式
 *   的项目转码里带 work-mode-projects-<编号>，映射回应用数据目录里实际存在的项目文件夹
 *   （找不到就归入对话）。
 */

import path from 'node:path';

import { parseJsonLine, readLines } from '../lineReader.js';
import type { NormalizedMessage, ReadContext, ScanContext, SourceAdapter, SourceListResult, SourceSession } from '../types.js';
import { decodeDashedPath, dirExistsSync, isRecord, makeTitle, str, walkFiles } from './common.js';

interface TraeLocator { files: string[] }

/** Trae 各变体（国际版 / 国内版 / AICC）的家目录数据根，记忆格式相同。 */
const MEMORY_ROOTS = ['.trae', '.trae-cn', '.trae-aicc'];
const MEMORY_FILE_PREFIX = 'session_memory_';

/** SOLO 工作模式项目在转码目录名里的标记。 */
const WORK_MODE_RE = /work-mode-projects-([0-9a-f]{24})/i;
/** SOLO 工作模式项目实际存放的应用（macOS 应用数据目录名）。 */
const APP_DIR_VARIANTS = ['TRAE SOLO', 'TRAE SOLO CN', 'Trae', 'Trae CN'];

/** `YYYY-MM-DD HH:MM:SS`（本地时区）→ epoch 毫秒；解析失败返回 0。 */
function localTimeMs(raw: string): number {
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime() : 0;
}

/** actions / learned 之类的小节：数组渲染成列表，字符串渲染成单行；空值返回 null。 */
function section(label: string, value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? `${label}: ${text}` : null;
  }
  if (!Array.isArray(value)) return null;
  const items = value.map((v) => str(v).trim()).filter((t) => t.length > 0);
  return items.length > 0 ? `${label}:\n${items.map((t) => `- ${t}`).join('\n')}` : null;
}

/** 一轮摘要 → 导入消息正文；intent 缺失时视为不可用。 */
function formatTurn(obj: Record<string, unknown>): string | null {
  const intent = str(obj.intent).trim();
  if (!intent) return null;
  const sections = [`Intent: ${intent}`];
  for (const [label, key] of [['Actions', 'actions'], ['Outcome', 'outcome'], ['Learned', 'learned']] as const) {
    const text = section(label, obj[key]);
    if (text) sections.push(text);
  }
  return sections.join('\n\n');
}

/** 一轮的时间：created_at_ms 优先，其次本地时间字符串；都没有返回 0。 */
function turnAt(obj: Record<string, unknown>): number {
  const meta = isRecord(obj.compact_summary_meta) ? obj.compact_summary_meta : null;
  const atMs = meta && typeof meta.created_at_ms === 'number' ? meta.created_at_ms : 0;
  return atMs || localTimeMs(str(obj.message_summary_time));
}

/** 项目转码目录名 → 实际工作目录；解码不出返回 null（归入对话）。 */
function projectCwd(name: string, homeDir: string): string | null {
  const base = name.replace(/--p2-[0-9a-f]{16,}$/i, '');
  const workMode = base.match(WORK_MODE_RE);
  if (workMode) {
    for (const app of APP_DIR_VARIANTS) {
      const dir = path.join(homeDir, 'Library', 'Application Support', app, 'ModularData', 'ai-agent', 'work-mode-projects', workMode[1]!);
      if (dirExistsSync(dir)) return dir;
    }
    return null;
  }
  return decodeDashedPath(base, dirExistsSync) ?? decodeDashedPath(name, dirExistsSync);
}

async function list(ctx: ScanContext): Promise<SourceListResult> {
  const cwdCache = new Map<string, string | null>();
  const sessions = new Map<string, {
    files: Array<{ file: string; dateDir: string; mtimeMs: number }>;
    sizeBytes: number;
    projectDir: string;
  }>();
  for (const root of MEMORY_ROOTS) {
    const projects = path.join(ctx.homeDir, root, 'memory', 'projects');
    const found = await walkFiles(projects, (name) => name.startsWith(MEMORY_FILE_PREFIX) && name.endsWith('.jsonl'), { maxDepth: 3 });
    for (const f of found) {
      const sid = path.basename(f.file).slice(MEMORY_FILE_PREFIX.length, -'.jsonl'.length);
      if (!sid) continue;
      const projectDir = path.dirname(path.dirname(f.file));
      const entry = sessions.get(sid) ?? { files: [], sizeBytes: 0, projectDir };
      entry.files.push({ file: f.file, dateDir: path.basename(path.dirname(f.file)), mtimeMs: f.mtimeMs });
      entry.sizeBytes += f.size;
      sessions.set(sid, entry);
    }
  }
  const out: SourceSession[] = [];
  let unreadableCount = 0;
  for (const [sid, entry] of sessions) {
    entry.files.sort((a, b) => a.dateDir.localeCompare(b.dateDir) || a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
    let title = '';
    let firstAt = 0;
    let lastAt = 0;
    for (const f of entry.files) {
      for await (const line of readLines(f.file)) {
        const obj = parseJsonLine(line);
        if (!obj) continue;
        const intent = str(obj.intent).trim();
        if (!intent) continue;
        const at = turnAt(obj);
        if (!title) {
          title = makeTitle(intent, '');
          firstAt = at || Math.floor(f.mtimeMs);
        }
        if (at) lastAt = Math.max(lastAt, at);
      }
    }
    // 没有任何一条可读摘要的会话：没有可导入的内容。
    if (!title) {
      unreadableCount += 1;
      continue;
    }
    if (!cwdCache.has(entry.projectDir)) {
      cwdCache.set(entry.projectDir, projectCwd(path.basename(entry.projectDir), ctx.homeDir));
    }
    const cwd = cwdCache.get(entry.projectDir) ?? null;
    out.push({
      source: 'trae',
      sourceSessionId: sid,
      title,
      cwd,
      createdAt: firstAt,
      updatedAt: lastAt || Math.floor(entry.files[entry.files.length - 1]!.mtimeMs),
      archived: false,
      sizeBytes: entry.sizeBytes,
      locator: JSON.stringify({ files: entry.files.map((f) => f.file) } satisfies TraeLocator),
      dialogue: cwd === null,
    });
  }
  return { sessions: out, internalCount: 0, unreadableCount };
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const { files } = JSON.parse(session.locator) as TraeLocator;
  // 摘要行自带时间；缺失时沿用上一轮的时间，写入层保证严格递增。
  let clock = session.createdAt;
  for (const file of files) {
    const sid = path.basename(file, '.jsonl').slice(MEMORY_FILE_PREFIX.length);
    let lineNo = 0;
    for await (const line of readLines(file, { signal: ctx.signal, onBytes: ctx.onBytes })) {
      lineNo += 1;
      const obj = parseJsonLine(line);
      if (!obj) continue;
      const text = formatTurn(obj);
      if (!text) continue;
      const at = turnAt(obj);
      clock = Math.max(at || clock, clock);
      const messageNo = str(obj.message_id).trim() || `${sid}-${lineNo}`;
      yield { key: messageNo, role: 'assistant', content: text, createdAt: clock };
    }
  }
}

export const traeAdapter: SourceAdapter = { id: 'trae', label: 'Trae', list, read };
