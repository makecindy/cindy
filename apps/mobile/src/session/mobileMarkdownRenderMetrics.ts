import type { MobileMarkdownParseResult } from '@/session/messageMarkdown';

/** DEV/perf-harness counters for Markdown parsing and list item allocation. */
export interface MobileMarkdownRenderMetrics {
  fullParseCount: number;
  incrementalParseCount: number;
  reusedBlockCount: number;
  parsedSourceUtf16Length: number;
  parseDurationMsTotal: number;
  parseDurationMsMax: number;
  renderItemRebuildCount: number;
}

const metrics: MobileMarkdownRenderMetrics = {
  fullParseCount: 0,
  incrementalParseCount: 0,
  reusedBlockCount: 0,
  parsedSourceUtf16Length: 0,
  parseDurationMsTotal: 0,
  parseDurationMsMax: 0,
  renderItemRebuildCount: 0,
};

export function recordMobileMarkdownParse(
  result: Pick<MobileMarkdownParseResult, 'incremental' | 'reusedBlockCount' | 'parsedSourceUtf16Length'>,
  durationMs: number,
): void {
  if (result.incremental) metrics.incrementalParseCount += 1;
  else metrics.fullParseCount += 1;
  metrics.reusedBlockCount += result.reusedBlockCount;
  metrics.parsedSourceUtf16Length += result.parsedSourceUtf16Length;
  metrics.parseDurationMsTotal += Math.max(0, durationMs);
  metrics.parseDurationMsMax = Math.max(metrics.parseDurationMsMax, Math.max(0, durationMs));
}

export function recordMobileMessageRenderItem(): void {
  metrics.renderItemRebuildCount += 1;
}

export function getMobileMarkdownRenderMetrics(): MobileMarkdownRenderMetrics {
  return { ...metrics };
}

/** Test/perf-harness reset; production behavior does not depend on these counters. */
export function resetMobileMarkdownRenderMetrics(): void {
  metrics.fullParseCount = 0;
  metrics.incrementalParseCount = 0;
  metrics.reusedBlockCount = 0;
  metrics.parsedSourceUtf16Length = 0;
  metrics.parseDurationMsTotal = 0;
  metrics.parseDurationMsMax = 0;
  metrics.renderItemRebuildCount = 0;
}
