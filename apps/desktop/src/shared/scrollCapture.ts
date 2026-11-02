import type { RegionScreenshotBitmap } from './regionScreenshot';

export type ScrollMatch =
  | { kind: 'same' | 'unmatched' }
  | { kind: 'append' | 'prepend'; offset: number; header: number; footer: number };

const COLUMNS = 24;
// Copy the exact columns used by matching into contiguous rows once. Searching
// every offset in a full-resolution bitmap otherwise repeatedly touches distant
// cache lines (and does the same work again for reverse scrolling).
function sampleColumns(frame: RegionScreenshotBitmap, contrast = false): RegionScreenshotBitmap {
  const columns = Array.from({ length: COLUMNS }, (_, column) => Math.floor(frame.width * (0.05 + (column / (COLUMNS - 1)) * 0.9)));
  const data = new Uint8Array(frame.height * COLUMNS * 4);
  for (let y = 0; y < frame.height; y++) {
    for (let column = 0; column < COLUMNS; column++) {
      const from = (y * frame.width + columns[column]) * 4;
      const to = (y * COLUMNS + column) * 4;
      data[to] = frame.data[from];
      data[to + 1] = frame.data[from + 1];
      data[to + 2] = frame.data[from + 2];
      if (contrast) {
        // A fixed wallpaper can sit underneath moving, translucent text. Remove
        // the local background in matching features only; exported pixels stay
        // untouched. Nine horizontal pixels retain glyph detail while suppressing
        // smooth background gradients. Centre signed contrast in the byte range.
        for (let channel = 0; channel < 3; channel++) {
          let background = 0;
          for (let dx = -4; dx <= 4; dx++) {
            const x = Math.max(0, Math.min(frame.width - 1, columns[column] + dx));
            background += frame.data[(y * frame.width + x) * 4 + channel];
          }
          data[to + channel] = Math.round(128 + (frame.data[from + channel] - background / 9) / 2);
        }
      }
    }
  }
  return { width: COLUMNS, height: frame.height, data };
}

const errorAt = (a: RegionScreenshotBitmap, b: RegionScreenshotBitmap, ay: number, by: number, columns: readonly number[]) => {
  let error = 0;
  const aRow = ay * a.width * 4;
  const bRow = by * b.width * 4;
  for (const x of columns) {
    const ai = aRow + x * 4;
    const bi = bRow + x * 4;
    error += Math.abs(a.data[ai] - b.data[bi]);
    error += Math.abs(a.data[ai + 1] - b.data[bi + 1]);
    error += Math.abs(a.data[ai + 2] - b.data[bi + 2]);
  }
  return error / (columns.length * 3);
};

/** Find downward scrolling with overlap; ambiguous/repeated content is never appended. */
export function matchScrollFrames(previous: RegionScreenshotBitmap, next: RegionScreenshotBitmap, allowReverse = true): ScrollMatch {
  if (previous.width !== next.width || previous.height !== next.height || previous.height < 32) return { kind: 'unmatched' };
  const colour = matchSampledFrames(sampleColumns(previous), sampleColumns(next), allowReverse);
  if (colour.kind !== 'unmatched') return colour;
  // Retry rejected colour matches using local contrast, with the same independent
  // columns, overlap, ambiguity and full-row checks. Do not relax the confidence
  // thresholds or replace the anchor with an unverified frame after a mismatch.
  const detail = matchSampledFrames(sampleColumns(previous, true), sampleColumns(next, true), allowReverse);
  return detail.kind === 'append' || detail.kind === 'prepend' ? detail : colour;
}

