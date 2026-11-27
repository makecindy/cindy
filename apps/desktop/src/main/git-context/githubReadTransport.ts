const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 6;
const MAX_CACHE_ENTRIES = 1_000;

function rateLimitBucket(path: string): 'graphql' | 'rest' {
  return path === '/graphql' || path.startsWith('/graphql?') ? 'graphql' : 'rest';
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
    const waiters = this.waitQueue.splice(0);
    for (const wake of waiters) wake(false);
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
