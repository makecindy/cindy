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

import { promises as fs } from 'node:fs';

import { z } from 'zod';

import type { DocsToolRegistry } from '../cindy_docsToolRegistry.js';
import { describeOutput, DocsPathError, prepareInputPath, prepareOutputPath, resolveSessionRoot } from './_paths.js';
import { errorPayload, okPayload } from './_payload.js';
import type { DocsMcpSessionCtx, DocsPdfPageSize, RenderHtmlToPdfFn } from './types.js';

/** 与设计一致的渲染硬超时。加载卡死的页面不能拖着任务不放。 */
export const RENDER_PDF_TIMEOUT_MS = 30_000;
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
  'HTML 里可以引用网络资源(图片、字体);相对路径资源只有在用 htmlPath 时才解析得到。',
  '',
  '【排版】pageSize 默认 A4;margins 单位是英寸,默认四边 0.4;',
  'printBackground 默认 true(否则深色底、色块全部不打印)。',
  '分页控制在 HTML 里用 CSS: page-break-after / break-inside: avoid。',
  '',
  '【自检】返回里带 bytes。PDF 只有一两 KB 通常意味着渲染出了白页 ——',
  '这时应检查 HTML 是否真有内容、外部资源是否加载失败,重做一次,而不是直接交付。',
  '',
  '【输出】outPath 必须在本任务的工作目录内。同名文件默认不覆盖,确要覆盖再传 overwrite: true。',
].join('\n');

const PAGE_SIZES: readonly DocsPdfPageSize[] = ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid'];

export function registerRenderPdfTool(
  registry: DocsToolRegistry,
  sessionCtx: DocsMcpSessionCtx,
  renderHtmlToPdf: RenderHtmlToPdfFn,
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
        .describe('内联 HTML 源码。与 htmlPath 二选一。相对路径的本地资源不会被解析。'),
      outPath: z.string().min(1).describe('输出 .pdf 路径,工作目录内的相对路径或绝对路径。'),
      pageSize: z.enum(PAGE_SIZES as unknown as [DocsPdfPageSize, ...DocsPdfPageSize[]])
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
      overwrite: z.boolean().default(false).describe('目标文件已存在时是否覆盖。默认 false。'),
    },
    handler: async ({ htmlPath, html, outPath, pageSize, landscape, printBackground, margins, overwrite }) => {
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
        const abs = await prepareOutputPath(root, outPath, overwrite);
        const sourcePath = hasPath ? await prepareInputPath(root, htmlPath!) : undefined;

        const buffer = await renderHtmlToPdf({
          ...(sourcePath ? { htmlPath: sourcePath } : { html: html! }),
          pageSize,
          landscape,
          printBackground,
          margins: {
            top: margins?.top ?? DEFAULT_MARGIN_INCHES,
            bottom: margins?.bottom ?? DEFAULT_MARGIN_INCHES,
            left: margins?.left ?? DEFAULT_MARGIN_INCHES,
            right: margins?.right ?? DEFAULT_MARGIN_INCHES,
          },
          timeoutMs: RENDER_PDF_TIMEOUT_MS,
        });

        if (!buffer || buffer.length === 0) {
          return errorPayload(
            'RENDER_EMPTY',
            '渲染出来是空的 PDF。请检查 HTML 里是否真有可见内容(常见原因:整页被 CSS 隐藏、外部样式没加载到)。',
            {},
          );
        }
        await fs.writeFile(abs, buffer);

        const described = await describeOutput(root, abs);
        return okPayload({
          ...described,
          format: 'pdf',
          pageSize,
          landscape,
          ...(described.bytes < SUSPICIOUS_PDF_BYTES
            ? {
                warning:
                  'PDF 字节数异常小,很可能渲染成了白页。请打开确认内容,必要时检查 HTML 与外部资源后重做,不要直接交付。',
              }
            : {}),
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
