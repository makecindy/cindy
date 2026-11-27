const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 6;
const MAX_CACHE_ENTRIES = 1_000;

export type GithubRateLimitPressure = 'normal' | 'low' | 'critical' | 'exhausted';

export interface GithubRateLimitStatus {
  level: GithubRateLimitPressure;
  remaining?: number;
  limit?: number;
  resetAt?: number;
}

interface QuotaEntry {
  remaining: number;
  limit: number;
  resetAt: number;
  observedAt: number;
}

const PRESSURE_RANK: Record<GithubRateLimitPressure, number> = {
  normal: 0,
  low: 1,
  critical: 2,
  exhausted: 3,
};

function rateLimitBucket(path: string): 'graphql' | 'rest' {
  return path === '/graphql' || path.startsWith('/graphql?') ? 'graphql' : 'rest';
}

function bucketFromHeader(resource: string | null, fallback: 'graphql' | 'rest'): 'graphql' | 'rest' {
  const trimmed = resource?.trim().toLowerCase();
  if (trimmed === 'graphql') return 'graphql';
  if (trimmed === 'core') return 'rest';
  return fallback;
}

function parseRetryAfterMs(raw: string | null, now: number): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs) && dateMs > now) return dateMs;
  return null;
}

function rateLimitedError(): Error {
  return Object.assign(new Error('GITHUB_RATE_LIMITED'), { code: 'GITHUB_RATE_LIMITED' });
}

