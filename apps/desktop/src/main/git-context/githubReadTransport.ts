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
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly now = Date.now,
  ) {}

  invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.pending.clear();
    this.retryAt.clear();
  }

  async read(
    scope: string,
    token: string,
    path: string,
    options: { body?: unknown; ttl?: number; refresh?: boolean } = {},
  ): Promise<unknown> {
    const key = `${scope}:${path}:${JSON.stringify(options.body ?? null)}`;
    const cached = this.cache.get(key);
    if (!options.refresh && cached && cached.observedAt + (options.ttl ?? 60_000) > this.now())
      return cached.data;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const operation = (async () => {
      if ((this.retryAt.get(scope) ?? 0) > this.now()) throw new Error('GITHUB_RATE_LIMITED');
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
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has('retry-after') ||
            response.headers.get('x-ratelimit-remaining') === '0'))
      ) {
        const retry = Number(response.headers.get('retry-after'));
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        this.retryAt.set(
          scope,
          Math.max(this.now() + (retry > 0 ? retry * 1000 : 60_000), reset || 0),
        );
      }
      if (response.status === 304 && cached) {
        cached.observedAt = this.now();
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
      if (data && typeof data === 'object') this.observations.set(data, this.now());
      if (JSON.stringify(data).length > 2_000_000) return data;
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { data, etag: response.headers.get('etag'), observedAt: this.now() });
      return data;
    })();
    this.pending.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    }
  }
}
