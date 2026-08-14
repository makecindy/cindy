import crypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { PluginMarketApi } from '../api';

const logger = vi.hoisted(() => ({
  warn: vi.fn(),
}));
const serverApi = vi.hoisted(() => {
  class TestServerApiError extends Error {
    constructor(
      public readonly code: string,
      public readonly statusCode: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ServerApiError: TestServerApiError, serverApiFetch: vi.fn() };
});

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: logger.warn, error: vi.fn() }),
}));
vi.mock('../../serverApiClient.js', () => serverApi);
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => 'https://plugins.example.com',
}));

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

function removal(pluginId: string, ghostId: string) {
  return {
    pluginId,
    ghostId,
    scope: 'organization',
    organizationId: 'org-1',
    action: 'purge',
    removedAt: '2026-08-03T08:00:00.000Z',
  };
}

/** 依序吐出各页响应（自动补 schemaVersion: 2）的 fetcher mock。 */
function pagedFetcher(...pages: Array<Record<string, unknown>>) {
  const fetcher = vi.fn();
  for (const page of pages) {
    fetcher.mockResolvedValueOnce({ schemaVersion: 2, ...page });
  }
  return fetcher;
}

describe('PluginMarketApi 默认 fetcher 的日志隐私', () => {
  it('⚠️ 默认 fetcher 走 serverApiFetch 时带 redactErrorDetails + logLabel（不外泄插件 ID）', async () => {
    // 2026-08-06 review：plugin 的 path 带用户装的插件 ID,4xx/5xx 日志不得外泄它。
    serverApi.serverApiFetch.mockReset();
    serverApi.serverApiFetch.mockRejectedValueOnce(new Error('nope'));
    await expect(new PluginMarketApi().detail('cindy-github')).rejects.toBeTruthy();
    const opts = serverApi.serverApiFetch.mock.calls[0]?.[1] ?? {};
    expect(opts.redactErrorDetails).toBe(true);
    expect(opts.logLabel).toBe('/api/plugins');
  });
});

describe('PluginMarketApi', () => {
  it('paginates with opaque cursors and deduplicates repeated ids', async () => {
    const fetcher = pagedFetcher(
      { plugins: [summary(PLUGIN_A, 'alpha')], nextCursor: PLUGIN_A },
      {
        plugins: [summary(PLUGIN_A, 'alpha'), summary(PLUGIN_B, 'beta')],
        nextCursor: null,
      },
    );
    const api = new PluginMarketApi(fetcher, () => '1.2.3');

    await expect(api.listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }, { id: PLUGIN_B }],
      removals: [],
    });
    expect(fetcher.mock.calls[1]?.[0]).toContain(`cursor=${PLUGIN_A}`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'x-cindy-version': '1.2.3' },
      timeoutMs: 15_000,
    });
  });

  it('deduplicates removals by pluginId across pages keeping the first-seen notice', async () => {
    const fetcher = pagedFetcher(
      {
        plugins: [],
        removals: [removal(PLUGIN_A, 'alpha')],
        nextCursor: PLUGIN_A,
      },
      {
        plugins: [],
        removals: [
          // 同 pluginId 但内容不同的后到通告必须被丢弃(保首见)。
          { ...removal(PLUGIN_A, 'alpha'), removedAt: '2026-08-04T00:00:00.000Z' },
          removal(PLUGIN_B, 'beta'),
        ],
        nextCursor: null,
      },
    );

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      plugins: [],
      removals: [
        { pluginId: PLUGIN_A, removedAt: '2026-08-03T08:00:00.000Z' },
        { pluginId: PLUGIN_B },
      ],
    });
  });

  it('keeps active plugins over conflicting removals across pages', async () => {
    const fetcher = pagedFetcher(
      {
        plugins: [],
        removals: [removal(PLUGIN_A, 'alpha'), removal(PLUGIN_B, 'beta')],
        nextCursor: PLUGIN_A,
      },
      { plugins: [summary(PLUGIN_A, 'alpha')], removals: [], nextCursor: null },
    );

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }],
      removals: [{ pluginId: PLUGIN_B }],
    });
    expect(logger.warn).toHaveBeenCalledWith('market removal ignored because plugin is active', {
      pluginId: PLUGIN_A,
    });
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

  it('posts the PR-2A successful-install contract with a short deadline', async () => {
    const eventId = '123e4567-e89b-42d3-a456-426614174000';
    const fetcher = vi.fn().mockResolvedValue({
      accepted: true,
      duplicate: false,
      eventId,
    });
    const api = new PluginMarketApi(fetcher, () => '1.2.3');

    await expect(api.recordInstallReceipt(PLUGIN_A, 'release-1', eventId)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      eventId,
    });
    expect(fetcher).toHaveBeenCalledWith(`/api/plugins/${PLUGIN_A}/install-events`, {
      cache: 'no-store',
      headers: { 'x-cindy-version': '1.2.3' },
      method: 'POST',
      body: { eventId, releaseId: 'release-1' },
      timeoutMs: 5_000,
      suppressAuthSideEffects: true,
    });
  });

  it('accepts the idempotent duplicate response and rejects response drift', async () => {
    const eventId = '123e4567-e89b-42d3-a456-426614174000';
    const duplicate = new PluginMarketApi(
      vi.fn().mockResolvedValue({ accepted: true, duplicate: true, eventId }),
    );
    await expect(
      duplicate.recordInstallReceipt(PLUGIN_A, 'release-1', eventId),
    ).resolves.toMatchObject({ duplicate: true, eventId });

    const drifted = new PluginMarketApi(
      vi.fn().mockResolvedValue({ accepted: true, duplicate: false, eventId: crypto.randomUUID() }),
    );
    await expect(drifted.recordInstallReceipt(PLUGIN_A, 'release-1', eventId)).rejects.toThrow(
      'response is invalid',
    );
  });

  it('marks terminal 4xx receipt failures as permanent but keeps retryable failures', async () => {
    const permanent = new PluginMarketApi(
      vi.fn().mockRejectedValue(new serverApi.ServerApiError('NOT_FOUND', 404, 'not found')),
    );
    await expect(
      permanent.recordInstallReceipt(PLUGIN_A, 'release-1', crypto.randomUUID()),
    ).rejects.toMatchObject({ name: 'PermanentPluginInstallReceiptError' });

    const retryableError = new serverApi.ServerApiError('RATE_LIMITED', 429, 'retry later');
    const retryable = new PluginMarketApi(vi.fn().mockRejectedValue(retryableError));
    await expect(
      retryable.recordInstallReceipt(PLUGIN_A, 'release-1', crypto.randomUUID()),
    ).rejects.toBe(retryableError);
  });
});
