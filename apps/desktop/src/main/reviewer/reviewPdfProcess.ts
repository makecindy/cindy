import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { utilityProcess } from 'electron';

import type {
  ReviewPdfInspectProcessResult,
  ReviewPdfPageInspection,
  ReviewPdfTextProcessResult,
  ReviewPdfUtilityRequest,
  ReviewPdfUtilityResponse,
} from './reviewPdfProcessProtocol.js';

export type {
  ReviewPdfInspectProcessResult,
  ReviewPdfPageInspection,
  ReviewPdfTextProcessResult,
} from './reviewPdfProcessProtocol.js';

export interface ReviewPdfUtilityChildLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'error', listener: (type: string, location: string, report: string) => void): void;
  kill(): boolean;
}

export interface ReviewPdfTextProcessOptions {
  timeoutMs: number;
  maxPages: number;
  maxInputBytes: number;
  /** Test seam; production always forks the packaged Electron utility entry. */
  fork?: () => ReviewPdfUtilityChildLike;
}

function forkReviewPdfUtilityProcess(): ReviewPdfUtilityChildLike {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return utilityProcess.fork(path.join(__dirname, 'reviewPdfUtilityProcess.js'), [], {
    serviceName: 'cindy-review-pdf-extractor',
    env,
    cwd: os.tmpdir(),
    execArgv: ['--max-old-space-size=128', '--max-semi-space-size=8'],
    stdio: 'ignore',
  });
}

function isReviewPdfTextProcessResult(
  value: unknown,
  maxChars: number,
  maxPages: number,
): value is ReviewPdfTextProcessResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.sections) &&
    record.sections.every((section) => typeof section === 'string') &&
    record.sections.join('\n\n').length <= maxChars &&
    Number.isSafeInteger(record.pagesInspected) &&
    Number(record.pagesInspected) >= 0 &&
    Number(record.pagesInspected) <= maxPages &&
    Number.isSafeInteger(record.numPages) &&
    Number(record.numPages) >= Number(record.pagesInspected) &&
    typeof record.clipped === 'boolean'
  );
}

function parseResponse(value: unknown, expectedId: string): ReviewPdfUtilityResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Partial<ReviewPdfUtilityResponse>;
  if (response.kind !== 'result' || response.id !== expectedId) return null;
  if (response.ok === false) {
    return typeof response.error === 'string' && response.error.length > 0
      ? (response as Extract<ReviewPdfUtilityResponse, { ok: false }>)
      : null;
  }
  return response.ok === true
    ? (response as Extract<ReviewPdfUtilityResponse, { ok: true }>)
    : null;
}

/**
 * 一次性子进程作业的公共骨架:fork → 发一条请求 → 收一条匹配响应 → 无论成败都 kill。
 * extract 与 inspect 共用它,超时/崩溃/退出的处理只此一份,不会两边走样。
 */
