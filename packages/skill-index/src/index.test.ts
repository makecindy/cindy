import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SkillIndex, type SkillEmbeddingAdapter, type SkillEntry } from './index.js';

/**
 * Test value: real SkillIndex sync/build/search/snapshot entry points protect the
 * task-driven skill discovery feature, without loading instructions or a model.
 * New package: no existing suite covers ranking, incremental embeddings or reload.
 * Minimal cases below distinguish keyword/semantic matches and content generations.
 * Tier: unit; metadata, fake vectors and JSON roundtrips are entirely in memory.
 */
const entries: SkillEntry[] = [
  { id: 'video', name: 'video-transcribe', description: '提取视频音频，录屏课程转文字和字幕',
    aliases: ['视频转字幕'], tags: ['课程', '转写'], filePath: path.join('skills', 'video', 'SKILL.md'), source: 'local' },
  { id: 'game', name: 'game-effects', description: '制作游戏粒子特效和角色动画',
    tags: ['游戏特效'], filePath: path.join('skills', 'game', 'SKILL.md'), source: 'local' },
  { id: 'word', name: 'word-documents', description: '编写文档和排版表格',
    filePath: path.join('skills', 'word', 'SKILL.md'), source: 'local' },
];

function indexed(): SkillIndex {
  const index = new SkillIndex();
  index.sync(entries);
  return index;
}

function embedding(identity = 'test:model:3'): SkillEmbeddingAdapter & { embed: ReturnType<typeof vi.fn> } {
  return {
    identity,
    // Semantic intent deliberately has no shared lexical token with the catalog.
    embed: vi.fn(async (texts: readonly string[], inputType: 'query' | 'document') =>
      ({ modelUsed: identity, vectors: texts.map((text) => inputType === 'query' ? [1, 0, 0]
        : text.startsWith('video-transcribe') ? [1, 0, 0]
        : text.startsWith('game-effects') ? [0, 1, 0] : [0, 0, 1]) })),
  };
}

