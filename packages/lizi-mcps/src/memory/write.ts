/**
 * memory/write.ts — memory_write tool
 *
 * 写入或覆盖 memory 分片。schema 强校验 (frontmatter + size + slug 路径) 在 storage
 * 层完成, 这里只接管 z.object 校验 + tool result 包装。
 *
 * mode 语义:
 *  - 'create' (默认): 撞名抛 ALREADY_EXISTS, LLM 应改 'update' 或 'append'
 *  - 'update'       : 覆盖现有 (不存在抛 NOT_FOUND)
 *  - 'append'       : 追加到 body 末尾 (不存在抛 NOT_FOUND)
 *
 * 返 WriteResult 含可选 warning ('shard-size-exceeded' / 'index-size-exceeded')
 * 与 warningDetail (sizeBytes/softLimitBytes;hardLimitBytes 仅分片警告带,
 * 索引警告无硬上限), LLM 按超限幅度决定不动 / 微剪 / memory_consolidate 瘦身。
 */

import { z } from 'zod';

import { withStore } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';
import type { WriteOptions } from '@cindy/maker-core';

export function registerMemoryWriteTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_write',
    category: 'write',
    description:
      '写入一条 memory 分片。type 必须是 user/feedback/project/reference 之一; ' +
      'name 是 filename slug ([a-z0-9_-]{1,64}, 不是显示文本); title 显示标题 (中英均可); ' +
      'description 一行 hook (用作 MEMORY.md 索引行, 无换行, ≤ 200 字符); body 主体内容。' +
      'mode 默认 create (撞名拒绝), 可选 update/append。' +
      ' 写入后 MEMORY.md 自动重建; 软超 size 上限返 warning + warningDetail' +
      ' (sizeBytes/softLimitBytes, 分片警告另带 hardLimitBytes; 索引警告无硬上限),' +
      ' 按超限幅度决定不动 / 微剪 / memory_consolidate。',
    inputShape: {
      type: z.enum(['user', 'feedback', 'project', 'reference']),
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9_-]+$/, 'slug 只允许 [a-z0-9_-]')
        .describe('filename slug, 不是显示文本'),
      title: z.string().min(1).max(100),
      description: z
        .string()
        .min(1)
        .max(200)
        .describe('一行 hook, 无换行, 用作 MEMORY.md 索引'),
      body: z.string().min(1),
      mode: z.enum(['create', 'update', 'append']).optional(),
    },
    handler: async (args) =>
      withStore(deps, (store) => store.write(args as WriteOptions)),
  });
}
