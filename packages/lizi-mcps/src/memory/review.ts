/**
 * memory/review.ts — memory_review tool
 *
 * 让 LLM 自审当前 workdir 的所有 memory, 找矛盾/过期/冗余条目, 输出文字建议。
 * 不自动执行 delete/consolidate — 让调用方 LLM 在 turn 内决定 + 走标准 tool,
 * 保留可观测性 (跟 Claude Code Auto Dream 同思路, 但不开后台 cron)。
 *
 * 内部走 manager.runReview 跑一次 host 端 oneShot (默认 claude haiku, 最便宜)。
 * 大概几秒钟返回一段 markdown 建议。
 */

import { withStore } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';

export function registerMemoryReviewTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_review',
    category: 'maintain',
    description:
      '让 LLM 自审当前 workdir 的所有 memory, 输出 ≤200 字建议: 哪些可合并 / 删除 / 矛盾。' +
      ' 不自动执行 — 调用方 LLM 拿到建议后自行决定调 memory_delete / memory_consolidate。' +
      ' 用 host 端 haiku 跑, 几秒钟返回。',
    inputShape: {},
    handler: async () =>
      // 必须走 withStore: list/search/write 已按解析后的 scope 开 store。
      // 原先直接 runReview(deps.workdir) 会在 linked worktree 上读旧分片
      // (Codex #2399 P1)。runReview 的入参是 scope key, 与 getStore 同一把钥匙。
      withStore(deps, (_store, { manager, scopeKey }) => manager.runReview(scopeKey)),
  });
}
