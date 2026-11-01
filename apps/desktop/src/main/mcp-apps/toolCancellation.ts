import { AsyncLocalStorage } from 'node:async_hooks';

export interface AppToolCallIdentity {
  sessionId: string;
  sessionInstanceId: string;
  threadId: string;
}

interface ActiveCall {
  identity: AppToolCallIdentity;
  cancel: () => void;
}

const scope = new AsyncLocalStorage<{ calls: Set<ActiveCall>; identity: AppToolCallIdentity }>();

/** Bridge-local calls; never includes built-ins, discovery, or another bridge generation. */
export class AppToolCancellation {
  private readonly calls = new Set<ActiveCall>();

  run<T>(identity: AppToolCallIdentity, run: () => T): T {
    return scope.run({ calls: this.calls, identity }, run);
  }

  /** Snapshot before interrupt: a late ACK must not cancel the next turn's calls. */
  prepare(identity: AppToolCallIdentity, isCurrent: () => boolean): () => void {
    const pending = [...this.calls].filter(call =>
      call.identity.sessionId === identity.sessionId &&
      call.identity.sessionInstanceId === identity.sessionInstanceId &&
      call.identity.threadId === identity.threadId);
    return () => {
      if (!isCurrent()) return;
      for (const call of pending) {
        if (!this.calls.delete(call)) continue;
        call.cancel();
      }
    };
  }
}

/** Only the App facade's tools/call handler participates. SDK abort sends upstream cancelled. */
export async function withAppToolCancellation<T>(
  signal: AbortSignal,
  assertCurrent: () => void,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const active = scope.getStore();
  if (!active) return run(signal);
  const controller = new AbortController();
  const inCallContext = AsyncLocalStorage.snapshot();
  const call: ActiveCall = {
    identity: active.identity,
    cancel: () => inCallContext(() => {
      // Owner/server revocation keeps its existing boundary; never contact stale credentials.
      try { assertCurrent(); } catch { return; }
      controller.abort(new Error('Codex task stopped'));
    }),
  };
  active.calls.add(call);
  try { return await run(AbortSignal.any([signal, controller.signal])); }
  finally { active.calls.delete(call); }
}
