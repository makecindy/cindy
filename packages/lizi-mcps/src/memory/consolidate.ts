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

import { memoryScopeArg, storeForNew, storeHolding, withStore, type MemoryScopeName } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';

export function registerMemoryConsolidateTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_consolidate',
    category: 'maintain',
    description:
      '原子化合并多个 memory 分片 — 写一个新的 (或更新现有) + 删源 + 一次性重建索引/FTS。' +
      ' 用于 size warning 后的瘦身, 或 review 发现可合并冗余时。' +
      ' target 字段同 memory_write (含 type/name/title/description/body); sources 是要删的源 filename 列表。' +
      ' scope 是合并结果放哪一份 (规则同 memory_write); sources 可以来自另一份, 例如把项目里的通用偏好并进 user。',
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
      scope: memoryScopeArg,
    },
    handler: async ({ sources, target, scope }) => {
      const saved = deps.beginWrite?.(deps.getSessionContext?.());
      let writtenScope: MemoryScopeName | undefined;
      const result = await withStore(deps, async (_store, ctx) => {
        const wanted = scope as MemoryScopeName | undefined;
        const targetFile = `${target.type}_${target.name}.md`;
        // 结果放哪一份: 指定的优先; 目标已存在就跟着它; 否则按新条目的规则。
        const existing = wanted ? null : await storeHolding(ctx, targetFile).catch(() => null);
        const dest = existing && (await existing.store.read(targetFile).then(() => true, () => false))
          ? existing
          : await storeForNew(ctx, wanted, target.type);
        const other = await ctx.open(dest.scope === 'user' ? 'project' : 'user');
        // 源文件在结果那一份里的走原子合并; 只在另一份里的, 合并成功后再从那一份删掉。
        const own: string[] = [];
        const foreign: string[] = [];
        for (const source of sources) {
          const inDest = await dest.store.read(source).then(() => true, () => false);
          const inOther = !inDest && other ? await other.read(source).then(() => true, () => false) : false;
          (inOther ? foreign : own).push(source);
        }
        const merged = await dest.store.consolidate({ sources: own, target: { ...target } });
        for (const source of foreign) {
          await other!.delete(source);
          merged.deletedSources.push(source);
        }
        deps.onStoreChanged?.(deps.getSessionContext?.(), ctx.scopes[dest.scope]!);
        if (ctx.scopes.user) writtenScope = dest.scope;
        return { ...merged, scope: dest.scope };
      });
      if (!result.isError) saved?.({ key: `${target.type}_${target.name}.md`, title: target.title, action: 'updated',
        ...(writtenScope ? { scope: writtenScope } : {}) });
      return result;
    },
  });
}
