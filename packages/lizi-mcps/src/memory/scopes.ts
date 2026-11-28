/**
 * memory/scopes.ts — memory_scopes tool
 *
 * 列出当前账号下有记忆的范围: 「关于你」一份, 加每个有记忆的项目。整理记忆时用它拿到别的
 * 项目的 `project` 值, 再传给 memory_list / memory_read / memory_write / memory_delete /
 * memory_consolidate。只返回位置和条数, 不含任何记忆内容。
 */

import { withStore } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';

export function registerMemoryScopesTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_scopes',
    category: 'read',
    description:
      '列出当前账号下有记忆的范围 (整理记忆时用): 「关于你」(scope "user") 和每个有记忆的项目。' +
      ' 每项返回 kind (user / project)、project (项目的键; user 那一项为 null)、count (条数)、' +
      ' current (是不是当前任务所在的项目)。要操作别的项目的记忆, 把它的 project 值传给其它' +
      ' memory 工具的 project 参数。伙伴的记忆不在此列。',
    inputShape: {},
    handler: async () =>
      withStore(deps, async (_store, ctx) =>
        (await ctx.manager.listScopes()).map((scope) => ({
          kind: scope.kind,
          project: scope.kind === 'project' ? scope.scopeKey : null,
          count: scope.count,
          current: scope.kind === 'project' && scope.scopeKey === ctx.scopes.project,
        })), { accountWide: true }),
  });
}
