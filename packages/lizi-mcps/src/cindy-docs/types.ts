/**
 * cindy-docs/types.ts —— cindy_docs 的 host 依赖契约。
 *
 * 分层理由(写清以免后人误改):
 *  - docx / pptxgenjs / exceljs / marked 都是纯 JS,没有原生绑定、不碰 Electron,
 *    与本包已有的 sharp / googleapis / ssh 客户端同级,直接在 @cindy/mcps 内实现,
 *    不需要绕一层 host 注入。
 *  - **唯一必须 host 注入的是 HTML → PDF 渲染**:它靠 Chromium `printToPDF`,
 *    只有 Electron 主进程能提供。本包铁律是不 import electron(否则 package 无法
 *    在非 Electron 宿主复用,也会污染依赖方向),所以渲染函数由 desktop main 在
 *    mcp-providers.ts 闭包注入。
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
 * host 渲染回调的入参。`htmlPath` 与 `html` 二选一,由工具层保证:
 *  - htmlPath 已经过 workingDir 边界校验,是可直接 loadFile 的绝对路径;
 *  - html 是内联源码,由 host 落到自己的临时目录再加载(临时文件生命周期归 host,
 *    见 docs/dev-rules/credentials-and-local-storage.md:可丢弃临时数据放
 *    app.getPath('temp') / os.tmpdir() 下的任务专属目录)。
 */
export interface DocsPdfRenderInput {
  htmlPath?: string;
  html?: string;
  pageSize: DocsPdfPageSize;
  landscape: boolean;
  printBackground: boolean;
  margins: DocsPdfMargins;
  /** 单次渲染的硬超时(含建窗、加载与 printToPDF)。 */
  timeoutMs: number;
}

/**
 * HTML → PDF 渲染回调。返回 PDF 字节;失败必须 throw(工具层统一翻成
 * RENDER_FAILED / RENDER_TIMEOUT)。host 侧实现见
 * apps/desktop/src/main/doc-tools/htmlPdfRenderer.ts。
 */
export type RenderHtmlToPdfFn = (input: DocsPdfRenderInput) => Promise<Buffer>;

/**
 * cindy_docs MCP server 工厂参数。
 *
 * renderHtmlToPdf 缺省 = host 没接渲染能力(如纯 Node 宿主复用本包)→ render_pdf
 * 工具不注册,与 memory 的 session_search / contacts 的系统通讯录同模式:能力不
 * 具备就不出现在 list_tools 里,而不是注册了再运行期报错。
 */
export interface DocsMcpDeps {
  renderHtmlToPdf?: RenderHtmlToPdfFn;
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
