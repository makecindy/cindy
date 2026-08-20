/**
 * One-shot packaged Electron utility process for bounded PDF reading.
 *
 * 两种作业共用这一条链路(同一个 forge entry —— pdfjs 只打包一份,也只在这里跑):
 *  - 'extract' : Reviewer 读 PDF 交付物正文。
 *  - 'inspect' : cindy_docs 的 inspect_pdf,回读刚生成的 PDF 做产出自检。
 * 正式包关闭 RunAsNode,PDF.js 一律在这个一次性进程里跑,超时直接 kill。
 */

// PDF.js uses a fake worker under Node and otherwise loads `./pdf.worker.mjs`
// with a variable dynamic import. Forge/Vite cannot discover or copy that
// sibling into the packaged `.vite/build` directory. Importing it here both
// bundles the worker implementation and initializes `globalThis.pdfjsWorker`,
// so the fake worker never depends on an unshipped runtime file.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import type {
  ReviewPdfInspectProcessResult,
  ReviewPdfPageInspection,
  ReviewPdfTextProcessResult,
  ReviewPdfUtilityRequest,
  ReviewPdfUtilityResponse,
} from './reviewPdfProcessProtocol.js';

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

/** 两种请求共有的字节与页数护栏。 */
function hasValidEnvelope(request: Partial<ReviewPdfUtilityRequest>): boolean {
  return (
    typeof request.id === 'string' &&
    request.id.length > 0 &&
    request.data instanceof Uint8Array &&
    Number.isSafeInteger(request.maxInputBytes) &&
    Number(request.maxInputBytes) > 0 &&
    request.data.byteLength <= Number(request.maxInputBytes) &&
    Number.isSafeInteger(request.maxPages) &&
    Number(request.maxPages) > 0
  );
}

function parseRequest(value: unknown): ReviewPdfUtilityRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Partial<ReviewPdfUtilityRequest>;
  if (!hasValidEnvelope(request)) return null;

  if (request.kind === 'extract') {
    const maxChars = (request as { maxChars?: unknown }).maxChars;
    if (!Number.isSafeInteger(maxChars) || Number(maxChars) <= 0) return null;
    return request as ReviewPdfUtilityRequest;
  }

  if (request.kind === 'inspect') {
    const inspect = request as { pages?: unknown; previewChars?: unknown };
    if (!Number.isSafeInteger(inspect.previewChars) || Number(inspect.previewChars) < 0) {
      return null;
    }
    if (
      !Array.isArray(inspect.pages) ||
      !inspect.pages.every((page) => Number.isSafeInteger(page) && Number(page) >= 1)
    ) {
      return null;
    }
    return request as ReviewPdfUtilityRequest;
  }

  return null;
}

export async function extractReviewPdfText(
  data: Uint8Array,
  maxChars: number,
  maxPages: number,
): Promise<ReviewPdfTextProcessResult> {
  const loadingTask = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    useWasm: false,
    stopAtErrors: true,
    maxImageSize: 1,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: 0,
  });
  let document: Awaited<typeof loadingTask.promise> | null = null;
  try {
    document = await loadingTask.promise;
    const pageLimit = Math.min(document.numPages, maxPages);
    const sections: string[] = [];
    let totalChars = 0;
    let pagesInspected = 0;
    let clipped = false;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pagesInspected = pageNumber;
      const parts: string[] = [];
      for (const item of textContent.items) {
        if (!item || typeof item !== 'object' || !('str' in item)) continue;
        if (typeof item.str !== 'string') continue;
        parts.push(item.str, item.hasEOL ? '\n' : ' ');
      }
      const text = parts
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      if (!text) continue;
      const section = `--- 第 ${pageNumber} 页 ---\n${text}`;
      const separatorChars = sections.length > 0 ? 2 : 0;
      const remaining = maxChars - totalChars - separatorChars;
      if (section.length > remaining) {
        if (remaining > 0) sections.push(section.slice(0, remaining));
        clipped = true;
        break;
      }
      sections.push(section);
      totalChars += separatorChars + section.length;
    }
    return { sections, pagesInspected, numPages: document.numPages, clipped };
  } finally {
    if (document) await document.destroy().catch(() => undefined);
    else await loadingTask.destroy().catch(() => undefined);
  }
}

