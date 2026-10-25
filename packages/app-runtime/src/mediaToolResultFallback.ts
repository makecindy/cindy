/**
 * mediaToolResultFallback.ts
 * ---------------------------------------------------------------------------
 * 媒体工具结果的 echo 兜底暂存池。背景:cc CLI 的 stream-json stdout 可能被
 * 同进程日志(如 ANTHROPIC_LOG=debug 的请求体 dump)插队损坏,tool_result 的
 * user echo 概率性丢失 → renderer 收不到 xdt_image_urls、图片卡不渲染也不落库。
 *
 * 方案:art / mivo 的 MCP 工具本来就在本 main 进程执行,结果产出的瞬间通过
 * `onMediaToolResult` dep 同步塞进这里;turn 结束时 messagePersistBroadcaster
 * 的 flushOrphanToolResults 发现"有 tool_use 但没等到 tool_result"的媒体工具
 * 调用,按 args 确定性配对(mivo 用 jobId,art 用 prompt/model 等入参全集),
 * 直接落库 + 广播,彻底解除对 stdout echo 的依赖。
 *
 * echo 正常到达时池子不被消费,条目靠 TTL 过期 — 不会产生重复消息。
 * 池子进程级共享(MCP service 是跨 session 单例),配对靠 args 语义键,
 * 不依赖 session 归属。
 */

import type { MediaToolResultPayload } from '@cindy/mcps';
import type { DbLogger } from '@cindy/runtime-db/logging';


interface PendingEntry extends MediaToolResultPayload {
  ts: number;
  consumed: boolean;
}
export function createMediaToolResultFallback(logger: DbLogger) {
const log = logger;


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
function recordMediaToolResult(payload: MediaToolResultPayload): void {
  try {
    sweep();
    pending.push({ ...payload, ts: Date.now(), consumed: false });
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
    if (JSON.stringify(toolUseArgs[k]) !== JSON.stringify(payloadArgs[k])) return false;
    hits++;
  }
  return hits > 0;
}

/**
 * 为一个未收到 echo 的 tool_use 认领媒体结果。命中则标记 consumed 并返回
 * resultText(即应落库的 tool_result 内容);无匹配返回 null。
 */
function takeMediaToolResult(toolUseInput: unknown): string | null {
  const toolUseArgs = extractCallArgs(toolUseInput);
  if (!toolUseArgs) return null;
  // 从新到旧遍历:同键条目(如同一按钮 TTL 内重复触发)认领最近一次的结果,
  // 避免把上一轮遗留的旧图配给新的 tool_use。
  for (let i = pending.length - 1; i >= 0; i--) {
    const entry = pending[i];
    if (entry.consumed || Date.now() - entry.ts > TTL_MS) continue;
    if (argsMatch(toolUseArgs, entry.args)) {
      entry.consumed = true;
      log.info('media tool result reclaimed for echo-less tool_use', {
        keys: Object.keys(entry.args),
        bytes: entry.resultText.length,
      });
      return entry.resultText;
    }
  }
  return null;
}

/** 测试用:清空池。 */
function __resetMediaToolResultPoolForTesting(): void {
  pending.length = 0;
}
return {
  recordMediaToolResult,
  takeMediaToolResult,
  __resetMediaToolResultPoolForTesting
};
}
