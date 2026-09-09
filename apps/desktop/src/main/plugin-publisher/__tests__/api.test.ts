import { describe, expect, it, vi } from 'vitest';

import { ServerApiError } from '../../serverApiClient.js';
import {
  createUnknownFailureCodeReporter,
  PluginPublisherApi,
  UNKNOWN_FAILURE_CODE_REPORT_LIMIT,
} from '../api.js';

const SHA = 'a'.repeat(64);

function okPrepare() {
  return {
    uploadId: 'upload-1',
    putUrl: 'https://bucket.example.test/object',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-oss-forbid-overwrite': 'true',
    },
    expiresAt: '2026-08-19T08:15:00.000Z',
    status: 'awaiting_upload',
  };
}

describe('PluginPublisherApi', () => {
  it('prepare / status / list use Connection JWT and skip Access Token refresh', async () => {
    const fetchImpl = vi.fn(async (apiPath: string) => {
      if (apiPath === '/api/publisher/uploads') return okPrepare();
      if (apiPath.startsWith('/api/publisher/uploads/upload-1') && !apiPath.endsWith('/commit')) {
        return {
          uploadId: 'upload-1',
          status: 'validating',
          pluginId: null,
          releaseId: null,
          ghostId: null,
          version: null,
          reviewStatus: null,
          failure: null,
        };
      }
      return { releases: [], nextCursor: null };
    });
    const api = new PluginPublisherApi({
      getToken: async () => 'conn-token',
      invalidateToken: vi.fn(),
      fetchImpl: fetchImpl as never,
    });

    await api.prepare({ sizeBytes: 12, sha256: SHA });
    await api.status('upload-1');
    await api.listMine();

    expect(fetchImpl).toHaveBeenCalled();
    for (const call of fetchImpl.mock.calls as unknown as Array<[string, Record<string, unknown>]>) {
      const opts = call[1];
      expect(opts.token).toBe('conn-token');
      expect(opts.skipAutoRefresh).toBe(true);
      expect(opts.redactErrorDetails).toBe(true);
      expect(opts.logLabel).toBe('/api/publisher');
    }
  });

  it('reads commit body.status so HTTP 202 expired is not success', async () => {
    const api = new PluginPublisherApi({
      getToken: async () => 'conn-token',
      invalidateToken: vi.fn(),
      fetchImpl: (async () => ({ uploadId: 'upload-1', status: 'expired' })) as never,
    });
    await expect(api.commit('upload-1')).resolves.toEqual({
      uploadId: 'upload-1',
      status: 'expired',
    });
  });

  it('invalidates and reissues the Connection JWT once after 401', async () => {
    const invalidateToken = vi.fn();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new ServerApiError('CONNECTION_TOKEN_EXPIRED', 401, 'expired');
      }
      return { uploadId: 'upload-1', status: 'validating' };
    });
    const api = new PluginPublisherApi({
      getToken: async () => `token-${calls + 1}`,
      invalidateToken,
      fetchImpl: fetchImpl as never,
    });
    await expect(api.commit('upload-1')).resolves.toMatchObject({ status: 'validating' });
    expect(invalidateToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports an unknown bounded failure code once without forwarding its message', async () => {
    const onUnknownFailureCode = vi.fn();
    const unknownFailure = {
      code: 'PUBLISH_FUTURE_POLICY',
      message: 'user-facing server detail that must not enter the warning',
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        uploadId: 'upload-unknown',
        status: 'failed',
        pluginId: null,
        releaseId: null,
        ghostId: null,
        version: null,
        reviewStatus: null,
        failure: unknownFailure,
      })
      .mockResolvedValueOnce({
        releases: [
          {
            uploadId: 'upload-unknown',
            status: 'failed',
            pluginId: null,
            releaseId: null,
            ghostId: null,
            version: null,
            reviewStatus: null,
            failure: unknownFailure,
            createdAt: '2026-08-19T08:15:00.000Z',
            updatedAt: '2026-08-19T08:16:00.000Z',
          },
        ],
        nextCursor: null,
      });
    const api = new PluginPublisherApi({
      getToken: async () => 'conn-token',
      invalidateToken: vi.fn(),
      unknownFailureCodeReporter: createUnknownFailureCodeReporter(onUnknownFailureCode),
      fetchImpl: fetchImpl as never,
    });

    const status = await api.status('upload-unknown');
    const list = await api.listMine();

    expect(onUnknownFailureCode).toHaveBeenCalledOnce();
    expect(onUnknownFailureCode).toHaveBeenCalledWith('PUBLISH_FUTURE_POLICY');
    expect(status.failure?.message).toBe(unknownFailure.message);
    expect(list.releases[0]?.failure?.message).toBe(unknownFailure.message);
  });

  it('saturates unknown failure reports instead of evicting and flooding logs', () => {
    expect(UNKNOWN_FAILURE_CODE_REPORT_LIMIT).toBe(64);

    const onUnknownFailureCode = vi.fn();
    const reporter = createUnknownFailureCodeReporter(onUnknownFailureCode);

    for (let index = 0; index <= UNKNOWN_FAILURE_CODE_REPORT_LIMIT; index += 1) {
      reporter.report(`FUTURE_CODE_${index}`);
    }
    // An eviction policy would report the 65th code and could keep warning forever.
    reporter.report('FUTURE_CODE_0');

    expect(onUnknownFailureCode).toHaveBeenCalledTimes(UNKNOWN_FAILURE_CODE_REPORT_LIMIT);
    expect(onUnknownFailureCode).not.toHaveBeenCalledWith(
      `FUTURE_CODE_${UNKNOWN_FAILURE_CODE_REPORT_LIMIT}`,
    );
  });
});
