export type TextTargetWatchRange = {
  start: number;
  end: number;
  touchedTrailingEdge?: boolean;
};

export type TextTargetWatchMapResult =
  | { status: 'unchanged'; start: number; end: number; touchedTrailingEdge: boolean }
  | { status: 'updated'; start: number; end: number; touchedTrailingEdge: boolean; text: string }
  | { status: 'cleared' }
  | { status: 'lost' };

const SENTENCE_END_PUNCTUATION = /[。！？.!?\n]/;
const BOUNDARY_ABSORB_SLACK = 2;

/**
 * Maps a tracked voice-inserted string slice across a controlled input value
 * change (`prevFullText` -> `nextFullText`) without relying on ProseMirror
 * transactions.
 */
export function mapTextTargetWatchRange(
  prevFullText: string,
  nextFullText: string,
  range: TextTargetWatchRange,
): TextTargetWatchMapResult {
  const touchedBefore = Boolean(range.touchedTrailingEdge);
  if (prevFullText === nextFullText) {
    return {
      status: 'unchanged',
      start: range.start,
      end: range.end,
      touchedTrailingEdge: touchedBefore,
    };
  }
  if (!nextFullText) {
    return { status: 'cleared' };
  }

  const start = Math.max(0, Math.min(range.start, prevFullText.length));
  const end = Math.max(start, Math.min(range.end, prevFullText.length));

  let prefix = 0;
  const maxPrefix = Math.min(prevFullText.length, nextFullText.length);
  while (prefix < maxPrefix && prevFullText[prefix] === nextFullText[prefix]) {
    prefix += 1;
  }

  let prevEnd = prevFullText.length;
  let nextEnd = nextFullText.length;
  while (
    prevEnd > prefix &&
    nextEnd > prefix &&
    prevFullText[prevEnd - 1] === nextFullText[nextEnd - 1]
  ) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  const delta = nextEnd - prevEnd;

  // Edit strictly before the segment (or pure insertion right before `start`):
  // shift the range without marking the segment edited.
  if (prevEnd <= start) {
    return {
      status: 'unchanged',
      start: start + delta,
      end: end + delta,
      touchedTrailingEdge: touchedBefore,
    };
  }

  // Edit strictly after the segment.
  if (prefix > end) {
    return {
      status: 'unchanged',
      start,
      end,
      touchedTrailingEdge: touchedBefore,
    };
  }

  // Pure insertion right at `end` (e.g. completing a truncated trailing word or
  // retyping after backspacing the end of the segment).
  if (prefix === end && prevEnd === end) {
    const inserted = nextFullText.slice(prefix, nextEnd);
    const prevChar = end > start ? prevFullText[end - 1] : '';
    const shouldAbsorb =
      inserted.length > 0 &&
      !inserted.includes('\n') &&
      (touchedBefore || (!SENTENCE_END_PUNCTUATION.test(prevChar) && !/^\s/.test(inserted)));
    if (shouldAbsorb) {
      const nextRangeEnd = end + delta;
      return {
        status: 'updated',
        start,
        end: nextRangeEnd,
        touchedTrailingEdge: true,
        text: nextFullText.slice(start, nextRangeEnd),
      };
    }
    return {
      status: 'unchanged',
      start,
      end,
      touchedTrailingEdge: false,
    };
  }

  // Edit contained inside [start, end].
  if (prefix >= start && prevEnd <= end) {
    const nextRangeEnd = end + delta;
    const text = nextFullText.slice(start, nextRangeEnd);
    if (!text) return { status: 'cleared' };
    return {
      status: 'updated',
      start,
      end: nextRangeEnd,
      touchedTrailingEdge: prevEnd === end || touchedBefore,
      text,
    };
  }

  // Edit encompasses the entire tracked segment plus surrounding text.
  if (prefix < start && prevEnd >= end) {
    if (nextEnd === prefix) return { status: 'cleared' };
    return { status: 'lost' };
  }

  // Edit crosses the left boundary.
  if (prefix < start && prevEnd > start && prevEnd < end) {
    const nextRangeStart = start - prefix <= BOUNDARY_ABSORB_SLACK ? prefix : nextEnd;
    const nextRangeEnd = end + delta;
    if (nextRangeEnd <= nextRangeStart) return { status: 'cleared' };
    return {
      status: 'updated',
      start: nextRangeStart,
      end: nextRangeEnd,
      touchedTrailingEdge: touchedBefore,
      text: nextFullText.slice(nextRangeStart, nextRangeEnd),
    };
  }

  // Edit crosses the right boundary.
  const nextRangeEnd = prevEnd - end <= BOUNDARY_ABSORB_SLACK ? nextEnd : prefix;
  if (nextRangeEnd <= start) return { status: 'cleared' };
  return {
    status: 'updated',
    start,
    end: nextRangeEnd,
    touchedTrailingEdge: true,
    text: nextFullText.slice(start, nextRangeEnd),
  };
}