/** pdfjs 里代表"画了一张图"的算子。用于区分「这页有图」和「这页什么都没有」。 */
const IMAGE_OPS: readonly number[] = [
  pdfjs.OPS.paintImageXObject,
  pdfjs.OPS.paintInlineImageXObject,
  pdfjs.OPS.paintImageMaskXObject,
  pdfjs.OPS.paintImageXObjectRepeat,
  pdfjs.OPS.paintImageMaskXObjectRepeat,
].filter((op): op is number => typeof op === 'number');

/**
 * 读 PDF 的结构快照:页数、每页尺寸/旋转、文本量与开头片段、绘图与图像算子数,
 * 并据此判定空白页。
 *
 * 这是 cindy_docs 产出自检的数据来源 —— 生成 PDF 最常见也最难自查的翻车是
 * 「文件生成了、打开是白的」,它在字节数上完全正常。这里给的是确定性证据:
 * 某页 textChars=0 且 drawOps=0 且 imageOps=0,那它就是白的。
 *
 * 算子表单独 try/catch:损坏页或超预算时降级成 null 而不是让整次检查失败 ——
 * 半份结构信息也比"检查工具自己挂了"有用。null 时 blank 恒为 false,不猜。
 */
export async function inspectPdfPages(
  data: Uint8Array,
  requestedPages: readonly number[],
  maxPages: number,
  previewChars: number,
): Promise<ReviewPdfInspectProcessResult> {
  const loadingTask = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    useWasm: false,
    stopAtErrors: true,
    // 与 extract 不同:这里要数图像算子,不能把 maxImageSize 卡到 1(那会让含图页
    // 直接报错)。仍然不解码到位图 —— 只读算子表,内存占用与页面复杂度成正比。
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: 0,
  });
  let document: Awaited<typeof loadingTask.promise> | null = null;
  try {
    document = await loadingTask.promise;
    const numPages = document.numPages;

    // 去重 + 升序 + 丢掉越界页码;不传则从第 1 页顺序取。
    const wanted =
      requestedPages.length > 0
        ? [...new Set(requestedPages)].filter((n) => n >= 1 && n <= numPages).sort((a, b) => a - b)
        : Array.from({ length: numPages }, (_, i) => i + 1);
    const selected = wanted.slice(0, maxPages);

    const pages: ReviewPdfPageInspection[] = [];
    for (const pageNumber of selected) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });

      const textContent = await page.getTextContent();
      const parts: string[] = [];
      for (const item of textContent.items) {
        if (!item || typeof item !== 'object' || !('str' in item)) continue;
        if (typeof item.str !== 'string') continue;
        parts.push(item.str, item.hasEOL ? '\n' : ' ');
      }
      const text = parts.join('').replace(/\s+/g, ' ').trim();

      let drawOps: number | null = null;
      let imageOps: number | null = null;
      try {
        const operatorList = await page.getOperatorList();
        const fnArray = operatorList.fnArray;
        let images = 0;
        for (const fn of fnArray) {
          if (IMAGE_OPS.includes(fn)) images += 1;
        }
        drawOps = fnArray.length;
        imageOps = images;
      } catch {
        drawOps = null;
        imageOps = null;
      }

      pages.push({
        page: pageNumber,
        width: Math.round(viewport.width * 100) / 100,
        height: Math.round(viewport.height * 100) / 100,
        rotation: viewport.rotation,
        textChars: text.length,
        textPreview: previewChars > 0 ? text.slice(0, previewChars) : '',
        drawOps,
        imageOps,
        blank: text.length === 0 && drawOps === 0 && imageOps === 0,
      });
    }
    return { numPages, pagesInspected: pages.length, pages };
  } finally {
    if (document) await document.destroy().catch(() => undefined);
    else await loadingTask.destroy().catch(() => undefined);
  }
}

if (parentPort) {
  let started = false;
  parentPort.on('message', (event) => {
    if (started) return;
    const request = parseRequest(event.data);
    if (!request) return;
    started = true;
    const job =
      request.kind === 'extract'
        ? extractReviewPdfText(request.data, request.maxChars, request.maxPages)
        : inspectPdfPages(
            request.data,
            request.pages,
            request.maxPages,
            request.previewChars,
          );
    void job
      .then<ReviewPdfUtilityResponse, ReviewPdfUtilityResponse>(
        (result) => ({ kind: 'result', id: request.id, ok: true, result }),
        (error) => ({
          kind: 'result',
          id: request.id,
          ok: false,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 8_000),
        }),
      )
      .then((response) => parentPort.postMessage(response));
  });
}
