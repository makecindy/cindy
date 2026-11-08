/** Searchable metadata only. Skill instructions remain at filePath. */
export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  filePath: string;
  source: string;
  aliases?: string[];
  tags?: string[];
}

/** identity identifies the endpoint, model, dimensions and embedding options. */
export interface SkillEmbeddingAdapter {
  identity: string;
  embed(texts: readonly string[], inputType: 'query' | 'document'): Promise<number[][]>;
}

export interface SkillIndexSnapshot {
  schemaVersion: 1;
  entries: Array<{
    entry: SkillEntry;
    textHash: string;
    vector?: number[];
  }>;
  vectorIdentity?: string;
}

export interface SkillMatch {
  id: string;
  name: string;
  description: string;
  filePath: string;
  source: string;
  score: number;
  matchedTerms: string[];
}

export interface SkillSearchOptions {
  limit?: number;
  embedding?: SkillEmbeddingAdapter;
}

export interface SkillSearchResult {
  mode: 'keyword' | 'hybrid';
  matches: SkillMatch[];
}
