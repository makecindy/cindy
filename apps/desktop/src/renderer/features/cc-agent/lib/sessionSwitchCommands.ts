/**
 * "Previous / next task" command channel.
 *
 * The Codex Micro encoder turns through the task list, but the list only exists
 * inside the sidebar (`CCAgentSidebarUpper`'s `visibleSessionsWithRemote`) while
 * the command arrives in `MainLayout`, many layers away. Rather than thread the
 * list or a ref through everything in between, this mirrors the shape already
 * used by `features/right-sidebar/lib/sidebarCommands.ts`: one module-level
 * emitter, one payload, with the state owner subscribing.
 *
 * Direction only — the publisher does not know the list, and the subscriber
 * does not need to know why it was asked to move.
 */

export type SessionSwitchDirection = 'previous' | 'next';

type Listener = (direction: SessionSwitchDirection) => void;

const listeners = new Set<Listener>();

/** Ask whoever owns the visible task list to move one step. */
export function requestSessionSwitch(direction: SessionSwitchDirection): void {
  for (const listener of listeners) {
    try {
      listener(direction);
    } catch {
      // A broken subscriber must not poison-pill the caller.
    }
  }
}

/** Subscribe to switch requests. Returns an unsubscribe function. */
export function onRequestSessionSwitch(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Where one step of the knob lands: an existing task, or the "new task" row
 * that sits above the list — turning up from the first task lands there rather
 * than stopping.
 */
export type SessionSwitchTarget = { kind: 'session'; sessionId: string } | { kind: 'new-task' };

/**
 * The stop one step from where the user is, in the order the sidebar shows.
 *
 * The list the knob walks is the new-task row followed by the visible tasks,
 * so `previous` moves up it and `next` moves down.
 *
 * Stops at both ends rather than wrapping: the encoder is a continuous control,
 * and wrapping from the last task back to the top would move the user somewhere
 * far away with no way to feel where the list ended.
 *
 * Returns null when there is nowhere to go — already at an end, or the active
 * task is not in the visible list at all (filtered out by search or a status
 * filter), in which case moving relative to it would be a guess.
 */
export function pickAdjacentSessionId(
  visibleSessionIds: readonly string[],
  activeId: string | null,
  direction: SessionSwitchDirection,
): SessionSwitchTarget | null {
  // One list: the new-task row, then every visible task under it.
  const stops: SessionSwitchTarget[] = [
    { kind: 'new-task' },
    ...visibleSessionIds.map((sessionId) => ({ kind: 'session' as const, sessionId })),
  ];
  // `activeId === null` means the new-task page is open, which is stop 0.
  const index = activeId
    ? stops.findIndex((stop) => stop.kind === 'session' && stop.sessionId === activeId)
    : 0;
  if (index < 0) return null;
  const target = index + (direction === 'next' ? 1 : -1);
  if (target < 0 || target >= stops.length) return null;
  return stops[target] ?? null;
}
