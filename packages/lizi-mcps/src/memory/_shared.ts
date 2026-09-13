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

import {
  resolveMemoryScopeKey,
  type MakerMemoryManager,
  type MakerMemoryStore,
} from '@cindy/maker-core';

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
export type WithStoreContext = {
  store: MakerMemoryStore;
  /** 解析后的 session scope key (linked worktree 已归一到主仓)。 */
  scopeKey: string;
  manager: MakerMemoryManager;
};

export async function withStore(
  deps: MemoryMcpDeps,
  fn: (store: MakerMemoryStore, ctx: WithStoreContext) => Promise<unknown>,
): Promise<MemoryToolResult> {
  let store: MakerMemoryStore;
  let manager: MakerMemoryManager;
  let scopeKey: string;
  let scopeAtEntry: string | null = null;
  try {
    manager = deps.getManager();
    if (!manager.isEnabled()) {
      return buildJsonResult(
        { ok: false, code: 'MAKER_MEMORY_NOT_READY', message: 'maker memory disabled (mode != "maker")' },
        true,
      );
    }
    // 操作锚点 (review #2388 Codex 4th P1): getStore 返回的裸 store 在 manager
    // 守卫之外被调用方 await — 在拿 store 前捕获 scope, fn 完成后复核, 期间
    // 登出/切账号则操作结果不可信, fail-closed。
    scopeAtEntry = manager.currentOwnerScopeKey?.() ?? null;
    const ctx = deps.getSessionContext?.();
    const workdir = ctx?.workingDir ?? deps.workdir;
    // SSH remote 会话 (ctx 带 remoteHostId) 的 workdir 是远端路径 — 经 scope
    // key 定位, 与 agent 启动注入 (claude-code/codex index.ts) 同一键规则;
    // 本地会话在此额外做 git worktree 归一化 (#2379)。已注入的 memoryScopeKey
    // (含 bot: / ssh:) 原样透传, 不再二次解析。
    //
    // 本地路径的外层 resolveMemoryScopeKey 缓存未命中时最长数秒 (Codex
    // #2519 3971991054)。该 await 发生在 getStore 的 owner 守卫之前: 期间切
    // 账号后 getStore 会以新 owner 为入口绑 store, 后置复核只能报错、无法
    // 撤销已发生的写/删。与 manager.getStore 同款: await 前捕获, await 后
    // 立刻复核, 不一致 fail-closed, 不调用 getStore。
    if (ctx?.memoryScopeKey) {
      scopeKey = ctx.memoryScopeKey;
    } else {
      const resolveScope = deps.resolveMemoryScopeKey ?? resolveMemoryScopeKey;
      scopeKey = await resolveScope(workdir, ctx?.remoteHostId);
    }
    // git 探测是 await: 期间 logout / 切账号会换 owner, 甚至换掉 getManager()
    // 绑定的 manager。必须在 getStore 前按入口 scope 复核, 否则会把解析到的
    // key 开到新 owner 的池里 (Codex #2399 P1 / #2519 3971991054)。
    manager = deps.getManager();
    if (scopeAtEntry !== null && manager.currentOwnerScopeKey?.() !== scopeAtEntry) {
      return buildJsonResult(
        {
          ok: false,
          code: 'MAKER_MEMORY_NOT_READY',
          message: 'owner scope changed during scope resolve; refusing to open store',
        },
        true,
      );
    }
    store = await manager.getStore(scopeKey);
  } catch (err) {
    const { code, message } = classifyMemoryError(err);
    return buildJsonResult({ ok: false, code, message }, true);
  }
  try {
    const data = await fn(store, { store, scopeKey, manager });
    // 操作后复核: owner 在 fn 执行期间切换 → 结果不可信, 不得按成功返回。
    if (scopeAtEntry !== null && deps.getManager().currentOwnerScopeKey?.() !== scopeAtEntry) {
      return buildJsonResult(
        {
          ok: false,
          code: 'MAKER_MEMORY_NOT_READY',
          message: 'owner scope changed during memory operation; result not trusted',
        },
        true,
      );
    }
    return buildJsonResult({ ok: true, data });
  } catch (err) {
    const { code, message } = classifyMemoryError(err);
    return buildJsonResult({ ok: false, code, message }, true);
  }
}
