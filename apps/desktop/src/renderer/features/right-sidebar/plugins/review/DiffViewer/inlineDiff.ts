import { diffWordsWithSpace } from 'diff';

import type { Hunk } from '@/lib/gitReview.types';
import { HIGHLIGHT_MAX_LINE_LENGTH, highlightLineKey, LruCache } from './highlight';
import { buildPairedChangedLinesForHunk } from './diffRows';

export type InlineDiffSide = 'add' | 'delete';

export interface InlineDiffRange {
  start: number;
  end: number;
}

export interface InlineDiffPair {
  deleteRanges: InlineDiffRange[];
  addRanges: InlineDiffRange[];
}

interface InlineDiffOptions {
  maxLineLength?: number;
  minCommonRatio?: number;
}

export const INLINE_DIFF_MIN_COMMON_RATIO = 0.3;
// Inline word diffing is synchronous. Keep it away from medium whole-file
// rewrites even when an existing task has the legacy word-diff default enabled.
export const INLINE_DIFF_MAX_PAIR_COUNT = 150;
export const INLINE_DIFF_MAX_TOTAL_CHARS = 200_000;

const inlineDiffCache = new LruCache<string, InlineDiffPair | null>(2000);
const inlineHtmlCache = new LruCache<string, string>(2000);
const INLINE_DIFF_CLASSES: Record<InlineDiffSide, string> = {
  add: 'rounded-[2px] bg-[var(--diff-add-emphasis)]',
  delete: 'rounded-[2px] bg-[var(--diff-del-emphasis)]',
};

export function computeInlineDiffRanges(
  oldText: string,
  newText: string,
  options: InlineDiffOptions = {},
): InlineDiffPair | null {
  const maxLineLength = options.maxLineLength ?? HIGHLIGHT_MAX_LINE_LENGTH;
  const minCommonRatio = options.minCommonRatio ?? INLINE_DIFF_MIN_COMMON_RATIO;
  const cacheKey = `${maxLineLength}\0${minCommonRatio}\0${oldText}\0${newText}`;
  const cached = inlineDiffCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = computeInlineDiffRangesUncached(oldText, newText, { maxLineLength, minCommonRatio });
  inlineDiffCache.set(cacheKey, result);
  return result;
}

export function computeInlineDiffRangesUncached(
  oldText: string,
  newText: string,
  options: Required<InlineDiffOptions>,
): InlineDiffPair | null {
  if (oldText.length === 0 || newText.length === 0) return null;
  if (oldText.length > options.maxLineLength || newText.length > options.maxLineLength) return null;
  if (oldText === newText) return null;

  const changes = diffWordsWithSpace(oldText, newText, { timeout: 20 });
  if (!changes) return null;

  const deleteRanges: InlineDiffRange[] = [];
  const addRanges: InlineDiffRange[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  let commonLength = 0;

  for (const change of changes) {
    const length = change.value.length;
    if (change.removed) {
      deleteRanges.push({ start: oldOffset, end: oldOffset + length });
      oldOffset += length;
    } else if (change.added) {
      addRanges.push({ start: newOffset, end: newOffset + length });
      newOffset += length;
    } else {
      commonLength += length;
      oldOffset += length;
      newOffset += length;
    }
  }

  const commonRatio = commonLength / Math.max(oldText.length, newText.length);
  if (commonRatio < options.minCommonRatio) return null;

  const mergedDeleteRanges = mergeInlineDiffRanges(deleteRanges, oldText.length);
  const mergedAddRanges = mergeInlineDiffRanges(addRanges, newText.length);
  if (mergedDeleteRanges.length === 0 && mergedAddRanges.length === 0) return null;
  return {
    deleteRanges: mergedDeleteRanges,
    addRanges: mergedAddRanges,
  };
}

export function mergeInlineDiffRanges(
  ranges: readonly InlineDiffRange[],
  contentLength = Number.POSITIVE_INFINITY,
): InlineDiffRange[] {
  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, contentLength)),
      end: Math.max(0, Math.min(range.end, contentLength)),
    }))
    .filter((range) => range.start < range.end)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: InlineDiffRange[] = [];
  for (const range of normalized) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function collectInlineDiffRanges(hunks: readonly Hunk[]): Map<string, InlineDiffRange[]> {
  const out = new Map<string, InlineDiffRange[]>();
  if (shouldSkipInlineDiffCollection(hunks)) return out;
  for (const hunk of hunks) {
    for (const pair of buildPairedChangedLinesForHunk(hunk)) {
      if (!pair.deleteLine || !pair.addLine) continue;
      const inlineDiff = computeInlineDiffRanges(pair.deleteLine.content, pair.addLine.content);
      if (!inlineDiff) continue;
      if (inlineDiff.deleteRanges.length > 0) {
        out.set(highlightLineKey(hunk.index, pair.deleteLine.index), inlineDiff.deleteRanges);
      }
      if (inlineDiff.addRanges.length > 0) {
        out.set(highlightLineKey(hunk.index, pair.addLine.index), inlineDiff.addRanges);
      }
    }
  }
  return out;
}

