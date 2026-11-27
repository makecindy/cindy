/**
 * Factory（droid）来源适配器（换引擎续做）。
 *
 * Factory 不开源，格式按公开社区解析器与实际样本整理，读取尽量宽容：
 * - 历史：`~/.factory/sessions/<目录转码>/<会话编号>.jsonl`（也见过 `projects/` 下）；
 * - 首行 `session_start` 带 id / title / cwd；其后 `message` 行的 `message` 与 Claude Code
 *   相似（role + 字符串或 text / tool_use / tool_result / thinking 内容块）；
 * - 读不出任何消息时由导入执行层标为失败，不会生成空任务。
 */

import path from 'node:path';

import { parseJsonLine, readLines } from '../lineReader.js';
import type { NormalizedMessage, ReadContext, ScanContext, SourceAdapter, SourceListResult, SourceSession } from '../types.js';
import { anthropicBlocks, decodeDashedPath, dirExistsSync, isRecord, makeTitle, str, toMs, walkFiles } from './common.js';

interface FactoryLocator { file: string }


function lineMessages(obj: Record<string, unknown>, lineNo: number): NormalizedMessage[] {
  const type = str(obj.type);
  const message = isRecord(obj.message) ? obj.message : type === 'user' || type === 'assistant' ? obj : null;
  if (!message) return [];
  const role = str(message.role) || type;
  if (role !== 'user' && role !== 'assistant') return [];
  return anthropicBlocks(role, message.content, `${lineNo}`, toMs(obj.timestamp ?? message.timestamp));
}

async function head(file: string): Promise<{ id: string; title: string; cwd: string; firstAt: number; firstUser: string }> {
  let id = '';
  let title = '';
  let cwd = '';
  let firstAt = 0;
  let firstUser = '';
  let lineNo = 0;
  for await (const line of readLines(file, { maxBytes: 256 * 1024 })) {
    lineNo += 1;
    const obj = parseJsonLine(line);
    if (!obj) continue;
    if (str(obj.type) === 'session_start') {
      id = str(obj.id) || id;
      title = str(obj.title) || title;
      cwd = str(obj.cwd) || cwd;
      continue;
    }
    firstAt = firstAt || toMs(obj.timestamp);
    if (!firstUser) {
      const user = lineMessages(obj, lineNo).find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
      if (user) firstUser = user.content as string;
    }
    if (firstUser && id) break;
  }
  return { id, title, cwd, firstAt, firstUser };
}

async function list(ctx: ScanContext): Promise<SourceListResult> {
  const sessions: SourceSession[] = [];
  const seen = new Set<string>();
  let unreadableCount = 0;
  for (const sub of ['sessions', 'projects']) {
    const root = path.join(ctx.homeDir, '.factory', sub);
    const files = await walkFiles(root, (name) => name.endsWith('.jsonl'), { maxDepth: 2 });
    for (const f of files) {
      if (f.size === 0) continue;
      try {
        const h = await head(f.file);
        const id = h.id || path.basename(f.file, '.jsonl');
        if (seen.has(id)) continue;
        const title = makeTitle(h.title || h.firstUser, '');
        if (!title) continue;
        seen.add(id);
        const projectDir = path.basename(path.dirname(f.file));
        sessions.push({
          source: 'factory',
          sourceSessionId: id,
          title,
          cwd: h.cwd || (projectDir === sub ? null : decodeDashedPath(projectDir, dirExistsSync)),
          createdAt: h.firstAt || Math.floor(f.mtimeMs),
          updatedAt: Math.floor(f.mtimeMs),
          archived: false,
          sizeBytes: f.size,
          locator: JSON.stringify({ file: f.file } satisfies FactoryLocator),
        });
      } catch {
        unreadableCount += 1;
      }
    }
  }
  return { sessions, internalCount: 0, unreadableCount };
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const { file } = JSON.parse(session.locator) as FactoryLocator;
  let lineNo = 0;
  for await (const line of readLines(file, { signal: ctx.signal, onBytes: ctx.onBytes })) {
    lineNo += 1;
    const obj = parseJsonLine(line);
    if (obj) yield* lineMessages(obj, lineNo);
  }
}

export const factoryAdapter: SourceAdapter = { id: 'factory', label: 'Factory', list, read };
