import type { GhostInstallConsentRequest } from '../../../../shared/ghostInstallConsent';

export interface UpdateReviewList {
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly GhostInstallConsentRequest[];
}
type Review = (requests: UpdateReviewList, signal: AbortSignal) => Promise<Set<string>>;
type Collect = (request: GhostInstallConsentRequest, signal: AbortSignal, review: Review) => Promise<boolean>;

// Window-local rendezvous. Each token routes one real Main prompt, never grants consent.
const waiting = new Map<string, Collect>();

export function collectUpdateConsent(request: GhostInstallConsentRequest, signal: AbortSignal, review: Review) {
  if (!request.batchRowId || request.purpose || request.initiator !== 'user' || request.facts.kind !== 'update') return;
  return waiting.get(request.batchRowId)?.(request, signal, review);
}

// Do not spend the Host's nine-minute decision window waiting on other downloads.
// Usually finish() flushes first. A stalled download must not postpone already verified rows.
const COLLECTION_WINDOW_MS = 30_000;

export class UpdateAllConsent {
  private timer?: ReturnType<typeof setTimeout>;
  private reviewInFlight?: Promise<void>;
  private entries = new Map<string, { request: GhostInstallConsentRequest; answer: (yes: boolean) => void }>();
  private review?: Review;
  private visible?: AbortController;
  private listeners = new Set<() => void>();
  private snapshot: GhostInstallConsentRequest[] = [];
  private readonly list: UpdateReviewList = {
    subscribe: listener => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    getSnapshot: () => this.snapshot,
  };

  constructor(private readonly current: () => boolean = () => true) {}

  private changed() {
    if (!this.visible) return;
    this.snapshot = Array.from(this.entries.values(), entry => entry.request);
    this.listeners.forEach(listener => listener());
    if (!this.snapshot.length) this.visible.abort();
  }

  /** Start the next download after this row finishes or Main pauses it for review. */
  track(install: (token: string) => Promise<void>) {
    const token = Array.from(crypto.getRandomValues(new Uint32Array(4)), word => word.toString(16).padStart(8, '0')).join('');
    let advance!: () => void;
    const paused = new Promise<void>(resolve => { advance = resolve; });
    waiting.set(token, (request, signal, review) => {
      waiting.delete(token);
      this.review = review;
      return new Promise<boolean>(resolve => {
        const abort = () => answer(false);
        const answer = (yes: boolean) => {
          signal.removeEventListener('abort', abort);
          this.entries.delete(request.requestId);
          this.changed();
          resolve(yes && !signal.aborted);
        };
        this.entries.set(request.requestId, { request, answer });
        signal.addEventListener('abort', abort, { once: true });
        this.changed();
        if (signal.aborted) abort();
        if (!this.visible && this.timer === undefined) {
          this.timer = setTimeout(() => { void this.flush(); }, COLLECTION_WINDOW_MS);
        }
        advance();
      });
    });
    const done = install(token).finally(() => waiting.delete(token));
    return { done, ready: Promise.race([done, paused]) };
  }

  private flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.reviewInFlight) return this.reviewInFlight;
    const review = this.review;
    if (!this.entries.size || !review) return Promise.resolve();
    const dismissed = new AbortController();
    this.visible = dismissed;
    this.changed();
    const run = async () => {
      let selected = new Set<string>();
      try {
        if (this.current()) selected = await review(this.list, dismissed.signal);
      } catch {
        // An unavailable review surface cannot authorize an update.
      } finally {
        this.visible = undefined;
        for (const { request, answer } of this.entries.values()) {
          answer(this.current() && !dismissed.signal.aborted && selected.has(request.requestId));
        }
        this.reviewInFlight = undefined;
      }
    };
    this.reviewInFlight = Promise.resolve().then(run);
    return this.reviewInFlight;
  }

  async finish() {
    do { await this.flush(); } while (this.entries.size);
  }
}