export function shouldSkipInlineDiffCollection(hunks: readonly Hunk[]): boolean {
  let pairCount = 0;
  let totalChars = 0;
  for (const hunk of hunks) {
    for (const pair of buildPairedChangedLinesForHunk(hunk)) {
      if (!pair.deleteLine || !pair.addLine) continue;
      pairCount += 1;
      totalChars += pair.deleteLine.content.length + pair.addLine.content.length;
      if (pairCount > INLINE_DIFF_MAX_PAIR_COUNT || totalChars > INLINE_DIFF_MAX_TOTAL_CHARS) return true;
    }
  }
  return false;
}

export function renderInlineDiffHtml({
  content,
  html,
  ranges,
  side,
}: {
  content: string;
  html?: string;
  ranges: readonly InlineDiffRange[];
  side: InlineDiffSide;
}): string {
  const normalizedRanges = mergeInlineDiffRanges(ranges, content.length);
  if (normalizedRanges.length === 0) return html ?? escapeHtml(content);

  const cacheKey = `${side}\0${content}\0${html ?? ''}\0${rangeFingerprint(normalizedRanges)}`;
  const cached = inlineHtmlCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let rendered: string;
  try {
    rendered = html ? renderHighlightedInlineDiffHtml(content, html, normalizedRanges, side) : renderPlainInlineDiffHtml(content, normalizedRanges, side);
  } catch {
    rendered = renderPlainInlineDiffHtml(content, normalizedRanges, side);
  }
  inlineHtmlCache.set(cacheKey, rendered);
  return rendered;
}

function renderHighlightedInlineDiffHtml(
  content: string,
  html: string,
  ranges: readonly InlineDiffRange[],
  side: InlineDiffSide,
): string {
  if (typeof document === 'undefined') {
    return renderPlainInlineDiffHtml(content, ranges, side);
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  if (template.content.textContent !== content) {
    throw new Error('highlighted inline diff content mismatch');
  }

  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(
    template.content,
    typeof NodeFilter === 'undefined' ? 4 : NodeFilter.SHOW_TEXT,
  );
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }

  let offset = 0;
  for (const textNode of textNodes) {
    const text = textNode.data;
    const start = offset;
    const end = start + text.length;
    offset = end;

    const overlapping = ranges.filter((range) => range.start < end && range.end > start);
    if (overlapping.length === 0) continue;

    const fragment = document.createDocumentFragment();
    let localOffset = 0;
    for (const range of overlapping) {
      const localStart = Math.max(range.start - start, 0);
      const localEnd = Math.min(range.end - start, text.length);
      if (localStart > localOffset) {
        fragment.append(document.createTextNode(text.slice(localOffset, localStart)));
      }
      fragment.append(createInlineDiffSpan(text.slice(localStart, localEnd), side));
      localOffset = localEnd;
    }
    if (localOffset < text.length) {
      fragment.append(document.createTextNode(text.slice(localOffset)));
    }
    textNode.replaceWith(fragment);
  }

  return template.innerHTML;
}

function renderPlainInlineDiffHtml(
  content: string,
  ranges: readonly InlineDiffRange[],
  side: InlineDiffSide,
): string {
  let html = '';
  let offset = 0;
  for (const range of ranges) {
    if (range.start > offset) {
      html += escapeHtml(content.slice(offset, range.start));
    }
    html += `<span data-review-inline-diff="${side}" class="${INLINE_DIFF_CLASSES[side]}">${escapeHtml(content.slice(range.start, range.end))}</span>`;
    offset = range.end;
  }
  if (offset < content.length) {
    html += escapeHtml(content.slice(offset));
  }
  return html;
}

function createInlineDiffSpan(text: string, side: InlineDiffSide): HTMLSpanElement {
  const span = document.createElement('span');
  span.dataset.reviewInlineDiff = side;
  span.className = INLINE_DIFF_CLASSES[side];
  span.textContent = text;
  return span;
}

function rangeFingerprint(ranges: readonly InlineDiffRange[]): string {
  return ranges.map((range) => `${range.start}:${range.end}`).join(',');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
