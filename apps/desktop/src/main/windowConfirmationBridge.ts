import { randomUUID } from 'node:crypto';
import { HOST_CONFIRM_TIMEOUT_MS } from './maker-ipc/hostConfirmTiming.js';

export interface WindowConfirmationTarget<T> {
  id: number;
  send(request: T & { requestId: string }): boolean;
  dismiss(requestId: string): void;
}

interface PendingConfirmation<T> {
  target: WindowConfirmationTarget<T>;
  key?: string;
  resolve(confirmed: boolean): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort(): void;
}

/** Shared window-bound round trip extracted from the install-consent bridge.
 * Main owns the pending decision; delivery, abort and timeout never grant consent. */
export class WindowConfirmationBridge<T> {
  private readonly pending = new Map<string, PendingConfirmation<T>>();

  constructor(private readonly deps: { timeoutMs?: number; unavailableMessage?: string } = {}) {}

  request(
    target: WindowConfirmationTarget<T>,
    request: T,
    options: { signal?: AbortSignal; key?: string } = {},
  ): Promise<boolean> {
    if (options.signal?.aborted) return Promise.resolve(false);
    if (options.key && [...this.pending.values()].some(entry => entry.key === options.key))
      return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise<boolean>((resolve, reject) => {
      const abort = () => this.settle(requestId, false);
      const timer = setTimeout(abort, this.deps.timeoutMs ?? HOST_CONFIRM_TIMEOUT_MS);
      this.pending.set(requestId, { target, key: options.key, resolve, timer, signal: options.signal, abort });
      options.signal?.addEventListener('abort', abort, { once: true });
      let delivered = false;
      try {
        delivered = target.send({ ...request, requestId });
      } catch {
        // A closed or unavailable window cannot approve.
      }
      if (!delivered && this.pending.has(requestId)) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        reject(new Error(this.deps.unavailableMessage ?? 'Confirmation window unavailable'));
      } else if (options.signal?.aborted) abort();
    });
  }

  resolve(requesterId: number, requestId: string, confirmed: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.target.id !== requesterId) return false;
    this.settle(requestId, confirmed === true);
    return true;
  }

  cancelRequester(requesterId: number): void {
    for (const [id, entry] of [...this.pending])
      if (entry.target.id === requesterId) this.settle(id, false);
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, false);
  }

  get pendingCount(): number { return this.pending.size; }

  private settle(id: string, confirmed: boolean): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    try { entry.target.dismiss(id); } catch { /* Window already gone. */ }
    entry.resolve(confirmed);
  }
}
