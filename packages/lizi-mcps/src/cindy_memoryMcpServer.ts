/**
 * cindy_memoryMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server exposing Maker Memory (cross-agent shared workdir-scoped
 * memory) to cc / codex agents. Mirrors cindy_schedulerMcpServer.ts:
 *
 *  - 只暴露两个 entry tool: list_tools / call_tool (常驻 prompt ~200 token)
 *  - 7 个细粒度工具 (memory_read/list/write/delete/consolidate/review/search)
 *    在 memory/*.ts 内注册到 MemoryToolRegistry, 按需通过 list_tools(category)
 *    + call_tool({name, args}) 发现/调用
 *
 * workdir 绑定:
 *  Claude SDK 每个 Query 实例化一次,session 启动时 workdir 已知,通过工厂参数关
 *  到 closure。Codex HTTP bridge 每个 streamable session 实例化一次,但 factory
 *  阶段只有全局空 ctx；tool-call 阶段通过 AsyncLocalStorage 解析当前 thread ctx,
 *  由 memory/_shared.ts 的 withStore 取真实 workingDir。
 *
 * 不依赖 maker-core agent 代码 — 通过 deps.getManager() 拿 MakerMemoryManager,
 * 跟 scheduler 'getScheduler' 同模式 (避免持长生命周期引用, 用户 logout/切账号
 * 后 manager 被 host 替换时仍工作)。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withAccountDataAccess } from './account-data-access.js';
import { jsonObjectArg } from './json-object-arg.js';

import { MemoryToolRegistry } from './cindy_memoryToolRegistry.js';
import {
  registerMemoryConsolidateTool,
  registerMemoryDeleteTool,
  registerMemoryListTool,
  registerMemoryReadTool,
  registerMemoryReviewTool,
  registerMemorySearchTool,
  registerMemoryWriteTool,
  registerSessionSearchTool,
} from './memory/index.js';
import type { MemoryMcpDeps } from './types.js';

// ── Entry-tool descriptions (内嵌, 跟 scheduler 同模式) ─────────────────────

const D_LIST_TOOLS =
  '探索 cindy_memory 可用工具 (渐进式发现入口)。不传 category → 返回所有类目+每个类目工具数量。' +
  '传 category=read/write/maintain/search → 返回该类目下所有工具的名称和简介。' +
  '获取工具名后用 call_tool({name, args}) 执行;参数错误会返回完整 JSON Schema 自纠。';

const D_CALL_TOOL =
  '调用 cindy_memory 中的某个具体工具。先用 list_tools 拿工具名 + 简介, 再用本工具执行。' +
  '错误码:' +
  '`MAKER_MEMORY_NOT_READY` = maker memory 未启用 (mode != "maker"), 提示用户切换 settings;' +
  '`NOT_FOUND` = 指定 memory 文件不存在;' +
  '`ALREADY_EXISTS` = create 撞名 — 改 mode:"update" 或 "append";' +
  '`INVALID_PARAMS` = schema/路径/size 等业务校验失败, 按 message 修正;' +
  '`INVALID_ARGS` = zod 校验失败 (返 schema 自纠);' +
  '`INTERNAL` = 其他底层错。';

const CATEGORY_ENUM = ['read', 'write', 'maintain', 'search'] as const;

function registerListToolsEntry(server: McpServer, registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  server.tool(
    'list_tools',
    D_LIST_TOOLS,
    {
      category: z.enum(CATEGORY_ENUM).optional().describe('工具类目, 不传时返回所有类目概览'),
    },
    async ({ category }) => withAccountDataAccess(deps.withAccountDataAccess, deps.getSessionContext?.().sessionId, async () => {
      if (category) {
        const tools = registry.list(category);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                category,
                tools: tools.map((t) => ({ name: t.name, description: t.description })),
                hint: '调用具体工具用 call_tool({name, args})',
              }),
            },
          ],
        };
      }
      const counts: Record<string, number> = {};
      for (const t of registry.list()) {
        counts[t.category] = (counts[t.category] ?? 0) + 1;
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              categories: registry.listCategories().map((c) => ({
                name: c,
                tool_count: counts[c] ?? 0,
              })),
              hint: '用 list_tools({category}) 查看某类目工具列表',
            }),
          },
        ],
      };
    }),
  );
}

function registerCallToolEntry(server: McpServer, registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  server.tool(
    'call_tool',
    D_CALL_TOOL,
    {
      name: z.string().describe('工具名, 从 list_tools 获取 (e.g. memory_write / memory_search)'),
      args: jsonObjectArg('工具参数 JSON; 不确定 schema 可先传 {} 触发反馈'),
    },
    async ({ name, args }) => withAccountDataAccess(deps.withAccountDataAccess, deps.getSessionContext?.().sessionId, async () => registry.call(name, args)),
  );
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createCindyMemoryMcpServer(deps: MemoryMcpDeps): McpServer {
  const server = new McpServer({
    name: 'cindy_memory',
    version: '1.0.0',
  });

  const registry = new MemoryToolRegistry();

  // 注册顺序 = list_tools 里的位次。读类优先, 写类次之, 维护类放最后。
  registerMemoryListTool(registry, deps);
  registerMemoryReadTool(registry, deps);
  registerMemorySearchTool(registry, deps);
  // session_search 仅在 host 提供 searchSessions 时注册 (跟 art video registry 同模式)。
  registerSessionSearchTool(registry, deps);
  registerMemoryWriteTool(registry, deps);
  registerMemoryDeleteTool(registry, deps);
  registerMemoryConsolidateTool(registry, deps);
  registerMemoryReviewTool(registry, deps);

  registerListToolsEntry(server, registry, deps);
  registerCallToolEntry(server, registry, deps);

  return server;
}
