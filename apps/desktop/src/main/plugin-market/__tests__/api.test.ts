import { describe, expect, it, vi } from 'vitest';

import { PluginMarketApi } from '../api';

const PLUGIN_A = `c${'a'.repeat(24)}`;
const PLUGIN_B = `c${'b'.repeat(24)}`;

function summary(id: string, ghostId: string) {
  return {
    id,
    ghostId,
    name: ghostId,
    description: null,
    author: null,
    scope: 'public',
    organizationId: null,
    defaultInstall: false,
    currentRelease: {
      id: `release-${ghostId}`,
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
      publishedAt: '2026-07-23T00:00:00.000Z',
    },
  };
}

describe('PluginMarketApi', () => {
  it('paginates with opaque cursors and deduplicates repeated ids', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 2,
        plugins: [summary(PLUGIN_A, 'alpha')],
        nextCursor: PLUGIN_A,
      })
      .mockResolvedValueOnce({
        schemaVersion: 2,
        plugins: [summary(PLUGIN_A, 'alpha'), summary(PLUGIN_B, 'beta')],
        nextCursor: null,
      });
    const api = new PluginMarketApi(fetcher);

    await expect(api.listAll()).resolves.toHaveLength(2);
    expect(fetcher.mock.calls[1]?.[0]).toContain(`cursor=${PLUGIN_A}`);
  });

  it('fails closed when the server still returns schema v1', async () => {
    const api = new PluginMarketApi(
      vi.fn().mockResolvedValue({
        schemaVersion: 1,
        plugins: [],
        nextCursor: null,
      }),
    );

    await expect(api.listAll()).rejects.toThrow('schemaVersion');
  });

  it('rejects a cursor that does not advance', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      schemaVersion: 2,
      plugins: [],
      nextCursor: PLUGIN_A,
    });
    const api = new PluginMarketApi(fetcher);

    await expect(api.listAll()).rejects.toThrow('游标未前进');
  });
});
