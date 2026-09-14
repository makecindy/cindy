/**
 * cindy-docs/inspect_pdf.ts —— 回读一份 PDF 的结构,做产出自检。
 *
 * 为什么需要它:生成 PDF 最常见、也最难自查的翻车是「文件生成了,打开是白的」——
 * 字节数完全正常(PDF 结构、字体、元数据都在),光看 bytes 判断不出来。模型不回读
 * 就交付,用户打开才发现,这是最坏的顺序。
 *
 * 本工具给的是**确定性证据**而不是猜测:某页 textChars=0 且 drawOps=0 且
 * imageOps=0,那它就是白的;12 页而不是预期的 2 页,说明分页样式没生效;
 * 页面尺寸不是 A4,说明 pageSize 传错了。
 *
 * 【不产出图片】本工具返回结构与文本,不做位图渲染 —— 见 README/PR 说明:
 * 把 PDF 栅格成 PNG 在 Node 侧需要引入原生 canvas 绑定(打包链路改造 + 每平台
 * 二进制),代价与收益不匹配。空白/串页/尺寸错这几类真实翻车,结构证据已经能定死。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import { z } from 'zod';

import type { DocsToolRegistry } from '../cindy_docsToolRegistry.js';
import {
  DocsPathError,
  prepareInputPath,
  readInputFileWithinLimit,
  resolveSessionRoot,
} from './_paths.js';
import { errorPayload, okPayload } from './_payload.js';
import type { DocsMcpSessionCtx, InspectPdfFn } from './types.js';

/** 解析超时。结构读取比渲染轻得多,15 秒足够;卡住通常意味着文件损坏。 */
export const INSPECT_PDF_TIMEOUT_MS = 15_000;
/** 单次最多检查多少页 —— 页数越多算子表解析越贵,而自检并不需要通读全文。 */
const DEFAULT_MAX_PAGES = 10;
const HARD_MAX_PAGES = 50;
/** 每页文本预览字符数。够判断"这页装的是不是我以为的内容",又不撑爆上下文。 */
const PREVIEW_CHARS = 400;
/** 输入上限:超大 PDF 解析会顶满 utility process 的内存预算。 */
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** 常见纸张(pt),用于把裸数字翻译成人能对照的名字。允许 2pt 误差。 */
const PAPER_SIZES: ReadonlyArray<{ name: string; w: number; h: number }> = [
  { name: 'A3', w: 841.89, h: 1190.55 },
  { name: 'A4', w: 595.28, h: 841.89 },
  { name: 'A5', w: 419.53, h: 595.28 },
  { name: 'Letter', w: 612, h: 792 },
  { name: 'Legal', w: 612, h: 1008 },
  { name: 'Tabloid', w: 792, h: 1224 },
];

function describePaper(width: number, height: number): string {
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2;
  for (const paper of PAPER_SIZES) {
    if (near(width, paper.w) && near(height, paper.h)) return paper.name;
    if (near(width, paper.h) && near(height, paper.w)) return `${paper.name} landscape`;
  }
  // 非标准尺寸直接报英寸,比报 pt 更容易被人对照。
  return `${(width / 72).toFixed(2)}×${(height / 72).toFixed(2)} in`;
}

const DESCRIPTION = [
  '回读一份 PDF 的结构,用来检查自己刚生成的 PDF 到底对不对。',
  '',
  '【务必在交付 PDF 前调一次】render_pdf 返回成功只代表"文件写出来了",',
  '不代表内容是对的。最常见的翻车是整页空白 —— 字节数看着完全正常。',
  '',
  '【能查出什么】每页的:文字字符数与开头片段、绘图/图像算子数、是否空白、',
  '页面尺寸(会翻译成 A4 / Letter 这类名字)与旋转角。文档级还给总页数与空白页清单。',
  '',
  '【怎么判读】',
  '- blankPages 非空 → 那几页是结构上确定为空的,大概率 CSS 把内容藏了或外部资源没加载上,重做;',
  '- visibilityUnverified=true → 某页算子解析未完成,未做位图级可见性确认,结构检查证据不完整;请重试或人工打开确认,不要把 verdict 当作视觉验收;',
  '- numPages 远超预期 → 分页样式没生效(检查 page-break / break-inside);',
  '- paper 不是你要的尺寸 → render_pdf 的 pageSize 传错了;',
  '- textPreview 和你写的内容对不上 → 装错了内容或页序错乱。',
  '',
  '【不产出图片】本工具返回结构与文本,不做位图预览。空白、串页、尺寸错这几类',
  '真实翻车靠上面的字段已经能定死;需要肉眼确认版式细节时,请把文件路径给用户去打开。',
  '',
  '【参数】pages 可指定要看的页码(1 起,如 [1,2,5]);不传就从第 1 页顺序取 maxPages 页。',
  '分批连续检查时,把上一批响应的 inspectedThrough、verdict 和 pdfSha256 分别作为 inspectedThrough、previousVerdict 与 previousPdfSha256 原样传回,工具才会确认文件未变化并累计覆盖和已发现的异常。',
].join('\n');

