/**
 * cindy_docsMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server:文档工坊(cindy_docs)。把「说人话要一份 PDF/Word/Excel/PPT」
 * 变成真文件的一组格式原语。
 *
 * 设计:
 *  - server name = `cindy_docs`,对应可关插件 id 'docs'(不是 essential —— 不做文档的
 *    用户应该能关掉,省下入口工具的那点上下文)。
 *  - 所有工具走 `list_tools` / `call_tool` 两个入口,渐进式发现,与 cindy_helper 同款
 *    二级分派:六个工具的完整描述加起来不短,不该在每个会话的系统提示里常驻。
 *  - 三个类目:
 *    - 'author'  : make_docx / make_pptx / make_xlsx —— 从结构化内容直接出 Office 文件
 *    - 'convert' : render_pdf                       —— 出 PDF
 *    - 'read'    : read_sheet / inspect_pdf         —— 读已有表格 / 回读 PDF 做产出自检
 *
 * 边界:
 *  - 本包不 import electron(既有铁律)。render_pdf 靠 Chromium printToPDF,渲染函数
 *    由 desktop main 经 deps.renderHtmlToPdf 注入;host 没注入就不注册该工具。
 *  - 生成/读取工具依赖的 docx / pptxgenjs / exceljs / marked 都是纯 JS,与本包已有的
 *    sharp / googleapis 同级,直接在包内实现,不再绕一层注入。
 *  - inspect_pdf 同样走 host 注入:桌面宿主把 pdfjs 放在一次性 utility process 里跑
 *    (正式包关闭 RunAsNode,解析不可信 PDF 也不该在 Electron main 内进行)。
 *  - **零系统依赖**:全部能力都不要求用户预先安装 LibreOffice / Office 或任何外部程序。
 *  - 所有文件路径钳制在当前 tool-call 解析出来的会话 workingDir 内(见 cindy-docs/_paths.ts)。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { jsonObjectArg } from './json-object-arg.js';
import { DocsToolRegistry } from './cindy_docsToolRegistry.js';
import {
  registerInspectPdfTool,
  registerMakeDocxTool,
  registerMakePptxTool,
  registerMakeXlsxTool,
  registerReadSheetTool,
  registerRenderPdfTool,
} from './cindy-docs/index.js';
import type { DocsMcpDeps, DocsMcpSessionCtx } from './cindy-docs/types.js';
import { resolveLiziMcpSessionContext } from './session-context.js';
import { logToolResultErrorCode } from './tool-error-telemetry.js';
import type { LiziMcpLogger } from './types.js';

const D_LIST_TOOLS =
  '探索 cindy_docs(文档工坊)可用工具(渐进式发现入口)。用户要把内容做成 ' +
  'PDF / Word / Excel / PPT 这类真文件时先来这里。全部能力零系统依赖,' +
  '不需要用户预先装 LibreOffice / Office 或任何外部程序。' +
  '不传 category → 返回所有类目 + 每个类目工具数量。' +
  '传 category=author → 从结构化内容直接生成 Office 文件(make_docx 出 Word、' +
  'make_pptx 出演示文稿、make_xlsx 出 Excel);' +
  '传 category=convert → 出 PDF(render_pdf 把 HTML 用内置 Chromium 排版成 PDF);' +
  '传 category=read → 读已有文件做核对(read_sheet 读 xlsx / csv / tsv;' +
  'inspect_pdf 回读 PDF 的页数/尺寸/空白页 —— 交付 PDF 前务必用它自检一次)。' +
  '获取工具名后用 call_tool({name, args}) 执行。' +
  '所有输入输出路径都必须在当前任务的工作目录内。';

const D_CALL_TOOL =
  '调用 cindy_docs 中的某个具体工具(render_pdf / make_docx / make_pptx / make_xlsx / ' +
  'read_sheet / inspect_pdf)。先用 list_tools 拿工具名 + 完整参数说明。' +
  '错误码:`UNKNOWN_TOOL` = 工具名不存在;`INVALID_ARGS` = 参数 schema 校验失败(返回 schema 自纠);' +
  '`PATH_NOT_ALLOWED` = 路径不在会话工作目录内(改用工作目录内的相对路径);' +
  '`FILE_EXISTS` = 目标文件已存在(确认要覆盖就加 overwrite:true,否则换文件名);' +
  '`NOT_A_FILE` = 输入文件找不到;`NO_SESSION_CONTEXT` = 本次调用没绑定工作目录。' +
  '生成类工具成功后返回 path / relativePath / bytes。' +
  '**出完 PDF 一定要用 inspect_pdf 回读一次再交付** —— 整页空白的 PDF 字节数看着完全正常,' +
  '只看 bytes 判断不出来;inspect_pdf 的 blankPages / verdict 才是确定性证据。';

const CATEGORY_ENUM = ['author', 'convert', 'read'] as const;

function registerListToolsEntry(server: McpServer, registry: DocsToolRegistry): void {
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
  registry: DocsToolRegistry,
  telemetry: { logger?: LiziMcpLogger; getSessionId: () => string | undefined },
): void {
  server.tool(
    'call_tool',
    D_CALL_TOOL,
    {
      name: z.string().describe('工具名,从 list_tools 获取(如 make_docx)'),
      args: jsonObjectArg('工具参数(JSON 对象)。不确定 schema 时可先传 {} 触发错误反馈。'),
    },
    async ({ name, args }) => {
      const result = await registry.call(name, args);
      logToolResultErrorCode({
        logger: telemetry.logger,
        server: 'cindy_docs',
        tool: name,
        result,
        sessionId: telemetry.getSessionId(),
      });
      return result;
    },
  );
}

export function createCindyDocsMcpServer(
  deps: DocsMcpDeps,
  sessionCtx: DocsMcpSessionCtx,
): McpServer {
  const server = new McpServer({ name: 'cindy_docs', version: '1.0.0' });
  const registry = new DocsToolRegistry();

  registerMakeDocxTool(registry, sessionCtx);
  registerMakePptxTool(registry, sessionCtx);
  registerMakeXlsxTool(registry, sessionCtx);
  registerReadSheetTool(registry, sessionCtx);
  // render_pdf / inspect_pdf 只在 host 提供了对应回调时注册 —— 没有这些能力的宿主
  // 里让模型看不到它们,好过看见了调用再拿到一个「不可用」。
  if (deps.renderHtmlToPdf) {
    registerRenderPdfTool(registry, sessionCtx, deps.renderHtmlToPdf);
  }
  if (deps.inspectPdf) {
    registerInspectPdfTool(registry, sessionCtx, deps.inspectPdf);
  }

  registerListToolsEntry(server, registry);
  registerCallToolEntry(server, registry, {
    ...(deps.logger ? { logger: deps.logger } : {}),
    // per-call 解析:Codex / Pi 的 HTTP bridge 在 server factory 阶段 ctx 是空的,
    // tool-call 阶段才由 AsyncLocalStorage 恢复。
    getSessionId: () => resolveLiziMcpSessionContext(sessionCtx).sessionId,
  });

  return server;
}

export type { DocsMcpDeps, DocsMcpSessionCtx } from './cindy-docs/types.js';
