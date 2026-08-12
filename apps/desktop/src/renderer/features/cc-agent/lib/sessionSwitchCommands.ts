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
 * The task one step from `activeId` in display order.
 *
 * Stops at both ends rather than wrapping: the encoder is a continuous control,
 * and wrapping from the last task back to the first would move the user
 * somewhere far away with no way to feel where the list ended.
 *
 * Returns null when there is nowhere to go — no list, already at the end, or
 * the active task is not in the visible list at all (filtered out by search or
 * a status filter), in which case moving would be a guess.
 */
export function pickAdjacentSessionId(
  visibleSessionIds: readonly string[],
  activeId: string | null,
  direction: SessionSwitchDirection,
): string | null {
  if (visibleSessionIds.length === 0) return null;
  if (!activeId) {
    // Nothing selected: start at whichever end the user turned toward.
    return direction === 'next'
      ? (visibleSessionIds[0] ?? null)
      : (visibleSessionIds[visibleSessionIds.length - 1] ?? null);
  }
  const index = visibleSessionIds.indexOf(activeId);
  if (index < 0) return null;
  const target = direction === 'next' ? index + 1 : index - 1;
  if (target < 0 || target >= visibleSessionIds.length) return null;
  return visibleSessionIds[target] ?? null;
}
