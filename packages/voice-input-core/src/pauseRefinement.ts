// A pause may complete a sentence without ASR punctuation. Subsequent requests
// require another sentence, not a spelling/punctuation revision of the same one.
// This is intentionally conservative when the provider omits all punctuation.
function sentenceCount(text: string): number {
  return text
    .split(/[。！？!?]+|\.(?=\s|$)/u)
    .filter((part) => /[\p{L}\p{N}]/u.test(part)).length;
}

export function hasAdditionalSentence(
  previous: string,
  current: string,
): boolean {
  const contentLength = (text: string) =>
    (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return (
    contentLength(current) > contentLength(previous) &&
    sentenceCount(current) > sentenceCount(previous)
  );
}

/**
 * Default per-chunk character cap for unrefined dictation tails so long
 * continuous dictations do not hit upstream `maxRefineOutputTokens` (1,024).
 */
export const DEFAULT_MAX_REFINE_CHUNK_CHARS = 600;

/**
 * Refinement requests a managed voice-server session accepts when the server
 * does not report its limit: servers from before pause-time refinement allow
 * one attempt plus one client fallback retry.
 */
export const LEGACY_MANAGED_REFINE_REQUEST_LIMIT = 2;

/** Reads `refiner.maxRefineRequests` from a voice-server session response. */
export function resolveManagedRefineRequestLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : LEGACY_MANAGED_REFINE_REQUEST_LIMIT;
}

