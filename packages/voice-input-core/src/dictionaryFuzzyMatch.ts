import { HANZI_PINYIN_GROUPS, HANZI_POLYPHONE_ALTERNATES } from './hanziPinyinTable';
import type { DictationRefinementContext } from './types';

export type DictionaryAliasHint = NonNullable<DictationRefinementContext['dictionaryAliasHints']>[number];

export type DictionaryMatchOptions = {
  maxHintsScanned?: number;
  maxAliasesScanned?: number;
  maxMatches?: number;
  maxChars?: number;
};

type NormalizedAlias = {
  text: string;
  matchText: string;
  count: number;
};

type NormalizedCandidate = {
  term: string;
  termKey: string;
  frequency: number;
  aliases: NormalizedAlias[];
  topAliasCount: number;
};

type LatinSpan = {
  raw: string;
  compact: string;
};

type CjkRun = {
  text: string;
  syllables: ReadonlyArray<readonly string[]>;
  fuzzySyllables: ReadonlyArray<readonly string[]>;
};

type MatchCandidate = {
  surface: string;
  term: string;
  termKey: string;
  pairKey: string;
  tier: 1 | 2 | 3 | 4;
  score: number;
  frequency: number;
};

const DEFAULT_MAX_HINTS_SCANNED = 1_000;
const DEFAULT_MAX_ALIASES_SCANNED = 8;
const DEFAULT_MAX_MATCHES = 12;
const DEFAULT_MAX_CHARS = 1_800;

// CJK fuzzy matching only considers multi-character spans (>= 2 Hanzi); single
// Hanzi homophones are far too ambiguous and would pollute the prompt.
const MIN_CJK_FUZZY_LENGTH = 2;
const MAX_CJK_FUZZY_LENGTH = 12;
// Compound space/hyphen/dot matching ("lite llm" -> "LiteLLM", "next js" -> "Next.js").
const MIN_COMPOUND_COMPACT_LENGTH = 4;
// Damerau-Levenshtein edit-distance matching requires >= 6 compact chars for
// distance 1 (avoiding 5-letter English collisions like stack/Slack, codes/Codex)
// and >= 9 compact chars for distance 2.
const MIN_EDIT_DISTANCE_1_LENGTH = 6;
const MIN_EDIT_DISTANCE_2_LENGTH = 9;

