/**
 * Claude Code 会话转录(jsonl)的 tool_use id 归一化 —— resume 前修复
 * kimi 系 tool_call id 与 CLI ensureToolResultPairing 冲突导致的上下文腐蚀。
 *
 * 背景(2026-07-31 moonshot/kimi-k3 实测事故,顺藤摸到的完整因果链):
 *   1. moonshot 服务端按「当前请求历史里可见的 tool 调用数」铸造 tool_call id
 *      (`${ToolName}_${index}`:Bash_210、TaskCreate_35 这种形态)。
 *   2. 会话 rewind / 中断轮被 CLI 投影排除后,可见调用数 < 历史已用 id 上界,
 *      resume 后 moonshot 重新铸出**与历史重复**的 id(实测:Bash_210 被铸 9 次、
 *      Bash_212 被铸 27 次)。
 *   3. CC CLI(2.1.219 起)的 ensureToolResultPairing 用全局 Set 去重:后出现的
 *      重复 id tool_use 块连同其 tool_result 一起从请求里丢弃;被掏空的 user
 *      消息以字面量 "(no content)" 占位进请求。模型于是看到自己的工具调用
 *      「被阻止」、用户不断「发空消息」,进入空转循环(inc-4977 同族)。
 *
 * 修复策略(resume/spawn 前对转录做一次性归一化,幂等):
 *   a. 去重:同一 id 的第 N 次出现重写为 `${id}_dup${N}`(tool_use 与按出现
 *      顺序配对的 tool_result 同步改写;与 compat-proxy dedupeDuplicateToolUseIds
 *      的出现序配对语义一致,超编 result 保持原 id 不动)。
 *   b. 移出铸造空间:所有 `${name}_${digits}` 形态 id 改写为 `${name}_x${digits}`。
 *      moonshot 的铸造器只会产出 `_数字` 后缀,改写后历史 id 与未来新铸 id
 *      永不撞车;`_x` 形态不再匹配本规则 → 幂等,二次运行零改写。
 *
 * id 对模型与 API 均为不透明字符串,配对关系保持 → 改写不改变会话语义。
 * 未改动的行保持原始字节(与 fork-jsonl-repair 同约定),改写整文件前调用方
 * 负责备份(见 normalizeClaudeSessionJsonlToolIds)。
 */

import { promises as fs } from 'node:fs';

import { createClaudeJsonlBackup } from './fork-jsonl-repair.js';

type JsonObject = Record<string, unknown>;

/** moonshot/kimi 铸造器形态的 id:`${ToolName}_${纯数字}`。 */
const MINTED_ID_RE = /^([A-Za-z][A-Za-z0-9]*)_(\d+)$/;

/** 廉价预扫:文件里是否存在疑似铸造 id 的 tool_use / tool_result,无命中则跳过全量解析。 */
const SUSPECT_ID_RE = /"(?:id|tool_use_id)"\s*:\s*"[A-Za-z][A-Za-z0-9]*_\d+"/;

export interface NormalizeClaudeJsonlToolIdsResult {
  /** 归一化后的完整文本(changed=false 时与输入同引用)。 */
  text: string;
  changed: boolean;
  lineCount: number;
  /** 预扫未命中而跳过时为 true(此时 changed=false,未做解析)。 */
  skipped: boolean;
  /** 去重改写的块数(tool_use + tool_result 合计)。 */
  dedupedBlockCount: number;
  /** 移出铸造空间改写的块数(tool_use + tool_result 合计)。 */
  offsetBlockCount: number;
  /** 参与去重判定的重复 id 个数(诊断用)。 */
  duplicateIdCount: number;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolUseBlock(block: unknown): block is JsonObject & { id: string } {
  return (
    isRecord(block) &&
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    block.id.length > 0
  );
}

function isToolResultBlock(block: unknown): block is JsonObject & { tool_use_id: string } {
  return (
    isRecord(block) &&
    block.type === 'tool_result' &&
    typeof block.tool_use_id === 'string' &&
    block.tool_use_id.length > 0
  );
}

function messageContentBlocks(entry: JsonObject): JsonObject[] | null {
  const message = entry.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  return content as JsonObject[];
}

function offsetMintedId(id: string): string | null {
  const match = MINTED_ID_RE.exec(id);
  if (!match) return null;
  return `${match[1]}_x${match[2]}`;
}

/**
 * 文本级归一化:解析 → 去重 → 移出铸造空间 → 仅重写有改动的行。
 *
 * 预扫未命中(纯 Anthropic toolu_* / OpenAI call_* 会话)直接返回原文,
 * 不做 JSON 解析 —— spawn 前路径上对绝大多数会话零成本。
 */
export function normalizeClaudeJsonlToolIdsText(text: string): NormalizeClaudeJsonlToolIdsResult {
  const lineCount = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (!SUSPECT_ID_RE.test(text)) {
    return {
      text,
      changed: false,
      lineCount,
      skipped: true,
      dedupedBlockCount: 0,
      offsetBlockCount: 0,
      duplicateIdCount: 0,
    };
  }

  const hadTrailingNewline = text.endsWith('\n');
  const rawLines = text.split('\n');
  if (hadTrailingNewline) rawLines.pop();
  const entries = rawLines.map((line, index) => {
    try {
      return JSON.parse(line) as JsonObject;
    } catch {
      const preview = line.slice(0, 120);
      throw new Error(`tool id normalize: JSONL parse error at line ${index + 1}: ${preview}`);
    }
  });

  // pass 1: 统计每个 tool_use id 的出现次数(assistant 条目)。
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    for (const block of messageContentBlocks(entry) ?? []) {
      if (isToolUseBlock(block)) counts.set(block.id, (counts.get(block.id) ?? 0) + 1);
    }
  }
  let duplicateIdCount = 0;
  for (const n of counts.values()) {
    if (n > 1) duplicateIdCount += 1;
  }

