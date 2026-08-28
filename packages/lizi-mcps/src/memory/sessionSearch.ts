/**
 * memory/sessionSearch.ts — session_search tool
 *
 * 跨 session 历史对话 FTS5 检索 (Hermes 风格). 数据在 desktop messages 表的 FTS5
 * 影子表 (messages_fts), 通过 deps.searchSessions 注入访问。
 *
 * 只在 host 启用了 searchSessions 时注册 — 跟 art video registry 同模式: host 没
 * 提供能力的 tool 不暴露给 LLM, 避免出现"工具存在但调了永远 500"的状态。
 *
 * 跟 memory_search 区别:
 *  - memory_search: 搜提炼后的 memory 分片 (短、稀疏、值得反复回看)
 *  - session_search: 搜原始对话历史 (长、稠密、噪声多)
 *
 * 用途: LLM 想回忆 "上次怎么解决这个 bug" / "用户提到过的某事在哪轮聊的" 时调。
 */

import { z } from 'zod';

import { buildJsonResult } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';
import { classifyMemoryError } from './errors.js';

export function registerSessionSearchTool(
  registry: MemoryToolRegistry,
  deps: MemoryMcpDeps,
): void {
  if (!deps.searchSessions) {
    // host 没接 messages_fts → 不注册, list_tools 也看不到。
    return;
  }
  const searchFn = deps.searchSessions;
  registry.register({
    name: 'session_search',
    category: 'search',
    description:
      'FTS5 全文检索本地存档的历史对话内容 (跨所有 session)。返回按相关度排序的 message ' +
      '命中 (sessionId / messageId / role / snippet 高亮 / ts)。' +
      ' 跟 memory_search 区别: memory_search 搜提炼后的 memory 分片, session_search 搜原始对话。' +
      ' 用于 "上次怎么解决这个 bug" / "用户提到过 X 在哪轮" 类场景。',
    inputShape: {
      query: z.string().min(1).max(256).describe('搜索关键词 (中文按字相邻匹配, 多词 AND, 最长 256)'),
      sessionId: z.string().optional().describe('限定某 session'),
      role: z.enum(['user', 'assistant', 'system']).optional().describe('限定 message role'),
      limit: z.number().int().min(1).max(50).optional().describe('默认 10'),
    },
    handler: async ({ query, sessionId, role, limit }) => {
      try {
        const opts: { sessionId?: string; role?: typeof role; limit?: number } = {};
        if (sessionId) opts.sessionId = sessionId;
        if (role) opts.role = role;
        if (limit) opts.limit = limit;
        const hits = await searchFn(query, opts);
        return buildJsonResult({ ok: true, data: { hits, count: hits.length } });
      } catch (err) {
        const { code, message } = classifyMemoryError(err);
        return buildJsonResult({ ok: false, code, message }, true);
      }
    },
  });
}
