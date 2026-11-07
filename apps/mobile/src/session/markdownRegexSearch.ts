/** Search the parser's fixed, non-empty global regex grammars in one immutable
 * inline body, including a separate instance for recursive marks.
 * Retain only the next raw match per grammar, not a list of all tokens. A cursor
 * inside a previous match must search again: it can expose overlapping syntax.
 * Keep raw starts (including consumed prefix groups) and the search origin;
 * rejected candidates can advance a matcher beyond the next parser cursor.
 */
export function createMarkdownRegexSearch<T = never>(input: string) {
  const pending = new Map<string, { from: number; match: RegExpExecArray | null }>();
  const searched = new Set<string>();
  const candidates = new Map<string, { from: number; through: number; value: T }>();
  let candidateThrough = Infinity;
  return {
    // Cache validation/normalization as well as the raw search. The safe reuse
    // boundary is the earliest RAW hit, including rejected hits and consumed
    // prefix groups, not the final accepted token. Moving inside that hit can
    // expose overlapping syntax; the matcher must then run again.
    next: (key: string, from: number, build: () => T): T => {
      const cached = candidates.get(key);
      if (cached && from >= cached.from && from <= cached.through) return cached.value;
      candidateThrough = Infinity;
      const value = build();
      candidates.set(key, { from, through: candidateThrough, value });
      return value;
    },
    begin: () => searched.clear(),
    exec: (regex: RegExp): RegExpExecArray | null => {
      const from = regex.lastIndex;
      const key = `${regex.source}/${regex.flags}`;
      // A grammar can reject its first hit and continue. Preserve that first hit
      // for the next parser cursor; caching the final miss would make an earlier
      // cursor rescan the entire suffix (or skip newly exposed overlapping syntax).
      if (searched.has(key)) {
        const match = regex.exec(input);
        if (match) candidateThrough = Math.min(candidateThrough, match.index);
        return match;
      }
      searched.add(key);
      let cached = pending.get(key);
      if (!cached || from < cached.from || (cached.match !== null && from > cached.match.index)) {
        cached = { from, match: regex.exec(input) };
        pending.set(key, cached);
      } else {
        // Match RegExp.exec's cursor contract, including a miss resetting to zero.
        regex.lastIndex = cached.match ? cached.match.index + cached.match[0].length : 0;
      }
      if (cached.match) candidateThrough = Math.min(candidateThrough, cached.match.index);
      return cached.match;
    },
  };
}
