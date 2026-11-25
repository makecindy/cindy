import { useEffect, useLayoutEffect, useRef } from 'react';
import type { AgentInputProjection } from '../../../shared/agentInputQueue';
import type { SessionChatState } from '@/lib/makerChatStore';

type Receipt = 'accepted' | 'rejected' | 'unknown';
type FailureState = Pick<SessionChatState, 'error' | 'errorReason' | 'errorRetryText' | 'errorPersistId' |
  'inputRecovery' | 'pendingQueue' | 'agentStatus' | 'isStreaming' | 'credentialSwitchWait'>;

/** Identify a retry by native provenance, never by a transcript position or by matching question text. */
export function dagFailedRetryTarget(state: FailureState, question: string, routeKey: string) {
  const recovery = state.inputRecovery;
  if (!question || !recovery || !state.error || !state.errorRetryText || state.agentStatus.isRunning ||
      state.isStreaming || state.credentialSwitchWait) return null;
  const item = recovery.kind === 'active-turn' ? recovery.item : state.pendingQueue[0];
  if (!item || (recovery.kind === 'queue-head' && (item.clientId !== recovery.clientId || state.pendingQueue[0]?.isPendingEnqueue))) return null;
  if (![item.clientId, item.retrySourceClientId, item.supersedesUserClientId].includes(question)) return null;
  return {
    key: JSON.stringify([routeKey, recovery.kind, item.clientId, state.errorPersistId, state.error, state.errorReason]),
    kind: recovery.kind, clientId: item.clientId, source: item.retrySourceClientId ?? item.supersedesUserClientId ?? item.clientId,
    priorQueue: state.pendingQueue.map(q => q.clientId),
  };
}
type Target = NonNullable<ReturnType<typeof dagFailedRetryTarget>>;
type NativePort = {
  id: string;
  target: () => Target | null;
  withPreparedRetry: (dispatch: () => Promise<void>) => Promise<void>;
  retry: (observe: (projection: AgentInputProjection) => void) => Promise<void>;
};

export function createDagFailedRetry(id: string, userMessageId: string, current: () => boolean) {
  let settle!: (v: Receipt) => void;
  const receipt = new Promise<Receipt>(resolve => { settle = resolve; });
  let started = false, dispatched = false, finished = false;
  let nativeIdle = Promise.resolve();
  let replacement: { clientId: string; source: string; replaces: string } | undefined;
  const finish = (outcome: Receipt) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    settle(outcome);
  };
  const cancel = () => finish(dispatched ? 'unknown' : 'rejected');
  let timer = setTimeout(cancel, 10_000); // Only for a pane that never becomes ready.
  async function start(port: NativePort) {
    if (started || finished) return;
    started = true;
    let release!: () => void;
    nativeIdle = new Promise<void>(resolve => { release = resolve; });
    clearTimeout(timer);
    timer = setTimeout(cancel, 60_000);
    try {
      const target = id === port.id && current() ? port.target() : null;
      if (!target) return finish('rejected');
      await port.withPreparedRetry(async () => {
        const latest = !finished && current() ? port.target() : null;
        if (!latest || latest.key !== target.key || dispatched) return;
        dispatched = true;
        await port.retry(p => {
          if (finished || !current() || p.sessionId !== id) return;
          if (p.error || p.recovery) return finish('rejected');
          if (p.error !== null || p.recovery !== null) return finish('unknown');
          const head = p.pendingQueue[0];
          // A resolved retry can be a no-op. Only the host receipt's actual rearmed
          // head or a fresh, provenance-bound manual clone confirms this handoff.
          const confirmed = head && (latest.kind === 'queue-head' ? head.clientId === latest.clientId :
            !!head.clientId && head.clientId !== latest.clientId && !head.autoResume && !latest.priorQueue.includes(head.clientId) &&
            (head.retrySourceClientId === undefined || head.retrySourceClientId === latest.source) &&
            (head.retrySourceClientId === latest.source || head.supersedesUserClientId === latest.clientId));
          if (confirmed && latest.kind === 'active-turn' && head.supersedesUserClientId === latest.clientId &&
              head.clientId !== latest.clientId && head.originalSyntheticTrigger !== 'continue') {
            replacement = { clientId: head.clientId, source: head.retrySourceClientId ?? latest.source, replaces: head.supersedesUserClientId };
          }
          finish(confirmed ? 'accepted' : 'unknown');
        });
      });
    } finally {
      cancel();
      release();
    }
  }
  return { id, userMessageId, receipt, whenIdle: () => nativeIdle, get replacement() { return replacement; }, cancel, start };
}
export type DagFailedRetry = ReturnType<typeof createDagFailedRetry>;

/** An unmounted, changed or unavailable pane never contributes a retry capability. */
export function DagFailedRetryBridge({ request, ...port }: NativePort & { request: DagFailedRetry }) {
  const live = useRef<{ request: DagFailedRetry; port: NativePort } | null>(null);
  useLayoutEffect(() => {
    live.current = { request, port };
    return () => { live.current = null; };
  });
  useEffect(() => {
    const target = () => live.current?.request === request ? live.current.port.target() : null;
    const pane = live.current?.port;
    if (pane) void request.start({ ...pane, target }).catch(() => { /* receipt already settled */ });
    return () => {
      // StrictMode replays effects in-place. A real unmount/replacement revokes this request.
      queueMicrotask(() => { if (live.current?.request !== request) request.cancel(); });
    };
  }, [request]);
  return null;
}

/** Mounted only alongside the banner's enabled original-input (not continue) action. */
export function DagRetryAvailable({ flag }: { flag: { current: boolean } }) {
  useLayoutEffect(() => {
    flag.current = true;
    return () => { flag.current = false; };
  }, [flag]);
  return null;
}
