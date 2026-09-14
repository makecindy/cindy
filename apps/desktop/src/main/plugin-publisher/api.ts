/**
 * Organization member upload HTTP client.
 *
 * Connection JWT only. skipAutoRefresh is required: a 401 on this audience is
 * not an Access Token expiry. Commit is always HTTP 202 — callers must read
 * body.status (expired is not a success).
 */
import {
  parseCommitPluginMemberUploadResponse,
  parseListMyPluginMemberReleasesResponse,
  parsePluginMemberUploadStatusResponse,
  parsePreparePluginMemberUploadRequest,
  parsePreparePluginMemberUploadResponse,
  type CommitPluginMemberUploadResponse,
  type ListMyPluginMemberReleasesResponse,
  type PluginMemberUploadStatusResponse,
  type PreparePluginMemberUploadResponse,
} from '@cindy/plugin-protocol';

import { getClientEndpoint } from '../clientEndpointsService.js';
import { createLogger } from '../logger.js';
import { ServerApiError, serverApiFetch, type ApiFetchOptions } from '../serverApiClient.js';

const PLUGIN_PUBLISHER_API_TIMEOUT_MS = 15_000;
export const UNKNOWN_FAILURE_CODE_REPORT_LIMIT = 64;
const CONNECTION_UNAUTHORIZED_CODES = new Set([
  'CONNECTION_UNAUTHORIZED',
  'INVALID_CONNECTION_TOKEN',
  'CONNECTION_TOKEN_EXPIRED',
]);

export class PluginPublisherApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PluginPublisherApiError';
  }
}

export interface PluginPublisherApiDeps {
  getToken(): Promise<string>;
  invalidateToken(): void;
  unknownFailureCodeReporter?: UnknownFailureCodeReporter;
  fetchImpl?: <T>(apiPath: string, options: Omit<ApiFetchOptions, 'baseUrl'>) => Promise<T>;
}

export interface UnknownFailureCodeReporter {
  report(code: string): void;
}

export function createUnknownFailureCodeReporter(
  reportUnknownCode: (code: string) => void,
): UnknownFailureCodeReporter {
  const reportedCodes = new Set<string>();
  return {
    report(code) {
      if (reportedCodes.has(code)) return;
      // Saturate instead of evicting: eviction lets a stream of new codes recycle old entries
      // and produce an unbounded warning flood.
      if (reportedCodes.size >= UNKNOWN_FAILURE_CODE_REPORT_LIMIT) return;
      reportedCodes.add(code);
      reportUnknownCode(code);
    },
  };
}

const log = createLogger('plugin-publisher');
const defaultUnknownFailureCodeReporter = createUnknownFailureCodeReporter((code) => {
  log.warn('plugin publisher received unknown member upload failure code', { code });
});

function wrapError(error: unknown): never {
  if (error instanceof PluginPublisherApiError) throw error;
  if (error instanceof ServerApiError) {
    throw new PluginPublisherApiError(error.code, error.statusCode, error.message);
  }
  throw error;
}

export class PluginPublisherApi {
  private readonly unknownFailureCodeReporter: UnknownFailureCodeReporter;

  constructor(private readonly deps: PluginPublisherApiDeps) {
    this.unknownFailureCodeReporter =
      deps.unknownFailureCodeReporter ?? defaultUnknownFailureCodeReporter;
  }

  private reportUnknownFailureCode(code: string): void {
    this.unknownFailureCodeReporter.report(code);
  }

  private inspectFailures(statuses: readonly PluginMemberUploadStatusResponse[]): void {
    for (const status of statuses) {
      if (status.failure?.knownCode === null) {
        this.reportUnknownFailureCode(status.failure.code);
      }
    }
  }

  private async authorizedFetch<T>(
    apiPath: string,
    options: Omit<ApiFetchOptions, 'baseUrl' | 'token' | 'skipAutoRefresh'>,
  ): Promise<T> {
    const fetchImpl =
      this.deps.fetchImpl ??
      ((path, opts) =>
        serverApiFetch(path, {
          ...opts,
          baseUrl: () => getClientEndpoint('pluginApiBaseUrl'),
        }));
    const request = async (token: string): Promise<T> =>
      fetchImpl<T>(apiPath, {
        cache: 'no-store',
        timeoutMs: PLUGIN_PUBLISHER_API_TIMEOUT_MS,
        redactErrorDetails: true,
        logLabel: '/api/publisher',
        allowedRedactedErrorCodes: [
          'FORBIDDEN',
          'MEMBERSHIP_INACTIVE',
          'INVALID_PARAMS',
          'RATE_LIMITED',
          'RATE_LIMIT_UNAVAILABLE',
          'AUTH_CONTEXT_UNAVAILABLE',
          'STORAGE_UNAVAILABLE',
          'CONNECTION_UNAUTHORIZED',
          'INVALID_CONNECTION_TOKEN',
          'CONNECTION_TOKEN_EXPIRED',
        ],
        ...options,
        token,
        skipAutoRefresh: true,
      });

    try {
      return await request(await this.deps.getToken());
    } catch (error) {
      if (
        error instanceof ServerApiError &&
        error.statusCode === 401 &&
        CONNECTION_UNAUTHORIZED_CODES.has(error.code)
      ) {
        this.deps.invalidateToken();
        try {
          return await request(await this.deps.getToken());
        } catch (retryError) {
          wrapError(retryError);
        }
      }
      wrapError(error);
    }
  }

  async prepare(input: { sizeBytes: number; sha256: string }): Promise<PreparePluginMemberUploadResponse> {
    const body = parsePreparePluginMemberUploadRequest(input);
    const raw = await this.authorizedFetch<unknown>('/api/publisher/uploads', {
      method: 'POST',
      body,
    });
    return parsePreparePluginMemberUploadResponse(raw);
  }

  async commit(uploadId: string): Promise<CommitPluginMemberUploadResponse> {
    const raw = await this.authorizedFetch<unknown>(
      `/api/publisher/uploads/${encodeURIComponent(uploadId)}/commit`,
      { method: 'POST', body: {} },
    );
    // HTTP 202 is success for serverApiFetch; expired is a body.status, not a 4xx.
    return parseCommitPluginMemberUploadResponse(raw);
  }

  async status(uploadId: string): Promise<PluginMemberUploadStatusResponse> {
    const raw = await this.authorizedFetch<unknown>(
      `/api/publisher/uploads/${encodeURIComponent(uploadId)}`,
      { method: 'GET' },
    );
    const response = parsePluginMemberUploadStatusResponse(raw);
    this.inspectFailures([response]);
    return response;
  }

  async listMine(cursor?: string): Promise<ListMyPluginMemberReleasesResponse> {
    const search = new URLSearchParams();
    if (cursor) search.set('cursor', cursor);
    const suffix = search.toString() ? `?${search.toString()}` : '';
    const raw = await this.authorizedFetch<unknown>(`/api/publisher/releases/mine${suffix}`, {
      method: 'GET',
    });
    const response = parseListMyPluginMemberReleasesResponse(raw);
    this.inspectFailures(response.releases);
    return response;
  }
}
