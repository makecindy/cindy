/**
 * memory/read.ts — memory_read tool
 *
 * 读单条 memory 分片全文 (含 frontmatter + body). LLM 看到 MEMORY.md 索引后,
 * 想拿某个分片详细内容时调。
 */

import { z } from 'zod';

import { memoryScopeArg, storeHolding, withStore, type MemoryScopeName } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';

export function registerMemoryReadTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_read',
    category: 'read',
    description:
      '读取一条 memory 分片的完整内容 (frontmatter + body)。filename 形如 "user_preferences.md", 可从 MEMORY.md 索引或 memory_list 获取。' +
      ' 不传 scope 时两份记忆都找。不存在返 NOT_FOUND, 文件名格式非法返 INVALID_PARAMS。',
    inputShape: {
      filename: z
        .string()
        .min(1)
        .describe('memory 分片文件名, e.g. "feedback_response_style.md"'),
      scope: memoryScopeArg,
    },
    handler: async ({ filename, scope }) =>
      withStore(deps, async (_store, ctx) => {
        const target = await storeHolding(ctx, filename, scope as MemoryScopeName | undefined);
        return { ...(await target.store.read(filename)), scope: target.scope };
      }),
  });
}
