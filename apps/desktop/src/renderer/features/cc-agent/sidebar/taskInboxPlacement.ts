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

/** Section → row keys, as shown when the pointer entered the inbox list. */
export type FrozenInboxLayout = ReadonlyMap<TaskInboxSection, readonly string[]>;

export function snapshotInboxLayout<T>(
  groups: ReadonlyMap<TaskInboxSection, readonly T[]>,
  keyOf: (item: T) => string,
): FrozenInboxLayout {
  return new Map([...groups].map(([section, items]) => [section, items.map(keyOf)]));
}

const SETTLED: ReadonlySet<TaskInboxSection> = new Set(['snoozed', 'archived']);

/**
 * While the pointer is over the inbox (2026-11-18 user request), rows keep the order and section
 * they had, so a one-click Done never lands on a row that just moved. Status inside a row still
 * updates in place. Explicit moves into or out of snoozed / archived (Done, snooze, wake,
 * restore — here or on another device) take effect at once: the row leaves its frozen slot, the
 * rows below close the gap, and it is appended to the end of its new section. Other moves and
 * newly arriving tasks wait until the pointer leaves.
 */
export function freezeInboxLayout<T>(
  fresh: ReadonlyMap<TaskInboxSection, readonly T[]>,
  keyOf: (item: T) => string,
  frozen: FrozenInboxLayout,
): Map<TaskInboxSection, T[]> {
  const freshSection = new Map<string, { section: TaskInboxSection; item: T }>();
  for (const [section, items] of fresh) {
    for (const item of items) freshSection.set(keyOf(item), { section, item });
  }
  const result = new Map<TaskInboxSection, T[]>([...fresh.keys()].map((section) => [section, []]));
  const placed = new Set<string>();
  const moved = new Set<string>();
  for (const [section, keys] of frozen) {
    for (const key of keys) {
      const current = freshSection.get(key);
      if (!current) continue; // deleted or filtered out
      if (current.section !== section && (SETTLED.has(current.section) || SETTLED.has(section))) {
        moved.add(key);
        continue;
      }
      result.get(section)?.push(current.item);
      placed.add(key);
    }
  }
  for (const [section, items] of fresh) {
    for (const item of items) {
      const key = keyOf(item);
      if (placed.has(key)) continue;
      if (moved.has(key) || SETTLED.has(section)) result.get(section)!.push(item);
    }
  }
  return result;
}
