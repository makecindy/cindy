import { McpError } from '@modelcontextprotocol/sdk/types.js';

export const VIEW_STATE_KEY = 'cindy/view-state';
export const VIEW_STATE_METHOD = 'cindy/view-state/set';
export const VIEW_STATE_CAPABILITY = { version: 1, maxBytes: 65536, maxSessionBytes: 1048576 };
export interface ViewStateSnapshot { json: string | null; bytes: number }
export interface ViewStateStorage {
  read(): Promise<unknown>;
  save(snapshot: ViewStateSnapshot): Promise<void>;
}
export function viewStateError(code: string): McpError {
  const temporary = code === 'CINDY_VIEW_STATE_BUSY' || code === 'CINDY_VIEW_STATE_STORAGE_UNAVAILABLE';
  return new McpError(code === 'MCP_APP_CARD_UNAVAILABLE' ? -32000 : temporary ? -32603 : -32602,
    code, { code, ...(code === 'CINDY_VIEW_STATE_BUSY' ? { retryAfterMs: 500 } : {}) });
}
/** Validate before stringify: do not silently drop non-JSON fields or invoke accessors. */
export function viewStateSnapshot(state: unknown): ViewStateSnapshot {
  const invalid = () => { throw viewStateError('CINDY_VIEW_STATE_INVALID'); };
  if (state === null) return { json: null, bytes: 0 };
  if (typeof state !== 'object' || Array.isArray(state)) return invalid();
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 8192) invalid();
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || !value || depth > 16 || seen.has(value)) return invalid();
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) invalid();
    const data = value as Record<string, unknown>;
    if (Object.values(descriptors).some(d => !('value' in d))) invalid();
    if (data.type === 'resource_link' && typeof data.uri === 'string' && /^(cindy-media:|library:|handoff:)/i.test(data.uri))
      throw viewStateError('CINDY_VIEW_STATE_LOCAL_REFERENCE');
    if (array && (Object.keys(value).length !== value.length ||
        Object.keys(value).some((key, index) => key !== String(index)))) invalid();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable) invalid();
      visit(descriptor.value, depth + 1);
    }
    seen.delete(value);
  };
  visit(state, 1);
  const json = JSON.stringify(state);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > VIEW_STATE_CAPABILITY.maxBytes) throw viewStateError('CINDY_VIEW_STATE_TOO_LARGE');
  return { json, bytes };
}

interface Batch {
  snapshot: ViewStateSnapshot;
  done: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}
/** A pending batch's callers receive the same commit outcome, never an enqueue acknowledgement. */
export class ViewStateWriter {
  private inFlight?: Batch;
  private pending?: Batch;
  private requests = 0;
  constructor(private readonly save: ViewStateStorage['save']) {}
  get hasRequests(): boolean { return this.requests > 0; }
  barrier(): Promise<void> {
    // A failed write does not imply that the last committed snapshot cannot be read.
    return Promise.allSettled([this.inFlight?.done, this.pending?.done]).then(() => {});
  }
  async set(state: unknown): Promise<void> {
    if (this.requests >= 32) throw viewStateError('CINDY_VIEW_STATE_BUSY');
    const snapshot = viewStateSnapshot(state);
    this.requests++;
    try {
      if (this.pending) {
        this.pending.snapshot = snapshot;
        await this.pending.done;
      } else {
        let resolve!: () => void, reject!: (error: unknown) => void;
        const batch: Batch = { snapshot, done: new Promise<void>((yes, no) => { resolve = yes; reject = no; }),
          resolve: () => resolve(), reject: error => reject(error) };
        if (this.inFlight) this.pending = batch;
        else this.start(batch);
        await batch.done;
      }
    } finally { this.requests--; }
  }
  private start(batch: Batch): void {
    this.inFlight = batch;
    void Promise.resolve().then(() => this.save(batch.snapshot)).then(batch.resolve, batch.reject).finally(() => {
      this.inFlight = undefined;
      const next = this.pending;
      this.pending = undefined;
      if (next) this.start(next);
    });
  }
}
