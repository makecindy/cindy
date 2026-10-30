import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { resolveLlamaCppCatalog, resolveLlamaCppModelLists } from '../llamaCppCatalog.js';
import { pickFeaturedOllamaModels } from '../localModelRuntime.js';

describe('shared local shortlist', () => {
  it('exposes GGUF packages for every current model without copying Ollama measurements', () => {
    const source = BUNDLED_CATALOG.modelRegistry!.localModels!;
    const catalog = resolveLlamaCppCatalog();
    expect(catalog).toHaveLength(source.models.length);
    expect(catalog[0]!.id).toBe(source.featuredIds[0]);
    for (const model of catalog) {
      expect(model).not.toHaveProperty('minUnifiedMemoryGb');
      expect(model).not.toHaveProperty('runtimeProfile');
      expect(model.variants.length).toBeGreaterThan(0);
    }
    expect(
      pickFeaturedOllamaModels({
        platform: 'darwin',
        arch: 'arm64',
        totalmemBytes: 256 * 1024 ** 3,
      }).map((m) => m.id),
    ).toEqual(source.featuredIds);
  });
  it('projects the shared primary for the 256 GB Apple host without borrowing its runtime settings', () => {
    const input = { platform: 'darwin' as const, arch: 'arm64', totalmemBytes: 256 * 1024 ** 3 };
    const lists = resolveLlamaCppModelLists(input);
    expect(lists.recommendation).toEqual({
      featuredIds: ['qwen38-flash-next', 'qwen38-27b'],
      memoryGb: 256,
      appleSilicon: true,
    });
    expect(
      lists.catalog.find((entry) => entry.id === lists.recommendation.featuredIds[0])?.variants[0]
        ?.quantization,
    ).toBe('Q4_K_M');
    expect(
      resolveLlamaCppModelLists({ ...input, totalmemBytes: 0 }).recommendation.featuredIds,
    ).toEqual([]);
    expect(
      resolveLlamaCppModelLists({ ...input, totalmemBytes: 16 * 1024 ** 3 }).recommendation
        .featuredIds,
    ).toEqual([]);
    const source = structuredClone(BUNDLED_CATALOG.modelRegistry!.localModels!);
    source.featuredIds = [];
    expect(resolveLlamaCppModelLists(input, source).recommendation.featuredIds).toEqual([]);
    source.featuredIds = ['qwen38-27b'];
    source.models.find((model) => model.id === 'qwen38-27b')!.llamacpp = [];
    expect(resolveLlamaCppModelLists(input, source).recommendation.featuredIds).toEqual([]);
  });
  it('honors explicit withdrawals and user names without restoring removed packages', () => {
    expect(resolveLlamaCppCatalog({ version: 1, models: [], featuredIds: [] })).toEqual([]);
    const source = structuredClone(BUNDLED_CATALOG.modelRegistry!.localModels!);
    const primary = source.models.find((model) => model.id === source.featuredIds[0])!;
    primary.name = 'My custom name';
    primary.descriptions = { en: 'My description' };
    expect(resolveLlamaCppCatalog(source)[0]!.descriptions).toEqual({ en: 'My description' });
    expect(resolveLlamaCppCatalog(source)[0]!.name).toBe('My custom name');
    primary.llamacpp = [];
    expect(resolveLlamaCppCatalog(source).some((m) => m.id === primary.id)).toBe(false);
    for (const model of source.models) delete model.llamacpp;
    expect(resolveLlamaCppCatalog(source)).toEqual([]);
  });
});