function matchSampledFrames(previous: RegionScreenshotBitmap, next: RegionScreenshotBitmap, allowReverse: boolean): ScrollMatch {
  const height = previous.height;
  // Stationary side panes and margins do not vote against content that moved.
  // Require several independent columns so a blinking caret cannot become a scroll.
  const allColumns = Array.from({ length: COLUMNS }, (_, column) => column);
  const columns = allColumns.filter((x) => {
    let error = 0;
    for (let y = 0; y < height; y++) error += errorAt(previous, next, y, y, [x]);
    return error / height > 3;
  });
  // A caret/hover repaint is not evidence of scrolling. Keep the accepted anchor
  // until enough independent columns move; do not turn local activity into loss.
  if (columns.length < 3) {
    const changedRows = Array.from({ length: height }, (_, y) => y).filter((y) => errorAt(previous, next, y, y, allColumns) >= 2);
    const localRepaint = !changedRows.length || changedRows[changedRows.length - 1] - changedRows[0] + 1 <= Math.max(16, height * 0.1);
    return { kind: localRepaint ? 'same' : 'unmatched' };
  }
  const rowErrors = Array.from({ length: height }, (_, y) => errorAt(previous, next, y, y, columns));
  if (rowErrors.every((error) => error < 2)) return { kind: 'same' };
  const mostlyStationary = rowErrors.filter((error) => error < 2).length / height >= 0.9;
  let header = 0;
  let footer = 0;
  const fixedLimit = Math.floor(height / 3);
  while (header < fixedLimit && rowErrors[header] < 2) header++;
  while (footer < fixedLimit && rowErrors[height - 1 - footer] < 2) footer++;
  const end = height - footer;
  const minimumOverlap = Math.max(24, Math.floor((end - header) * 0.2));
  const candidates: Array<{ offset: number; score: number }> = [];
  let bestScore = Infinity;
  const maximumOffset = end - header - minimumOverlap;
  // Compare both directions and zero motion. Otherwise a reverse scroll through
  // similar paragraphs can masquerade as a weaker forward match and duplicate text.
  for (let offset = -maximumOffset; offset <= maximumOffset; offset++) {
    const start = header + Math.max(0, -offset);
    const overlap = end - header - Math.abs(offset);
    const rows = Math.min(48, overlap);
    let sum = 0;
    for (let sample = 0; sample < rows; sample++) {
      const y = start + Math.floor((sample / rows) * overlap);
      sum += errorAt(previous, next, y + offset, y, columns);
      // Errors are nonnegative: this partial mean is a lower bound. An accepted
      // score is <= 3 and its largest ambiguity margin is 1.5, so a candidate
      // already above 4.5 cannot win or invalidate any accepted match. Prune it
      // even before finding a winner (especially valuable for unrelated frames).
      // Keep full scores for mostly-stationary frames: their zero-motion winner
      // may intentionally be accepted above 3, so its ordering still matters.
      const cutoff = bestScore <= 3 ? bestScore + Math.max(0.15, bestScore * 0.5)
        : mostlyStationary ? Infinity : 4.5;
      if (sum / rows > cutoff) break;
    }
    const score = sum / rows;
    candidates.push({ offset, score });
    bestScore = Math.min(bestScore, score);
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (best?.offset < 0 && allowReverse) {
    const reverse = matchSampledFrames(next, previous, false);
    return reverse.kind === 'append' ? { ...reverse, kind: 'prepend', offset: -reverse.offset } : { kind: 'unmatched' };
  }
  if (best?.offset === 0 && (best.score <= 3 || mostlyStationary)) return { kind: 'same' };
  if (!best || best.offset <= 0 || best.score > 3) return { kind: 'unmatched' };
  const rival = candidates.find((candidate) => Math.abs(candidate.offset - best.offset) > 2);
  // White space dilutes the mean error on text pages. Compare relative confidence:
  // an exact overlap must beat a similar-looking neighbouring paragraph, while
  // genuinely repeated content (two equally good offsets) remains ambiguous.
  if (rival && rival.score < best.score + Math.max(0.15, best.score * 0.5)) return { kind: 'unmatched' };
  // Validate every row, rather than trusting the sparse search on repeated text.
  let good = 0;
  let sum = 0;
  for (let y = header; y < end - best.offset; y++) {
    const error = errorAt(previous, next, y + best.offset, y, columns);
    sum += error;
    if (error < 10) good++;
  }
  const count = end - header - best.offset;
  if (sum / count > 6 || good / count < 0.9) return { kind: 'unmatched' };
  return { kind: 'append', offset: best.offset, header, footer };
}

/** Owns only accepted frames. Failed matching keeps the last accepted anchor intact. */
export class ScrollCapture {
  private previous: RegionScreenshotBitmap;
  private parts: Uint8Array<ArrayBuffer>[];
  private rows: number;
  private position = 0;
  private top = 0;
  private bottom = 0;

  constructor(first: RegionScreenshotBitmap, private readonly maxPixels = 32_000_000) {
    this.previous = first;
    this.parts = [first.data];
    this.rows = first.height;
  }

  get height(): number { return this.rows; }

  add(frame: RegionScreenshotBitmap): ScrollMatch['kind'] | 'limit' {
    const match = matchScrollFrames(this.previous, frame);
    if (match.kind !== 'append' && match.kind !== 'prepend') return match.kind;
    const position = this.position + match.offset;
    const before = Math.max(0, this.top - position);
    const after = Math.max(0, position - this.bottom);
    const extension = before + after;
    if (this.rows + extension > 32_768 || (this.rows + extension) * frame.width > this.maxPixels) return 'limit';
    this.position = position;
    this.previous = frame;
    // Revisiting an already captured part moves the anchor, without duplicating it.
    if (!extension) return 'same';
    // The previous footer becomes stale; keep it exactly once at the final bottom.
    const stride = frame.width * 4;
    const remove = before ? match.header : match.footer;
    if (remove) {
      let remaining = remove * stride;
      while (remaining && this.parts.length) {
        const last = (before ? this.parts.shift() : this.parts.pop())!;
        if (last.length > remaining) {
          if (before) this.parts.unshift(last.subarray(remaining));
          else this.parts.push(last.subarray(0, last.length - remaining));
          remaining = 0;
        } else remaining -= last.length;
      }
      this.rows -= remove;
    }
    const added = extension + remove;
    if (before) this.parts.unshift(frame.data.slice(0, added * stride));
    else this.parts.push(frame.data.slice((frame.height - added) * stride));
    this.rows += added;
    this.top = Math.min(this.top, position);
    this.bottom = Math.max(this.bottom, position);
    return before ? 'prepend' : 'append';
  }

  /** Preview reads only its visible rows; full export is assembled on demand. */
  image(start = 0, count = this.rows): RegionScreenshotBitmap {
    start = Math.max(0, Math.min(this.rows, Math.floor(start)));
    const height = Math.max(0, Math.min(this.rows - start, Math.ceil(count)));
    const stride = this.previous.width * 4;
    const data = new Uint8Array(height * stride);
    const from = start * stride, to = from + data.length;
    let offset = 0;
    for (const part of this.parts) {
      const left = Math.max(from, offset), right = Math.min(to, offset + part.length);
      if (right > left) data.set(part.subarray(left - offset, right - offset), left - from);
      offset += part.length;
      if (offset >= to) break;
    }
    return { width: this.previous.width, height, data };
  }
}
