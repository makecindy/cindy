/**
 * memory/consolidate.ts — memory_consolidate tool
 *
 * 把多个分片合并成一个新分片 (写新条目 + 删源 + 重建索引, 原子化)。
 * LLM 收到 size warning ('shard-size-exceeded' / 'index-size-exceeded') 后调,
 * 或者 review 工具发现可合并条目主动调。
 *
 * 防呆: 不允许把 target 写到正要被删的 source (会自删) — store 层已处理。
 */

import { z } from 'zod';

import { withStore } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';

export function registerMemoryConsolidateTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_consolidate',
    category: 'maintain',
    description:
      '原子化合并多个 memory 分片 — 写一个新的 (或更新现有) + 删源 + 一次性重建索引/FTS。' +
      ' 用于 size warning 后的瘦身, 或 review 发现可合并冗余时。' +
      ' target 字段同 memory_write (含 type/name/title/description/body); sources 是要删的源 filename 列表。',
    inputShape: {
      sources: z
        .array(z.string().min(1))
        .min(1)
        .describe('要删除的源分片 filename 列表 (target 自身会被自动跳过)'),
      target: z.object({
        type: z.enum(['user', 'feedback', 'project', 'reference']),
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_-]+$/),
        title: z.string().min(1).max(100),
        description: z.string().min(1).max(200),
        body: z.string().min(1),
      }),
    },
    handler: async ({ sources, target }) => {
      const saved = deps.beginWrite?.(deps.getSessionContext?.());
      const result = await withStore(deps, store => store.consolidate({ sources, target: { ...target } }));
      if (!result.isError) saved?.({ key: `${target.type}_${target.name}.md`, title: target.title, action: 'updated' });
      return result;
    },
  });
}
