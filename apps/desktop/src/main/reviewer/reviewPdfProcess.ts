import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { utilityProcess } from 'electron';

import type {
  ReviewPdfTextProcessResult,
  ReviewPdfUtilityRequest,
  ReviewPdfUtilityResponse,
} from './reviewPdfProcessProtocol.js';

export type { ReviewPdfTextProcessResult } from './reviewPdfProcessProtocol.js';

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

  const child = (options.fork ?? forkReviewPdfUtilityProcess)();
  const id = randomUUID();
  return new Promise<ReviewPdfTextProcessResult>((resolve, reject) => {
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
      if (!isReviewPdfTextProcessResult(response.result, maxChars, options.maxPages)) {
        finish(() => reject(new Error('PDF extractor returned an invalid result')));
        return;
      }
      finish(() => resolve(response.result));
    });
    child.on('error', (type, location) => {
      finish(() =>
        reject(new Error(`PDF utility process failed: ${type}${location ? ` (${location})` : ''}`)),
      );
    });
    child.on('exit', (code) => {
      finish(() => reject(new Error(`PDF extractor exited with code ${String(code)}`)));
    });

    const request: ReviewPdfUtilityRequest = {
      kind: 'extract',
      id,
      data: new Uint8Array(data),
      maxInputBytes: options.maxInputBytes,
      maxChars,
      maxPages: options.maxPages,
    };
    try {
      child.postMessage(request);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
