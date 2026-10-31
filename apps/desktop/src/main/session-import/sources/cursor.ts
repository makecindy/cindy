/**
 * Cursor CLI 来源适配器（换引擎续做）。
 *
 * - 历史：`~/.cursor/projects/<目录转码>/agent-transcripts/<编号>/<编号>.jsonl`（旧版直接放在
 *   agent-transcripts 下）。每行 `{ role, message: { content: [text | tool_use] } }`，
 *   另有 `{ type: 'turn_ended', status }` 状态行；
 * - 用户消息包在 `<timestamp>…</timestamp><user_query>…</user_query>` 里，取出提问与时间；
 * - 记录不带工具结果与逐条时间，只能按顺序还原；
 * - 工作目录从目录转码还原（`empty-window` 表示没有打开文件夹，归入对话）。
 */

import path from 'node:path';

import { parseJsonLine, readLines } from '../lineReader.js';
import type { NormalizedMessage, ReadContext, ScanContext, SourceAdapter, SourceListResult, SourceSession } from '../types.js';
import { decodeDashedPath, dirExistsSync, isRecord, makeTitle, str, toMs, walkFiles } from './common.js';

interface CursorLocator { file: string; mtimeMs: number }


function cursorRoot(homeDir: string): string {
  return path.join(homeDir, '.cursor', 'projects');
}

/** `<timestamp>…</timestamp>\n<user_query>…</user_query>` → { text, at } */
export function unwrapCursorUserText(raw: string): { text: string; at: number } {
  const at = toMs(raw.match(/<timestamp>([\s\S]*?)<\/timestamp>/)?.[1]?.trim() ?? '');
  const query = raw.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1];
  const text = (query ?? raw.replace(/<timestamp>[\s\S]*?<\/timestamp>/, '')).trim();
  return { text, at };
}

function projectOf(file: string): string {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('agent-transcripts');
  return i > 0 ? parts[i - 1]! : '';
}

async function list(ctx: ScanContext): Promise<SourceListResult> {
  const sessions: SourceSession[] = [];
  const files = await walkFiles(cursorRoot(ctx.homeDir), (name, full) => name.endsWith('.jsonl') && full.includes(`${path.sep}agent-transcripts${path.sep}`), { maxDepth: 5 });
  const cwdCache = new Map<string, string | null>();
  let internalCount = 0;
  for (const f of files) {
    // 子 Agent 的记录挂在父任务目录的 subagents/ 下，属于父任务内部过程。
    if (f.file.includes(`${path.sep}subagents${path.sep}`)) {
      internalCount += 1;
      continue;
    }
    if (f.size === 0) continue;
    const id = path.basename(f.file, '.jsonl');
    const project = projectOf(f.file);
    if (!cwdCache.has(project)) cwdCache.set(project, project === 'empty-window' ? null : decodeDashedPath(project, dirExistsSync));
    let title = '';
    let firstAt = 0;
    for await (const line of readLines(f.file, { maxBytes: 256 * 1024 })) {
      const obj = parseJsonLine(line);
      if (obj?.role !== 'user' || !isRecord(obj.message) || !Array.isArray(obj.message.content)) continue;
      const raw = obj.message.content.map((b) => (isRecord(b) ? str(b.text) : '')).join('\n');
      const { text, at } = unwrapCursorUserText(raw);
      if (text) {
        title = makeTitle(text, '');
        firstAt = at;
        break;
      }
    }
    // 只有状态行、没有一句提问（例如一开始就撞上额度）：不是可续做的任务。
    if (!title) continue;
    sessions.push({
      source: 'cursor',
      sourceSessionId: id,
      title,
      cwd: cwdCache.get(project) ?? null,
      createdAt: firstAt || Math.floor(f.mtimeMs),
      updatedAt: Math.floor(f.mtimeMs),
      archived: false,
      sizeBytes: f.size,
      locator: JSON.stringify({ file: f.file, mtimeMs: f.mtimeMs } satisfies CursorLocator),
      dialogue: project === 'empty-window',
    });
  }
  return { sessions, internalCount, unreadableCount: 0 };
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const { file } = JSON.parse(session.locator) as CursorLocator;
  // 没有逐条时间：用户消息带时间时以它为准，其余按顺序递增（写入层保证严格递增）。
  let clock = session.createdAt;
  let lineNo = 0;
  let toolSeq = 0;
  for await (const line of readLines(file, { signal: ctx.signal, onBytes: ctx.onBytes })) {
    lineNo += 1;
    const obj = parseJsonLine(line);
    if (!obj || !isRecord(obj.message) || !Array.isArray(obj.message.content)) continue;
    const role = obj.role === 'user' ? 'user' : obj.role === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    let part = 0;
    for (const block of obj.message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        if (role === 'user') {
          const { text, at } = unwrapCursorUserText(block.text);
          if (at) clock = Math.max(clock, at);
          if (text) yield { key: `${lineNo}-${part++}`, role: 'user', content: text, createdAt: clock };
        } else if (block.text.trim()) {
          yield { key: `${lineNo}-${part++}`, role: 'assistant', content: block.text, createdAt: clock };
        }
      } else if (block.type === 'tool_use' && role === 'assistant') {
        const toolUseId = str(block.id) || `cursor-${lineNo}-${toolSeq++}`;
        yield {
          key: `${lineNo}-${part++}`,
          role: 'tool_use',
          content: { toolUseId, toolName: str(block.name) || 'tool', input: block.input ?? null },
          toolUseId,
          createdAt: clock,
        };
      }
    }
  }
}

export const cursorAdapter: SourceAdapter = { id: 'cursor', label: 'Cursor', list, read };