  // pass 2: 去重 —— 第 N(N≥2) 次出现的 call 重写为 `${id}_dup${N}`;
  // 按出现顺序配对的第 N 个 result 同步改写(超编 result 保持原 id,
  // 与 compat-proxy dedupeDuplicateToolUseIds 语义一致)。
  const changedLineIndexes = new Set<number>();
  let dedupedBlockCount = 0;
  if (duplicateIdCount > 0) {
    const callSeen = new Map<string, number>();
    const resultSeen = new Map<string, number>();
    entries.forEach((entry, index) => {
      const role = isRecord(entry.message) ? entry.message.role : undefined;
      const blocks = messageContentBlocks(entry);
      if (!blocks) return;
      let lineChanged = false;
      for (const block of blocks) {
        if (role === 'assistant' && isToolUseBlock(block)) {
          const n = (callSeen.get(block.id) ?? 0) + 1;
          callSeen.set(block.id, n);
          if (n >= 2) {
            block.id = `${block.id}_dup${n}`;
            dedupedBlockCount += 1;
            lineChanged = true;
          }
        } else if (role === 'user' && isToolResultBlock(block)) {
          const id = block.tool_use_id;
          const n = (resultSeen.get(id) ?? 0) + 1;
          resultSeen.set(id, n);
          if (n >= 2 && (counts.get(id) ?? 0) >= n) {
            block.tool_use_id = `${id}_dup${n}`;
            dedupedBlockCount += 1;
            lineChanged = true;
          }
        }
      }
      if (lineChanged) changedLineIndexes.add(index);
    });
  }

  // pass 3: 移出铸造空间 —— `${name}_${digits}` → `${name}_x${digits}`(幂等)。
  let offsetBlockCount = 0;
  entries.forEach((entry, index) => {
    const blocks = messageContentBlocks(entry);
    if (!blocks) return;
    let lineChanged = false;
    for (const block of blocks) {
      if (isToolUseBlock(block)) {
        const next = offsetMintedId(block.id);
        if (next !== null) {
          block.id = next;
          offsetBlockCount += 1;
          lineChanged = true;
        }
      } else if (isToolResultBlock(block)) {
        const next = offsetMintedId(block.tool_use_id);
        if (next !== null) {
          block.tool_use_id = next;
          offsetBlockCount += 1;
          lineChanged = true;
        }
      }
    }
    if (lineChanged) changedLineIndexes.add(index);
  });

  const changed = changedLineIndexes.size > 0;
  const nextText = changed
    ? `${entries
      .map((entry, index) => (changedLineIndexes.has(index) ? JSON.stringify(entry) : rawLines[index]))
      .join('\n')}${hadTrailingNewline ? '\n' : ''}`
    : text;

  return {
    text: nextText,
    changed,
    lineCount: entries.length,
    skipped: false,
    dedupedBlockCount,
    offsetBlockCount,
    duplicateIdCount,
  };
}

export interface NormalizeClaudeSessionJsonlToolIdsResult
  extends Omit<NormalizeClaudeJsonlToolIdsResult, 'text'> {
  filePath: string;
  backupPath?: string;
}

/**
 * 文件级归一化:有改动时先备份(`.bak.<timestamp>`)再整文件重写;
 * 无改动 / 预扫跳过时不触碰文件(连备份也不留)。
 */
export async function normalizeClaudeSessionJsonlToolIds(
  filePath: string,
): Promise<NormalizeClaudeSessionJsonlToolIdsResult> {
  const original = await fs.readFile(filePath, 'utf8');
  const normalized = normalizeClaudeJsonlToolIdsText(original);
  let backupPath: string | undefined;
  if (normalized.changed) {
    backupPath = await createClaudeJsonlBackup(filePath, original);
    await fs.writeFile(filePath, normalized.text, 'utf8');
  }
  return {
    filePath,
    changed: normalized.changed,
    ...(backupPath ? { backupPath } : {}),
    lineCount: normalized.lineCount,
    skipped: normalized.skipped,
    dedupedBlockCount: normalized.dedupedBlockCount,
    offsetBlockCount: normalized.offsetBlockCount,
    duplicateIdCount: normalized.duplicateIdCount,
  };
}
