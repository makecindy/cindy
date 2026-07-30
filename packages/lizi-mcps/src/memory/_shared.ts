/**
 * memory/_shared.ts
 *
 * 共享 helpers:
 *  - buildJsonResult: 拼成单 text MemoryToolResult, 跟 scheduler/_shared 同形
 *  - withStore:       拿 per-workdir MakerMemoryStore, 自动 try/catch + 错误翻译
 *
 * MakerMemoryManager 通过 deps.getManager() lazy 拿 (跟 scheduler 同模式),
 * manager 自身可能在用户切 mode/账号时被替换, 不能持长生命周期引用。
 *
 * deps.workdir 是 MCP server 工厂里的 fallback。Codex HTTP bridge 初始化期拿到
 * 的是全局空 ctx，所以 tool call 时优先通过 deps.getSessionContext() 读取当前
 * thread 的真实 workingDir。
 */

import { buildMemoryScopeKey, type MakerMemoryStore } from '@cindy/maker-core';

import type { MemoryToolResult } from '../cindy_memoryToolRegistry.js';
import type { MemoryMcpDeps } from '../types.js';
import { classifyMemoryError } from './errors.js';

export function buildJsonResult(payload: unknown, isError = false): MemoryToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * 拿当前 session 绑定 workdir 的 Store. manager 不可用 (没注入 / disabled) 时
 * 返 MAKER_MEMORY_NOT_READY 错误, 调用方按 plan 决定是否提示用户开 mode。
 */
export async function withStore(
  deps: MemoryMcpDeps,
  fn: (store: MakerMemoryStore) => Promise<unknown>,
): Promise<MemoryToolResult> {
  let store: MakerMemoryStore;
  try {
    const manager = deps.getManager();
    if (!manager.isEnabled()) {
      return buildJsonResult(
        { ok: false, code: 'MAKER_MEMORY_NOT_READY', message: 'maker memory disabled (mode != "maker")' },
        true,
      );
    }
    const ctx = deps.getSessionContext?.();
    const workdir = ctx?.workingDir ?? deps.workdir;
    // SSH remote 会话 (ctx 带 remoteHostId) 的 workdir 是远端路径 — 经 scope
    // key 定位, 与 agent 启动注入 (claude-code/codex index.ts) 同一键规则。
    store = await manager.getStore(buildMemoryScopeKey(workdir, ctx?.remoteHostId));
  } catch (err) {
    const { code, message } = classifyMemoryError(err);
    return buildJsonResult({ ok: false, code, message }, true);
  }
  try {
    const data = await fn(store);
    return buildJsonResult({ ok: true, data });
  } catch (err) {
    const { code, message } = classifyMemoryError(err);
    return buildJsonResult({ ok: false, code, message }, true);
  }
}
