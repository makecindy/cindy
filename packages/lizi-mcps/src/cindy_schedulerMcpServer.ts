/**
 * cindy_schedulerMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server exposing xdt-maker's local Scheduler to cc / codex
 * agents. Mirrors the shape of `cindy_feishuBotMcpServer.ts` /
 * `feishu/mcp/server.ts`：
 *
 *  - server only exposes two entry tools: `list_tools` / `call_tool`
 *  - fine-grained tools live in scheduler/*.ts and register on a registry
 *
 * Phase 5 hard rules satisfied here:
 *  - server name is **cindy_scheduler**（独立，不复用 cindy_feishu_bot）
 *  - 没有 import any maker-core agent code（cc/codex 文件零修改 — 加 provider
 *    自动被 host:63&73 注入）
 *  - 只通过 `deps.getScheduler()` 操作，不直接 new 引擎类
 *  - 每个 tool handler 入口 try/catch，把 `'scheduler not started'` 翻成
 *    `SCHEDULER_NOT_READY` —— 见 scheduler/_shared.ts withScheduler
 *  - 错误码集复用 IPC 层 NOT_FOUND/INVALID_PARAMS/INTERNAL + 新增
 *    SCHEDULER_NOT_READY，与 IPC 嗅探规则同源（scheduler/errors.ts）
 *  - 读 tool（list/get/list_runs）payload 与 maker.schedule.list() 同形透传
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonObjectArg } from './json-object-arg.js';

import { SchedulerToolRegistry } from './cindy_schedulerToolRegistry.js';
import {
  registerScheduleCreateTool,
  registerScheduleDeleteTool,
  registerScheduleGetTool,
  registerScheduleListRunsTool,
  registerScheduleListTool,
  registerScheduleNotifyCurrentRunTool,
  registerSchedulePauseTool,
  registerScheduleResumeTool,
  registerScheduleRunNowTool,
  registerScheduleSetPreRunHookTool,
  registerScheduleSilenceCurrentRunTool,
  registerScheduleUpdateTool,
} from './scheduler/index.js';
import { resolveLiziMcpSessionContext } from './session-context.js';
import type { LiziMcpSessionContext, SchedulerMcpDeps } from './types.js';

/**
 * Per-session 上下文(在 providers.ts 的 toClaudeSdkConfig(ctx) 时绑定到闭包,
 * 与 XdtHelperMcpSessionCtx / OrcaMcpSessionCtx 同形)。schedule_silence_current_run /
 * schedule_notify_current_run 需要 —— 它们据 sessionId 反查本会话当前 in-flight run,
 * 免去 agent 传 runId。
 * codex 路径下闭包 ctx 为空 sessionId,运行时由 AsyncLocalStorage 经
 * resolveLiziMcpSessionContext 补回当前 thread 的 ctx。
 */
export interface SchedulerMcpSessionCtx {
  agentKind: 'claude-code' | 'codex' | 'pi';
  workingDir: string;
  sessionId?: string;
  vendorOptions?: Record<string, unknown>;
}

// ── Entry-tool descriptions ─────────────────────────────────────────────────
//
// 内嵌 string，不走 prompts/*.md ?raw 模板：scheduler 工具家族短小，没有共享
// rules 文档需要 bundle，inline 比额外建 prompts 目录更轻。cindy_feishu_bot 的
// markdown 模板是为了未来扩 chat_meta / reaction 等家族留 slot，scheduler 暂
// 不需要。

const D_LIST_TOOLS =
  '探索 cindy_scheduler 可用工具（渐进式发现入口）。不传 category → 返回所有类目+每个类目工具数量。' +
  '传 category=scheduler → 返回该类目下所有工具的名称和简介。' +
  '获取工具名后用 call_tool({name, args}) 执行；参数错误会返回完整 JSON Schema。';