const PURE_CJK_PATTERN = /^[\u4e00-\u9fff]+$/;
const HAS_CJK_PATTERN = /[\u4e00-\u9fff]/;
const LATIN_TOKEN_PATTERN = /[a-z0-9]+(?:[._'/-][a-z0-9]+)*/gi;
const CJK_RUN_PATTERN = /[\u4e00-\u9fff]+/g;
const COMPACT_STRIP_PATTERN = /[\s._'/-]+/g;

let cachedHanziSyllables: Map<string, readonly string[]> | null = null;
let cachedFuzzySyllables: Map<string, string> | null = null;

function getHanziSyllableMap(): Map<string, readonly string[]> {
  if (cachedHanziSyllables) return cachedHanziSyllables;
  const map = new Map<string, string[]>();
  for (const [syllable, chars] of Object.entries(HANZI_PINYIN_GROUPS)) {
    for (const ch of chars) {
      const existing = map.get(ch);
      if (existing) {
        if (!existing.includes(syllable)) existing.push(syllable);
      } else {
        map.set(ch, [syllable]);
      }
    }
  }
  for (const [ch, alternates] of Object.entries(HANZI_POLYPHONE_ALTERNATES)) {
    const existing = map.get(ch);
    if (existing) {
      for (const alt of alternates) {
        if (!existing.includes(alt)) existing.push(alt);
      }
    } else {
      map.set(ch, [...alternates]);
    }
  }
  cachedHanziSyllables = map;
  return map;
}

/**
 * Canonicalizes a Mandarin pinyin syllable for common ASR and accent confusions:
 * - flat/retroflex initials: zh↔z, ch↔c, sh↔s
 * - nasal/lateral initial: l↔n
 * - front/back nasal finals: ang↔an, eng↔en, ing↔in, iang↔ian, uang↔uan
 */
export function normalizeFuzzyMandarinSyllable(syllable: string): string {
  if (!cachedFuzzySyllables) cachedFuzzySyllables = new Map();
  const cached = cachedFuzzySyllables.get(syllable);
  if (cached !== undefined) return cached;

  let value = syllable;
  if (value.startsWith('zh')) value = `z${value.slice(2)}`;
  else if (value.startsWith('ch')) value = `c${value.slice(2)}`;
  else if (value.startsWith('sh')) value = `s${value.slice(2)}`;
  else if (value.startsWith('l')) value = `n${value.slice(1)}`;

  if (value.endsWith('iang')) value = `${value.slice(0, -4)}ian`;
  else if (value.endsWith('uang')) value = `${value.slice(0, -4)}uan`;
  else if (value.endsWith('ang')) value = `${value.slice(0, -3)}an`;
  else if (value.endsWith('eng')) value = `${value.slice(0, -3)}en`;
  else if (value.endsWith('ing')) value = `${value.slice(0, -3)}in`;

  cachedFuzzySyllables.set(syllable, value);
  return value;
}

/** Returns tone-less Mandarin pinyin syllables for a single Hanzi, if known. */
export function lookupHanziPinyinSyllables(char: string): readonly string[] | undefined {
  return getHanziSyllableMap().get(char);
}

/**
 * Bounded Damerau-Levenshtein (optimal string alignment) distance with early exit.
 * Returns `maxDistance + 1` as soon as the edit distance is guaranteed to exceed `maxDistance`.
 */
export function boundedDamerauLevenshtein(
  source: string,
  target: string,
  maxDistance: number,
): number {
  const m = source.length;
  const n = target.length;
  if (Math.abs(m - n) > maxDistance) return maxDistance + 1;
  if (source === target) return 0;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevPrev = new Int32Array(n + 1);
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;

  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    let rowMin = i;
    const sc = source.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const tc = target.charCodeAt(j - 1);
      const cost = sc === tc ? 0 : 1;
      let val = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
      if (
        i > 1
        && j > 1
        && sc === target.charCodeAt(j - 2)
        && source.charCodeAt(i - 2) === tc
      ) {
        val = Math.min(val, prevPrev[j - 2] + 1);
      }
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    const tmp = prevPrev;
    prevPrev = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeMatchText(text: string): string {
  return normalizeSpace(text).toLocaleLowerCase();
}

function compactText(text: string): string {
  return normalizeMatchText(text).replace(COMPACT_STRIP_PATTERN, '');
}

function normalizePositiveInteger(value: unknown): number {
  return Math.max(1, Math.floor(typeof value === 'number' && Number.isFinite(value) ? value : 1));
}

function extractTermsFromUserDictionary(userDictionary: string | undefined): string[] {
  if (!userDictionary) return [];
  const terms: string[] = [];
  for (const rawLine of userDictionary.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip section headings such as "手动添加:" / "自动添加:" / "Manual:".
    if (/[:：]$/.test(line) && !line.startsWith('-')) continue;
    const stripped = line.startsWith('-') ? line.slice(1).trim() : line;
    const normalized = normalizeSpace(stripped);
    if (normalized) terms.push(normalized);
  }
  return terms;
}

function extractLatinSpans(dictationText: string): LatinSpan[] {
  const tokens: Array<{ raw: string; start: number; end: number }> = [];
  LATIN_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LATIN_TOKEN_PATTERN.exec(dictationText)) !== null) {
    tokens.push({ raw: match[0], start: match.index, end: match.index + match[0].length });
  }
  const spans: LatinSpan[] = [];
  const seenRaw = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    for (let width = 1; width <= 3 && i + width <= tokens.length; width += 1) {
      // Only merge adjacent tokens separated by whitespace or light punctuation.
      if (width > 1) {
        const between = dictationText.slice(tokens[i + width - 2].end, tokens[i + width - 1].start);
        if (!/^[\s._/-]+$/.test(between)) break;
      }
      const raw = dictationText.slice(tokens[i].start, tokens[i + width - 1].end).trim();
      const compact = compactText(raw);
      if (!compact) continue;
      const key = `${raw.toLocaleLowerCase()}`;
      if (seenRaw.has(key)) continue;
      seenRaw.add(key);
      spans.push({ raw, compact });
    }
  }
  return spans;
}

function extractCjkRuns(dictationText: string): CjkRun[] {
  const runs: CjkRun[] = [];
  CJK_RUN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CJK_RUN_PATTERN.exec(dictationText)) !== null) {
    const text = match[0];
    if (text.length < MIN_CJK_FUZZY_LENGTH) continue;
    const syllables: Array<readonly string[]> = [];
    const fuzzySyllables: Array<readonly string[]> = [];
    for (const ch of text) {
      const syls = lookupHanziPinyinSyllables(ch) ?? [];
      syllables.push(syls);
      fuzzySyllables.push(syls.map(normalizeFuzzyMandarinSyllable));
    }
    runs.push({ text, syllables, fuzzySyllables });
  }
  return runs;
}

