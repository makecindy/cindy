import { describe, expect, it } from 'vitest';
import { piSupportedEfforts } from '../piThinkingLevels.mjs';
import { piNativeCatalogModels } from '../piNativeCatalog.js';

describe('Pi sparse thinking level maps', () => {
  it('keeps standard levels when only extended levels and aliases are declared', () => {
    expect(piSupportedEfforts({ reasoning: true,
      thinkingLevelMap: { minimal: 'low', xhigh: 'xhigh', max: 'max' },
    })).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
  it('honors explicit null holes and does not infer extended levels', () => {
    expect(piSupportedEfforts({ reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: 'max' },
    })).toEqual(['high', 'max']);
    expect(piSupportedEfforts({ reasoning: true })).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(piSupportedEfforts({ reasoning: true, thinkingLevelMap: null }))
      .toEqual(['minimal', 'low', 'medium', 'high']);
  });
  it('keeps non-reasoning models fixed regardless of stale mappings', () => {
    expect(piSupportedEfforts({ thinkingLevelMap: { high: 'high' } })).toEqual([]);
    expect(piSupportedEfforts({ reasoning: false, thinkingLevelMap: { high: 'high' } })).toEqual([]);
  });
  it('retains medium in the actual pinned Terra catalog', () => {
    const model = piNativeCatalogModels('openai-codex').find((m) => m.id === 'gpt-5.6-terra');
    expect(model?.efforts).toContain('medium');
    expect(model?.defaultEffort).toBe('medium');
  });
});
