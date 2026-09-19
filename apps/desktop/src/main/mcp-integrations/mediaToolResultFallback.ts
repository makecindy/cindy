/**
 * mediaToolResultFallback.ts
 * ---------------------------------------------------------------------------
 * 媒体工具结果的 echo 兜底暂存池。背景:cc CLI 的 stream-json stdout 可能被
 * 同进程日志(如 ANTHROPIC_LOG=debug 的请求体 dump)插队损坏,tool_result 的
 * user echo 概率性丢失 → renderer 收不到 xdt_image_urls、图片卡不渲染也不落库。
 *
 * 方案:媒体 MCP 工具本来就在本 main 进程执行,结果产出的瞬间通过
 * Host dep 同步塞进这里;turn 结束时 messagePersistBroadcaster
 * 的 flushOrphanToolResults 发现"有 tool_use 但没等到 tool_result"的媒体工具
 * 调用,旧 art / mivo 按语义 args 配对,ghost_call 按工具名 + tool_use id
 * （无 id 时按 session + 完整 input，且只认领唯一候选）精确配对,
 * 直接落库 + 广播,彻底解除对 stdout echo 的依赖。
 *
 * ghost_call 的 echo 正常到达时会消费对应条目,避免无 tool_use id 的后续相同
 * 调用误领旧结果;旧 art / mivo 条目仍靠 TTL 过期。池子进程级共享(MCP service
 * 是跨 session 单例),ghost_call 的精确条目额外按 session 隔离。
 */

import { isDeepStrictEqual } from 'node:util';
import type { MediaToolResultPayload } from '@cindy/mcps';
import { isGhostCallToolName } from '../../shared/ghost.js';
import { createLogger } from '../logger.js';

const log = createLogger('mediaToolResultFallback');

interface PendingEntryBase {
  resultText: string;
  ts: number;
  consumed: boolean;
}

type PendingEntry =
  | (PendingEntryBase & { match: 'semantic-args'; args: Record<string, unknown> })
  | (PendingEntryBase & {
      match: 'exact-tool-use';
      sessionId: string;
      toolName: string;
      toolUseId?: string;
      toolUseInput: unknown;
    });

type ExactPendingEntry = Extract<PendingEntry, { match: 'exact-tool-use' }>;

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 50;

const pending: PendingEntry[] = [];

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].consumed || pending[i].ts < cutoff) pending.splice(i, 1);
  }
  while (pending.length > MAX_ENTRIES) pending.shift();
}

/** @cindy/mcps `onMediaToolResult` dep 的实现。永不 throw。 */
export function recordMediaToolResult(payload: MediaToolResultPayload): void {
  try {
    sweep();
    pending.push({
      match: 'semantic-args',
      ...payload,
      ts: Date.now(),
      consumed: false,
    });
    log.debug('media tool result recorded', {
      keys: Object.keys(payload.args),
      bytes: payload.resultText.length,
      poolSize: pending.length,
    });
  } catch {
    // 兜底池故障不影响工具主流程
  }
}

/**
 * 按完整 MCP 工具名和 input 记录结果。ghost_call 的输入可能没有任何
 * 业务 args，不能沿用旧 art / mivo 的「至少一个语义键」配对。
 */
export function recordMediaToolResultForToolUse(payload: {
  sessionId: string;
  toolName: string;
  toolUseId?: string;
  toolUseInput: unknown;
  resultText: string;
}): void {
  try {
    sweep();
    pending.push({
      match: 'exact-tool-use',
      ...payload,
      toolUseInput: structuredClone(payload.toolUseInput),
      ts: Date.now(),
      consumed: false,
    });
    log.debug('media tool result recorded for exact tool use', {
      toolName: payload.toolName,
      bytes: payload.resultText.length,
      poolSize: pending.length,
    });
  } catch {
    // 兜底池故障不影响工具主流程
  }
}

/**
 * 从 tool_use 的 input 中取出配对用的 args 对象。lizi_art / lizi_mivo 都是
 * `call_tool({ name, args })` 形态 → 取 input.args;直接参数形态取 input 本身。
 */
function extractCallArgs(toolUseInput: unknown): Record<string, unknown> | null {
  if (!toolUseInput || typeof toolUseInput !== 'object') return null;
  const input = toolUseInput as Record<string, unknown>;
  const inner = input.args;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return input;
}

/**
 * 确定性配对:payload.args 的每个键都必须在 tool_use args 中存在且值 JSON 相等
 * (payload.args 是"语义键全集"——mivo 是 { jobId },art 是完整 request——
 * tool_use args 允许有额外键,如 mivo call_tool 的 timeout)。至少命中一个键。
 */
