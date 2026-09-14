/**
 * cindy_sshMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server exposing xdt-maker's built-in SSH remote-host
 * capability (desktop ConnectionPool) to cc / codex agents. Mirrors the shape
 * of `cindy_schedulerMcpServer.ts`：
 *
 *  - server only exposes two entry tools: `list_tools` / `call_tool`
 *  - fine-grained tools live in ssh/*.ts and register on a registry
 *
 * 定位：用户说"帮我 ssh 到某台机器做某事"时，agent 通过本工具集在**已配置**
 * 主机上直接执行命令——复用已配好的 alias / ssh-agent / key（当前直连，
 * 不支持 ProxyJump 跳板：ConnectionPool 既有限制，远程会话同样如此），
 * 不手拼 ssh 命令行、远端不安装任何东西。与「远程会话」（远端 bootstrap
 * agent 对聊）互补，二者互不替代。
 *
 * 硬规则：
 *  - 只通过 deps.getPool() / deps.ensureReady() 操作，不 import
 *    @cindy/maker-remote-ssh（连接生命周期归 desktop main 管）
 *  - 错误 payload / 日志不携带 command 原文（见 ssh/exec.ts 头注释）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonObjectArg } from './json-object-arg.js';

import { SshToolRegistry } from './ssh/registry.js';
import { errorPayload } from './ssh/_shared.js';
import {
  registerSshExecTool,
  registerSshHostStatusTool,
  registerSshListHostsTool,
} from './ssh/index.js';
import type { SshMcpDeps } from './types.js';

const D_LIST_TOOLS =
  '探索 cindy_ssh 可用工具（渐进式发现入口）。不传 category → 返回所有类目+每个类目工具数量。' +
  '传 category=ssh → 返回该类目下所有工具的名称和简介。' +
  '用户要求 ssh 到某台机器执行命令 / 查看远端状态时，用本工具集（复用应用内已配置的 SSH 主机与认证），' +
  '不要用 Bash 手拼 ssh 命令行。获取工具名后用 call_tool({name, args}) 执行。';

const D_CALL_TOOL =
  '调用 cindy_ssh 中的某个具体工具。先用 list_tools 拿工具名 + 简介，再用本工具执行。' +
  '错误码：' +
  '`HOST_NOT_FOUND` = 目标主机未配置（返回已配置清单，引导用户到「设置 → 远程连接」添加）；' +
  '`AMBIGUOUS_HOST` = hostname 命中多台，改用 alias；' +
  '`SSH_AUTH_FAILED` = 认证失败（确定性错误，不要重试，把 hint 转告用户）；' +
  '`SSH_AGENT_UNAVAILABLE` = 本机 SSH Agent 不可用（启动 Agent / ssh-add 后再试）；' +
  '`SSH_CONFIG_AUTH_UNSUPPORTED` = Cindy 暂不能安全复现该主机的部分 SSH 配置规则（确定性错误，不要重试）；' +
  '`SSH_CONNECT_FAILED` = 连接/执行失败；' +
  '`EXEC_TIMEOUT` = 命令超时（长任务改 nohup 后台跑再轮询）；' +
  '`INVALID_ARGS` = zod schema 校验失败（返回 schema 自纠）；' +
  '`INTERNAL` = 工具内部错误（如连接池不可用），不宜盲目重试，把 hint 转告用户。';

const CATEGORY_ENUM = ['ssh'] as const;

function registerListToolsEntry(server: McpServer, registry: SshToolRegistry): void {
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
                tools: tools.map((t) => ({ name: t.name, description: t.description })),
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
  registry: SshToolRegistry,
): void {
  server.tool(
    'call_tool',
    D_CALL_TOOL,
    {
      name: z
        .string()
        .describe('工具名，从 list_tools 获取（如 ssh_exec / ssh_list_hosts）'),
      args: jsonObjectArg('工具参数（JSON 对象）。不确定 schema 时可先传 {} 触发错误反馈。'),
    },
    async ({ name, args }) => {
      return registry.call(name, args);
    },
  );
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createSshMcpServer(deps: SshMcpDeps): McpServer {
  const server = new McpServer({
    name: 'cindy_ssh',
    version: '1.0.0',
  });

  const registry = new SshToolRegistry();

  // 注册顺序 = list_tools 里的位次。读优先 → 写在后。
  registerSshListHostsTool(registry, deps);
  registerSshHostStatusTool(registry, deps);
  registerSshExecTool(registry, deps);

  registerListToolsEntry(server, registry);
  registerCallToolEntry(server, registry);

  return server;
}