describe('SkillIndex task discovery', () => {
  it.each(['C++', '帮我用 C++', 'C#', '使用 C# 写程序'])('retains symbolic language names in %s', async (query) => {
    const index = new SkillIndex();
    index.sync([
      { ...entries[0]!, id: 'cpp', name: 'cpp-specialist', description: 'Develop C++ applications.' },
      { ...entries[0]!, id: 'csharp', name: 'dotnet-specialist', description: 'Develop applications.', tags: ['C#'] },
      { ...entries[0]!, id: 'partial', name: 'other', description: 'EC++ SC# C++suffix C#suffix' },
    ]);
    expect((await index.search(query)).matches.map(item => item.id)).toEqual([query.includes('++') ? 'cpp' : 'csharp']);
  });

  it.each([
    ['帮我把录屏课程转成文字', 'video'],
    ['做游戏特效', 'game'],
    ['视频转字幕', 'video'],
    ['WORD-DOCUMENTS', 'word'],
  ])('finds %s from metadata', async (query, expected) => {
    const result = await indexed().search(query);
    expect(result.mode).toBe('keyword');
    expect(result.matches[0]?.id).toBe(expected);
    expect(result.matches[0]?.matchedTerms.length).toBeGreaterThan(0);
  });

  it('keeps exact names first, returns bounded summaries, and resolves their original source', async () => {
    const index = indexed();
    const result = await index.search('game-effects', { limit: 1 });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toEqual({
      id: 'game', name: entries[1]!.name, description: entries[1]!.description,
      filePath: entries[1]!.filePath, source: 'local', score: expect.any(Number),
      matchedTerms: expect.arrayContaining(['game-effects']),
    });
    expect(index.resolve(result.matches[0]!.id)).toEqual(entries[1]);
    expect(index.resolve('missing')).toBeUndefined();
  });

  it('does not match unrelated requests, filesystem paths, sources or partial Latin words', async () => {
    const index = new SkillIndex();
    index.sync([{ ...entries[0]!, name: 'partial', description: 'alpha', filePath: 'secret-location', source: 'private-source' }]);
    for (const query of ['art', 'secret-location', 'private-source', 'unmatched9382', '  ']) {
      expect((await index.search(query)).matches).toEqual([]);
    }
  });

  it('uses actual semantic similarity to find a lexically absent task after a snapshot reload', async () => {
    const index = indexed();
    const adapter = embedding();
    expect((await index.search('spoken lessons into searchable notes')).matches).toEqual([]);
    expect(await index.buildVectors(adapter)).toEqual({ embedded: 3, reused: 0 });
    const saved = JSON.parse(JSON.stringify(index.snapshot()));
    const restarted = new SkillIndex(saved);
    expect(await restarted.buildVectors(adapter)).toEqual({ embedded: 0, reused: 3 });
    const result = await restarted.search('spoken lessons into searchable notes', { embedding: adapter });
    expect(result.mode).toBe('hybrid');
    expect(result.matches.map((match) => match.id)).toEqual(['video']);
    expect(result.matches[0]?.matchedTerms).toEqual([]);
    expect(adapter.embed).toHaveBeenLastCalledWith(['spoken lessons into searchable notes'], 'query');
    expect(adapter.embed).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicitly named skill first even when semantic ranking favors another', async () => {
    const index = indexed();
    const adapter = embedding();
    await index.buildVectors(adapter);
    const result = await index.search('game-effects', { embedding: adapter });
    expect(result.matches[0]?.id).toBe('game');
    expect(result.matches.map((match) => match.id)).toContain('video');
  });

  it('reuses unchanged vectors, embeds only changed text, and removes deleted skills', async () => {
    const index = indexed();
    const adapter = embedding();
    await index.buildVectors(adapter);
    const edited = { ...entries[1]!, description: '游戏特效与动态光照' };
    const moved = { ...entries[0]!, filePath: path.join('new-place', 'SKILL.md'), source: 'project' };
    expect(index.sync([moved, edited])).toEqual({ added: 0, changed: 2, removed: 1 });
    expect(await index.buildVectors(adapter)).toEqual({ embedded: 1, reused: 1 });
    expect(adapter.embed.mock.calls[1]?.[0]).toEqual([expect.stringContaining('动态光照')]);
    expect(adapter.embed.mock.calls[1]?.[0][0]).not.toContain('new-place');
    expect(index.resolve('word')).toBeUndefined();
    expect((await index.search('word-documents')).matches).toEqual([]);
    expect(index.sync([moved, edited])).toEqual({ added: 0, changed: 0, removed: 0 });
    expect(await index.buildVectors(adapter)).toEqual({ embedded: 0, reused: 2 });
  });

  it('builds a complete new generation when the embedding identity changes', async () => {
    const index = indexed();
    await index.buildVectors(embedding());
    const next = embedding('other:model:3');
    expect((await index.search('视频', { embedding: next })).mode).toBe('keyword');
    expect(next.embed).not.toHaveBeenCalled();
    expect(await index.buildVectors(next)).toEqual({ embedded: 3, reused: 0 });
    expect(index.snapshot().vectorIdentity).toBe(next.identity);
    expect((await index.search('spoken lessons into searchable notes', { embedding: next })).matches[0]?.id).toBe('video');
  });

  it('keeps a pending query on its original vector generation while a new model is built', async () => {
    const index = indexed();
    const oldModel = embedding();
    await index.buildVectors(oldModel);
    let finishQuery!: (vectors: number[][]) => void;
    const pendingQuery = new Promise<number[][]>((resolve) => { finishQuery = resolve; });
    const search = index.search('spoken lessons into searchable notes', {
      embedding: { identity: oldModel.identity, embed: async () => ({ vectors: await pendingQuery, modelUsed: oldModel.identity }) },
    });
    const newModel: SkillEmbeddingAdapter = {
      identity: 'new-model:same-dimensions',
      embed: async (texts, inputType) => ({ modelUsed: 'new-model', vectors: texts.map((text) => inputType === 'query' ? [1, 0, 0]
        : text.startsWith('game-effects') ? [1, 0, 0]
        : text.startsWith('video-transcribe') ? [0, 1, 0] : [0, 0, 1]) }),
    };
    await index.buildVectors(newModel);
    finishQuery([[1, 0, 0]]);
    expect((await search).matches.map((match) => match.id)).toEqual(['video']);
    expect((await index.search('spoken lessons into searchable notes', { embedding: newModel }))
      .matches.map((match) => match.id)).toEqual(['game']);
  });

  it('leaves the previous generation intact when a replacement embedding fails', async () => {
    const index = indexed();
    const adapter = embedding();
    await index.buildVectors(adapter);
    const before = index.snapshot();
    await expect(index.buildVectors({ identity: 'unavailable', embed: async () => { throw new Error('API unavailable'); } }))
      .rejects.toThrow('API unavailable');
    expect(index.snapshot()).toEqual(before);
    expect((await index.search('spoken lessons into searchable notes', { embedding: adapter })).matches[0]?.id).toBe('video');
  });

  // PR #9374: an old incremental build could overwrite a completed new-model
  // generation. Unit tier: two controlled promises through buildVectors/search.
  it('rejects an incremental build after another build publishes a generation', async () => {
    const index = indexed();
    const oldModel = embedding();
    await index.buildVectors(oldModel);
    index.sync([...entries, { ...entries[0]!, id: 'added', name: 'added' }]);
    let finish!: (vectors: number[][]) => void;
    const pending = new Promise<number[][]>(resolve => { finish = resolve; });
    const oldBuild = index.buildVectors({ identity: oldModel.identity, embed: async () => ({ vectors: await pending, modelUsed: oldModel.identity }) });
    const next = embedding('new-model');
    await index.buildVectors(next);
    const before = index.snapshot();
    finish([[0, 0, 1]]);
    await expect(oldBuild).rejects.toThrow('generation changed');
    expect(index.snapshot()).toEqual(before);
    expect((await index.search('spoken lessons into searchable notes', { embedding: next })).matches[0]?.id).toBe('video');
  });

  it('publishes no vectors for a malformed response and reports a query dimension mismatch', async () => {
    const index = indexed();
    await expect(index.buildVectors({ identity: 'bad', embed: async () => ({ vectors: [[1, 0]], modelUsed: 'test:model:3' }) }))
      .rejects.toThrow('count');
    expect(index.snapshot().entries.every((entry) => entry.vector === undefined)).toBe(true);
    const adapter = embedding();
    await index.buildVectors(adapter);
    await expect(index.search('query', { embedding: { identity: adapter.identity, embed: async () => ({ vectors: [[1, 0]], modelUsed: 'test:model:3' }) } }))
      .rejects.toThrow('dimensions');
  });

  // PR #9374: a provider alias can change its actual model without changing
  // dimensions. Unit tier; exercise persistence, query, incremental build and rebuild.
  it('rejects alias drift and explicitly rebuilds every vector with the new model', async () => {
    let modelUsed = 'revision-1';
    const base = embedding('alias');
    const adapter: SkillEmbeddingAdapter = {
      identity: base.identity,
      embed: async (texts, inputType) => ({ ...(await base.embed(texts, inputType)), modelUsed }),
    };
    const index = indexed();
    await index.buildVectors(adapter);
    const restarted = new SkillIndex(JSON.parse(JSON.stringify(index.snapshot())));
    modelUsed = 'revision-2';
    await expect(restarted.search('spoken lessons into searchable notes', { embedding: adapter })).rejects.toThrow('sync --rebuild');
    restarted.sync([...entries, { ...entries[0]!, id: 'added', name: 'added' }]);
    const before = restarted.snapshot();
    await expect(restarted.buildVectors(adapter)).rejects.toThrow('sync --rebuild');
    expect(restarted.snapshot()).toEqual(before);
    expect(await restarted.buildVectors(adapter, { rebuild: true })).toEqual({ embedded: 4, reused: 0 });
    expect(restarted.snapshot().vectorModel).toBe('revision-2');
    expect((await restarted.search('spoken lessons into searchable notes', { embedding: adapter })).matches[0]?.id).toBe('video');
  });
});