function sharesAny(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (right.includes(left[i])) return true;
  }
  return false;
}

function findBestCjkMatch(
  targetText: string,
  termKey: string,
  runs: readonly CjkRun[],
): { surface: string; tier: 2 | 3; score: number } | null {
  if (!PURE_CJK_PATTERN.test(targetText)) return null;
  const len = targetText.length;
  if (len < MIN_CJK_FUZZY_LENGTH || len > MAX_CJK_FUZZY_LENGTH) return null;

  const targetChars = Array.from(targetText);
  const targetSyls: Array<readonly string[]> = [];
  const targetFuzzy: Array<readonly string[]> = [];
  for (const ch of targetChars) {
    const syls = lookupHanziPinyinSyllables(ch);
    if (!syls || syls.length === 0) return null;
    targetSyls.push(syls);
    targetFuzzy.push(syls.map(normalizeFuzzyMandarinSyllable));
  }

  let best: { surface: string; tier: 2 | 3; score: number } | null = null;
  for (const run of runs) {
    if (run.text.length < len) continue;
    for (let offset = 0; offset <= run.text.length - len; offset += 1) {
      const surface = run.text.slice(offset, offset + len);
      if (surface === termKey) continue;

      let exactCharCount = 0;
      let exactPinyinCount = 0;
      let fuzzyPinyinCount = 0;
      for (let i = 0; i < len; i += 1) {
        const ch = surface[i];
        if (ch === targetChars[i]) {
          exactCharCount += 1;
          exactPinyinCount += 1;
          fuzzyPinyinCount += 1;
        } else if (sharesAny(run.syllables[offset + i], targetSyls[i])) {
          exactPinyinCount += 1;
          fuzzyPinyinCount += 1;
        } else if (sharesAny(run.fuzzySyllables[offset + i], targetFuzzy[i])) {
          fuzzyPinyinCount += 1;
        }
      }

      if (exactPinyinCount === len) {
        // Exact homophone across all syllables (highest confidence CJK fuzzy tier).
        const score = 200 + exactCharCount * 10 + len;
        if (!best || best.tier > 2 || score > best.score) {
          best = { surface, tier: 2, score };
        }
      } else if (fuzzyPinyinCount === len) {
        // Near-homophone: for 2-char words require at least 1 exact-pinyin position
        // so two simultaneous loose substitutions cannot collide on unrelated words.
        if (len === 2 && exactPinyinCount < 1) continue;
        const score = 120 + exactPinyinCount * 15 + exactCharCount * 5 + len;
        if (!best || (best.tier === 3 && score > best.score)) {
          best = { surface, tier: 3, score };
        }
      } else if (len >= 4 && exactPinyinCount >= len - 1) {
        // 4+ char proper noun with a single misheard syllable (e.g. "飞书多维表割").
        const score = 100 + exactCharCount * 10 + len;
        if (!best || (best.tier === 3 && score > best.score)) {
          best = { surface, tier: 3, score };
        }
      }
    }
  }
  return best;
}

