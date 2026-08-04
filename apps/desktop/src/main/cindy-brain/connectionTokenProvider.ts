/**
 * Main-process-only Connection JWT cache. Tokens never persist and concurrent
 * requests for the same Membership/audience share one issuance operation.
 */
export interface IssuedConnectionToken {
  token: string;
  expiresIn: number;
  audience: string;
}

export interface ConnectionTokenProviderDeps {
  issue(audience: string): Promise<IssuedConnectionToken>;
  now?: () => number;
}

interface CachedConnectionToken {
  token: string;
  usableUntil: number;
}

const EXPIRY_MARGIN_MS = 60_000;
const MAX_TOKEN_CHARS = 32 * 1024;
const MAX_EXPIRES_IN_SECONDS = 1_800;

function cacheKey(membershipId: string, audience: string): string {
  return `${membershipId}\u0000${audience}`;
}

export class ConnectionTokenProvider {
  private readonly cache = new Map<string, CachedConnectionToken>();
  private readonly inflight = new Map<string, { generation: number; promise: Promise<string> }>();
  private readonly now: () => number;
  /**
   * Account-boundary generation. A late issuance from an old Membership must
   * neither re-enter the cache nor continue to an enterprise request.
   */
  private generation = 0;

  constructor(private readonly deps: ConnectionTokenProviderDeps) {
    this.now = deps.now ?? Date.now;
  }

  async getToken(input: { membershipId: string; audience: string }): Promise<string> {
    const key = cacheKey(input.membershipId, input.audience);
    const cached = this.cache.get(key);
    if (cached && this.now() < cached.usableUntil) return cached.token;
    if (cached) this.cache.delete(key);

    const generation = this.generation;
    let entry = this.inflight.get(key);
    if (!entry || entry.generation !== generation) {
      const promise = this.issueAndCache(key, input.audience, generation).finally(() => {
        if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
      });
      entry = { generation, promise };
      this.inflight.set(key, entry);
    }
    return entry.promise;
  }

  invalidate(input: { membershipId: string; audience: string }): void {
    this.cache.delete(cacheKey(input.membershipId, input.audience));
  }

  clearAll(): void {
    this.generation += 1;
    this.cache.clear();
    // The underlying HTTP call is not cancellable here, but new callers must
    // never join an issuance that started before the account boundary.
    this.inflight.clear();
  }

  private async issueAndCache(key: string, audience: string, generation: number): Promise<string> {
    const issued = await this.deps.issue(audience);
    if (
      typeof issued.token !== 'string' ||
      issued.token.length === 0 ||
      issued.token.length > MAX_TOKEN_CHARS ||
      issued.audience !== audience ||
      !Number.isSafeInteger(issued.expiresIn) ||
      issued.expiresIn <= 0 ||
      issued.expiresIn > MAX_EXPIRES_IN_SECONDS
    ) {
      throw new Error('Connection token issuer returned an invalid response');
    }
    if (generation !== this.generation) {
      throw new Error('Connection token request was superseded by an account change');
    }
    this.cache.set(key, {
      token: issued.token,
      usableUntil: this.now() + Math.max(0, issued.expiresIn * 1_000 - EXPIRY_MARGIN_MS),
    });
    return issued.token;
  }
}
