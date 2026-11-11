/**
 * WorkBuddy 来源适配器（换引擎续做）。
 *
 * WorkBuddy 基于 CodeBuddy，没有公开的存储说明，读取尽量宽容：
 * - 历史：`~/.workbuddy/projects/<目录转码>/<会话编号>.jsonl`（也兼容 `~/.workbuddy-ai/`）；
 *   只走 projects/，不碰 mcp.json、连接器状态、密钥等其它文件；
 * - 每行一条记录，兼容两种写法：
 *   · CodeBuddy 风格：`message`（role + input_text / output_text 内容）、`function_call`、
 *     `function_call_result`、`topic`（标题）；`providerData.skipRun` 的是注入的提示，跳过；
 *   · Claude Code 风格：`user` / `assistant` 带 `message`；
 * - 读不出任何消息时由导入执行层标为失败，不会生成空任务。
 */

import path from 'node:path';

import { parseJsonLine, readLines } from '../lineReader.js';
import type { NormalizedMessage, ReadContext, ScanContext, SourceAdapter, SourceListResult, SourceSession } from '../types.js';
import {
  anthropicBlocks,
  decodeDashedPath,
  dirExistsSync,
  firstNonEmpty,
  isRecord,
  makeTitle,
  parseMaybeJson,
  str,
  stringifyOutput,
  toMs,
  walkFiles,
} from './common.js';

interface WorkBuddyLocator { file: string }

const ROOTS = ['.workbuddy', '.workbuddy-ai'];

function lineMessages(obj: Record<string, unknown>, lineNo: number): NormalizedMessage[] {
  const type = str(obj.type);
  const createdAt = toMs(obj.timestamp);
  const key = `${lineNo}`;
  if (type === 'message') {
    if (isRecord(obj.providerData) && obj.providerData.skipRun === true) return [];
    const role = str(obj.role);
    if (role !== 'user' && role !== 'assistant') return [];
    return anthropicBlocks(role, obj.content, key, createdAt);
  }
  if (type === 'function_call') {
    const toolUseId = firstNonEmpty(obj.callId, obj.call_id, obj.id) || key;
    return [{
      key,
      role: 'tool_use',
      content: { toolUseId, toolName: str(obj.name) || 'tool', input: parseMaybeJson(obj.arguments) },
      toolUseId,
      createdAt,
    }];
  }
  if (type === 'function_call_result' || type === 'function_call_output') {
    const toolUseId = firstNonEmpty(obj.callId, obj.call_id, obj.id);
    return toolUseId ? [{ key, role: 'tool_result', content: stringifyOutput(obj.output), toolUseId, createdAt }] : [];
  }
  if ((type === 'user' || type === 'assistant') && isRecord(obj.message)) {
    return anthropicBlocks(type, obj.message.content, key, createdAt);
  }
  return [];
}

async function head(file: string): Promise<{ topic: string; cwd: string; firstAt: number; firstUser: string; id: string }> {
  let topic = '';
  let cwd = '';
  let firstAt = 0;
  let firstUser = '';
  let id = '';
  let lineNo = 0;
  for await (const line of readLines(file, { maxBytes: 256 * 1024 })) {
    lineNo += 1;
    const obj = parseJsonLine(line);
    if (!obj) continue;
    if (str(obj.type) === 'topic' && str(obj.topic)) topic = str(obj.topic);
    cwd = cwd || str(obj.cwd);
    id = id || str(obj.sessionId);
    firstAt = firstAt || toMs(obj.timestamp);
    if (!firstUser) {
      const user = lineMessages(obj, lineNo).find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
      if (user) firstUser = user.content as string;
    }
  }
  return { topic, cwd, firstAt, firstUser, id };
}

async function list(ctx: ScanContext): Promise<SourceListResult> {
  const sessions: SourceSession[] = [];
  const seen = new Set<string>();
  let internalCount = 0;
  let unreadableCount = 0;
  for (const root of ROOTS) {
    const projects = path.join(ctx.homeDir, root, 'projects');
    const files = await walkFiles(projects, (name) => name.endsWith('.jsonl'), { maxDepth: 3 });
    for (const f of files) {
      // 与 Claude Code 一样，子 Agent 记录在会话旁挂目录的 subagents/ 下。
      if (f.file.includes(`${path.sep}subagents${path.sep}`)) {
        internalCount += 1;
        continue;
      }
      if (path.dirname(path.dirname(f.file)) !== projects || f.size === 0) continue;
      try {
        const h = await head(f.file);
        const id = h.id || path.basename(f.file, '.jsonl');
        if (seen.has(id)) continue;
        const title = makeTitle(h.topic || h.firstUser, '');
        if (!title) continue;
        seen.add(id);
        sessions.push({
          source: 'workbuddy',
          sourceSessionId: id,
          title,
          cwd: h.cwd || decodeDashedPath(path.basename(path.dirname(f.file)), dirExistsSync),
          createdAt: h.firstAt || Math.floor(f.mtimeMs),
          updatedAt: Math.floor(f.mtimeMs),
          archived: false,
          sizeBytes: f.size,
          locator: JSON.stringify({ file: f.file } satisfies WorkBuddyLocator),
        });
      } catch {
        unreadableCount += 1;
      }
    }
  }
  return { sessions, internalCount, unreadableCount };
}

async function* read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage> {
  const { file } = JSON.parse(session.locator) as WorkBuddyLocator;
  let lineNo = 0;
  for await (const line of readLines(file, { signal: ctx.signal, onBytes: ctx.onBytes })) {
    lineNo += 1;
    const obj = parseJsonLine(line);
    if (obj) yield* lineMessages(obj, lineNo);
  }
}

export const workbuddyAdapter: SourceAdapter = { id: 'workbuddy', label: 'WorkBuddy', list, read };
