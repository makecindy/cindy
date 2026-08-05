/**
 * generatedFiles — 从一轮回复的 tool_use 消息里派生「本轮 agent 新建的文件」。
 * ---------------------------------------------------------------------------
 * 纯派生、不新增持久化:tool_use 消息本身已落库并原样回放,所以历史会话重开后
 * 这张卡能稳定重建。跨 agent(claude-code / codex / pi)的工具名差异统一交给
 * `describeToolUse` 归一化,不自己维护工具名表:
 *   - kind==='file' 且 action==='create'  → Write / write(claude / pi 新建文件)
 *   - kind==='fileChange' 的 changes 里 action==='add' → codex file_change 新增文件
 * 「修改已有文件」(edit / update)与读取不算产出(产品口径:只收新建,见
 * AskUserQuestion 决策)。move / delete 同样排除。
 */

import { describeToolUse } from '@cindy/maker-shared';

import { resolveToolFilePath } from './localPathResolver';
import { basename } from './utils';

export interface GeneratedFileRef {
  /** 已按 workingDir 解析的绝对路径(用于存在性校验与 chip 打开)。 */
  path: string;
  /** 展示用文件名(basename)。 */
  name: string;
}

interface ToolUseLike {
  role: string;
  toolName?: string;
  toolInput?: unknown;
}

/** 单条 tool_use 消息 → 它新建的文件原始路径列表(可能为空)。 */
function createdPathsFromToolUse(toolName: string, input: unknown): string[] {
  const descriptor = describeToolUse(toolName, input);
  if (descriptor.kind === 'file') {
    return descriptor.action === 'create' && descriptor.filePath ? [descriptor.filePath] : [];
  }
  if (descriptor.kind === 'fileChange') {
    return descriptor.changes
      .filter((c) => c.action === 'add' && c.path)
      .map((c) => c.path);
  }
  return [];
}

/**
 * 一组消息(通常是一个 turn 的切片,但对任意切片都成立)→ 新建文件的有序去重
 * 列表。路径经 `resolveToolFilePath` 解析成绝对路径;`workingDir` 为空时按原样
 * 保留(与其它 chip 解析同策)。存在性校验由调用方在渲染前做(异步 IPC)。
 */
export function collectGeneratedFiles(
  messages: readonly ToolUseLike[],
  workingDir: string,
): GeneratedFileRef[] {
  const seen = new Set<string>();
  const out: GeneratedFileRef[] = [];
  for (const msg of messages) {
    if (msg.role !== 'tool_use') continue;
    const toolName = msg.toolName ?? '';
    if (!toolName) continue;
    for (const rawPath of createdPathsFromToolUse(toolName, msg.toolInput)) {
      const abs = resolveToolFilePath(rawPath, workingDir);
      const key = abs.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: abs, name: basename(abs) });
    }
  }
  return out;
}