function findBestLatinOrMixedMatch(
  targetText: string,
  termKey: string,
  dictationText: string,
  normalizedDictation: string,
  latinSpans: readonly LatinSpan[],
): { surface: string; tier: 2 | 4; score: number } | null {
  const targetCompact = compactText(targetText);
  if (targetCompact.length < MIN_COMPOUND_COMPACT_LENGTH) return null;

  // Mixed CJK + Latin term (e.g. "飞书Bitable" vs "飞书 bitable"): match after
  // removing internal spaces/hyphens when surface differs from exact term.
  if (HAS_CJK_PATTERN.test(targetText)) {
    const compactDictation = compactText(dictationText);
    if (!compactDictation.includes(targetCompact)) return null;
    if (normalizedDictation.includes(termKey)) return null;
    // Build a loose whitespace/hyphen pattern to extract the original surface span.
    const escapedChars = Array.from(targetCompact).map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const surfaceMatch = new RegExp(escapedChars.join('[\\s._/-]*'), 'i').exec(dictationText);
    if (!surfaceMatch) return null;
    const surface = normalizeSpace(surfaceMatch[0]);
    if (!surface || normalizeMatchText(surface) === termKey) return null;
    return { surface, tier: 2, score: 180 + targetCompact.length };
  }

  // Pure Latin/alphanumeric matching against extracted word & multi-word spans.
  if (!/^[a-z0-9]+$/.test(targetCompact)) return null;

  let best: { surface: string; tier: 2 | 4; score: number } | null = null;
  const maxDist = targetCompact.length >= MIN_EDIT_DISTANCE_2_LENGTH
    ? 2
    : targetCompact.length >= MIN_EDIT_DISTANCE_1_LENGTH
      ? 1
      : 0;

  for (const span of latinSpans) {
    if (normalizeMatchText(span.raw) === termKey) continue;
    if (span.compact === targetCompact) {
      // Exact compound match ("lite llm" -> "LiteLLM", "next js" -> "Next.js").
      const score = 200 + targetCompact.length;
      if (!best || best.tier > 2 || score > best.score) {
        best = { surface: span.raw, tier: 2, score };
      }
      continue;
    }
    if (maxDist === 0) continue;
    if (Math.abs(span.compact.length - targetCompact.length) > maxDist) continue;
    const dist = boundedDamerauLevenshtein(span.compact, targetCompact, maxDist);
    if (dist > 0 && dist <= maxDist) {
      const score = 100 - dist * 30 + targetCompact.length;
      if (!best || (best.tier === 4 && score > best.score)) {
        best = { surface: span.raw, tier: 4, score };
      }
    }
  }
  return best;
}

function dictationAlreadyContainsExactTerm(normalizedDictation: string, termKey: string): boolean {
  if (!termKey) return false;
  if (HAS_CJK_PATTERN.test(termKey)) {
    return normalizedDictation.includes(termKey);
  }
  const escaped = termKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(normalizedDictation);
}

/**
 * Builds the bounded `userDictionaryMatches` prompt block by combining:
 * 1. Exact alias substring matches (existing highest-priority behavior),
 * 2. Compound normalization matches (spaces/hyphens/dots stripped, e.g. "lite llm" -> "LiteLLM"),
 * 3. Lightweight zero-dependency Chinese pinyin exact & near-homophone recall,
 * 4. Bounded Damerau-Levenshtein edit-distance recall for longer Latin/alphanumeric terms.
 */
