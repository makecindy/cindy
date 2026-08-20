/**
 * cindy-docs/index.ts
 *
 * cindy_docs 工具族的聚合导出。cindy_docsMcpServer.ts 从这里一次性 import 并注册
 * (与 xdt-helper/index.ts、scheduler/index.ts 同模式)。
 */

export { registerMakeDocxTool } from './make_docx.js';
export { registerMakePptxTool, PPTX_THEMES, isSupportedPptxImage } from './make_pptx.js';
export { registerMakeXlsxTool } from './make_xlsx.js';
export { registerReadSheetTool } from './read_sheet.js';
export {
  registerRenderPdfTool,
  RENDER_PDF_TIMEOUT_MS,
  RENDER_PDF_FONT_TIMEOUT_MS,
} from './render_pdf.js';
export { registerInspectPdfTool, INSPECT_PDF_TIMEOUT_MS } from './inspect_pdf.js';

export { markdownToDocxBuffer, type MarkdownToDocxOptions } from './markdownToDocx.js';
export { parseDelimited, delimiterForExtension, type ParseDelimitedOptions } from './csv.js';
export {
  DocsPathError,
  describeOutput,
  prepareInputPath,
  prepareOutputPath,
  resolveSessionRoot,
} from './_paths.js';
export { okPayload, errorPayload, type DocsPayloadResult } from './_payload.js';

export type {
  DocsMcpDeps,
  DocsMcpSessionCtx,
  DocsPdfInspection,
  DocsPdfMargins,
  DocsPdfPageInspection,
  DocsPdfPageSize,
  DocsPdfRenderInput,
  DocsPdfRenderOutput,
  InspectPdfFn,
  RenderHtmlToPdfFn,
} from './types.js';
