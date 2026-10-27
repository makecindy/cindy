/** What of a companion's todos moves with it to another computer (cloud-companions.md §2). */
import type { TeammateTodo } from '@cindy/maker-shared/teammate-todo';

/** Todos that travel: open ones, ones set aside for later, and those closed in the last month. */
const TODO_RECENT_MS = 30 * 24 * 60 * 60_000;
const TODO_MAX = 500;
const TODO_HISTORY = 20;

/** A todo as it travels: no delivery in flight (it belongs to this computer's queue), bounded history. */
export function portableTodo(item: TeammateTodo): Record<string, unknown> {
  const { action: _action, legacyId: _legacyId, legacyFingerprint: _fingerprint, legacyVerdict: _verdict, ...rest } = item;
  return { ...rest, action: null, history: item.history.slice(-TODO_HISTORY) };
}

export function travellingTodos(items: readonly TeammateTodo[], now = Date.now()): TeammateTodo[] {
  return items.filter((item) => item.status === 'open' || item.decision?.kind === 'later' || now - Date.parse(item.updatedAt) < TODO_RECENT_MS)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, TODO_MAX);
}