export function buildFuzzyUserDictionaryMatches(
  dictationText: string,
  hints: DictationRefinementContext['dictionaryAliasHints'],
  userDictionary?: string,
  options: DictionaryMatchOptions = {},
): string | undefined {
  const normalizedDictation = normalizeMatchText(dictationText);
  if (!normalizedDictation) return undefined;

  const maxHintsScanned = options.maxHintsScanned ?? DEFAULT_MAX_HINTS_SCANNED;
  const maxAliasesScanned = options.maxAliasesScanned ?? DEFAULT_MAX_ALIASES_SCANNED;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const candidates: NormalizedCandidate[] = [];
  const seenCandidateTermKeys = new Set<string>();

  if (Array.isArray(hints)) {
    for (const hint of hints.slice(0, maxHintsScanned)) {
      const term = normalizeSpace(typeof hint?.term === 'string' ? hint.term : '');
      const termKey = normalizeMatchText(term);
      if (!term || !termKey || seenCandidateTermKeys.has(termKey)) continue;
      seenCandidateTermKeys.add(termKey);
      const aliases = Array.isArray(hint.aliases)
        ? hint.aliases
          .slice(0, maxAliasesScanned)
          .map((alias) => ({
            text: normalizeSpace(typeof alias?.text === 'string' ? alias.text : ''),
            matchText: normalizeMatchText(typeof alias?.text === 'string' ? alias.text : ''),
            count: normalizePositiveInteger(alias?.count),
          }))
          .filter((alias) => alias.text && alias.matchText && alias.matchText !== termKey)
          .sort((a, b) => b.count - a.count || b.text.length - a.text.length)
        : [];
      candidates.push({
        term,
        termKey,
        frequency: normalizePositiveInteger(hint.frequency),
        aliases,
        topAliasCount: aliases[0]?.count ?? 0,
      });
    }
  }

  // Also include terms from formatted `userDictionary` so manually added terms
  // without recorded aliases still benefit from compound/pinyin/fuzzy recall.
  if (candidates.length < maxHintsScanned && userDictionary) {
    for (const term of extractTermsFromUserDictionary(userDictionary)) {
      if (candidates.length >= maxHintsScanned) break;
      const termKey = normalizeMatchText(term);
      if (!termKey || seenCandidateTermKeys.has(termKey)) continue;
      seenCandidateTermKeys.add(termKey);
      candidates.push({
        term,
        termKey,
        frequency: 1,
        aliases: [],
        topAliasCount: 0,
      });
    }
  }

  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => b.frequency - a.frequency || b.topAliasCount - a.topAliasCount);

  let latinSpans: LatinSpan[] | null = null;
  let cjkRuns: CjkRun[] | null = null;
  const getLatinSpans = (): readonly LatinSpan[] => (latinSpans ??= extractLatinSpans(dictationText));
  const getCjkRuns = (): readonly CjkRun[] => (cjkRuns ??= extractCjkRuns(dictationText));

  const matches: MatchCandidate[] = [];
  for (const candidate of candidates) {
    // Tier 1: Exact normalized substring against known aliases.
    const exactAlias = candidate.aliases.find((alias) => normalizedDictation.includes(alias.matchText));
    if (exactAlias) {
      matches.push({
        surface: exactAlias.text,
        term: candidate.term,
        termKey: candidate.termKey,
        pairKey: `${exactAlias.matchText}=>${candidate.termKey}`,
        tier: 1,
        score: 1000 + exactAlias.count,
        frequency: candidate.frequency,
      });
      continue;
    }

    // If the dictation already contains the exact term, skip noisy fuzzy matches.
    if (dictationAlreadyContainsExactTerm(normalizedDictation, candidate.termKey)) {
      continue;
    }

    // Tiers 2-4: Fuzzy recall against the canonical term and its known aliases.
    const probeTexts = [candidate.term, ...candidate.aliases.map((alias) => alias.text)];
    let bestFuzzy: { surface: string; tier: 2 | 3 | 4; score: number } | null = null;
    for (const probe of probeTexts) {
      const cjkMatch = PURE_CJK_PATTERN.test(probe)
        ? findBestCjkMatch(probe, candidate.termKey, getCjkRuns())
        : null;
      if (cjkMatch && (!bestFuzzy || cjkMatch.tier < bestFuzzy.tier || (cjkMatch.tier === bestFuzzy.tier && cjkMatch.score > bestFuzzy.score))) {
        bestFuzzy = cjkMatch;
        if (cjkMatch.tier === 2) break;
      }

      const latinMatch = !PURE_CJK_PATTERN.test(probe)
        ? findBestLatinOrMixedMatch(probe, candidate.termKey, dictationText, normalizedDictation, getLatinSpans())
        : null;
      if (latinMatch && (!bestFuzzy || latinMatch.tier < bestFuzzy.tier || (latinMatch.tier === bestFuzzy.tier && latinMatch.score > bestFuzzy.score))) {
        bestFuzzy = latinMatch;
        if (latinMatch.tier === 2) break;
      }
    }

    if (bestFuzzy) {
      const surfaceKey = normalizeMatchText(bestFuzzy.surface);
      if (surfaceKey && surfaceKey !== candidate.termKey) {
        matches.push({
          surface: bestFuzzy.surface,
          term: candidate.term,
          termKey: candidate.termKey,
          pairKey: `${surfaceKey}=>${candidate.termKey}`,
          tier: bestFuzzy.tier,
          score: bestFuzzy.score,
          frequency: candidate.frequency,
        });
      }
    }
  }

  if (matches.length === 0) return undefined;

  matches.sort((a, b) => a.tier - b.tier || b.frequency - a.frequency || b.score - a.score);

  const lines: string[] = [];
  const seenTerms = new Set<string>();
  const seenPairs = new Set<string>();
  for (const match of matches) {
    if (lines.length >= maxMatches) break;
    if (seenTerms.has(match.termKey) || seenPairs.has(match.pairKey)) continue;
    seenTerms.add(match.termKey);
    seenPairs.add(match.pairKey);
    lines.push(`- “${match.surface}” 可能是 “${match.term}”`);
  }

  const block = lines.join('\n');
  return block.length > maxChars
    ? block.slice(0, maxChars).trim()
    : block || undefined;
}
