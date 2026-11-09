import type { SkillEntry } from './types.js';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const STOP_WORDS = new Set(['a', 'i', 'the', 'and', 'for', 'with', 'please', 'help', '帮我', '帮忙', '一个', '一下', '如何', '怎么', '进行']);

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Only public discovery metadata is sent to an embedding adapter. */
export function retrievalText(entry: SkillEntry): string {
  return [entry.name, entry.description, ...(entry.aliases ?? []), ...(entry.tags ?? [])]
    .map(normalizeText)
    .filter(Boolean)
    .join('\n');
}

function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  // Preserve symbol-bearing names and versions (C++20, C#12.0, C++2a).
  // Do not let Segmenter turn their suffixes into unrelated numeric query terms.
  const remaining = query.replace(/(?<![a-z0-9_+#])[a-z][a-z0-9]*(?:\+\+|#)(?:\d[a-z0-9]*(?:\.[a-z0-9]+)*)?(?![a-z0-9_+#])/gu, term => {
    terms.add(term);
    return ' '.repeat(term.length);
  });
  // Single-letter languages are words too, but C must remain distinct from C++/C#.
  for (const term of remaining.match(/(?<![a-z0-9_+#])[a-z](?![a-z0-9_+#])/gu) ?? []) {
    if (!STOP_WORDS.has(term)) terms.add(term);
  }
  for (const part of segmenter.segment(remaining)) {
    if (part.isWordLike && part.segment.length > 1 && !STOP_WORDS.has(part.segment)) {
      terms.add(part.segment);
    }
  }
  // Bigrams bridge different Chinese word boundaries without matching single
  // grammatical characters throughout otherwise unrelated descriptions.
  for (const run of query.match(/\p{Script=Han}+/gu) ?? []) {
    const characters = [...run];
    for (let i = 0; i + 1 < characters.length; i++) {
      const term = characters[i] + characters[i + 1];
      if (!STOP_WORDS.has(term)) terms.add(term);
    }
  }
  return [...terms];
}

function prepareTermMatcher(term: string): (text: string) => boolean {
  if (/^[a-z0-9][a-z0-9._+#'-]*$/u.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^a-z0-9_+#])${escaped}(?=$|[^a-z0-9_+#])`, 'u');
    return text => pattern.test(text);
  }
  return text => text.includes(term);
}

export interface KeywordScore {
  score: number;
  exact: boolean;
  matchedTerms: string[];
}

/** Query work is independent of catalog size. */
export function prepareKeywordQuery(query: string) {
  const normalized = normalizeText(query);
  return { normalized, terms: queryTerms(normalized).map(term => ({ term, matches: prepareTermMatcher(term) })) };
}

export function scoreKeywords(entry: SkillEntry, query: ReturnType<typeof prepareKeywordQuery>): KeywordScore {
  const { normalized, terms } = query;
  const names = [entry.name, ...(entry.aliases ?? [])].map(normalizeText);
  const exact = names.includes(normalized);
  const tags = (entry.tags ?? []).map(normalizeText).join('\n');
  const description = normalizeText(entry.description);
  let score = exact ? 100 : 0;
  const matchedTerms: string[] = exact ? [normalized] : [];
  for (const { term, matches } of terms) {
    const weight = names.some(matches) ? 4
      : matches(tags) ? 3
      : matches(description) ? 1 : 0;
    if (weight) {
      score += weight;
      if (!matchedTerms.includes(term)) matchedTerms.push(term);
    }
  }
  return { score, exact, matchedTerms };
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error('Query and indexed vectors have different dimensions');
  let dot = 0;
  let lengthA = 0;
  let lengthB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    lengthA += a[i]! * a[i]!;
    lengthB += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(lengthA * lengthB);
}

/** Reciprocal rank fusion, with deterministic tie-breaking at the caller. */
export function reciprocalRankScore(keywordRank?: number, semanticRank?: number): number {
  return (keywordRank === undefined ? 0 : 1 / (60 + keywordRank))
    + (semanticRank === undefined ? 0 : 1 / (60 + semanticRank));
}