export function endsWithSentenceBoundary(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /(?:[。！？!?…]+|\.)["”’'）】》」』]*$/u.test(trimmed);
}

/**
 * Extracts the unrefined suffix appended after `frozenRawPrefix`.
 * Returns `null` when ASR backtracked and modified `frozenRawPrefix`.
 */
export function sliceUnrefinedDelta(
  frozenRawPrefix: string,
  currentRaw: string,
): string | null {
  const normalizedCurrent = currentRaw.replace(/\s+/g, ' ').trim();
  const normalizedFrozen = frozenRawPrefix.replace(/\s+/g, ' ').trim();
  if (!normalizedFrozen) return normalizedCurrent;
  if (!normalizedCurrent.startsWith(normalizedFrozen)) return null;
  return normalizedCurrent.slice(normalizedFrozen.length).trim();
}

/**
 * Drops leading join punctuation that ASR appended onto a previously frozen
 * sentence when the frozen refined prefix already ended with punctuation
 * (e.g. frozen raw "第一句" -> refined "第一句。", later raw "第一句。第二句" ->
 * delta "。第二句" -> stripped to "第二句").
 */
export function stripLeadingJoinPunctuation(
  rawDelta: string,
  precedingRefined: string,
): string {
  const trimmed = rawDelta.trim();
  if (!trimmed || !precedingRefined.trim()) return trimmed;
  if (!/[。！？!?，,；;：:…]["”’'）】》」』]*$/u.test(precedingRefined.trim())) {
    return trimmed;
  }
  const stripped = trimmed.replace(/^[。！？!?，,；;：:、\s]+/u, '').trim();
  return /[\p{L}\p{N}]/u.test(stripped) ? stripped : trimmed;
}

/**
 * Returns the trailing 1-2 sentences of already-refined text so incremental
 * delta refinement has read-only style/term continuity without resending the
 * full dictation.
 */
export function extractRecentRefinedContext(
  cumulativeRefined: string,
  maxSentences = 2,
  maxChars = 240,
): string {
  const trimmed = cumulativeRefined.trim();
  if (!trimmed || maxSentences <= 0 || maxChars <= 0) return '';
  const sentences = trimmed
    .match(/[^。！？!?\n]+(?:[。！？!?]+|\n+|$)/gu)
    ?.map((part) => part.trim())
    .filter(Boolean) ?? [trimmed];
  const tail = sentences.slice(-maxSentences).join(' ').trim();
  if (tail.length <= maxChars) return tail;
  return tail.slice(tail.length - maxChars).trim();
}

function contentChars(text: string): string {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).join('').toLocaleLowerCase();
}

/**
 * Strips an accidental echo of the trailing suffix of `precedingRefined` from
 * the start of `nextRefined`, ONLY when the user did not actually repeat those
 * characters at the beginning of `rawDelta`.
 */
export function stripAccidentalPrecedingOverlap(
  precedingRefined: string,
  nextRefined: string,
  rawDelta?: string,
): string {
  const prev = precedingRefined.trimEnd();
  const next = nextRefined.trimStart();
  if (!prev || !next) return next;
  const maxCheck = Math.min(prev.length, next.length, 64);
  const rawHeadContent = rawDelta ? contentChars(rawDelta.slice(0, 48)) : '';
  for (let len = maxCheck; len >= 4; len -= 1) {
    const candidate = next.slice(0, len);
    if (!prev.endsWith(candidate)) continue;
    const candidateContent = contentChars(candidate);
    if (candidateContent.length < 4) continue;
    if (rawHeadContent && rawHeadContent.startsWith(candidateContent)) {
      return next;
    }
    const remainder = next.slice(len).replace(/^[ \t]+/, '');
    if (/[\p{L}\p{N}]/u.test(remainder)) {
      return remainder;
    }
  }
  return next;
}

/**
 * Joins an already-refined prefix with a newly refined incremental suffix,
 * inserting a space only across ASCII/Latin boundaries and guarding against
 * accidental context echoes.
 */
export function joinRefinedSegments(
  precedingRefined: string,
  nextRefined: string,
  rawDelta?: string,
): string {
  const prev = precedingRefined.trimEnd();
  const next = stripAccidentalPrecedingOverlap(prev, nextRefined.trimStart(), rawDelta);
  if (!prev) return next;
  if (!next) return prev;
  if (prev.endsWith('\n') || next.startsWith('\n')) return `${prev}${next}`;
  const needsSpace = /[A-Za-z0-9,.;:!?)%]$/.test(prev) && /^[A-Za-z0-9("'[]/.test(next);
  return needsSpace ? `${prev} ${next}` : `${prev}${next}`;
}

/**
 * Splits a long unrefined dictation delta into sentence-aligned chunks no
 * longer than `maxChunkChars`, so each refiner request stays comfortably inside
 * output-token limits even when the user speaks continuously without pausing.
 */
export function splitLongDeltaForRefinement(
  rawDelta: string,
  maxChunkChars = DEFAULT_MAX_REFINE_CHUNK_CHARS,
): string[] {
  const normalized = rawDelta.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChunkChars) return [normalized];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const remaining = normalized.length - cursor;
    if (remaining <= maxChunkChars) {
      const tail = normalized.slice(cursor).trim();
      if (tail) chunks.push(tail);
      break;
    }
    const windowEnd = cursor + maxChunkChars;
    const slice = normalized.slice(cursor, windowEnd);
    const minSplit = Math.floor(maxChunkChars * 0.4);
    let splitAt = -1;

    // Prefer sentence-ending punctuation, then clause punctuation, then whitespace.
    const patterns = [
      /[。！？!?]+(?=["”’'）】》」』]*)|\.(?=\s)/gu,
      /[，,;；：:、]/gu,
      /\s+/gu,
    ];
    for (const pattern of patterns) {
      let lastEnd = -1;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(slice)) !== null) {
        const end = match.index + match[0].length;
        if (end >= minSplit) lastEnd = end;
      }
      if (lastEnd >= minSplit) {
        splitAt = cursor + lastEnd;
        break;
      }
    }

    if (splitAt <= cursor) splitAt = windowEnd;
    const piece = normalized.slice(cursor, splitAt).trim();
    if (piece) chunks.push(piece);
    cursor = splitAt;
    while (cursor < normalized.length && normalized[cursor] === ' ') cursor += 1;
  }
  return chunks;
}
