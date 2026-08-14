import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  extractReviewPdfTextInChild,
  type ReviewPdfUtilityChildLike,
} from '../reviewPdfProcess.js';
import type { ReviewPdfUtilityRequest } from '../reviewPdfProcessProtocol.js';

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