function argsMatch(toolUseArgs: Record<string, unknown>, payloadArgs: Record<string, unknown>): boolean {
  const keys = Object.keys(payloadArgs);
  if (keys.length === 0) return false;
  let hits = 0;
  for (const k of keys) {
    if (!(k in toolUseArgs)) continue;
    if (!isDeepStrictEqual(toolUseArgs[k], payloadArgs[k])) return false;
    hits++;
  }
  return hits > 0;
}

function exactToolUseContextMatches(
  entry: ExactPendingEntry,
  toolName?: string,
  sessionId?: string,
): boolean {
  return sessionId === entry.sessionId
    && (toolName === entry.toolName
      || (isGhostCallToolName(toolName) && isGhostCallToolName(entry.toolName)));
}

function consume(entry: PendingEntry): string {
  entry.consumed = true;
  log.info('media tool result reclaimed for echo-less tool_use', {
    match: entry.match,
    ...(entry.match === 'semantic-args'
      ? { keys: Object.keys(entry.args) }
      : { toolName: entry.toolName }),
    bytes: entry.resultText.length,
  });
  return entry.resultText;
}

/**
 * 正常 echo 到达后消费对应 ghost_call 条目。无 toolUseId 时必须同时命中
 * 完整 echo 正文；仅凭相同 input 无法区分并发调用。
 */
export function discardMediaToolResultForToolUse(
  toolUseInput: unknown,
  toolName?: string,
  toolUseId?: string,
  sessionId?: string,
  echoedResultText?: string,
): void {
  try {
    sweep();
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      if (entry.match !== 'exact-tool-use' || entry.consumed) continue;
      if (!exactToolUseContextMatches(entry, toolName, sessionId)) continue;
      const matched = entry.toolUseId
        ? toolUseId === entry.toolUseId
        : echoedResultText !== undefined
          && echoedResultText === entry.resultText
          && isDeepStrictEqual(toolUseInput, entry.toolUseInput);
      if (!matched) continue;
      entry.consumed = true;
      log.debug('media tool result discarded after normal echo', {
        toolName: entry.toolName,
        bytes: entry.resultText.length,
      });
      return;
    }
  } catch {
    // 兜底池故障不影响工具主流程
  }
}

/** turn 收口后移除未消费的 ghost 精确条目，禁止旧结果跨 turn 被重试认领。 */
export function clearMediaToolResultsForSession(sessionId: string): void {
  try {
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      if (entry.match === 'exact-tool-use' && entry.sessionId === sessionId) {
        pending.splice(i, 1);
      }
    }
  } catch {
    // 兜底池故障不影响 turn 收口
  }
}

/**
 * 为一个未收到 echo 的 tool_use 认领媒体结果。命中则标记 consumed 并返回
 * resultText(即应落库的 tool_result 内容);无匹配返回 null。
 */
export function takeMediaToolResult(
  toolUseInput: unknown,
  toolName?: string,
  toolUseId?: string,
  sessionId?: string,
): string | null {
  const toolUseArgs = extractCallArgs(toolUseInput);
  if (isGhostCallToolName(toolName)) {
    const unidentifiedMatches: ExactPendingEntry[] = [];
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      if (
        entry.match !== 'exact-tool-use'
        || entry.consumed
        || Date.now() - entry.ts > TTL_MS
        || !exactToolUseContextMatches(entry, toolName, sessionId)
      ) {
        continue;
      }
      if (entry.toolUseId) {
        if (toolUseId === entry.toolUseId) return consume(entry);
        continue;
      }
      if (isDeepStrictEqual(toolUseInput, entry.toolUseInput)) unidentifiedMatches.push(entry);
    }
    if (unidentifiedMatches.length === 1) return consume(unidentifiedMatches[0]);
    if (unidentifiedMatches.length > 1) {
      log.warn('ambiguous media tool results left unclaimed', {
        toolName,
        candidates: unidentifiedMatches.length,
      });
    }
    return null;
  }
  // 从新到旧遍历:同键条目(如同一按钮 TTL 内重复触发)认领最近一次的结果,
  // 避免把上一轮遗留的旧图配给新的 tool_use。
  for (let i = pending.length - 1; i >= 0; i--) {
    const entry = pending[i];
    if (entry.consumed || Date.now() - entry.ts > TTL_MS) continue;
    const matched = entry.match === 'semantic-args'
      && toolUseArgs !== null
      && argsMatch(toolUseArgs, entry.args);
    if (matched) {
      return consume(entry);
    }
  }
  return null;
}

/** 测试用:清空池。 */
export function __resetMediaToolResultPoolForTesting(): void {
  pending.length = 0;
}