function runPdfUtilityJob<T>(
  buildRequest: (id: string) => ReviewPdfUtilityRequest,
  // 这里刻意用 boolean 而不是类型谓词:两种作业的响应是一个联合类型,谓词只会把它
  // 交叉成 `Union & T`,反而推不回调用方要的 T。真正的保证在运行期 —— validate 不
  // 通过就 reject,下面那次断言只在校验成功之后发生。
  validate: (result: unknown) => boolean,
  options: { timeoutMs: number; fork?: () => ReviewPdfUtilityChildLike },
): Promise<T> {
  const child = (options.fork ?? forkReviewPdfUtilityProcess)();
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error('PDF extraction timed out in the isolated process')));
    }, options.timeoutMs);
    timer.unref?.();

    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // The request already has an authoritative result. The utility process
        // is one-shot, and Electron may report it as gone before kill returns.
      }
      complete();
    };

    child.on('message', (message) => {
      const response = parseResponse(message, id);
      if (!response) return;
      if (!response.ok) {
        finish(() => reject(new Error(response.error.slice(0, 8_000))));
        return;
      }
      if (!validate(response.result)) {
        finish(() => reject(new Error('PDF extractor returned an invalid result')));
        return;
      }
      finish(() => resolve(response.result as T));
    });
    child.on('error', (type, location) => {
      finish(() =>
        reject(new Error(`PDF utility process failed: ${type}${location ? ` (${location})` : ''}`)),
      );
    });
    child.on('exit', (code) => {
      finish(() => reject(new Error(`PDF extractor exited with code ${String(code)}`)));
    });

    try {
      child.postMessage(buildRequest(id));
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

export async function extractReviewPdfTextInChild(
  data: Uint8Array,
  maxChars: number,
  options: ReviewPdfTextProcessOptions,
): Promise<ReviewPdfTextProcessResult> {
  if (
    !Number.isSafeInteger(maxChars) ||
    maxChars <= 0 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isSafeInteger(options.maxPages) ||
    options.maxPages <= 0 ||
    !Number.isSafeInteger(options.maxInputBytes) ||
    options.maxInputBytes <= 0 ||
    data.byteLength > options.maxInputBytes
  ) {
    throw new Error('invalid PDF extractor configuration');
  }

  return runPdfUtilityJob<ReviewPdfTextProcessResult>(
    (id) => ({
      kind: 'extract',
      id,
      data: new Uint8Array(data),
      maxInputBytes: options.maxInputBytes,
      maxChars,
      maxPages: options.maxPages,
    }),
    (result) => isReviewPdfTextProcessResult(result, maxChars, options.maxPages),
    options,
  );
}

export interface ReviewPdfInspectProcessOptions {
  timeoutMs: number;
  maxPages: number;
  maxInputBytes: number;
  previewChars: number;
  /** 要检查的页码(1 起);空数组 = 从头顺序取 maxPages 页。 */
  pages?: readonly number[];
  /** Test seam; production always forks the packaged Electron utility entry. */
  fork?: () => ReviewPdfUtilityChildLike;
}

function isReviewPdfPageInspection(value: unknown, maxPages: number): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const page = value as Record<string, unknown>;
  const nullableCount = (v: unknown): boolean =>
    v === null || (Number.isSafeInteger(v) && Number(v) >= 0);
  return (
    Number.isSafeInteger(page.page) &&
    Number(page.page) >= 1 &&
    typeof page.width === 'number' &&
    Number.isFinite(page.width) &&
    typeof page.height === 'number' &&
    Number.isFinite(page.height) &&
    Number.isSafeInteger(page.rotation) &&
    Number.isSafeInteger(page.textChars) &&
    Number(page.textChars) >= 0 &&
    typeof page.textPreview === 'string' &&
    nullableCount(page.drawOps) &&
    nullableCount(page.imageOps) &&
    typeof page.blank === 'boolean' &&
    typeof page.visibilityUnverified === 'boolean' &&
    maxPages > 0
  );
}

function isReviewPdfInspectResult(
  value: unknown,
  maxPages: number,
): value is ReviewPdfInspectProcessResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.numPages) &&
    Number(record.numPages) >= 0 &&
    Number.isSafeInteger(record.pagesInspected) &&
    Number(record.pagesInspected) >= 0 &&
    Number(record.pagesInspected) <= maxPages &&
    Array.isArray(record.pages) &&
    record.pages.length === Number(record.pagesInspected) &&
    record.pages.every((page) => isReviewPdfPageInspection(page, maxPages))
  );
}

/**
 * 读一份 PDF 的结构快照(页数/尺寸/文本量/空白判定),供 cindy_docs 的 inspect_pdf
 * 做产出自检。与文本抽取共用同一个一次性 utility process。
 */
export async function inspectPdfPagesInChild(
  data: Uint8Array,
  options: ReviewPdfInspectProcessOptions,
): Promise<ReviewPdfInspectProcessResult> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isSafeInteger(options.maxPages) ||
    options.maxPages <= 0 ||
    !Number.isSafeInteger(options.maxInputBytes) ||
    options.maxInputBytes <= 0 ||
    !Number.isSafeInteger(options.previewChars) ||
    options.previewChars < 0 ||
    data.byteLength > options.maxInputBytes
  ) {
    throw new Error('invalid PDF extractor configuration');
  }

  const pages = [...(options.pages ?? [])];
  if (!pages.every((page) => Number.isSafeInteger(page) && page >= 1)) {
    throw new Error('invalid PDF extractor configuration');
  }

  return runPdfUtilityJob<ReviewPdfInspectProcessResult>(
    (id) => ({
      kind: 'inspect',
      id,
      data: new Uint8Array(data),
      maxInputBytes: options.maxInputBytes,
      pages,
      maxPages: options.maxPages,
      previewChars: options.previewChars,
    }),
    (result) => isReviewPdfInspectResult(result, options.maxPages),
    options,
  );
}
