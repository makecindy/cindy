import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MobileAgentKind, MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import type { ComposerDraftSource } from '@/session/composerDraftSource';
import { composerDocumentQuotes } from '@/session/composerDocument';

// Runtime-only consumption survives page remounts; owner/device/task are all part of the key.
const consumedRevisions = new Map<string, number>();
const subscribeEmptyComposer = () => () => {};
const CACHE_RETRY_DELAYS_MS = [1_000, 3_000, 5_000];

export function usePromptRecommendation({ ownerId, deviceId, sessionId, agentKind, revision, running, maker,
  composerSource, hasAttachments = false, hasTerminalError = false, voiceIsBusy = false, queueEditing = false,
  available = true, connectionEpoch = 0 }: {
  ownerId?: string;
  deviceId: string;
  sessionId: string;
  agentKind: MobileAgentKind | null;
  revision?: number | null;
  running: boolean;
  available?: boolean;
  connectionEpoch?: number;
  composerSource?: ComposerDraftSource;
  hasAttachments?: boolean;
  hasTerminalError?: boolean;
  voiceIsBusy?: boolean;
  queueEditing?: boolean;
  maker: Pick<MobileMakerTransport, 'predictNextPrompt'>;
}) {
  const scope = JSON.stringify([ownerId, deviceId, sessionId]);
  // Subscribe to occupancy, not the draft string: typing need not redraw the task.
  const hasComposerContent = useSyncExternalStore(composerSource?.subscribe ?? subscribeEmptyComposer, () => {
    const snapshot = composerSource?.getSnapshot();
    return !!snapshot && (!!snapshot.draft.trim() || composerDocumentQuotes(snapshot.document).length > 0);
  });
  // Retention is separate from eligibility. All non-draft blockers hide cached
  // results too; only ordinary draft visibility belongs to the composer UI.
  const displayBlocked = hasAttachments || hasTerminalError || voiceIsBusy || queueEditing;
  const blocked = hasComposerContent || displayBlocked;
  const [result, setResult] = useState<{ scope: string; revision: number; prompt: string } | null>(null);
  // The transport is recreated when the device-link context refreshes. Keep the
  // latest callable without treating that refresh as a new recommendation run.
  const makerRef = useRef(maker);
  makerRef.current = maker;
  const request = useRef<{
    scope: string; revision: number; cacheOnly: boolean; recoveryGeneration: number; failed: boolean;
  } | null>(null);
  const connection = useRef({ available, connectionEpoch, generation: 0 });
  const paidRequest = useRef<{ scope: string; revision: number } | null>(null);
  const [settledAttempt, setSettledAttempt] = useState(0);
  useEffect(() => () => { request.current = null; }, []);
  const observed = useRef({
    scope,
    running: false,
    sawRunning: false,
    revisionAtStart: 0,
    liveRevision: null as number | null,
  });
  const current = useRef({ scope, revision, running, blocked, hasTerminalError, available });
  current.current = { scope, revision, running, blocked, hasTerminalError, available };
  const dismiss = useCallback(() => {
    if (revision) consumedRevisions.set(scope, revision);
    observed.current.sawRunning = false;
    observed.current.liveRevision = null;
    setResult(null);
  }, [scope, revision]);

  useEffect(() => {
    if (connection.current.available !== available || connection.current.connectionEpoch !== connectionEpoch) {
      connection.current = { available, connectionEpoch, generation: connection.current.generation + 1 };
    }
    if (observed.current.scope !== scope) {
      observed.current = {
        scope,
        running: false,
        sawRunning: false,
        revisionAtStart: 0,
        liveRevision: null,
      };
      request.current = null;
      paidRequest.current = null;
      setResult(null);
    }
    const run = observed.current;
    if (running) {
      if (!run.running) {
        // A fresh running edge starts a new completion generation. A dismissal
        // from the previous generation must not suppress this one.
        consumedRevisions.delete(scope);
        run.sawRunning = true;
        run.revisionAtStart = revision ?? 0;
        run.liveRevision = null;
        request.current = null;
        paidRequest.current = null;
        setResult(null);
      }
      run.running = true;
      return;
    }
    run.running = false;
    // Only an observed run can authorize a paid prediction. Keep waiting if
    // stopped arrives before its revision. The completion timestamp can settle
    // more than once during debounce; consume the live run only on dispatch.
    // Later metadata refreshes cannot authorize a second paid request.
    if (run.sawRunning && revision != null && revision > run.revisionAtStart) {
      run.liveRevision = revision;
    }
    if (!deviceId || !sessionId || !agentKind || !revision || consumedRevisions.get(scope) === revision) return;
    if (hasTerminalError) {
      // Failed turns are ineligible; ordinary composer interaction only hides.
      run.sawRunning = false;
      run.liveRevision = null;
      consumedRevisions.set(scope, revision);
      setResult(null);
      return;
    }
    if (!available || blocked || (result?.scope === scope && result.revision === revision)) return;
    // Historical navigation only reuses a host result; it never starts a paid prediction.
    const cacheOnly = run.liveRevision !== revision;
    const previous = request.current;
    const recovering = previous?.scope === scope && previous.revision === revision
      && previous.cacheOnly === cacheOnly;
    if (recovering && (!previous.failed || previous.recoveryGeneration === connection.current.generation)) return;
    // A lost response does not mean the host did not generate a recommendation.
    // Retry only after connectivity changes, and only read the host's cache.
    const requestCacheOnly = cacheOnly
      || (paidRequest.current?.scope === scope && paidRequest.current.revision === revision);
    const attempt = { scope, revision, cacheOnly, recoveryGeneration: connection.current.generation, failed: false };
    request.current = attempt;
    let cancelled = false;
    let started = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    const isCurrent = () => {
      const latest = current.current;
      return request.current === attempt && latest.scope === scope && latest.revision === revision
        && !latest.running && !latest.hasTerminalError && consumedRevisions.get(scope) !== revision;
    };
    const predict = () => {
      if (cancelled || (!started && current.current.blocked) || !isCurrent()) return;
      if (!current.current.available) {
        attempt.failed = true;
        return;
      }
      started = true;
      if (!requestCacheOnly) {
        run.sawRunning = false;
        paidRequest.current = { scope, revision };
      }
      void makerRef.current.predictNextPrompt({ sessionId, agentKind, turnGen: 0, completionRevision: revision, cacheOnly: requestCacheOnly })
        .then(({ prompt }) => {
          if (!isCurrent()) return;
          if (prompt) setResult({ scope, revision, prompt });
          else if (requestCacheOnly && retry < CACHE_RETRY_DELAYS_MS.length) {
            // A peer may create the cache just after our first lookup. Never
            // promote history to a paid request. Link errors wait for recovery
            // instead of entering this timed retry loop.
            timer = setTimeout(predict, CACHE_RETRY_DELAYS_MS[retry++]);
          }
        }).catch(() => {
          if (!isCurrent()) return;
          attempt.failed = true;
          // The old request can settle after reconnect. Recheck that already
          // observed recovery without replaying requests on ordinary renders.
          setSettledAttempt((value) => value + 1);
        });
    };
    timer = setTimeout(predict, 500);
    return () => {
      // Once dispatched, keep the result even if editing hides the capsule.
      // Its bounded cache-only retries can finish while hidden too; typing must
      // neither strand a cache miss nor restart a paid prediction.
      if (!started || !isCurrent()) {
        cancelled = true;
        clearTimeout(timer);
      }
      if (!started && request.current === attempt) request.current = null;
    };
  }, [scope, deviceId, sessionId, agentKind, revision, running, blocked, hasTerminalError, result,
    available, connectionEpoch, settledAttempt]);

  return {
    prompt: !running && !displayBlocked && result?.scope === scope && result.revision === revision
      && consumedRevisions.get(scope) !== revision ? result.prompt : null,
    dismiss,
  };
}
