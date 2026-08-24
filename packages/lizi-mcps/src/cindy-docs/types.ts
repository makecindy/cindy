/**
 * cindy-docs/types.ts —— cindy_docs 的 host 依赖契约。
 *
 * 分层理由(写清以免后人误改):
 *  - docx / pptxgenjs / exceljs / marked 都是纯 JS,没有原生绑定、不碰 Electron,
 *    与本包已有的 sharp / googleapis / ssh 客户端同级,直接在 @cindy/mcps 内实现,
 *    不需要绕一层 host 注入。
 *  - host 注入两类 Electron 边界能力:HTML → PDF 靠 Chromium `printToPDF`；
 *    最终落盘靠绑定到已验证目录身份的一次性 utility process。本包铁律是不
 *    import electron(否则 package 无法在非 Electron 宿主复用,也会污染依赖方向),
 *    所以这两个函数都由 desktop main 在 mcp-providers.ts 闭包注入。
 */

import type { LiziMcpLogger, LiziMcpSessionContext } from '../types.js';

/** render_pdf 支持的纸张。与 Electron printToPDF 的 pageSize 取值对齐。 */
export type DocsPdfPageSize = 'A3' | 'A4' | 'A5' | 'Legal' | 'Letter' | 'Tabloid';

/** 页边距,单位英寸(Electron printToPDF 的 margins 就用英寸)。 */
export interface DocsPdfMargins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * host 渲染回调的入参。工具层把已验证的 HTML 内容以 `htmlBytes` 或 `html` 传入:
 *  - htmlBytes 来自工作目录内已打开句柄的受限读取,host 不得按原路径重新打开;
 *  - html 是内联源码,由 host 落到自己的临时目录再加载(临时文件生命周期归 host,
 *    见 docs/dev-rules/credentials-and-local-storage.md:可丢弃临时数据放
 *    app.getPath('temp') / os.tmpdir() 下的任务专属目录)。
 */
export interface DocsPdfRenderInput {
  htmlBytes?: Uint8Array;
  html?: string;
  pageSize: DocsPdfPageSize;
  landscape: boolean;
  printBackground: boolean;
  margins: DocsPdfMargins;
  /** 单次渲染的硬超时(含建窗、加载、字体等待与 printToPDF)。 */
  timeoutMs: number;
  /**
   * 等 webfont 就绪的子超时。Chromium **不会**自己等 @font-face 加载完再打印,
   * 字体没就位就静默回退到系统字体 —— 这是「我指定的字体没生效」的头号成因。
   * 超过这个时间就照常渲染,并在结果里把 fontsReady 置 false 告警,不拖满总超时。
   */
  fontTimeoutMs: number;
}

/** 渲染结果:PDF 字节 + 字体是否在打印前真的就绪。 */
export interface DocsPdfRenderOutput {
  buffer: Buffer;
  /**
   * false = 等 document.fonts.ready 超时或探测失败,这份 PDF 里的字体可能被
   * Chromium 换成了系统默认字体。工具层据此给出可执行的告警。
   */
  fontsReady: boolean;
}

/**
 * HTML → PDF 渲染回调。失败必须 throw(工具层统一翻成 RENDER_FAILED /
 * RENDER_TIMEOUT)。host 侧实现见
 * apps/desktop/src/main/doc-tools/htmlPdfRenderer.ts。
 */
export type RenderHtmlToPdfFn = (input: DocsPdfRenderInput) => Promise<DocsPdfRenderOutput>;

/**
 * Host-owned output commit. Desktop binds the final file operation to a
 * previously verified parent-directory identity in a one-shot utility process.
 */
export type WriteDocsOutputFn = (input: {
  root: string;
  path: string;
  data: Uint8Array;
  overwrite: boolean;
}) => Promise<void>;

/** 单页结构快照。宽高单位是 PDF point(1/72 英寸)。 */
export interface DocsPdfPageInspection {
  page: number;
  width: number;
  height: number;
  rotation: number;
  textChars: number;
  textPreview: string;
  /** null = 算子表读取失败,不参与空白判定。 */
  drawOps: number | null;
  imageOps: number | null;
  blank: boolean;
  /** 结构存在但未做位图级可见性验证。 */
  visibilityUnverified: boolean;
}

export interface DocsPdfInspection {
  numPages: number;
  pagesInspected: number;
  pages: DocsPdfPageInspection[];
}

/**
 * 读 PDF 结构的 host 回调。与 renderHtmlToPdf 同理由外置:桌面宿主把 pdfjs 放在
 * 一次性 utility process 里跑(正式包关闭 RunAsNode,且解析不可信 PDF 不该在
 * Electron main 里进行),那条链路依赖 electron.utilityProcess,本包不能碰。
 */
export type InspectPdfFn = (input: {
  data: Uint8Array;
  /** 1 起的页码;空数组 = 从头顺序取 maxPages 页。 */
  pages: number[];
  maxPages: number;
  previewChars: number;
  timeoutMs: number;
}) => Promise<DocsPdfInspection>;

/**
 * cindy_docs MCP server 工厂参数。
 *
 * writeDocsOutput / renderHtmlToPdf / inspectPdf 缺省 = host 没接对应能力→
 * 对应工具不注册,与 memory 的 session_search / contacts 的系统通讯录同模式:
 * 能力不具备就不注册该顶层工具,而不是注册了再运行期报错。
 */
export interface DocsMcpDeps {
  /** Required for authoring tools; hosts must provide an identity-bound writer. */
  writeDocsOutput?: WriteDocsOutputFn;
  renderHtmlToPdf?: RenderHtmlToPdfFn;
  inspectPdf?: InspectPdfFn;
  logger?: LiziMcpLogger;
}

/**
 * Per-session ctx 绑定参数。与 XdtHelperMcpSessionCtx 同构:Claude in-process
 * 路径在 toClaudeSdkConfig(ctx) 时闭包绑定;Codex / Pi 的 HTTP bridge 在
 * tool-call 阶段由 getSessionContext 恢复。所有文件路径都以解析出来的
 * workingDir 为根,解析不出来就 fail closed(见 _paths.ts)。
 */
export interface DocsMcpSessionCtx extends LiziMcpSessionContext {
  agentKind: 'claude-code' | 'codex' | 'pi';
  workingDir: string;
}
