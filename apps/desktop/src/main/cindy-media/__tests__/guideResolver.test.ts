import { describe, expect, it, vi } from 'vitest';
import { resolveMediaGuide } from '../guideResolver.js';
const custom = { guideId: 'custom', revision: 'local-1' };
const official = { guideId: 'official', revision: 'public-1' };
// Unit: exercise discovery policy independently of any runtime or network.
describe('media Guide discovery', () => {
  it('prefers custom without reading official and observes the next get', async () => {
    let local: typeof custom | null = custom;
    const readOfficial = vi.fn(async () => official);
    const get = () => resolveMediaGuide('auto', { readCustom: () => local, readOfficial });
    expect(await get()).toEqual({ source: 'custom', value: custom });
    expect(readOfficial).not.toHaveBeenCalled();
    local = null;
    expect(await get()).toEqual({ source: 'official', value: official });
    local = { ...custom, revision: 'local-2' };
    expect(await get()).toEqual({ source: 'custom', value: local });
  });
  it('allows an explicit official attempt without changing either definition', async () => {
    expect(await resolveMediaGuide('official', { readCustom: () => custom, readOfficial: async () => official }))
      .toEqual({ source: 'official', value: official });
  });
  it('returns missing without retaining a negative result or swallowing a service failure', async () => {
    expect(await resolveMediaGuide('auto', { readCustom: () => null, readOfficial: async () => null })).toBeNull();
    await expect(resolveMediaGuide('auto', { readCustom: () => null, readOfficial: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
  });
});
