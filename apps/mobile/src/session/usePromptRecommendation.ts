import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MobileAgentKind, MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import type { ComposerDraftSource } from '@/session/composerDraftSource';
import { composerDocumentQuotes } from '@/session/composerDocument';

// Runtime-only consumption survives page remounts; owner/device/task are all part of the key.
const consumedRevisions = new Map<string, number>();
const subscribeEmptyComposer = () => () => {};
const CACHE_RETRY_DELAYS_MS = [1_000, 3_000, 5_000];

export function usePromptRecommendation({ ownerId, deviceId, sessionId, agentKind, revision, running, maker,
  composerSource, hasAttachments = false, hasTerminalError = false, voiceIsBusy = false }: {
  ownerId?: string;
  deviceId: string;
  sessionId: string;
  agentKind: MobileAgentKind | null;
  revision?: number | null;
  running: boolean;
  composerSource?: ComposerDraftSource;
  hasAttachments?: boolean;
  hasTerminalError?: boolean;
  voiceIsBusy?: boolean;
  maker: Pick<MobileMakerTransport, 'predictNextPrompt'>;
}) {
  const scope = JSON.stringify([ownerId, deviceId, sessionId]);
  // Subscribe to occupancy, not the draft string: typing need not redraw the task.
  const hasComposerContent = useSyncExternalStore(composerSource?.subscribe ?? subscribeEmptyComposer, () => {
    const snapshot = composerSource?.getSnapshot();
    return !!snapshot && (!!snapshot.draft.trim() || composerDocumentQuotes(snapshot.document).length > 0);
  });
  const blocked = hasComposerContent || hasAttachments || hasTerminalError || voiceIsBusy;
  const [result, setResult] = useState<{ scope: string; revision: number; prompt: string } | null>(null);
  // The transport is recreated when the device-link context refreshes. Keep the
  // latest callable without treating that refresh as a new recommendation run.
  const makerRef = useRef(maker);
  makerRef.current = maker;
  const request = useRef<{ scope: string; revision: number; cacheOnly: boolean } | null>(null);
  const observed = useRef({
    scope,
    running: false,
    sawRunning: false,
    revisionAtStart: 0,
    liveRevision: null as number | null,
  });
  const current = useRef({ scope, revision, running, blocked });
  current.current = { scope, revision, running, blocked };
  const dismiss = useCallback(() => {
    if (revision) consumedRevisions.set(scope, revision);
    setResult(null);
  }, [scope, revision]);

  useEffect(() => {
    if (observed.current.scope !== scope) {
      observed.current = {
        scope,
        running: false,
        sawRunning: false,
        revisionAtStart: 0,
        liveRevision: null,
      };
      request.current = null;
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
        setResult(null);
      }
      run.running = true;
      return;
    }
    run.running = false;
    // Only an observed run can authorize a paid prediction. Keep waiting if
    // stopped arrives before its revision, then bind that run to one completion.
    // Later metadata refreshes must not inherit permission from an older run.
    if (run.sawRunning && revision != null && revision > run.revisionAtStart) {
      run.liveRevision = revision;
      run.sawRunning = false;
    }
    if (!deviceId || !sessionId || !agentKind || !revision || consumedRevisions.get(scope) === revision) return;
    if (blocked) {
      // Consume this completion even if the draft/attachment is later removed.
      consumedRevisions.set(scope, revision);
      setResult(null);
      return;
    }
    // Historical navigation only reuses a host result; it never starts a paid prediction.
    const cacheOnly = run.liveRevision !== revision;
    if (request.current?.scope === scope && request.current.revision === revision
      && request.current.cacheOnly === cacheOnly) return;
    const attempt = { scope, revision, cacheOnly };
    request.current = attempt;
    let cancelled = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    const isCurrent = () => {
      const latest = current.current;
      return !cancelled && latest.scope === scope && latest.revision === revision
        && !latest.running && !latest.blocked && consumedRevisions.get(scope) !== revision;
    };
    const predict = () => {
      if (!isCurrent()) return;
      void makerRef.current.predictNextPrompt({ sessionId, agentKind, turnGen: 0, completionRevision: revision, cacheOnly })
        .then(({ prompt }) => {
          if (!isCurrent()) return;
          if (prompt) setResult({ scope, revision, prompt });
          else if (cacheOnly && retry < CACHE_RETRY_DELAYS_MS.length) {
            // A peer may create the cache just after our first lookup. Never
            // promote history to a paid request, and never retry link errors.
            timer = setTimeout(predict, CACHE_RETRY_DELAYS_MS[retry++]);
          }
        }).catch(() => { /* Old hosts and unavailable predictions remain silent. */ });
    };
    timer = setTimeout(predict, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (request.current === attempt) request.current = null;
    };
  }, [scope, deviceId, sessionId, agentKind, revision, running, blocked]);

  return {
    prompt: !running && !blocked && result?.scope === scope && result.revision === revision
      && consumedRevisions.get(scope) !== revision ? result.prompt : null,
    dismiss,
  };
}
