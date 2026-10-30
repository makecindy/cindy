import { useEffect, useRef, useState } from 'react';

/**
 * A loaded window can be entirely hidden rows: a teammate's scheduled prompt (every 10 minutes for a
 * mailbox check) is stored as a user row neither client shows, and the host still counts it toward
 * the 20-item history page. Then the chat renders nothing, the list cannot scroll, and the ordinary
 * "load earlier" paths — which need at least one visible row — never run, so the chat reads as empty.
 *
 * While the loaded window shows nothing and older history exists, keep reading older pages until a
 * row shows, the history ends, a page makes no progress, or the cap is reached. The cap covers about
 * two and a half idle days of 10-minute prompts.
 */
export const MAX_HIDDEN_HISTORY_CHASE_PAGES = 20;

export interface HiddenHistoryChaseInput {
  /** Account + computer + session: a new scope starts a fresh chase. */
  scope: string;
  /** Online, app in the foreground, and a history the screen may page. */
  enabled: boolean;
  /** Rows the chat actually renders (after hiding scheduled prompts and work detail). */
  visibleCount: number;
  canLoadEarlier: boolean;
  loading: boolean;
  /** Oldest loaded position; an older page moves it. */
  cursor: string | null;
}

export interface HiddenHistoryChaseState {
  scope: string;
  pages: number;
  lastCursor: string | null;
  exhausted: boolean;
}

export function initialHiddenHistoryChase(scope: string): HiddenHistoryChaseState {
  return { scope, pages: 0, lastCursor: null, exhausted: false };
}

export function planHiddenHistoryChase(
  current: HiddenHistoryChaseState,
  input: HiddenHistoryChaseInput,
): { state: HiddenHistoryChaseState; load: boolean } {
  const state = current.scope === input.scope ? current : initialHiddenHistoryChase(input.scope);
  if (!input.enabled || input.visibleCount > 0 || !input.canLoadEarlier || input.loading || state.exhausted) {
    return { state, load: false };
  }
  // A page that did not move the cursor (failed or empty) or too many pages: stop instead of looping.
  if (state.pages >= MAX_HIDDEN_HISTORY_CHASE_PAGES || (state.pages > 0 && input.cursor === state.lastCursor)) {
    return { state: { ...state, exhausted: true }, load: false };
  }
  return { state: { ...state, pages: state.pages + 1, lastCursor: input.cursor }, load: true };
}

/**
 * Runs the chase and reports whether it is still going, so the screen shows its syncing placeholder
 * instead of "No messages yet" meanwhile.
 */
export function useHiddenHistoryChase(input: HiddenHistoryChaseInput, loadEarlier: () => void): boolean {
  const state = useRef(initialHiddenHistoryChase(input.scope));
  const load = useRef(loadEarlier);
  load.current = loadEarlier;
  const [exhaustedScope, setExhaustedScope] = useState<string | null>(null);
  const { scope, enabled, visibleCount, canLoadEarlier, loading, cursor } = input;
  useEffect(() => {
    const plan = planHiddenHistoryChase(state.current, { scope, enabled, visibleCount, canLoadEarlier, loading, cursor });
    state.current = plan.state;
    if (plan.state.exhausted) setExhaustedScope(scope);
    if (plan.load) load.current();
  }, [scope, enabled, visibleCount, canLoadEarlier, loading, cursor]);
  return enabled && visibleCount === 0 && canLoadEarlier && exhaustedScope !== scope;
}
