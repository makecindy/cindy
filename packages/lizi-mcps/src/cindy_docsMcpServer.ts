/**
 * cindy_docsMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server:文档工坊(cindy_docs)。把「说人话要一份 PDF/Word/Excel/PPT」
 * 变成真文件的一组格式原语。
 *
 * 设计:
 *  - server name = `cindy_docs`,对应 Cindy 内部可开关的 built-in provider id 'docs'。
 *    这里的 id 只是宿主能力开关,不是需要用户安装的外置 `.cindy` 文档插件；不做文档的
 *    用户仍可关闭它,省下入口工具的那点上下文。
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
  '`ATOMIC_PUBLISH_UNSUPPORTED` 当前输出位置无法安全地原子防覆盖发布;' +
  '`NOT_A_FILE` 输入找不到;`NO_SESSION_CONTEXT` 本次调用没绑定工作目录。';

/**
 * 「先定版式再产出」——所有格式共用的那句总纲。
 *
 * 挂在**工具描述**上而不是只写进某类会话的提示词:模型选工具时一定会读到它,
 * 伙伴会话、普通会话、三种 harness 全覆盖,不依赖任何 skill 是否安装。实测确认
 * 描述原文会一字不差进模型上下文。
 *
 * 定完版式之后怎么落地,**取决于目标格式能接住多少设计**,所以下面分三种:
 *  - `make_pptx` → 走 HTML 设计稿:逐页版式选择与内容切分能整块迁移过去;
 *  - `render_pdf` → HTML 就是版式本身,一次写到位;
 *  - `make_docx` → 不走设计稿:它只收 markdown + 三选一主题,版式全由内置样式排,
 *    设计稿没有落点(见 D_DESIGN_DOCX 的说明);
 *  - `make_xlsx` → 不适用:表格好不好看取决于列宽、表头、数字格式。
 */
const D_DESIGN_CORE =
  ' 【动手前先定版式】选定一套字号层级、一组配色、统一的留白与对齐,把真实内容填进去' +
  '看层级立不立得住,再开始产出。跳过这一步就是「纯白一片只有字」的来源。';

/** PPT / Word:HTML 只是自己的设计草稿,成品必须由结构化工具还原。 */
const D_DESIGN_VIA_HTML =
  D_DESIGN_CORE +
  '**调本工具之前必须先做这一步,不是可选项**:在 `tmp/` 写一份自包含 HTML 设计稿' +
  '(样式内联)把版式落定,把真实内容填进去逐屏/逐页看一遍,再对着它还原成本工具的' +
  '结构化参数 —— 每一页/每一节用哪种版式、标题与正文的层级关系、表格怎么分栏、' +
  '哪里该留白,都在设计稿里定完再动手。' +
  '**这是你自己的工序,用户看不到也不该看到** —— 不要把设计稿发给他、不要问他' +
  '「要不要先看草稿」、不要把 `tmp/` 路径念给他听,他只收 `documents/` 里的成品。' +
  '设计稿只用来定版式,不要试图把 HTML 整份转成目标格式。';

/** PDF:HTML 本身就是版式,不需要额外的草稿环节。 */
const D_DESIGN_PDF =
  D_DESIGN_CORE + 'PDF 的 HTML 就是版式本身,按目标纸张(A4 / Letter)一次写到位再渲染。';

/**
 * Word:**不走 HTML 设计稿**,因为没有可迁移的落点。
 *
 * 这不是偷懒省事,是实测确认的事实:`make_docx` 只收 markdown / title /
 * subtitle / cover / theme,版式全由工具内部样式决定 —— 字号层级、留白、对齐
 * 一个都传不进来。硬要求先写 HTML 只会白烧一轮 token,模型也会当场指出这条
 * 要求与工具接口矛盾然后跳过(2026-08-21 真机复现,它把理由讲得很清楚)。
 *
 * 所以这里给的是**对得上它真实旋钮**的设计要求:结构、层级、表格、主题、封面。
 */
const D_DESIGN_DOCX =
  D_DESIGN_CORE +
  'Word 的版式由本工具的内置样式排,不需要另写 HTML 设计稿 —— 设计功夫花在能传进来的地方:' +
  'markdown 的标题层级要真的分出主次(不要通篇二级标题)、长段落切分、该用表格的地方用表格而不是罗列、' +
  '按内容气质选 theme(正式选 navy、日常选 light)、正式文档给 title + subtitle 出封面。';

/**
 * 顶层工具的对外描述。registry 里那份 description 讲的是参数细节,这里讲的是
 * **什么时候该调它** —— 顶层描述是模型唯一的选型依据,必须自解释。
 */
const TOP_LEVEL_DESCRIPTIONS: Record<string, string> = {
  make_pptx:
    '做 PPT 演示文稿(.pptx)。用户说「做个 PPT / 幻灯片 / 汇报稿 / slides / deck」时用这个,' +
    '传 slides 数组直接出真文件,自带封面/分节/内容三套版式与配色主题。' +
    '不要去找 python-pptx 之类的外部库,也不要只给文字大纲。' +
    D_DESIGN_VIA_HTML,
  make_docx:
    '做 Word 文档(.docx)。用户说「做个 Word / 文档 / 报告 / 说明书」且需要对方可编辑时用这个,' +
    '内容整理成 Markdown 传进来,标题层级、表格、封面会自动排好。' +
    D_DESIGN_DOCX,
  make_xlsx:
    '做 Excel 表格(.xlsx)。用户说「做个表 / 表格 / Excel / 统计表」时用这个,传 sheets + rows,' +
    '表头加粗冻结与数字格式自动处理;写公式要连缓存值一起给,否则很多阅读器打开是空白。',
  render_pdf:
    '出 PDF。用户要「PDF / 正式文档 / 可打印的东西」时用这个:先写一份自包含 HTML(内联样式)' +
    '把版式定下来,再用它渲染成 PDF。宿主用内置 Chromium 排版,不需要任何外部工具。' +
    D_DESIGN_PDF,
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

  if (deps.writeDocsOutput) {
    registerMakeDocxTool(registry, sessionCtx, deps.writeDocsOutput);
    registerMakePptxTool(registry, sessionCtx, deps.writeDocsOutput);
    registerMakeXlsxTool(registry, sessionCtx, deps.writeDocsOutput);
  }
  registerReadSheetTool(registry, sessionCtx);
  // 生成工具、render_pdf / inspect_pdf 只在 host 提供对应边界回调时注册 ——
  // 没有能力的宿主里让模型看不到它们,好过看见了调用再拿到一个「不可用」。
  if (deps.renderHtmlToPdf && deps.writeDocsOutput) {
    registerRenderPdfTool(
      registry,
      sessionCtx,
      deps.renderHtmlToPdf,
      deps.writeDocsOutput,
    );
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
