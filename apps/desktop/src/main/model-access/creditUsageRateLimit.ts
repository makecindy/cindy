import { ServerApiError, type ApiFetchOptions, type createServerApiClient } from '../serverApiClient.js';

type ServerFetch = ReturnType<typeof createServerApiClient>;
interface ReadScope { /** Realm and membership identity, supplied by the launcher. */ owner: string; generation: number }

/** Includes a 429 whose response body was interrupted after its headers arrived. */
export function isCreditUsageRateLimited(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const row = error as { statusCode?: number; httpStatus?: number; retryAt?: number };
  return row.statusCode === 429 || row.httpStatus === 429
    || (typeof row.retryAt === 'number' && Number.isFinite(row.retryAt) && row.retryAt > Date.now());
}

/**
 * The three credit-usage readers share only server-provided retry deadlines,
 * never amounts, authorization results or retries. Each physical hop, including
 * a 401 refresh, checks its actual endpoint. Other routes and writes pass through.
 */
export function createCreditUsageRateLimitFetch(fetch: ServerFetch, scope: () => ReadScope | null): ServerFetch {
  const deadlines = new Map<string, number>();
  return async function creditUsageFetch<T>(path: string, options: ApiFetchOptions): Promise<T> {
    if (path !== '/api/model-access/credit-usage' || (options.method ?? 'GET').toUpperCase() !== 'GET'
      || options.token !== undefined || options.authorization !== undefined) return fetch<T>(path, options);
    const initial = scope();
    if (!initial) throw new ServerApiError('PRECONDITION_FAILED', 409, 'Credit usage account changed');
    const captured = { ...initial };
    const assertCurrent = () => {
      const current = scope();
      if (current?.owner !== captured.owner || current.generation !== captured.generation) {
        throw new ServerApiError('PRECONDITION_FAILED', 409, 'Credit usage account changed');
      }
    };
    assertCurrent();
    const resolveBase = () => typeof options.baseUrl === 'function' ? options.baseUrl() : options.baseUrl;
    let lastBase: string | undefined;
    try {
      const value = await fetch<T>(path, { ...options, beforeHop(base) {
        assertCurrent();
        options.beforeHop?.(base);
        lastBase = base;
        const retryAt = deadlines.get(JSON.stringify([captured.owner, base]));
        if (retryAt !== undefined && retryAt > Date.now()) {
          throw new ServerApiError('RATE_LIMITED', 429, 'Credit usage is temporarily rate limited', retryAt, base);
        }
      } });
      assertCurrent();
      if (lastBase !== resolveBase()) throw new ServerApiError('PRECONDITION_FAILED', 409, 'Credit usage endpoint changed');
      // A concurrent success must not erase a newer 429 deadline.
      return value;
    } catch (error) {
      assertCurrent();
      const row = error as { retryAt?: unknown; servedBaseUrl?: unknown } | null;
      if (typeof row?.retryAt === 'number' && Number.isFinite(row.retryAt) && row.retryAt > Date.now()) {
        const base = typeof row.servedBaseUrl === 'string' ? row.servedBaseUrl : lastBase;
        if (base !== undefined) {
          const key = JSON.stringify([captured.owner, base]);
          // Deadlines survive same-account generation repairs; generations only
          // fence late results. Memory is bounded across account/endpoint changes.
          for (const [id, until] of deadlines) if (until <= Date.now()) deadlines.delete(id);
          if (!deadlines.has(key) && deadlines.size >= 32) deadlines.delete(deadlines.keys().next().value!);
          deadlines.set(key, Math.max(deadlines.get(key) ?? 0, row.retryAt));
        }
      }
      throw error;
    }
  };
}
