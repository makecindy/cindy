/** Search the parser's fixed, non-empty global regex grammars in one immutable
 * inline body, including a separate instance for recursive marks.
 * Retain only the next raw match per grammar, not a list of all tokens. A cursor
 * inside a previous match must search again: it can expose overlapping syntax.
 * Keep raw starts (including consumed prefix groups) and the search origin;
 * rejected candidates can advance a matcher beyond the next parser cursor.
 */
export function createMarkdownRegexSearch(input: string) {
  const pending = new Map<string, { from: number; match: RegExpExecArray | null }>();
  const searched = new Set<string>();
  return {
    begin: () => searched.clear(),
    exec: (regex: RegExp): RegExpExecArray | null => {
      const from = regex.lastIndex;
      const key = `${regex.source}/${regex.flags}`;
      // A grammar can reject its first hit and continue. Preserve that first hit
      // for the next parser cursor; caching the final miss would make an earlier
      // cursor rescan the entire suffix (or skip newly exposed overlapping syntax).
      if (searched.has(key)) return regex.exec(input);
      searched.add(key);
      let cached = pending.get(key);
      if (!cached || from < cached.from || (cached.match !== null && from > cached.match.index)) {
        cached = { from, match: regex.exec(input) };
        pending.set(key, cached);
      } else {
        // Match RegExp.exec's cursor contract, including a miss resetting to zero.
        regex.lastIndex = cached.match ? cached.match.index + cached.match[0].length : 0;
      }
      return cached.match;
    },
  };
}
