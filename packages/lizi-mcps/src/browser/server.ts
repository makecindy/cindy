import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonObjectArg } from '../json-object-arg.js';

import type { BrowserMcpDeps } from '../types.js';
import { BrowserToolRegistry } from './tool-registry.js';
import { registerBrowserTools } from './tools.js';
import { renderBrowserWorkflowRules } from './workflow-rules.js';
import type { HostToolMcpServer } from '../host-tool-runtime.js';

const D_LIST_TOOLS =
  '探索浏览器自动化可用工具(渐进式发现入口)。当网页抓取未取得用户所需内容时，可用浏览器继续读取动态页面或图片。' +
  '仅当用户请求依赖尚未查看的图片时，需查看图片或截图；跳转地址不能代替图片内容。' +
  '已有正文足够回答时直接回答，不因链接含 photo 或页面可能有图而额外开浏览器。' +
  '常规读页面、操作页面的用法已写在 call_tool 的说明里，不必先调用本工具。' +
  '传 category=browser → 返回浏览器工具的完整规则(登录墙交接、站点配方、读接口请求、读图、代理、切换浏览器、上传文件等)。' +
  '不传 category → 返回所有类目+每个类目工具数量。';

// The everyday loop lives in the tool description so the first call can be the real one. Read as a tool
// result instead, it cost every task one model round and about ten thousand tokens that no other task can
// reuse (measured on real sites: 4.3 rounds and 13.4 s a task against 2.6 and 9.7 with it up front).
// Keep it to what every backend does and to what most tasks need; the long tail stays in the rules that
// list_tools returns, and the last paragraph names when to fetch them.
const D_CALL_TOOL =
  '调用浏览器工具:call_tool({name:"browser", args:{action,…}})。常规读页面和操作页面按下面的用法直接调用,不需要先 list_tools;参数写错会返回 JSON Schema 用于修正。\n' +
  '【读】只要页面上的文字:{action:"read",url:"https://…"} 打开页面、等内容出现、返回可见文字并关闭标签页;' +
  '几个地址一次读完:{action:"read",pages:["https://…","https://…"]}(pages 是地址字符串的数组,同时打开)。' +
  '默认每页最多 8000 字符(maxChars 可调);被截断时把返回的 nextOffset 作为 offset 续读。确知页面结构时才加 selector 只读其中一块,不要猜。' +
  '公开的静态页面或接口,有网页抓取工具时优先用它。\n' +
  '【操作】要点击或输入时不要先 read,直接 {action:"open",url,label,afterSnapshot:{}} 打开并拿到带 ref 的页面快照,再用 ref 操作:' +
  '{action:"act",targetId,request:{kind:"click"|"type"|"select"|"press"|"hover",ref,…}}(type 带 text,select 带 values)。ref 只取自最近一次快照,不猜 CSS 选择器。' +
  '已经确定的连续几步放进 {action:"batch",targetId,steps:[…]} 一次做完(每步是一份普通参数,按顺序执行,失败即停);' +
  '后面还要继续操作时,在最后一步带 afterSnapshot:{} 拿到新的 ref;只需要读出结果时,最后接一步 {action:"read"}(读当前标签页的文字)。' +
  '不要一步一轮,也不要单独花一轮只为等待、核对或看一眼。\n' +
  '【等待】wait 不是顶层 action:{action:"act",targetId,request:{kind:"wait",text|textGone|selector|loadState,timeoutMs}} 等到条件成立,timeoutMs 是上限;只想停一下才用 timeMs。\n' +
  '【快照里没有的控件】(封闭 Shadow DOM、自绘组件):{action:"cdp",targetId,commands:[{method:"nodes",params:{filter}},{method:"click",params:{node}},{method:"type",params:{node,text}}]}。\n' +
  '【交给用户】登录、验证码、付款等必须由用户本人完成的步骤:停下来说明页面状态和需要用户做什么,不要绕过。\n' +
  '【完整规则】遇到登录墙交接、结果里的 loginWall / recipeSuggestions / rulesHint 提示,或要用站点配方、读接口请求、看图、代理、切换浏览器、上传文件时,先 list_tools({category:"browser"}) 读完整规则。';

const CATEGORY_ENUM = ['browser'] as const;

function registerListToolsEntry(server: McpServer, registry: BrowserToolRegistry, deps: BrowserMcpDeps): void {
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
        // Tailored to the active target; remembered so a later status can say the rules are for another one.
        const backend = deps.getBackendKind?.();
        registry.rulesBackend = backend ?? 'all';
        for (const key of ruleKeys) {
          if (key === 'browser-workflow') bundledRules[key] = renderBrowserWorkflowRules(backend);
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
      name: z.string().describe('工具名;浏览器操作是 browser'),
      args: jsonObjectArg('工具参数(JSON 对象)。不确定 schema 时可先传 {} 触发错误反馈。'),
    },
    async ({ name, args }) => registry.call(name, args),
  );
}

export function createBrowserMcpServer(deps: BrowserMcpDeps): HostToolMcpServer {
  const server = new McpServer({
    name: 'cindy_browser',
    version: '1.0.0',
  });
  const registry = new BrowserToolRegistry();
  registerBrowserTools(registry, deps);
  registerListToolsEntry(server, registry, deps);
  registerCallToolEntry(server, registry);
  return Object.assign(server, { hostTools: {
    list: () => registry.list().map(({ name, category }) => ({ name, category })),
    describe: (name: string) => registry.list().find(tool => tool.name === name),
    call: (name: string, args?: Record<string, unknown>) => registry.call(name, args),
    close: () => server.close(),
  } });
}
