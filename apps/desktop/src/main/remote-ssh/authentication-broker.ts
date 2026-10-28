import { randomUUID } from 'node:crypto';
import {
  INTERACTIVE_AUTH_TIMEOUT_MS, INTERACTIVE_AUTH_MAX_ANSWER_LENGTH,
  type KeyboardInteractiveChallenge,
} from '@cindy/maker-remote-ssh';
import type { SshAuthenticationRequest } from '../../shared/sshAuthentication.js';

export interface SshAuthenticationTarget {
  id: number;
  current(): boolean;
  send(request: SshAuthenticationRequest): void;
  dismiss(requestId: string): void;
}

interface Pending {
  target: SshAuthenticationTarget;
  request: SshAuthenticationRequest;
  resolve(answers: string[] | null): void;
  signal: AbortSignal;
  abort(): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Local window-bound exchange. Only the waiting SSH callback receives answers. */
export class SshAuthenticationBroker {
  private readonly pending = new Map<string, Pending>();

  request(target: SshAuthenticationTarget, challenge: KeyboardInteractiveChallenge, signal: AbortSignal): Promise<string[] | null> {
    if (signal.aborted || !target.current()) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise(resolve => {
      const request = { ...challenge, requestId, expiresAt: Date.now() + INTERACTIVE_AUTH_TIMEOUT_MS };
      const abort = () => this.settle(requestId, null);
      const timer = setTimeout(abort, INTERACTIVE_AUTH_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { target, request, resolve, signal, abort, timer });
      signal.addEventListener('abort', abort, { once: true });
      try { target.send(request); } catch { abort(); }
      if (signal.aborted) abort();
    });
  }

  list(targetId: number): SshAuthenticationRequest[] {
    return [...this.pending.values()].filter(p => p.target.id === targetId && p.target.current())
      .map(p => p.request);
  }

  submit(targetId: number, requestId: unknown, input: unknown): boolean {
    try {
      if (typeof requestId !== 'string' || requestId.length > 128) return false;
      const entry = this.pending.get(requestId);
      if (!entry || entry.target.id !== targetId) return false;
      if (!entry.target.current() || entry.signal.aborted || Date.now() >= entry.request.expiresAt) {
        this.settle(requestId, null);
        return false;
      }
      if (input !== null && (!Array.isArray(input) || input.length !== entry.request.prompts.length
        || !input.every(a => typeof a === 'string' && a.length <= INTERACTIVE_AUTH_MAX_ANSWER_LENGTH))) return false;
      this.settle(requestId, input === null ? null : [...input as string[]]);
      return true;
    } finally {
      // Even rejected, stale and wrong-window submissions leave no answer here.
      if (Array.isArray(input)) input.fill('');
    }
  }

  cancelTarget(targetId: number): void {
    for (const [id, entry] of this.pending) if (entry.target.id === targetId) this.settle(id, null);
  }

  cancelAll(): void {
    for (const id of this.pending.keys()) this.settle(id, null);
  }

  private settle(id: string, answers: string[] | null): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener('abort', entry.abort);
    try { entry.target.dismiss(id); } catch { /* The target may already be gone. */ }
    entry.resolve(answers);
  }
}
