import { describe, expect, it, vi } from 'vitest';

import { loadPluginMediaAvailability } from '../pluginMediaCatalogFallback.js';

describe('loadPluginMediaAvailability', () => {
  it('keeps a ready local video catalog when Gateway discovery fails', async () => {
    await expect(
      loadPluginMediaAvailability('video', 1, async () => {
        throw new Error('gateway unavailable');
      }),
    ).resolves.toEqual({ models: [], unavailable: [], candidateCount: 0 });
  });

  it('preserves the Gateway failure when no local video fallback exists', async () => {
    const load = vi.fn(async () => {
      throw new Error('gateway unavailable');
    });

    await expect(loadPluginMediaAvailability('video', 0, load)).rejects.toThrow(
      'gateway unavailable',
    );
  });

  it('never applies the video fallback to image catalogs', async () => {
    await expect(
      loadPluginMediaAvailability('image', 1, async () => {
        throw new Error('gateway unavailable');
      }),
    ).rejects.toThrow('gateway unavailable');
  });
});
