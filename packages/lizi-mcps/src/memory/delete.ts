/**
 * memory/delete.ts — memory_delete tool
 *
 * 删除单条 memory 分片. 不存在抛 NOT_FOUND. 删完 MEMORY.md 自动重建。
 * 用户主动让 LLM 清理 / review 后清理过期条目时调。
 */

import { z } from 'zod';

import { memoryScopeArg, storeHolding, withStore, type MemoryScopeName } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';

export function registerMemoryDeleteTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_delete',
    category: 'write',
    description:
      '删除一条 memory 分片。filename 形如 "user_preferences.md"。删除后 MEMORY.md 自动重建。' +
      ' 不传 scope 时两份记忆都找; 两份都有同名文件时须传 scope。不存在返 NOT_FOUND。',
    inputShape: {
      filename: z.string().min(1).describe('memory 分片文件名'),
      scope: memoryScopeArg,
    },
    handler: async ({ filename, scope }) =>
      withStore(deps, async (_store, ctx) => {
        const target = await storeHolding(ctx, filename, scope as MemoryScopeName | undefined);
        await target.store.delete(filename);
        return { deleted: filename, scope: target.scope };
      }),
  });
}