/** Account-scoped conditional reads and backoff shared by badges, tools and scripts. */
export class GithubReadTransport {
  private cache = new Map<string, { data: unknown; etag: string | null; observedAt: number }>();
  private pending = new Map<string, Promise<unknown>>();
  private generation = 0;
  private observations = new WeakMap<object, number>();
  observedAt(data: unknown): number {
    return data && typeof data === 'object'
      ? (this.observations.get(data) ?? this.now())
      : this.now();
  }
  private retryAt = new Map<string, number>();
  private quota = new Map<string, QuotaEntry>();
  private activeRequests = 0;
  private waitQueue: Array<(acquired: boolean) => void> = [];
  private readonly maxConcurrent: number;
  private readonly maxCacheEntries: number;
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly now = Date.now,
    maxConcurrent = DEFAULT_MAX_CONCURRENT_REQUESTS,
    maxCacheEntries = MAX_CACHE_ENTRIES,
  ) {
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    this.maxCacheEntries = Math.max(1, Math.floor(maxCacheEntries));
  }

  private putCache(
    key: string,
    entry: { data: unknown; etag: string | null; observedAt: number },
  ): void {
    this.cache.delete(key);
    while (this.cache.size >= this.maxCacheEntries) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, entry);
  }

  invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.pending.clear();
    this.retryAt.clear();
    this.quota.clear();
    const waiters = this.waitQueue.splice(0);
    for (const wake of waiters) wake(false);
  }

  private recordQuota(scope: string, fallbackBucket: 'graphql' | 'rest', headers: Headers): void {
    const rawRemaining = headers.get('x-ratelimit-remaining');
    const rawLimit = headers.get('x-ratelimit-limit');
    const rawReset = headers.get('x-ratelimit-reset');
    if (rawRemaining === null || rawLimit === null || rawReset === null) return;
    const remaining = Number(rawRemaining.trim());
    const limit = Number(rawLimit.trim());
    const resetSec = Number(rawReset.trim());
    if (
      !Number.isFinite(remaining) || remaining < 0 ||
      !Number.isFinite(limit) || limit <= 0 ||
      !Number.isFinite(resetSec) || resetSec <= 0
    ) {
      return;
    }
    const bucket = bucketFromHeader(headers.get('x-ratelimit-resource'), fallbackBucket);
    const now = this.now();
    this.quota.set(`${scope}:${bucket}`, {
      remaining: Math.floor(remaining),
      limit: Math.floor(limit),
      resetAt: resetSec * 1000,
      observedAt: now,
    });
  }

  /** Inspect live rate-limit pressure for adaptive background polling; auto-recovers once resetAt passes. */
  getRateLimitPressure(scope: string, bucket: 'graphql' | 'rest' = 'rest'): GithubRateLimitStatus {
    const now = this.now();
    const entry = this.quota.get(`${scope}:${bucket}`);
    const freshEntry = entry && entry.resetAt > now ? entry : undefined;
    if (this.isRateLimited(scope, bucket)) {
      return {
        level: 'exhausted',
        ...(freshEntry ? { remaining: freshEntry.remaining, limit: freshEntry.limit, resetAt: freshEntry.resetAt } : {}),
      };
    }
    if (!freshEntry) return { level: 'normal' };
    const { remaining, limit, resetAt } = freshEntry;
    if (remaining === 0) return { level: 'exhausted', remaining, limit, resetAt };
    if (remaining <= Math.max(50, Math.floor(limit * 0.05))) {
      return { level: 'critical', remaining, limit, resetAt };
    }
    if (remaining <= Math.max(200, Math.floor(limit * 0.2))) {
      return { level: 'low', remaining, limit, resetAt };
    }
    return { level: 'normal', remaining, limit, resetAt };
  }

  getCombinedRateLimitPressure(scope: string): GithubRateLimitPressure {
    const rest = this.getRateLimitPressure(scope, 'rest').level;
    const gql = this.getRateLimitPressure(scope, 'graphql').level;
    return PRESSURE_RANK[gql] >= PRESSURE_RANK[rest] ? gql : rest;
  }

  private isRateLimited(scope: string, bucket: 'graphql' | 'rest'): boolean {
    const now = this.now();
    return (
      (this.retryAt.get(scope) ?? 0) > now || (this.retryAt.get(`${scope}:${bucket}`) ?? 0) > now
    );
  }

  private waitForSlot(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  private releaseSlot(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next(true);
      return;
    }
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  async read(
    scope: string,
    token: string,
    path: string,
    options: { body?: unknown; ttl?: number; refresh?: boolean } = {},
  ): Promise<unknown> {
    const key = `${scope}:${path}:${JSON.stringify(options.body ?? null)}`;
    const cached = this.cache.get(key);
    if (!options.refresh && cached && cached.observedAt + (options.ttl ?? 60_000) > this.now()) {
      this.putCache(key, cached);
      return cached.data;
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const bucket = rateLimitBucket(path);
    const operation = (async () => {
      if (this.isRateLimited(scope, bucket)) throw rateLimitedError();
      if (this.activeRequests < this.maxConcurrent) {
        this.activeRequests += 1;
      } else {
        const acquired = await this.waitForSlot();
        if (!acquired) throw new Error('GITHUB_AUTH_CHANGED');
      }
      try {
        if (generation !== this.generation) throw new Error('GITHUB_AUTH_CHANGED');
        if (this.isRateLimited(scope, bucket)) throw rateLimitedError();
        const response = await this.fetchImpl(`https://api.github.com${path}`, {
          method: options.body ? 'POST' : 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(!options.body && cached?.etag ? { 'If-None-Match': cached.etag } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });
        if (generation !== this.generation) throw new Error('GITHUB_AUTH_CHANGED');
        this.recordQuota(scope, bucket, response.headers);
        const primaryExhausted = response.headers.get('x-ratelimit-remaining')?.trim() === '0';
        const hasRetryAfter = response.headers.has('retry-after');
        if (
          response.status === 429 ||
          (response.status === 403 && (primaryExhausted || hasRetryAfter))
        ) {
          const now = this.now();
          const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), now);
          if (primaryExhausted) {
            const resetSec = Number(response.headers.get('x-ratelimit-reset'));
            const resetMs = Number.isFinite(resetSec) && resetSec > 0 ? resetSec * 1000 : 0;
            const until = Math.max(resetMs, retryAfterMs ?? 0);
            const bucketKey = `${scope}:${bucket}`;
            this.retryAt.set(
              bucketKey,
              Math.max(
                this.retryAt.get(bucketKey) ?? 0,
                until > now ? until : now + DEFAULT_RATE_LIMIT_BACKOFF_MS,
              ),
            );
          } else {
            // Secondary rate limits still carry the hourly primary x-ratelimit-reset header
            // even with remaining quota; back off only by retry-after (or the short default).
            const until = retryAfterMs ?? now + DEFAULT_RATE_LIMIT_BACKOFF_MS;
            this.retryAt.set(scope, Math.max(this.retryAt.get(scope) ?? 0, until));
          }
        }
        if (response.status === 304 && cached) {
          cached.observedAt = this.now();
          this.putCache(key, cached);
          if (cached.data && typeof cached.data === 'object')
            this.observations.set(cached.data, cached.observedAt);
          return cached.data;
        }
        if (!response.ok)
          throw Object.assign(new Error(`GITHUB_HTTP_${response.status}`), {
            status: response.status,
          });
        const data: unknown = await response.json();
        if (generation !== this.generation) throw new Error('GITHUB_AUTH_CHANGED');
        const observedAt = this.now();
        if (data && typeof data === 'object') this.observations.set(data, observedAt);
        const etag = response.headers.get('etag');
        const ttl = options.ttl ?? 60_000;
        // Skip caching responses that can neither serve a TTL hit nor revalidate via If-None-Match
        // (e.g. POST /graphql status reads with ttl: 0), so they do not evict reusable REST ETags.
        const reusable = ttl > 0 || (!options.body && Boolean(etag));
        if (!reusable || JSON.stringify(data).length > 2_000_000) {
          this.cache.delete(key);
          return data;
        }
        this.putCache(key, { data, etag, observedAt });
        return data;
      } finally {
        this.releaseSlot();
      }
    })();
    this.pending.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    }
  }
}
