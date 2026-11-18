/**
 * memory/write.ts — memory_write tool
 *
 * 写入或覆盖 memory 分片。schema 强校验 (frontmatter + size + slug 路径) 在 storage
 * 层完成, 这里只接管 z.object 校验 + tool result 包装。
 *
 * name 接受 MEMORY.md 索引里的文件名、带 type 前缀的 slug 或纯 slug, 由 storage
 * 按逻辑地址解析到同一个分片 (见 storage.resolveFilename)。
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

import { shardNameSchema, memoryScopeArg, storeForNew, storeHolding, withStore, type MemoryScopeName } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';
import type { MakerMemoryStore, WriteOptions, WriteResult } from '@cindy/maker-core';

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_MAX = 5;

/** 这份记忆里最近 24 小时保存的其它条目 (新的在前, 至多 5 条); 内部的 digest 不算。 */
async function recentlySaved(
  store: MakerMemoryStore,
  justWritten: string,
): Promise<Array<{ filename: string; title: string }>> {
  const since = Date.now() - RECENT_WINDOW_MS;
  return (await store.list())
    .filter((record) => record.filename !== justWritten && record.frontmatter.type !== 'digest')
    .filter((record) => (Date.parse(record.frontmatter.updatedAt) || 0) >= since)
    .sort((a, b) => b.frontmatter.updatedAt.localeCompare(a.frontmatter.updatedAt))
    .slice(0, RECENT_MAX)
    .map((record) => ({ filename: record.filename, title: record.frontmatter.title }));
}

export function registerMemoryWriteTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_write',
    category: 'write',
    description:
      '写入一条 memory 分片。type 必须是 user/feedback/project/reference 之一; ' +
      'name 是 filename slug 或直接用 MEMORY.md 索引里的文件名 (如 project_foo.md), ' +
      '两种写法指向同一个分片; title 显示标题 (中英均可); ' +
      'description 一行 hook (用作 MEMORY.md 索引行, 无换行, ≤ 200 字符); body 主体内容。' +
      'mode 默认 create (撞名拒绝), 可选 update/append。' +
      ' scope 选哪一份记忆: user = 关于用户本人、每个项目都生效; project = 只属于当前仓库或目录;' +
      ' 不传时 user 类进 user, 其余进 project。' +
      ' 写入后 MEMORY.md 自动重建; 软超 size 上限返 warning + warningDetail' +
      ' (sizeBytes/softLimitBytes/hardLimitBytes), 按超限幅度决定不动 / 微剪 / memory_consolidate;' +
      ' 会让索引越过硬上限的写入被拒绝 (INVALID_PARAMS), 先合并或删除再写。' +
      ' 新建成功后若返回 savedRecently, 那是这份记忆里最近 24 小时保存的其它条目 (你上下文里的索引快照可能还没有它们):' +
      ' 其中有说同一件事的, 用 memory_consolidate 合并, 不要留两条。',
    inputShape: {
      type: z.enum(['user', 'feedback', 'project', 'reference']),
      name: shardNameSchema,
      title: z.string().min(1).max(100),
      description: z
        .string()
        .min(1)
        .max(200)
        .describe('一行 hook, 无换行, 用作 MEMORY.md 索引'),
      body: z.string().min(1),
      mode: z.enum(['create', 'update', 'append']).optional(),
      scope: memoryScopeArg,
    },
    handler: async ({ scope, ...args }) => {
      const saved = deps.beginWrite?.(deps.getSessionContext?.());
      let written: WriteResult | undefined;
      let writtenScope: MemoryScopeName | undefined;
      const result = await withStore(deps, async (_store, ctx) => {
        // 改已有条目时跟着文件走 (旧数据里 user 类可能还在项目那一份); 新建按规则选。
        const target = args.mode === 'update' || args.mode === 'append'
          ? await storeHolding(ctx, args.name as string, scope as MemoryScopeName | undefined, args.type as WriteOptions['type'])
          : await storeForNew(ctx, scope as MemoryScopeName | undefined, args.type as string);
        written = await target.store.write(args as WriteOptions);
        // 伙伴只有一份记忆, 回执不带 scope; Cindy 记忆才分账号级和项目。
        if (ctx.scopes.user) writtenScope = target.scope;
        // 索引是任务启动时的快照: 别的任务 (或本任务更早) 刚存下的条目模型看不到, 实际数据里
        // 同一天存出过两条说同一件事的记忆。新建时把这份记忆里刚存的其它条目告诉它, 由它判断
        // 是否重复 —— 宿主不做相似度判断 (标题相近的常常是两件事)。
        const savedRecently = args.mode === 'update' || args.mode === 'append'
          ? []
          // 只是提示: 记忆已经存好, 列不出来也不能把这次写入报成失败 (账号边界由 withStore 收尾复核)。
          : await recentlySaved(target.store, written.filename).catch(() => []);
        return { ...written, scope: target.scope, ...(savedRecently.length ? { savedRecently } : {}) };
      });
      if (!result.isError && written) saved?.({ key: written.filename, title: args.title as string,
        action: args.mode === 'update' || args.mode === 'append' ? 'updated' : 'created',
        ...(writtenScope ? { scope: writtenScope } : {}) });
      return result;
    },
  });
}
