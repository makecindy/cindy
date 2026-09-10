/**
 * memory/search.ts — memory_search tool
 *
 * SQLite FTS5 全文检索 (Hermes 风格)。query 当前走 phrase 精确匹配 (storage 层
 * escapeFtsQuery 包了双引号), 不支持 AND/OR/NOT advanced 语法 — 后续如果 LLM
 * 表达需求强再开 raw mode 选项。
 *
 * 适用场景: LLM 知道想找的内容大概是什么 (关键词), 但不知道哪个文件; 用 search
 * 拿候选 + snippet, 再走 memory_read 拿全文。
 */

import { z } from 'zod';

import { withStore } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';

export function registerMemorySearchTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_search',
    category: 'search',
    description:
      'FTS5 全文检索当前 workdir 的 memory (按 title/description/body)。返回按相关度排序的命中列表 ' +
      '(filename / type / title / snippet 高亮 / score)。query 当前走精确短语匹配, ' +
      '可选 type 限定类目, limit 默认 10 (上限 50)。' +
      ' 拿到候选后走 memory_read 拉全文。',
    inputShape: {
      query: z.string().min(1).describe('搜索关键词 (短语精确匹配)'),
      type: z
        .enum(['user', 'feedback', 'project', 'reference', 'moment'])
        .optional()
        .describe('限定类目'),
      limit: z.number().int().min(1).max(50).optional().describe('默认 10'),
    },
    handler: async ({ query, type, limit }) =>
      withStore(deps, async (store) => {
        const opts: { type?: typeof type; limit?: number } = {};
        if (type) opts.type = type;
        if (limit) opts.limit = limit;
        const hits = await store.search(query, opts);
        return { hits, count: hits.length };
      }),
  });
}
