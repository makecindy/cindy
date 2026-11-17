import type { TaskInboxSection } from '@cindy/maker-shared/live-task-priority';

/** Where the open task sat when the user started looking at it. */
export interface ViewedInboxPlacement {
  key: string;
  section: TaskInboxSection;
  index: number;
}

const LIVE: ReadonlySet<TaskInboxSection> = new Set(['inbox', 'working']);

/**
 * The open task keeps its section and slot while the user stays on it: sending a message
 * (inbox → working) or a round finishing (working → inbox) must not move the sidebar focus.
 * Explicit snooze / archive / restore apply at once. The task is re-sorted after the user leaves.
 * Returns the placement to remember for the next render (null when nothing is open).
 */
export function holdViewedInboxPlacement<T>(
  groups: Map<TaskInboxSection, T[]>,
  keyOf: (item: T) => string,
  viewedKey: string | undefined,
  previous: ViewedInboxPlacement | null,
): ViewedInboxPlacement | null {
  if (!viewedKey) return null;
  let current: { section: TaskInboxSection; index: number } | null = null;
  for (const [section, items] of groups) {
    const index = items.findIndex((item) => keyOf(item) === viewedKey);
    if (index >= 0) {
      current = { section, index };
      break;
    }
  }
  if (!current) return previous?.key === viewedKey ? previous : null;
  if (previous?.key !== viewedKey || !LIVE.has(previous.section) || !LIVE.has(current.section)) {
    return { key: viewedKey, ...current };
  }
  const source = groups.get(current.section)!;
  const [item] = source.splice(current.index, 1);
  const target = groups.get(previous.section)!;
  target.splice(Math.min(previous.index, target.length), 0, item);
  return previous;
}
