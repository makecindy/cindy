import { describe, expect, it } from 'vitest';
import { reserveModelIdForModel, type BucketSnapshotLike } from '../codexUsageBuckets.js';

describe('reserve entitlement validation', () => {
  const route = (reserve: BucketSnapshotLike) => reserveModelIdForModel({
    codex: { primary: { usedPercent: 100 } },
    base_model_inference: { normalModelSlug: 'gpt-5.6-luna', limitName: 'gpt-reserve', ...reserve },
  }, 'gpt-5.6-luna');

  it('requires positive evidence of available quota', () => {
    expect(route({ primary: { usedPercent: 40 } })).toBe('gpt-reserve');
    for (const usedPercent of [undefined, NaN, Infinity, -1, 100, 110]) {
      expect(route({ primary: { usedPercent } })).toBeNull();
    }
    expect(route({})).toBeNull();
    expect(route({ primary: { usedPercent: 40 }, secondary: { usedPercent: 100 } })).toBeNull();
  });

  it('does not treat arbitrary display names or another model as a wire route', () => {
    expect(route({ primary: { usedPercent: 40 }, limitName: 'another-model' })).toBeNull();
    expect(route({ primary: { usedPercent: 40 }, normalModelSlug: 'gpt-6-astra' })).toBeNull();
  });
});
