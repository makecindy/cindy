import { useLayoutEffect, useRef } from 'react';
import type { RemoteTaskSuggestionsMode } from './remoteTaskSuggestionsModel';

/** An idle cached peer is not settled until this list scope has acquired its owner. */
export function isTaskSuggestionsSyncPending(
  deviceIds: readonly string[],
  ownedDeviceIds: ReadonlySet<string>,
  connectionStates: Readonly<Record<string, 'idle' | 'syncing' | 'failed'>>,
): boolean {
  return deviceIds.some((id) => !ownedDeviceIds.has(id) || connectionStates[id] === 'syncing');
}

/** Retain only an already displayed recommendation during an ordinary list refresh. */
export function useRemoteTaskSuggestionsPresentation({
  scope,
  candidateMode,
  syncing,
}: {
  scope: string;
  candidateMode: RemoteTaskSuggestionsMode;
  syncing: boolean;
}) {
  const displayed = useRef<{ scope: string; mode: RemoteTaskSuggestionsMode } | null>(null);
  const retain = displayed.current?.scope === scope && displayed.current.mode === candidateMode;
  const mode = syncing && !retain ? null : candidateMode;

  useLayoutEffect(() => {
    // A different account/device or an ineligible candidate must not inherit visibility.
    displayed.current = mode ? { scope, mode } : null;
  }, [scope, mode]);

  return { mode, pending: syncing && candidateMode === 'empty' && !mode };
}
