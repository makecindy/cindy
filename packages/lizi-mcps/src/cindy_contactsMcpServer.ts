/**
 * cindy_contactsMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server exposing Maker Contacts(智能通讯录, agent-native 全局
 * 人物实体库)to cc / codex agents. Mirrors cindy_memoryMcpServer.ts:
 *
 *  - 只暴露两个 entry tool: list_tools / call_tool (常驻 prompt ~200 token)
 *  - 20+ 个细粒度工具在 contacts/*.ts 注册到 ContactsToolRegistry(import_system 仅
 *    macOS host 注入读取器时出现), 按需通过
 *    list_tools(category) + call_tool({name, args}) 发现/调用
 *
 * 与 memory 的关键差异: 通讯录是全局单库(人不属于 workdir), deps 不需要 workdir;
 * 功能开关经 deps.isEnabled(host 设置层)判定, withContacts 里代码级拦截。
 * 采集边界规则通过工具 rules 字段下发(list_tools 时可见), 不动 system prompt。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonObjectArg } from './json-object-arg.js';

import { ContactsToolRegistry } from './cindy_contactsToolRegistry.js';
import {
  registerContactsAddIdentityTool,
  registerContactsAppendEventTool,
  registerContactsCreateTool,
  registerContactsDeleteTool,
  registerContactsGetTool,
  registerContactsGroupTools,
  registerContactsListGroupsTool,
  registerContactsListTool,
  registerContactsMergeTool,
  registerContactsFindDuplicatesTool,
  registerContactsImportSystemTool,
  registerContactsVcfTools,
  registerContactsExportSystemTool,
  registerContactsRelationTools,
  registerContactsRemoveIdentityTool,
  registerContactsResolveTool,
  registerContactsSearchTool,
  registerContactsStatsTool,
  registerContactsUpdateTool,
} from './contacts/index.js';
import type { ContactsMcpDeps } from './types.js';

// ── Entry-tool descriptions ────────────────────────────────────────────────

const D_LIST_TOOLS =
  '探索智能通讯录(cindy_contacts)可用工具(渐进式发现入口)。这是 agent 专用的人物实体库: ' +
  '跨平台身份反查(邮箱/飞书/Slack/GitHub id → 这是谁)、关系背景、带日期事件流、分组。' +
  '遇到陌生邮箱/平台 id、要找人/发消息/@某人、需要人物背景时, 先来这里查。' +
  '不传 category → 返回所有类目+工具数量; 传 category=search/read/write/manage → 该类目工具清单' +
  '(rules 字段是该类工具的使用边界, 首次拉取时读一遍)。获取工具名后用 call_tool({name, args}) 执行。';

const D_CALL_TOOL =
  '调用智能通讯录(cindy_contacts)中的某个具体工具。先用 list_tools 拿工具名 + 简介, 再用本工具执行。' +
  '错误码: ' +
  '`CONTACTS_NOT_READY` = 通讯录未开启, 提示用户可在 设置→个性化→智能通讯录 开启; ' +
  '`NOT_FOUND` = 指定 contact/identity/event/group 不存在; ' +
  '`ALREADY_EXISTS` = 身份已在本人名下 / 组名撞名; ' +
  '`IDENTITY_CONFLICT` = 该身份已属于另一个人(data 带 conflictContactId, 应改为更新那份档案或询问用户是否 merge); ' +
  '`DUPLICATE_SUSPECT` = 名字与既有档案相似(data 带 candidates): 先 contacts_get 确认, 同人走 update, 不同人 allow_duplicate:true 重试; ' +
  '`INVALID_PARAMS` = 业务校验失败, 按 message 修正; ' +
  '`INVALID_ARGS` = zod 校验失败(返 schema 自纠); ' +
  '`PERMISSION_DENIED` = 系统通讯录授权被拒(引导用户去 系统设置→隐私与安全性 开启); ' +
  '`UNSUPPORTED_CAPABILITY` = 当前平台不支持该操作(如非 macOS 的系统通讯录); ' +
  '`INTERNAL` = 其他底层错。';

const CATEGORY_ENUM = ['search', 'read', 'write', 'manage'] as const;

function registerListToolsEntry(server: McpServer, registry: ContactsToolRegistry): void {
  server.tool(
    'list_tools',
    D_LIST_TOOLS,
    {
      category: z.enum(CATEGORY_ENUM).optional().describe('工具类目, 不传时返回所有类目概览'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ category }) => {
      if (category) {
        const tools = registry.list(category);
        // rules 去重: 同类多工具共享同一份规则文本时只下发一次
        const rules = Array.from(new Set(tools.flatMap((t) => t.rules ?? [])));
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                category,
                tools: tools.map((t) => ({ name: t.name, description: t.description })),
                ...(rules.length > 0 ? { rules } : {}),
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
    },
  );
}

function registerCallToolEntry(server: McpServer, registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  server.tool(
    'call_tool',
    D_CALL_TOOL,
    {
      name: z.string().describe('工具名, 从 list_tools 获取 (e.g. contacts_resolve / contacts_search)'),
      args: jsonObjectArg('工具参数 JSON; 不确定 schema 可先传 {} 触发反馈'),
    },
    async ({ name, args }) => {
      const result = await registry.call(name, args);
      // agent 经 MCP 直写同进程 store, 绕过 IPC 层的变更广播 — 这里按类目
      // 兜底通知宿主(write/manage 均可能改库), 让设置页/管理浮层实时刷新
      const category = registry.get(name)?.category;
      if (!result.isError && (category === 'write' || category === 'manage')) {
        try {
          deps.onMutated?.();
        } catch {
          // 通知失败不影响工具结果
        }
      }
      return result;
    },
  );
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createCindyContactsMcpServer(deps: ContactsMcpDeps): McpServer {
  const server = new McpServer({
    name: 'cindy_contacts',
    version: '1.0.0',
  });

  const registry = new ContactsToolRegistry();

  // 注册顺序 = list_tools 里的位次。search(最高频)优先, 读类次之, 写类再次, 管理类最后。
  registerContactsResolveTool(registry, deps);
  registerContactsSearchTool(registry, deps);
  registerContactsGetTool(registry, deps);
  registerContactsListTool(registry, deps);
  registerContactsListGroupsTool(registry, deps);
  registerContactsStatsTool(registry, deps);
  registerContactsCreateTool(registry, deps);
  registerContactsUpdateTool(registry, deps);
  registerContactsAddIdentityTool(registry, deps);
  registerContactsRemoveIdentityTool(registry, deps);
  registerContactsAppendEventTool(registry, deps);
  registerContactsRelationTools(registry, deps);
  registerContactsDeleteTool(registry, deps);
  registerContactsMergeTool(registry, deps);
  registerContactsFindDuplicatesTool(registry, deps);
  registerContactsImportSystemTool(registry, deps);
  registerContactsVcfTools(registry, deps);
  registerContactsExportSystemTool(registry, deps);
  registerContactsGroupTools(registry, deps);

  registerListToolsEntry(server, registry);
  registerCallToolEntry(server, registry, deps);

  return server;
}
