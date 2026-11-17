/**
 * memory/search.ts — memory_search tool
 *
 * SQLite FTS5 全文检索 (Hermes 风格)。召回分三层: 短语 MATCH → 整串 LIKE →
 * 前两层都为空时按空白拆词 OR (escapeFtsQuery 仍把 MATCH 收成 phrase, 不支持
 * AND/OR/NOT advanced 语法), 保证已有短语命中的结果集不变; 拆词臂按覆盖率过滤
 * 并按覆盖词数排序。
 *
 * 适用场景: LLM 知道想找的内容大概是什么 (关键词), 但不知道哪个文件; 用 search
 * 拿候选 + snippet, 再走 memory_read 拿全文。
 */

import { z } from 'zod';

import { withStore } from './_shared.js';
import type { MemoryMcpDeps, MemoryProviderHit } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';

export function registerMemorySearchTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_search',
    category: 'search',
    description:
      '关键词检索当前任务账号级与项目的 memory (按 title/description/body)。优先短语精确匹配; ' +
      '短语无命中时按空格拆词召回: 只保留覆盖至少一半关键词的命中 (无满足者时退回全部; ' +
      '2 个词时再滤掉分数过低的单关键词命中), 覆盖越多排得越前, ' +
      '片段展示命中词附近的上下文并用 <mark> 标记。' +
      '返回按相关度排序的命中列表 (scope / filename / type / title / snippet / score)。' +
      ' 可选 type 限定类目, limit 默认 10 (上限 50)。' +
      ' 拿到候选后走 memory_read 拉全文。',
    inputShape: {
      query: z.string().min(1).max(200).describe('搜索关键词, 短语优先; 多词用空格分隔 (最多 8 个词)'),
      type: z
        .enum(['user', 'feedback', 'project', 'reference'])
        .optional()
        .describe('限定类目'),
      limit: z.number().int().min(1).max(50).optional().describe('默认 10'),
    },
    handler: async ({ query, type, limit }) =>
      withStore(deps, async (_store, ctx) => {
        const opts: { type?: typeof type; limit?: number } = {};
        if (type) opts.type = type;
        if (limit) opts.limit = limit;
        const all = [];
        for (const scope of ['project', 'user'] as const) {
          const store = await ctx.open(scope);
          if (store) for (const hit of await store.search(query, opts)) all.push({ ...hit, scope });
        }
        // bm25: 越小越相关; 两份各自已排好, 合并后再取前 limit 条。
        const max = limit ?? 10;
        const hits = all.sort((a, b) => a.score - b.score).slice(0, max);
        let provided: MemoryProviderHit[];
        let truncated = false;
        try {
          const pending = deps.searchProviders?.(query, opts, deps.getSessionContext?.());
          if (!pending) return { hits, count: hits.length };
          const result = await pending;
          provided = Array.isArray(result) ? result : result.hits;
          truncated = !Array.isArray(result) && result.truncated === true;
        }
        catch { return { hits, count: hits.length }; }
        if (!provided.length) return { hits, count: hits.length };
        // Preserve each source's own ordering; scores from different indexes are
        // not comparable. Cindy and providers alternate within the caller's limit.
        const merged: Array<(typeof hits)[number] | MemoryProviderHit> = [];
        for (let i = 0; merged.length < max && (i < hits.length || i < provided.length); i++) {
          if (i < hits.length) merged.push(hits[i]);
          if (i < provided.length && merged.length < max) merged.push(provided[i]);
        }
        return { hits: merged, count: merged.length, ...(truncated ? { truncated: true } : {}) };
      }),
  });
}
