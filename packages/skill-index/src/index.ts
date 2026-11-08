import { createHash } from 'node:crypto';
import { cosineSimilarity, normalizeText, reciprocalRankScore, retrievalText, scoreKeywords } from './ranking.js';
import type { SkillEmbeddingAdapter, SkillEntry, SkillIndexSnapshot, SkillSearchOptions, SkillSearchResult } from './types.js';

export type { SkillEmbeddingAdapter, SkillEntry, SkillIndexSnapshot, SkillMatch, SkillSearchOptions, SkillSearchResult } from './types.js';

type IndexedEntry = SkillIndexSnapshot['entries'][number];

function hashText(entry: SkillEntry): string {
  return createHash('sha256').update(retrievalText(entry)).digest('hex');
}

function validateVectors(vectors: number[][], expectedCount: number, dimensions?: number): void {
  if (vectors.length !== expectedCount) throw new Error('Embedding response count does not match input');
  const dim = dimensions ?? vectors[0]?.length;
  for (const vector of vectors) {
    if (!vector.length || vector.length !== dim || vector.some((value) => !Number.isFinite(value))
      || !vector.some((value) => value !== 0)) {
      throw new Error('Embedding vectors must be finite, nonzero and have consistent dimensions');
    }
  }
}

/** Metadata retrieval with an optional, incrementally built semantic index.
 * The caller owns directory discovery, access scope and snapshot persistence.
 */
export class SkillIndex {
  private entries = new Map<string, IndexedEntry>();
  private vectorIdentity?: string;
  private vectorModel?: string;
  private vectorGeneration = 0;

  constructor(snapshot?: SkillIndexSnapshot) {
    if (!snapshot) return;
    if (snapshot.schemaVersion !== 1) throw new Error('Unsupported skill index snapshot version');
    this.vectorIdentity = snapshot.vectorIdentity;
    this.vectorModel = snapshot.vectorModel;
    for (const item of snapshot.entries) {
      const textHash = hashText(item.entry);
      this.entries.set(item.entry.id, {
        entry: structuredClone(item.entry),
        textHash,
        ...(item.vector && item.textHash === textHash ? { vector: [...item.vector] } : {}),
      });
    }
    validateVectors([...this.entries.values()].flatMap((item) => item.vector ? [item.vector] : []),
      [...this.entries.values()].filter((item) => item.vector).length);
  }

  sync(entries: readonly SkillEntry[]): { added: number; changed: number; removed: number } {
    const next = new Map<string, IndexedEntry>();
    let added = 0;
    let changed = 0;
    for (const entry of entries) {
      if (next.has(entry.id)) throw new Error(`Duplicate skill id: ${entry.id}`);
      const old = this.entries.get(entry.id);
      const textHash = hashText(entry);
      if (!old) added++;
      else if (JSON.stringify(old.entry) !== JSON.stringify(entry)) changed++;
      next.set(entry.id, {
        entry: structuredClone(entry),
        textHash,
        ...(old?.vector && old.textHash === textHash ? { vector: old.vector } : {}),
      });
    }
    const removed = [...this.entries.keys()].filter((id) => !next.has(id)).length;
    this.entries = next;
    return { added, changed, removed };
  }

  async buildVectors(adapter: SkillEmbeddingAdapter, options: { rebuild?: boolean } = {}): Promise<{ embedded: number; reused: number }> {
    const current = this.entries;
    const generation = this.vectorGeneration;
    const sameIdentity = !options.rebuild && this.vectorModel !== undefined && this.vectorIdentity === adapter.identity;
    const pending = [...current.values()].filter((item) => !sameIdentity || !item.vector);
    const reused = current.size - pending.length;
    if (!pending.length) return { embedded: 0, reused };
    const { vectors, modelUsed } = await adapter.embed(pending.map((item) => retrievalText(item.entry)), 'document');
    if (this.entries !== current) throw new Error('Skill catalog changed during vector indexing; build again');
    if (this.vectorGeneration !== generation) throw new Error('Vector generation changed during indexing; build again');
    if (sameIdentity && reused && modelUsed !== this.vectorModel) {
      throw new Error('Embedding model changed; rebuild the library vectors with sync --rebuild');
    }
    const existingDim = sameIdentity
      ? [...current.values()].find((item) => item.vector)?.vector?.length : undefined;
    validateVectors(vectors, pending.length, existingDim);
    // Publish only after the whole batch succeeds, keeping the old generation
    // available if another model cannot finish its replacement index.
    for (let i = 0; i < pending.length; i++) pending[i]!.vector = [...vectors[i]!];
    this.vectorIdentity = adapter.identity;
    this.vectorModel = modelUsed;
    this.vectorGeneration++;
    return { embedded: pending.length, reused };
  }

  async search(query: string, options: SkillSearchOptions = {}): Promise<SkillSearchResult> {
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    if (!normalizeText(query) || !this.entries.size) return { mode: 'keyword', matches: [] };
    // Keep this query on the generation it selected before awaiting the API.
    // buildVectors replaces vector arrays; retaining their references is enough.
    const entries = [...this.entries.values()].map((item) => ({ ...item }));
    const lexical = entries.map((item) => ({ item, ...scoreKeywords(item.entry, query) }));
    const keywords = lexical.filter((item) => item.score > 0)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.item.entry.id.localeCompare(b.item.entry.id));
    const keywordRanks = new Map(keywords.map((item, i) => [item.item.entry.id, i + 1]));
    const semanticRanks = new Map<string, number>();
    let mode: SkillSearchResult['mode'] = 'keyword';
    const indexed = entries.filter((item) => item.vector);
    const vectorModel = this.vectorModel;
    if (options.embedding && options.embedding.identity === this.vectorIdentity && indexed.length) {
      const { vectors, modelUsed } = await options.embedding.embed([query], 'query');
      if (modelUsed !== vectorModel) throw new Error('Embedding model changed; rebuild the library vectors with sync --rebuild');
      validateVectors(vectors, 1, indexed[0]!.vector!.length);
      const semantic = indexed.map((item) => ({ id: item.entry.id, score: cosineSimilarity(vectors[0]!, item.vector!) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      semantic.forEach((item, i) => semanticRanks.set(item.id, i + 1));
      mode = 'hybrid';
    }
    const matches = lexical.filter(({ item }) => keywordRanks.has(item.entry.id) || semanticRanks.has(item.entry.id))
      .map(({ item, matchedTerms, exact, score }) => ({
        id: item.entry.id,
        name: item.entry.name,
        description: item.entry.description,
        filePath: item.entry.filePath,
        source: item.entry.source,
        score: mode === 'hybrid'
          ? (exact ? 1 : 0) + reciprocalRankScore(keywordRanks.get(item.entry.id), semanticRanks.get(item.entry.id)) : score,
        matchedTerms,
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
    return { mode, matches };
  }

  snapshot(): SkillIndexSnapshot {
    return {
      schemaVersion: 1,
      entries: structuredClone([...this.entries.values()]),
      ...(this.vectorIdentity === undefined ? {} : { vectorIdentity: this.vectorIdentity }),
      ...(this.vectorModel === undefined ? {} : { vectorModel: this.vectorModel }),
    };
  }

  resolve(id: string): SkillEntry | undefined {
    const item = this.entries.get(id);
    return item ? structuredClone(item.entry) : undefined;
  }
}
