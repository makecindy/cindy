/** Bounded last-known metadata, never an execution grant or an authorization result. */
export const PROVIDER_METADATA_TRUST_MS = 30 * 60_000;

export interface ProviderMetadataContinuity { stale: boolean; remainingMs: number }
/** Known permission failures retire displayed metadata as well as host snapshots. */
export function isProviderAccessDeniedError(error: unknown): boolean {
  const row = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const message = typeof error === 'string' ? error : typeof row.message === 'string' ? row.message : '';
  const code = typeof row.code === 'string' && row.code !== 'IPC_ERROR' ? row.code
    : /\[([A-Z0-9_]+)\]/.exec(message)?.[1];
  // These two codes are produced only for explicit share/provider refusals,
  // not for ordinary network loss. Keep them separate from the broad pattern
  // so CHANNEL_NOT_ALLOWED and temporary transport errors keep their lifecycle.
  if (code === 'REMOTE_AGENT_SHARE_UNAVAILABLE' || code === 'REMOTE_AGENT_PROVIDER_NOT_ALLOWED') return true;
  return typeof code === 'string' && /REVOKED|DENIED|REMOVED|PAUSED|DISABLED|SUSPENDED|UNAUTHORIZED|FORBIDDEN|SCOPE_CHANGED/.test(code);
}
export function readProviderMetadataContinuity(value: unknown): ProviderMetadataContinuity | undefined {
  if (!value || typeof value !== 'object' || !('providerContinuity' in value)) return undefined;
  const stamp = (value as { providerContinuity: unknown }).providerContinuity;
  if (!stamp || typeof stamp !== 'object') return { stale: true, remainingMs: 0 };
  const row = stamp as { stale?: unknown; remainingMs?: unknown };
  return typeof row.stale === 'boolean' && typeof row.remainingMs === 'number' && Number.isFinite(row.remainingMs)
    && row.remainingMs > 0 && row.remainingMs <= PROVIDER_METADATA_TRUST_MS
    ? { stale: row.stale, remainingMs: row.remainingMs } : { stale: true, remainingMs: 0 };
}

/** View caches inherit a host deadline. Reading, mounting or forwarding never renews it. */
export class MetadataSnapshotExpiry {
  private readonly entries = new Map<string, { wall: number; mono: number; timer: ReturnType<typeof setTimeout>; expired(): void }>();
  forget(key: string): void {
    const entry = this.entries.get(key);
    if (entry) clearTimeout(entry.timer);
    this.entries.delete(key);
  }
  clear(): void { for (const key of this.entries.keys()) this.forget(key); }
  valid(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || (entry.wall > Date.now() && entry.mono > performance.now())) return true;
    this.forget(key); entry.expired();
    return false;
  }
  remember(key: string, value: unknown, requestedAt: { wall: number; mono: number }, expired: () => void): boolean {
    this.forget(key);
    const stamp = readProviderMetadataContinuity(value);
    if (!stamp) return true; // Older hosts retain their original view lifecycle.
    const wall = requestedAt.wall + stamp.remainingMs, mono = requestedAt.mono + stamp.remainingMs;
    const remaining = Math.min(wall - Date.now(), mono - performance.now());
    if (remaining <= 0) return false;
    const entry = { wall, mono, expired, timer: setTimeout(() => {
      if (this.entries.get(key) !== entry) return;
      this.forget(key); expired();
    }, remaining) };
    this.entries.set(key, entry);
    return true;
  }
}

export interface MetadataContinuityScope {
  /** Includes owner/realm and the current permission generation, not a renderer-supplied identity. */
  key: string;
  current(): boolean;
  signalingAvailable(): boolean;
  validForMs?: number;
  /** A forwarded snapshot carries its remaining budget, never a new 30-minute lease. */
  remainingTrustMs?(value: unknown): number;
  /** A host with its own directory generation/coalescing may deliberately refresh again. */
  joinPending?: boolean;
}

export interface MetadataContinuityResult<T> {
  value: T;
  stale: boolean;
  remainingMs: number;
}

interface Entry {
  snapshot?: { json: string; wallUntil: number; monoUntil: number };
  flight?: Promise<MetadataContinuityResult<unknown>>;
}

const SNAPSHOT_CHARACTER_BUDGET = 8 * 1024 * 1024;

