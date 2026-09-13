import { describe, expect, it, vi } from 'vitest';

describe('generated effort inputs initialize without DOM or circular imports', () => {
  it.each(['effort-first', 'registry-first'])(
    '%s preserves registration order, caching and interpolation',
    async (order) => {
      vi.resetModules();
      expect(typeof document).toBe('undefined');
      if (order === 'registry-first') await import('../colors');
      const effort = await import('../effortTierColors');
      const { colorRegistry } = await import('../color-registry');
      const first = colorRegistry.getColors();
      await import('../colors');
      await import('../effortTierColors');
      expect(colorRegistry.getColors()).toEqual(first);
      expect(first.length).toBe(542);
      expect(first[0].id).toBe('surface');
      expect(effort.effortTierColor('high')).toBe('#3B82F6');
      expect(effort.effortTierColor('unknown')).toBe('#14B8A6');
      for (const [key, value] of Object.entries(effort.EFFORT_TIER_COLORS)) {
        for (const mode of ['light', 'dark'] as const)
          expect(colorRegistry.resolveDefault(`effort-tier-${key}`, mode)).toBe(value);
      }
      for (const [key, value] of Object.entries(effort.PRICE_TIER_COLORS)) {
        for (const mode of ['light', 'dark'] as const)
          expect(colorRegistry.resolveDefault(`price-tier-${key}`, mode)).toBe(value);
      }
    },
  );
});
