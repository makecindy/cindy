/**
 * cindy-docs/render_pdf.ts —— HTML → PDF。
 *
 * 渲染本身在 desktop main 的隐藏 BrowserWindow 里跑(Chromium printToPDF),
 * 由 deps.renderHtmlToPdf 注入 —— 本包不 import electron。工具层只负责:
 * 参数校验、路径边界、把返回的字节落盘、把失败翻成人话。
 *
 * host 没注入渲染能力(纯 Node 宿主复用本包)时本工具整个不注册,不做「注册了
 * 再运行期报不可用」——模型看不到的工具不会被误选。
 */

import path from 'node:path';

import { z } from 'zod';

import type { DocsToolRegistry } from '../cindy_docsToolRegistry.js';
import {
  assertOutputExtension,
  describeOutput,
  DocsPathError,
  prepareInputPath,
  prepareOutputPath,
  readInputFileWithinLimit,
  resolveSessionRoot,
} from './_paths.js';
import { artifactMetadata, errorPayload, okPayload } from './_payload.js';
import {
  applyReportTemplate,
  extractHtmlTitle,
} from './pdfTemplate.js';
import {
  DEFAULT_DOCS_THEME,
  resolveDocsTheme,
  type DocsThemeName,
} from './themes.js';
import type {
  DocsMcpSessionCtx,
  DocsPdfPageSize,
  RenderHtmlToPdfFn,
  WriteDocsOutputFn,
} from './types.js';

/** 与设计一致的渲染硬超时。加载卡死的页面不能拖着任务不放。 */
export const RENDER_PDF_TIMEOUT_MS = 30_000;
/**
 * 等 webfont 就绪的子超时。Chromium 不会自己等 @font-face,字体没加载完就打印会被
 * 静默替换成系统字体。这里单独给一小段时间等 document.fonts.ready;等不到就照常
 * 出片并告警,不占满总超时(字体只是"可能不对",而不是"渲染失败")。
 */
export const RENDER_PDF_FONT_TIMEOUT_MS = 5_000;
/** 自包含 HTML 允许内联图片/字体，但仍需限制主进程读取和模板复制的内存上界。 */
export const RENDER_PDF_MAX_HTML_BYTES = 16 * 1024 * 1024;
/** 空/超小 PDF 的告警阈值:低于这个字节数几乎必然是白页,值得让模型自查。 */
const SUSPICIOUS_PDF_BYTES = 2_048;

const DEFAULT_MARGIN_INCHES = 0.4;

const DESCRIPTION = [
  '把 HTML 渲染成 PDF(用 Cindy 内置的 Chromium 排版,不需要用户装任何东西)。',
  '',
  '【何时用】需要精确版式的正式文档:报告、简历、发票、带图表的材料。',
  '推荐做法是先写一份自包含的 HTML(样式内联,不依赖外部 CSS 文件),再用本工具出 PDF。',
  '如果产物要给人二次编辑,请改用 make_docx —— PDF 不好改。',
  '',
  '【输入】htmlPath(工作目录内的 .html 文件)与 html(内联源码)二选一,必须给且只给一个。',
  'HTML 源码上限 16 MB;文件路径与内联源码使用同一上限。',
  '为防止不可信 HTML 借用户网络身份探测内网或触发跟踪,渲染窗会阻断外部网络请求。',
  '图片/字体/样式请内联成 data URI;为避免不可信 HTML 的本地资源竞态,file:// 子资源一律阻断。',
  '',
  '【模板】template 默认 auto:没有 <style> / 外链 CSS 的裸 HTML 会自动套内置报告模板',
  '(系统字体、标题层级、表格斑马纹、打印页边距)。已经自己写了样式的原样透传。',
  'template:"none" 关闭;theme: light / dark / navy 只影响自动套上的模板。',
  '',
  '【排版】pageSize 默认 A4;margins 单位是英寸,默认四边 0.4。',
  '自动套模板且未显式传 margins 时,Electron 边距归零,改由 CSS @page 管边距,避免双边距。',
  'printBackground 默认 true(否则深色底、色块全部不打印)。',
  '分页控制在 HTML 里用 CSS: page-break-after / break-inside: avoid。',
  '',
  '【字体】渲染前会等 @font-face 加载完(最多 5 秒)。等不到会照常出片,但返回里',
  'fontsReady=false —— 那说明 PDF 里的字体很可能被换成了系统默认字体。要么把字体',
  '改成 base64 内联进 HTML,要么接受回退,别不看这个字段就交付。',
  '',
  '【自检】出片后**务必再调 inspect_pdf 回读一次**:整页空白的 PDF 字节数看着完全',
  '正常,只看 bytes 判断不出来。inspect_pdf 会直接告诉你哪几页是白的、总共几页、',
  '纸张对不对。返回里的 bytes 只能筛掉最极端的情况。',
  '',
  '【输出】outPath 必须在本任务的工作目录内。同名文件默认不覆盖,确要覆盖再传 overwrite: true。',
].join('\n');

