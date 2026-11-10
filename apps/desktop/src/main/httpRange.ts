export type RangeParseResult =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' }
  | null;

/** Parse `Range: bytes=START-END` (single range only). Tagged union so the
 *  handler can split 206 / 416 / 200 cleanly:
 *    - null              → header absent or malformed → caller serves 200
 *    - {kind:'range'}    → caller serves 206 with the slice
 *    - {kind:'unsatisfiable'} → caller serves 416
 *  Shared by the desktop media protocols and the background HTTP service. */
export function parseRangeHeader(
  headerValue: string | null,
  totalSize: number,
): RangeParseResult {
  if (!headerValue) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(headerValue.trim());
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  let start: number;
  let end: number;
  if (startStr === '' && endStr !== '') {
    // Suffix range: last N bytes.
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    if (totalSize === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else if (startStr !== '') {
    start = parseInt(startStr, 10);
    end = endStr === '' ? totalSize - 1 : parseInt(endStr, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  } else {
    return null;
  }
  if (start > end || start >= totalSize || end >= totalSize) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'range', start, end };
}