/** Shared by all read entry points in one host; callers still enforce their own read permissions. */
export class MetadataContinuityReader {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: {
    retryable(error: unknown): boolean;
    wallNow?: () => number;
    monotonicNow?: () => number;
    refreshWaitMs?: number;
    /** Called when an authoritative denial retires a metadata resource. */
    onDenied?(resource: string, error: unknown): void;
  }) {}

  private wall(): number { return this.options.wallNow?.() ?? Date.now(); }
  private mono(): number { return this.options.monotonicNow?.() ?? performance.now(); }
  private id(scope: MetadataContinuityScope, resource: string): string { return JSON.stringify([scope.key, resource]); }

  invalidate(scope: MetadataContinuityScope, resource?: string): void {
    if (resource !== undefined) this.entries.delete(this.id(scope, resource));
    else for (const key of this.entries.keys()) if (JSON.parse(key)[0] === scope.key) this.entries.delete(key);
  }

  clear(): void { this.entries.clear(); }

  async read<T>(scope: MetadataContinuityScope, resource: string, request: () => Promise<T>): Promise<MetadataContinuityResult<T>> {
    const requireCurrent = () => {
      if (!scope.current()) throw new Error('Metadata scope changed');
    };
    requireCurrent();
    const key = this.id(scope, resource);
    let entry = this.entries.get(key);
    if (entry?.flight && scope.joinPending === false) {
      entry = { snapshot: entry.snapshot };
      this.entries.set(key, entry);
    }
    if (!entry) {
      // A safety bound on host metadata memory, not a limit on work or permission.
      if (this.entries.size >= 256) {
        const disposable = [...this.entries].find(([, value]) => !value.flight);
        if (disposable) this.entries.delete(disposable[0]);
        else {
          // The capacity bound limits storage, not the live reply. Use the same
          // request-start wall/mono anchor and forwarded remainder as the normal
          // flight so a healthy source is not reported as already expired.
          const wall = this.wall(), mono = this.mono();
          const requestedDuration = scope.validForMs ?? PROVIDER_METADATA_TRUST_MS;
          const duration = Number.isFinite(requestedDuration)
            ? Math.max(0, Math.min(PROVIDER_METADATA_TRUST_MS, requestedDuration)) : 0;
          const value = await request();
          requireCurrent();
          const forwarded = scope.remainingTrustMs?.(value) ?? duration;
          const lifetime = Number.isFinite(forwarded) ? Math.max(0, Math.min(duration, forwarded)) : 0;
          const remainingMs = Math.max(0, Math.min(wall + lifetime - this.wall(), mono + lifetime - this.mono()));
          return { value, stale: false, remainingMs };
        }
      }
      entry = {};
      this.entries.set(key, entry);
    }
    const currentEntry = entry;
    // Keep recently used directories when the bounded host cache needs space.
    this.entries.delete(key); this.entries.set(key, currentEntry);
    const cached = (): MetadataContinuityResult<T> | null => {
      requireCurrent();
      if (this.entries.get(key) !== currentEntry || !currentEntry.snapshot) return null;
      const remainingMs = Math.min(currentEntry.snapshot.wallUntil - this.wall(), currentEntry.snapshot.monoUntil - this.mono());
      if (remainingMs <= 0) { delete currentEntry.snapshot; return null; }
      return { value: JSON.parse(currentEntry.snapshot.json) as T, stale: true, remainingMs };
    };
    const snapshot = cached();
    if (snapshot && !scope.signalingAvailable()) return snapshot;
    if (!entry.flight) {
      const wall = this.wall(), mono = this.mono();
      const requestedDuration = scope.validForMs ?? PROVIDER_METADATA_TRUST_MS;
      const duration = Number.isFinite(requestedDuration)
        ? Math.max(0, Math.min(PROVIDER_METADATA_TRUST_MS, requestedDuration)) : 0;
      let resolveRequest!: (value: T) => void;
      let rejectRequest!: (error: unknown) => void;
      const response = new Promise<T>((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
      const flight = response.then(value => {
        requireCurrent();
        const forwarded = scope.remainingTrustMs?.(value) ?? duration;
        const lifetime = Number.isFinite(forwarded) ? Math.max(0, Math.min(duration, forwarded)) : 0;
        const remainingMs = Math.min(wall + lifetime - this.wall(), mono + lifetime - this.mono());
        if (this.entries.get(key) === currentEntry && remainingMs > 0) {
          const json = JSON.stringify(value);
          // Directory responses are bounded on the wire; avoid retaining oversized
          // metadata or unbounded caller-created objects in host memory as well.
          if (json !== undefined && json.length <= 4 * 1024 * 1024) {
            let retained = [...this.entries.values()].reduce((total, value) => total
              + (value === currentEntry ? 0 : value.snapshot?.json.length ?? 0), 0);
            for (const [otherKey, other] of this.entries) {
              if (retained + json.length <= SNAPSHOT_CHARACTER_BUDGET) break;
              if (other === currentEntry || !other.snapshot) continue;
              retained -= other.snapshot.json.length; delete other.snapshot;
              if (!other.flight) this.entries.delete(otherKey);
            }
            currentEntry.snapshot = { json, wallUntil: wall + lifetime, monoUntil: mono + lifetime };
          } else delete currentEntry.snapshot;
        }
        return { value, stale: false, remainingMs: Math.max(0, remainingMs) };
      }).catch(error => {
        const retryable = this.options.retryable(error);
        if (!retryable && this.entries.get(key) === currentEntry) this.entries.delete(key);
        if (!retryable && scope.current()) {
          try { this.options.onDenied?.(resource, error); } catch { /* display invalidation is best-effort */ }
        }
        const fallback = retryable ? cached() : null;
        if (fallback) return fallback;
        throw error;
      }).finally(() => {
        if (currentEntry.flight === flight) delete currentEntry.flight;
      });
      currentEntry.flight = flight;
      // Publish the single-flight before invoking user code, but preserve the
      // existing synchronous request-start edge (directory epochs rely on it).
      try { void Promise.resolve(request()).then(resolveRequest, rejectRequest); }
      catch (error) { rejectRequest(error); }
    }
    const flight = currentEntry.flight as Promise<MetadataContinuityResult<T>>;
    if (!snapshot) return flight;
    // A hung directory must not block an already verified model list. The one
    // read remains shared; late authoritative denial invalidates its snapshot.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fallback = new Promise<MetadataContinuityResult<T>>((resolve, reject) => {
      timer = setTimeout(() => {
        try {
          const value = cached();
          if (value) resolve(value); else void flight.then(resolve, reject);
        } catch (error) { reject(error); }
      }, this.options.refreshWaitMs ?? 2_000);
    });
    try { return await Promise.race([flight, fallback]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
