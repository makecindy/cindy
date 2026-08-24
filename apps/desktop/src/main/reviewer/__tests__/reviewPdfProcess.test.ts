import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  extractReviewPdfTextInChild,
  inspectPdfPagesInChild,
  type ReviewPdfUtilityChildLike,
} from '../reviewPdfProcess.js';
import type {
  ReviewPdfInspectUtilityRequest,
  ReviewPdfUtilityRequest,
} from '../reviewPdfProcessProtocol.js';

class FakePdfUtility extends EventEmitter implements ReviewPdfUtilityChildLike {
  readonly postMessage = vi.fn((message: unknown) => void message);
  readonly kill = vi.fn(() => true);
}

describe('isolated Review PDF extraction', () => {
  it('kills a non-responsive utility process instead of blocking Electron Main', async () => {
    const child = new FakePdfUtility();
    const startedAt = Date.now();

    await expect(
      extractReviewPdfTextInChild(Buffer.from('%PDF-1.4'), 1_000, {
        timeoutMs: 150,
        maxPages: 2,
        maxInputBytes: 1_024,
        fork: () => child,
      }),
    ).rejects.toThrow('timed out');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('accepts only the matching bounded response and terminates the one-shot child', async () => {
    const child = new FakePdfUtility();
    child.postMessage.mockImplementationOnce((message) => {
      const request = message as ReviewPdfUtilityRequest;
      queueMicrotask(() => {
        child.emit('message', {
          kind: 'result',
          id: request.id,
          ok: true,
          result: {
            sections: ['--- 第 1 页 ---\nTerms'],
            pagesInspected: 1,
            numPages: 1,
            clipped: false,
          },
        });
      });
    });

    await expect(
      extractReviewPdfTextInChild(Buffer.from('%PDF-1.4'), 1_000, {
        timeoutMs: 1_000,
        maxPages: 2,
        maxInputBytes: 1_024,
        fork: () => child,
      }),
    ).resolves.toMatchObject({ sections: ['--- 第 1 页 ---\nTerms'], pagesInspected: 1 });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

// inspect 与 extract 共用同一个一次性进程(同一个 forge entry,pdfjs 只打包一份),
// 所以超时/崩溃/kill 的语义必须完全一致 —— 这组用例守住这一点。
describe('isolated PDF structure inspection', () => {
  it('把页码与上限透传给子进程,并接收结构结果', async () => {
    const child = new FakePdfUtility();
    let sent: ReviewPdfInspectUtilityRequest | undefined;
    child.postMessage.mockImplementationOnce((message) => {
      sent = message as ReviewPdfInspectUtilityRequest;
      queueMicrotask(() => {
        child.emit('message', {
          kind: 'result',
          id: sent!.id,
          ok: true,
          result: {
            numPages: 3,
            pagesInspected: 1,
            pages: [
              {
                page: 2,
                width: 595.28,
                height: 841.89,
                rotation: 0,
                textChars: 0,
                textPreview: '',
                drawOps: 0,
                imageOps: 0,
                blank: true,
                visibilityUnverified: false,
              },
            ],
          },
        });
      });
    });

    await expect(
      inspectPdfPagesInChild(Buffer.from('%PDF-1.4'), {
        timeoutMs: 1_000,
        maxPages: 5,
        maxInputBytes: 1_024,
        previewChars: 100,
        pages: [2],
        fork: () => child,
      }),
    ).resolves.toMatchObject({ numPages: 3, pagesInspected: 1 });

    expect(sent).toMatchObject({ kind: 'inspect', pages: [2], maxPages: 5, previewChars: 100 });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('形状不合法的结果按失败处理,不把脏数据交上去', async () => {
    const child = new FakePdfUtility();
    child.postMessage.mockImplementationOnce((message) => {
      const request = message as ReviewPdfUtilityRequest;
      queueMicrotask(() => {
        child.emit('message', {
          kind: 'result',
          id: request.id,
          ok: true,
          // pagesInspected 与 pages.length 对不上 —— 校验必须拦下来。
          result: { numPages: 2, pagesInspected: 2, pages: [] },
        });
      });
    });

    await expect(
      inspectPdfPagesInChild(Buffer.from('%PDF-1.4'), {
        timeoutMs: 1_000,
        maxPages: 5,
        maxInputBytes: 1_024,
        previewChars: 100,
        fork: () => child,
      }),
    ).rejects.toThrow('invalid result');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('无响应的子进程照样被超时 kill', async () => {
    const child = new FakePdfUtility();
    await expect(
      inspectPdfPagesInChild(Buffer.from('%PDF-1.4'), {
        timeoutMs: 120,
        maxPages: 5,
        maxInputBytes: 1_024,
        previewChars: 100,
        fork: () => child,
      }),
    ).rejects.toThrow('timed out');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('超出字节上限在 fork 之前就被拒', async () => {
    const fork = vi.fn(() => new FakePdfUtility());
    await expect(
      inspectPdfPagesInChild(Buffer.alloc(2_048), {
        timeoutMs: 1_000,
        maxPages: 5,
        maxInputBytes: 1_024,
        previewChars: 100,
        fork,
      }),
    ).rejects.toThrow('invalid PDF extractor configuration');
    expect(fork).not.toHaveBeenCalled();
  });
});
