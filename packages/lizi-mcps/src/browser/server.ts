import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonObjectArg } from '../json-object-arg.js';

import type { BrowserMcpDeps } from '../types.js';
import { BrowserToolRegistry } from './tool-registry.js';
import { registerBrowserTools } from './tools.js';
import browserWorkflowRules from './prompts/rules/browser-workflow.md?raw';

/** key → markdown body. Bundled into list_tools responses ONCE per category. */
const RULES: Record<string, string> = {
  'browser-workflow': browserWorkflowRules,
};

const D_LIST_TOOLS =
  '探索浏览器自动化可用工具(渐进式发现入口)。不传 category → 返回所有类目+每个类目工具数量。' +
  '传 category=browser → 返回浏览器操作工具。获取工具名后用 call_tool({name, args}) 执行。';

const D_CALL_TOOL =
  '调用具体浏览器自动化工具。先用 list_tools 拿工具名 + 简介;参数错误会返回 JSON Schema 用于自我修正。';

const CATEGORY_ENUM = ['browser'] as const;

function registerListToolsEntry(server: McpServer, registry: BrowserToolRegistry): void {
  server.tool(
    'list_tools',
    D_LIST_TOOLS,
    {
      category: z.enum(CATEGORY_ENUM).optional().describe('工具类目。不传时返回所有类目概览。'),
    },
    async ({ category }) => {
      if (category) {
        const tools = registry.list(category);
        // Bundle each shared rule body ONCE per response (top-level `rules` map
        // keyed by rule key). Tools reference rule keys via their `rules: [...]`
        // field; resolve every key referenced in this category.
        const ruleKeys = registry.collectRuleKeys(category);
        const bundledRules: Record<string, string> = {};
        for (const key of ruleKeys) {
          const body = RULES[key];
          if (body) bundledRules[key] = body;
        }
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
                  ...(t.rules && t.rules.length > 0 ? { rules: t.rules } : {}),
                })),
                ...(Object.keys(bundledRules).length > 0 ? { rules: bundledRules } : {}),
                hint: '调用具体工具用 call_tool({name, args})。每个 tool 的 rules 数组列出它必须遵守的共享规则键,完整规则在顶层 rules 字段。',
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
              hint: '用 list_tools({category}) 查看某类工具列表。',
            }),
          },
        ],
      };
    },
  );
}

function registerCallToolEntry(server: McpServer, registry: BrowserToolRegistry): void {
  server.tool(
    'call_tool',
    D_CALL_TOOL,
    {
      name: z.string().describe('工具名,从 list_tools 获取(如 browser)'),
      args: jsonObjectArg('工具参数(JSON 对象)。不确定 schema 时可先传 {} 触发错误反馈。'),
    },
    async ({ name, args }) => registry.call(name, args),
  );
}

export function createBrowserMcpServer(deps: BrowserMcpDeps): McpServer {
  const server = new McpServer({
    name: 'cindy_browser',
    version: '1.0.0',
  });
  const registry = new BrowserToolRegistry();
  registerBrowserTools(registry, deps);
  registerListToolsEntry(server, registry);
  registerCallToolEntry(server, registry);
  return server;
}
