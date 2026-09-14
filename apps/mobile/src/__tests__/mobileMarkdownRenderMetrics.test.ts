import { beforeEach, describe, expect, it } from 'vitest';
import { parseMobileMarkdownDocument } from '@/session/messageMarkdown';
import {
  getMobileMarkdownRenderMetrics,
  recordMobileMarkdownParse,
  recordMobileMessageRenderItem,
  resetMobileMarkdownRenderMetrics,
} from '@/session/mobileMarkdownRenderMetrics';

describe('mobile Markdown/render metrics', () => {
  beforeEach(() => resetMobileMarkdownRenderMetrics());

  it('separates full and incremental parses and accumulates allocation counters', () => {
    const full = parseMobileMarkdownDocument('one');
    const incremental = { ...full, incremental: true, reusedBlockCount: 1, parsedSourceUtf16Length: 4 };

    recordMobileMarkdownParse(full, 2.5);
    recordMobileMarkdownParse(incremental, 1.25);
    recordMobileMessageRenderItem();
    recordMobileMessageRenderItem();

    expect(getMobileMarkdownRenderMetrics()).toEqual({
      fullParseCount: 1,
      incrementalParseCount: 1,
      reusedBlockCount: 1,
      parsedSourceUtf16Length: 7,
      parseDurationMsTotal: 3.75,
      parseDurationMsMax: 2.5,
      renderItemRebuildCount: 2,
    });
  });
});
