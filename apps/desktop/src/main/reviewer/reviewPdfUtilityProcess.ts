/** One-shot packaged Electron utility process for bounded PDF text extraction. */

// PDF.js uses a fake worker under Node and otherwise loads `./pdf.worker.mjs`
// with a variable dynamic import. Forge/Vite cannot discover or copy that
// sibling into the packaged `.vite/build` directory. Importing it here both
// bundles the worker implementation and initializes `globalThis.pdfjsWorker`,
// so the fake worker never depends on an unshipped runtime file.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import type {
  ReviewPdfTextProcessResult,
  ReviewPdfUtilityRequest,
  ReviewPdfUtilityResponse,
} from './reviewPdfProcessProtocol.js';

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

function parseRequest(value: unknown): ReviewPdfUtilityRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Partial<ReviewPdfUtilityRequest>;
  if (
    request.kind !== 'extract' ||
    typeof request.id !== 'string' ||
    request.id.length === 0 ||
    !(request.data instanceof Uint8Array) ||
    !Number.isSafeInteger(request.maxInputBytes) ||
    Number(request.maxInputBytes) <= 0 ||
    request.data.byteLength > Number(request.maxInputBytes) ||
    !Number.isSafeInteger(request.maxChars) ||
    Number(request.maxChars) <= 0 ||
    !Number.isSafeInteger(request.maxPages) ||
    Number(request.maxPages) <= 0
  ) {
    return null;
  }
  return request as ReviewPdfUtilityRequest;
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

if (parentPort) {
  let started = false;
  parentPort.on('message', (event) => {
    if (started) return;
    const request = parseRequest(event.data);
    if (!request) return;
    started = true;
    void extractReviewPdfText(request.data, request.maxChars, request.maxPages)
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