export function registerInspectPdfTool(
  registry: DocsToolRegistry,
  sessionCtx: DocsMcpSessionCtx,
  inspectPdf: InspectPdfFn,
): void {
  registry.register({
    name: 'inspect_pdf',
    category: 'read',
    description: DESCRIPTION,
    inputShape: {
      path: z.string().min(1).describe('PDF 路径,工作目录内的相对路径或绝对路径。'),
      pages: z
        .array(z.number().int().min(1))
        .max(HARD_MAX_PAGES)
        .optional()
        .describe(
          `要检查的页码(1 起),最多 ${HARD_MAX_PAGES} 项。不传 = 从第 1 页顺序取 maxPages 页。`,
        ),
      inspectedThrough: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('此前已连续检查到的页码。分批检查时传上一批响应的同名字段,默认 0。'),
      previousVerdict: z
        .enum(['ok', 'blank', 'partial-blank', 'warning', 'incomplete'])
        .optional()
        .describe(
          '上一批响应的 verdict。inspectedThrough > 0 时必须原样传回,避免后续正常页覆盖已发现的异常。',
        ),
      previousPdfSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe(
          '上一批响应的 pdfSha256。inspectedThrough > 0 时必须原样传回,文件变化时会要求从第 1 页重新检查。',
        ),
      maxPages: z
        .number()
        .int()
        .min(1)
        .max(HARD_MAX_PAGES)
        .default(DEFAULT_MAX_PAGES)
        .describe(`最多检查多少页,默认 ${DEFAULT_MAX_PAGES},上限 ${HARD_MAX_PAGES}。`),
    },
    handler: async ({
      path: inputPath,
      pages,
      inspectedThrough,
      previousVerdict,
      previousPdfSha256,
      maxPages,
    }) => {
      try {
        if (
          inspectedThrough > 0 &&
          (previousVerdict === undefined || previousPdfSha256 === undefined)
        ) {
          return errorPayload(
            'INVALID_ARGS',
            '分批检查已带 inspectedThrough,但缺少上一批的 previousVerdict 或 previousPdfSha256。请把上一批响应的 verdict 和 pdfSha256 原样传回,避免跨文件累计或丢失已发现的异常。',
            { inspectedThrough },
          );
        }
        const carriedVerdict = previousVerdict ?? 'incomplete';
        const root = resolveSessionRoot(sessionCtx);
        const abs = await prepareInputPath(root, inputPath);
        if (path.extname(abs).toLowerCase() !== '.pdf') {
          return errorPayload(
            'UNSUPPORTED_FORMAT',
            `只能检查 .pdf 文件,给的是 "${path.extname(abs) || '(无扩展名)'}"。`,
            { path: abs },
          );
        }

        const data = await readInputFileWithinLimit(
          root,
          abs,
          MAX_INPUT_BYTES,
          (bytes) =>
            new DocsPathError(
              'FILE_TOO_LARGE',
              `PDF 过大: ${bytes} 字节`,
              `PDF 有 ${(bytes / 1024 / 1024).toFixed(1)} MB,超出检查上限(64 MB)。请先压缩或拆分 PDF。`,
            ),
        );
        if (data.byteLength === 0) {
          return errorPayload(
            'EMPTY_FILE',
            '这个 PDF 是 0 字节 —— 上一步的生成其实没成功。请重新生成,不要交付。',
            { path: abs },
          );
        }
        const pdfSha256 = createHash('sha256').update(data).digest('hex');
        if (inspectedThrough > 0 && previousPdfSha256 !== pdfSha256) {
          return errorPayload(
            'PDF_CHANGED',
            '分批检查期间 PDF 内容已经变化,不能把不同文件版本的检查结果合并。请去掉 pages、inspectedThrough、previousVerdict 和 previousPdfSha256,从第 1 页重新检查当前文件。',
            {
              path: abs,
              previousPdfSha256,
              pdfSha256,
            },
          );
        }
        const inspection = await inspectPdf({
          data: new Uint8Array(data),
          pages: pages ?? [],
          maxPages,
          previewChars: PREVIEW_CHARS,
          timeoutMs: INSPECT_PDF_TIMEOUT_MS,
        });

        const decorated = inspection.pages.map((page) => ({
          ...page,
          paper: describePaper(page.width, page.height),
        }));
        if (inspection.pagesInspected === 0 || decorated.length === 0) {
          return errorPayload(
            'NO_PAGES_INSPECTED',
            inspection.numPages > 0
              ? '没有检查到任何页面。指定页码可能全部超出 PDF 的实际页数，请改用 1 到总页数之间的页码后重试。'
              : '这份 PDF 没有可检查的页面，不能把它当作检查通过的成品。请重新生成后再检查。',
            {
              path: abs,
              numPages: inspection.numPages,
              requestedPages: pages ?? [],
            },
          );
        }
        const blankPages = decorated.filter((p) => p.blank).map((p) => p.page);
        const allInspectedBlank = decorated.length > 0 && blankPages.length === decorated.length;
        const visibilityUnverifiedPages = decorated
          .filter((p) => p.visibilityUnverified)
          .map((p) => p.page);
        const inspectedPageNumbers = new Set(decorated.map((page) => page.page));
        let accumulatedThrough = Math.min(inspectedThrough, inspection.numPages);
        while (inspectedPageNumbers.has(accumulatedThrough + 1)) accumulatedThrough += 1;
        const partial = accumulatedThrough < inspection.numPages;
        const nextPages: number[] = [];
        if (partial) {
          // numPages is untrusted PDF metadata. Never allocate an array sized by
          // that declaration. Advance only through pages proven contiguous with
          // the caller's previous cursor, then generate one bounded next batch.
          for (
            let page = accumulatedThrough + 1;
            page <= inspection.numPages && nextPages.length < maxPages;
            page += 1
          ) {
            nextPages.push(page);
          }
        }
        const coverageWarning = partial
          ? `当前已连续覆盖 ${accumulatedThrough}/${inspection.numPages} 页，下一批页码为 ${nextPages.join('、')}。请用 pages: [${nextPages.join(', ')}]，并传 inspectedThrough: ${accumulatedThrough}，再把本次响应的 verdict 和 pdfSha256 原样作为 previousVerdict 与 previousPdfSha256 继续检查。`
          : undefined;

        const previousFoundBlank = carriedVerdict === 'blank' || carriedVerdict === 'partial-blank';
        const previousAllBlank = carriedVerdict === 'blank';
        const previousVisibilityUnverified = carriedVerdict === 'warning';
        const accumulatedAllBlank =
          allInspectedBlank && (inspectedThrough === 0 || previousAllBlank);
        const accumulatedFoundBlank = previousFoundBlank || blankPages.length > 0;
        const accumulatedVisibilityUnverified =
          previousVisibilityUnverified || visibilityUnverifiedPages.length > 0;

        const verdictAndWarning = accumulatedAllBlank
          ? {
              verdict: 'blank',
              warning: `连续检查到的每一页都是空白 —— 这份 PDF 不能交付。回去检查 HTML 是否真有可见内容、外部图片/字体是否加载失败,修好后重新生成再查一次。${coverageWarning ? ` ${coverageWarning}` : ''}`,
            }
          : accumulatedFoundBlank
            ? {
                verdict: 'partial-blank',
                warning: `${blankPages.length > 0 ? `第 ${blankPages.join('、')} 页是空白的。` : '此前批次已发现空白页。'}通常是分页把内容挤走了(检查 page-break / break-inside),修好后重新生成。${coverageWarning ? ` ${coverageWarning}` : ''}`,
              }
            : accumulatedVisibilityUnverified
              ? {
                  verdict: 'warning',
                  warning: `${visibilityUnverifiedPages.length > 0 ? `第 ${visibilityUnverifiedPages.join('、')} 页的结构算子解析未完成` : '此前批次存在结构算子解析未完成的页面'},未做位图级可见性确认,检查证据不完整。请重试并在必要时打开 PDF 确认。${coverageWarning ? ` ${coverageWarning}` : ''}`,
                }
              : partial
                ? { verdict: 'incomplete', warning: coverageWarning! }
                : { verdict: 'ok' };

        return okPayload({
          path: abs,
          bytes: data.byteLength,
          pdfSha256,
          numPages: inspection.numPages,
          pagesInspected: inspection.pagesInspected,
          inspectedThrough: accumulatedThrough,
          pages: decorated,
          blankPages,
          visibilityUnverifiedPages,
          ...(partial ? { nextPages } : {}),
          ...verdictAndWarning,
        });
      } catch (err) {
        if (err instanceof DocsPathError) {
          return errorPayload(err.code, err.hint, { message: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = /timed out|timeout|超时/i.test(message);
        return errorPayload(
          timedOut ? 'INSPECT_TIMEOUT' : 'INSPECT_FAILED',
          timedOut
            ? `解析超过 ${INSPECT_PDF_TIMEOUT_MS / 1000} 秒被中止,文件可能损坏或过于复杂。`
            : `读取 PDF 失败:${message}。如果这是刚生成的文件,说明生成环节就出了问题,请重做而不是交付。`,
          { message },
        );
      }
    },
  });
}