const D_CALL_TOOL =
  '调用 cindy_scheduler 中的某个具体工具。先用 list_tools 拿工具名 + 简介，再用本工具执行。' +
  '错误码：' +
  '`SCHEDULER_NOT_READY` = scheduler 未启动（用户登出或切账号窗口期），可重试或提示用户登录；' +
  '`NOT_FOUND` = 指定 schedule id 不存在；' +
  '`INVALID_PARAMS` = 参数格式错（cron / timezone / 字段缺失等），按 message 修正；' +
  '`INVALID_ARGS` = zod schema 校验失败（返回 schema 自纠）；' +
  '`INTERNAL` = 其他底层错。';

const CATEGORY_ENUM = ['scheduler'] as const;

function registerListToolsEntry(
  server: McpServer,
  registry: SchedulerToolRegistry,
): void {
  server.tool(
    'list_tools',
    D_LIST_TOOLS,
    {
      category: z
        .enum(CATEGORY_ENUM)
        .optional()
        .describe('工具类目。不传时返回所有类目概览。'),
    },
    async ({ category }) => {
      if (category) {
        const tools = registry.list(category);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                category,
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                })),
                hint: '调用具体工具用 call_tool({name, args})。',
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
              hint: '用 list_tools({category}) 查看某类目下的工具列表',
            }),
          },
        ],
      };
    },
  );
}

function registerCallToolEntry(
  server: McpServer,
  registry: SchedulerToolRegistry,
): void {
  server.tool(
    'call_tool',
    D_CALL_TOOL,
    {
      name: z
        .string()
        .describe('工具名，从 list_tools 获取（如 schedule_create / schedule_list）'),
      args: jsonObjectArg('工具参数（JSON 对象）。不确定 schema 时可先传 {} 触发错误反馈。'),
    },
    async ({ name, args }) => registry.call(name, args),
  );
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createSchedulerMcpServer(
  deps: SchedulerMcpDeps,
  sessionCtx?: SchedulerMcpSessionCtx,
): McpServer {
  const server = new McpServer({
    name: 'cindy_scheduler',
    version: '1.0.0',
  });

  const registry = new SchedulerToolRegistry();

  // 解析"是谁在调我":cc 路径取闭包 ctx,codex 路径由 AsyncLocalStorage 补回当前
  // thread 的 ctx。未绑定 session 时回退到 sessionId:undefined,silence 工具会退回
  // 到 agent 传的 runId。
  const fallbackCtx: LiziMcpSessionContext = sessionCtx ?? {
    agentKind: 'claude-code',
    workingDir: '',
  };
  const getSessionContext = (): LiziMcpSessionContext =>
    resolveLiziMcpSessionContext(fallbackCtx);

  // 注册顺序 = list_tools 里的位次。读优先 → 写次之 → 危险写在最后。
  registerScheduleListTool(registry, deps);
  registerScheduleGetTool(registry, deps);
  registerScheduleListRunsTool(registry, deps);
  // create / update 都注入 ctx:bindToCurrentSession 据 sessionId 自动填 targetSessionId,
  // 免去 agent 自己查 / 抄 session id(同 silence,避免绑错会话)。
  registerScheduleCreateTool(registry, deps, getSessionContext);
  registerScheduleUpdateTool(registry, deps, getSessionContext);
  // 前置检查脚本统一安装通道;host 未注入 hookScript 服务时内部自动跳过注册。
  registerScheduleSetPreRunHookTool(registry, deps);
  // pause / delete 注入 ctx:caller-ownership 豁免 —— agent 在任务 run 内
  // pause/delete 自己所属的 schedule 时,发起方这轮 run 不被 abort(见 delete.ts)。
  registerSchedulePauseTool(registry, deps, getSessionContext);
  registerScheduleResumeTool(registry, deps);
  registerScheduleRunNowTool(registry, deps);
  registerScheduleSilenceCurrentRunTool(registry, deps, getSessionContext);
  registerScheduleNotifyCurrentRunTool(registry, deps, getSessionContext);
  registerScheduleDeleteTool(registry, deps, getSessionContext);

  registerListToolsEntry(server, registry);
  registerCallToolEntry(server, registry);

  return server;
}