const PAGE_SIZES: readonly DocsPdfPageSize[] = [
  'A3',
  'A4',
  'A5',
  'Legal',
  'Letter',
  'Tabloid',
];

export function registerRenderPdfTool(
  registry: DocsToolRegistry,
  sessionCtx: DocsMcpSessionCtx,
  renderHtmlToPdf: RenderHtmlToPdfFn,
  writeDocsOutput: WriteDocsOutputFn,
): void {
  registry.register({
    name: 'render_pdf',
    category: 'convert',
    description: DESCRIPTION,
    inputShape: {
      htmlPath: z
        .string()
        .optional()
        .describe('工作目录内的 .html 文件路径。与 html 二选一。'),
      html: z
        .string()
        .optional()
        .describe(
          '内联 HTML 源码。与 htmlPath 二选一。图片/字体请使用 data URI,file:// 子资源不会被解析。',
        ),
      outPath: z
        .string()
        .min(1)
        .describe('输出 .pdf 路径,工作目录内的相对路径或绝对路径。'),
      pageSize: z
        .enum(PAGE_SIZES as unknown as [DocsPdfPageSize, ...DocsPdfPageSize[]])
        .default('A4')
        .describe('纸张尺寸,默认 A4。'),
      landscape: z.boolean().default(false).describe('是否横向。默认纵向。'),
      printBackground: z
        .boolean()
        .default(true)
        .describe('是否打印背景色与背景图。默认 true。'),
      margins: z
        .object({
          top: z.number().min(0).max(5).default(DEFAULT_MARGIN_INCHES),
          bottom: z.number().min(0).max(5).default(DEFAULT_MARGIN_INCHES),
          left: z.number().min(0).max(5).default(DEFAULT_MARGIN_INCHES),
          right: z.number().min(0).max(5).default(DEFAULT_MARGIN_INCHES),
        })
        .optional()
        .describe('页边距(英寸)。不传时四边都是 0.4。'),
      template: z
        .enum(['auto', 'report', 'none'])
        .default('auto')
        .describe(
          'auto=无样式时套内置报告模板;report=同样只套无样式 HTML;none=不套。',
        ),
      theme: z
        .enum(['light', 'dark', 'navy'])
        .default('light')
        .describe('自动套模板时使用的色板。已有样式的 HTML 不受影响。'),
      overwrite: z
        .boolean()
        .default(false)
        .describe('目标文件已存在时是否覆盖。默认 false。'),
    },
    handler: async ({
      htmlPath,
      html,
      outPath,
      pageSize,
      landscape,
      printBackground,
      margins,
      template,
      theme,
      overwrite,
    }) => {
      const hasPath = typeof htmlPath === 'string' && htmlPath.length > 0;
      const hasInline = typeof html === 'string' && html.length > 0;
      if (hasPath === hasInline) {
        return errorPayload(
          'INVALID_ARGS',
          hasPath
            ? 'htmlPath 和 html 只能给一个:要么指一个已有的 HTML 文件,要么直接给源码。'
            : '必须给 htmlPath(已有的 HTML 文件)或 html(内联源码)之一。',
          { gotHtmlPath: hasPath, gotHtml: hasInline },
        );
      }

      try {
        const root = resolveSessionRoot(sessionCtx);
        assertOutputExtension(outPath, '.pdf');
        const abs = await prepareOutputPath(root, outPath, overwrite);
        const sourcePath = hasPath
          ? await prepareInputPath(root, htmlPath!)
          : undefined;
        const sourceHtml = sourcePath
          ? (
              await readInputFileWithinLimit(
                root,
                sourcePath,
                RENDER_PDF_MAX_HTML_BYTES,
                (bytes) =>
                  new DocsPathError(
                    'FILE_TOO_LARGE',
                    `HTML 过大: ${bytes} 字节`,
                    `这份 HTML 有 ${(bytes / 1024 / 1024).toFixed(1)} MB,超出 PDF 渲染上限(16 MB)。请压缩内联图片/字体或拆分文档后重试。`,
                  ),
              )
            ).toString('utf8')
          : html!;
        if (!sourcePath) {
          const inlineBytes = Buffer.byteLength(sourceHtml, 'utf8');
          if (inlineBytes > RENDER_PDF_MAX_HTML_BYTES) {
            throw new DocsPathError(
              'FILE_TOO_LARGE',
              `HTML 过大: ${inlineBytes} 字节`,
              `这份 HTML 有 ${(inlineBytes / 1024 / 1024).toFixed(1)} MB,超出 PDF 渲染上限(16 MB)。请压缩内联图片/字体或拆分文档后重试。`,
            );
          }
        }
        const palette = resolveDocsTheme(
          (theme ?? DEFAULT_DOCS_THEME) as DocsThemeName,
        );
        const wrapped = applyReportTemplate(sourceHtml, palette, template);
        const userSetMargins = margins !== undefined;
        const effectiveMargins = userSetMargins
          ? {
              top: margins.top ?? DEFAULT_MARGIN_INCHES,
              bottom: margins.bottom ?? DEFAULT_MARGIN_INCHES,
              left: margins.left ?? DEFAULT_MARGIN_INCHES,
              right: margins.right ?? DEFAULT_MARGIN_INCHES,
            }
          : wrapped.applied
            ? { top: 0, bottom: 0, left: 0, right: 0 }
            : {
                top: DEFAULT_MARGIN_INCHES,
                bottom: DEFAULT_MARGIN_INCHES,
                left: DEFAULT_MARGIN_INCHES,
                right: DEFAULT_MARGIN_INCHES,
              };

        const { buffer, fontsReady } = await renderHtmlToPdf({
          // 套模板后走内联 html，host 会注入原文件目录的受限 base URL，既不改
          // 用户源文件，也能继续加载同目录相对资源。
          ...(wrapped.applied || !sourcePath
            ? {
                html: wrapped.html,
                ...(sourcePath ? { htmlBaseDir: path.dirname(sourcePath) } : {}),
              }
            : { htmlPath: sourcePath }),
          pageSize,
          landscape,
          printBackground,
          margins: effectiveMargins,
          timeoutMs: RENDER_PDF_TIMEOUT_MS,
          fontTimeoutMs: RENDER_PDF_FONT_TIMEOUT_MS,
        });

        if (!buffer || buffer.length === 0) {
          return errorPayload(
            'RENDER_EMPTY',
            '渲染出来是空的 PDF。请检查 HTML 里是否真有可见内容(常见原因:整页被 CSS 隐藏、外部样式没加载到)。',
            {},
          );
        }
        await writeDocsOutput({ root, path: abs, data: buffer, overwrite });

        const described = describeOutput(root, abs, buffer.byteLength);
        const warnings: string[] = [];
        if (described.bytes < SUSPICIOUS_PDF_BYTES) {
          warnings.push(
            'PDF 字节数异常小,很可能渲染成了白页。用 inspect_pdf 回读确认,必要时检查 HTML 与外部资源后重做,不要直接交付。',
          );
        }
        if (!fontsReady) {
          warnings.push(
            '等字体加载超时,PDF 里的字体可能已被换成系统默认字体。若排版对字体有要求,请把字体 base64 内联进 HTML 后重做。',
          );
        }
        return okPayload({
          ...described,
          format: 'pdf',
          pageSize,
          landscape,
          fontsReady,
          template,
          theme,
          templateApplied: wrapped.applied,
          nextStep:
            '用 inspect_pdf 回读这份 PDF,确认页数、纸张与是否有空白页,再交付。',
          artifact: artifactMetadata({
            format: 'pdf',
            title: extractHtmlTitle(sourceHtml),
            theme,
          }),
          ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
        });
      } catch (err) {
        if (err instanceof DocsPathError) {
          return errorPayload(err.code, err.hint, { message: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = /timeout|超时/i.test(message);
        return errorPayload(
          timedOut ? 'RENDER_TIMEOUT' : 'RENDER_FAILED',
          timedOut
            ? `渲染超过 ${RENDER_PDF_TIMEOUT_MS / 1000} 秒被中止。常见原因是 HTML 在等一个加载不出来的外部资源;把外部图片/字体改成内联或本地文件后重试。`
            : `渲染 PDF 失败:${message}`,
          { message },
        );
      }
    },
  });
}
