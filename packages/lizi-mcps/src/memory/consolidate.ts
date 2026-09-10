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
import {
  buildFilename,
  isBotOnlyMemoryType,
  MemoryError,
  parseBotMemoryScopeKey,
} from '@cindy/maker-core';

export function registerMemoryConsolidateTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_consolidate',
    category: 'maintain',
    description:
      '原子化合并多个 memory 分片 — 写一个新的 (或更新现有) + 删源 + 一次性重建索引/FTS。' +
      ' 用于 size warning 后的瘦身, 或 review 发现可合并冗余时。' +
      ' target 字段同 memory_write (含 type/name/title/description/body); sources 是要删的源 filename 列表。' +
      ' moment 可作为伙伴(bot)作用域的合并目标 (例如将旧时刻合并成一条 moment); 普通 workdir scope 不允许 moment。',
    inputShape: {
      sources: z
        .array(z.string().min(1))
        .min(1)
        .describe('要删除的源分片 filename 列表 (target 自身会被自动跳过)'),
      // nested strict: 顶层 call_tool 只对 sources/target 未知键 INVALID_ARGS;
      // target 内部必须同样拒 sourceSession 等伪造字段, 不能 z.object 默默剥掉。
      target: z.object({
        type: z.enum(['user', 'feedback', 'project', 'reference', 'moment']),
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_-]+$/),
        title: z.string().min(1).max(100),
        description: z.string().min(1).max(200),
        body: z.string().min(1),
        occurredAt: z.string().max(40).optional(),
        significance: z.enum(['normal', 'high']).optional(),
      }).strict(),
    },
    handler: async ({ sources, target }) =>
      withStore(deps, async (store, { scopeKey }): Promise<unknown> => {
        // MCP 边界门禁 (#4124): bot-only target 必须命中 bot scope。throw MemoryError
        // 让 withStore 走 classifyMemoryError (invalid-type → INVALID_PARAMS),
        // 与 store 层门禁同一条错误信封。
        if (isBotOnlyMemoryType(target.type) && parseBotMemoryScopeKey(scopeKey) === null) {
          throw new MemoryError('invalid-type', 'moment 仅伙伴(bot)记忆可用; 当前 scope 不是 bot 记忆');
        }
        // sourceSession 不暴露给模型: 仅新建 target 时从当前 session ctx 注入;
        // 已存在走 update, 不注入, 让 storage 保留原分片溯源。缺 ctx 则不带该字段。
        const sessionId = deps.getSessionContext?.()?.sessionId?.trim();
        const targetFilename = buildFilename(target.type, target.name);
        const targetExists = (await store.list()).some((record) => record.filename === targetFilename);
        const nextTarget =
          !targetExists && sessionId ? { ...target, sourceSession: sessionId } : { ...target };
        return store.consolidate({
          sources,
          target: nextTarget,
        });
      }),
  });
}
