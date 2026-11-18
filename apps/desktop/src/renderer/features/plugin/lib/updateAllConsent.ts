import type { GhostInstallConsentRequest } from '../../../../shared/ghostInstallConsent';

type Review = (requests: GhostInstallConsentRequest[], signal: AbortSignal) => Promise<Set<string>>;
type Collect = (request: GhostInstallConsentRequest, signal: AbortSignal, review: Review) => Promise<boolean>;

// Window-local rendezvous. Each token routes one real Main prompt, never grants consent.
const waiting = new Map<string, Collect>();

export function collectUpdateConsent(request: GhostInstallConsentRequest, signal: AbortSignal, review: Review) {
  if (!request.batchRowId || request.purpose || request.initiator !== 'user' || request.facts.kind !== 'update') return;
  return waiting.get(request.batchRowId)?.(request, signal, review);
}

export class UpdateAllConsent {
  private entries = new Map<string, { request: GhostInstallConsentRequest; answer: (yes: boolean) => void }>();
  private review?: Review;
  private readonly dismissed = new AbortController();

  /** Start the next download after this row finishes or Main pauses it for review. */
  track(install: (token: string) => Promise<void>) {
    const token = Array.from(crypto.getRandomValues(new Uint32Array(4)), word => word.toString(16).padStart(8, '0')).join('');
    let advance!: () => void;
    const paused = new Promise<void>(resolve => { advance = resolve; });
    waiting.set(token, (request, signal, review) => {
      waiting.delete(token);
      this.review = review;
      return new Promise<boolean>(resolve => {
        const abort = () => {
          answer(false);
          if (this.reviewing) this.dismissed.abort();
        };
        const answer = (yes: boolean) => {
          signal.removeEventListener('abort', abort);
          this.entries.delete(request.requestId);
          resolve(yes && !signal.aborted);
        };
        this.entries.set(request.requestId, { request, answer });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        advance();
      });
    });
    const done = install(token).finally(() => waiting.delete(token));
    return { done, ready: Promise.race([done, paused]) };
  }

  private reviewing = false;

  async finish(current: () => boolean) {
    const entries = [...this.entries.values()];
    let selected = new Set<string>();
    try {
      if (entries.length && this.review && current()) {
        this.reviewing = true;
        selected = await this.review(entries.map(entry => entry.request), this.dismissed.signal);
      }
    } finally {
      for (const { request, answer } of entries) {
        answer(current() && !this.dismissed.signal.aborted && selected.has(request.requestId));
      }
    }
  }
}
