/**
 * cindy_docsMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server:文档工坊(cindy_docs)。把「说人话要一份 PDF/Word/Excel/PPT」
 * 变成真文件的一组格式原语。
 *
 * 设计:
 *  - server name = `cindy_docs`,对应可关插件 id 'docs'(不是 essential —— 不做文档的
 *    用户应该能关掉,省下入口工具的那点上下文)。
 *  - **六个工具全部顶层直接注册**,不做渐进式发现(2026-08-21 真机实证后改回):
 *    伙伴会话里 cindy_docs 挂载成功、日志 instance_resolved,但 make_pptx 与
 *    list_tools 的调用次数都是 0 —— 模型看见的只是一个泛泛的 `list_tools` 入口,
 *    没有把「做个 PPT」和它联系起来,转头去找 python 库、没找到、回了句做不了。
 *    渐进披露适合 cindy_helper 那种几十个工具的大工具面;六个名字自解释的文档
 *    工具藏在二级分派后面,省下的上下文远不抵「能力等于不存在」的代价。
 *  - 三个类目(仍保留在 registry 里,供工具描述与测试分组用):
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

/**
 * 每个工具描述末尾都带的共同约束。顶层暴露后没有 call_tool 那段总说明可挂,
 * 这些错误码与纪律必须跟着每个工具走 —— 模型不会为了看约束去调另一个工具。
 */
const D_COMMON_TAIL =
  ' 全部能力零系统依赖,不需要用户预先装 LibreOffice / Office 或任何外部程序。' +
  '所有输入输出路径必须在当前任务的工作目录内(建议放 documents/,文件名用「日期-主题」)。' +
  '错误码:`PATH_NOT_ALLOWED` 路径越界;`FILE_EXISTS` 目标已存在(确认覆盖再加 overwrite:true);' +
  '`NOT_A_FILE` 输入找不到;`NO_SESSION_CONTEXT` 本次调用没绑定工作目录。';

/**
 * 顶层工具的对外描述。registry 里那份 description 讲的是参数细节,这里讲的是
 * **什么时候该调它** —— 顶层描述是模型唯一的选型依据,必须自解释。
 */
const TOP_LEVEL_DESCRIPTIONS: Record<string, string> = {
  make_pptx:
    '做 PPT 演示文稿(.pptx)。用户说「做个 PPT / 幻灯片 / 汇报稿 / slides / deck」时用这个,' +
    '传 slides 数组直接出真文件,自带封面/分节/内容三套版式与配色主题。' +
    '不要去找 python-pptx 之类的外部库,也不要只给文字大纲。',
  make_docx:
    '做 Word 文档(.docx)。用户说「做个 Word / 文档 / 报告 / 说明书」且需要对方可编辑时用这个,' +
    '内容整理成 Markdown 传进来,标题层级、表格、封面会自动排好。',
  make_xlsx:
    '做 Excel 表格(.xlsx)。用户说「做个表 / 表格 / Excel / 统计表」时用这个,传 sheets + rows,' +
    '表头加粗冻结与数字格式自动处理;写公式要连缓存值一起给,否则很多阅读器打开是空白。',
  render_pdf:
    '出 PDF。用户要「PDF / 正式文档 / 可打印的东西」时用这个:先写一份自包含 HTML(内联样式)' +
    '把版式定下来,再用它渲染成 PDF。宿主用内置 Chromium 排版,不需要任何外部工具。',
  read_sheet:
    '读已有表格(xlsx / csv / tsv)。用户丢来一个表要你分析、汇总、回答其中数据时用这个,' +
    '别让用户手工把内容贴进对话。也用于生成表格后回读核对。',
  inspect_pdf:
    '回读 PDF 做产出自检:页数、纸型、旋转、每页文字量与是否空白。' +
    '**出完 PDF 交付前一定要调它一次** —— 整页空白的 PDF 字节数看着完全正常,' +
    '只看文件大小判断不出来,blankPages / verdict 才是确定性证据。',
};

/**
 * 把 registry 里的工具逐个注册成顶层 MCP 工具。参数 schema 直接复用 registry
 * 的 inputShape(单一事实源),执行仍走 registry.call 以保留 strict 校验、
 * 统一错误码与 telemetry。
 */
function registerTopLevelTools(
  server: McpServer,
  registry: DocsToolRegistry,
  telemetry: { logger?: LiziMcpLogger; getSessionId: () => string | undefined },
): void {
  for (const summary of registry.list()) {
    const def = registry.get(summary.name);
    if (!def) continue;
    const description = `${TOP_LEVEL_DESCRIPTIONS[def.name] ?? def.description}${D_COMMON_TAIL}`;
    server.registerTool(
      def.name,
      {
        description,
        // **strict()**:拼错的字段必须报错,不能被静默剥掉。用 server.tool(rawShape)
        // 时 SDK 会按非严格对象解析,`tittle` 这种笔误会被悄悄丢掉、生成一份没有
        // 标题的文档 —— 用户要打开才发现。registerTool 收完整 schema,所以这里
        // 显式收严,与 registry.call 内部的 strict 口径保持一致。
        inputSchema: z.object(def.inputShape).strict(),
      },
      async (args: Record<string, unknown>) => {
        const result = await registry.call(def.name, args);
        logToolResultErrorCode({
          logger: telemetry.logger,
          server: 'cindy_docs',
          tool: def.name,
          result,
          sessionId: telemetry.getSessionId(),
        });
        return result;
      },
    );
  }
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

  registerTopLevelTools(server, registry, {
    ...(deps.logger ? { logger: deps.logger } : {}),
    // per-call 解析:Codex / Pi 的 HTTP bridge 在 server factory 阶段 ctx 是空的,
    // tool-call 阶段才由 AsyncLocalStorage 恢复。
    getSessionId: () => resolveLiziMcpSessionContext(sessionCtx).sessionId,
  });

  return server;
}

export type { DocsMcpDeps, DocsMcpSessionCtx } from './cindy-docs/types.js';
