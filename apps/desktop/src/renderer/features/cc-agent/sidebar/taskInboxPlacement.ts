import type { TaskInboxSection } from '@cindy/maker-shared/live-task-priority';

/** Section → row keys, as shown when the pointer entered a Done button. */
export type FrozenInboxLayout = ReadonlyMap<TaskInboxSection, readonly string[]>;

export function snapshotInboxLayout<T>(
  groups: ReadonlyMap<TaskInboxSection, readonly T[]>,
  keyOf: (item: T) => string,
): FrozenInboxLayout {
  return new Map([...groups].map(([section, items]) => [section, items.map(keyOf)]));
}

const NO_EXPLICIT_MOVES: ReadonlySet<string> = new Set();
const SETTLED: ReadonlySet<TaskInboxSection> = new Set(['snoozed', 'archived']);

/**
 * While the pointer is over a Done button, rows keep the order and section
 * they had, so a one-click Done never lands on a row that just moved. Status inside a row still
 * updates in place. Explicit moves into or out of snoozed / archived (Done, snooze, wake,
 * restore — here or on another device) take effect at once: the row leaves its frozen slot, the
 * rows below close the gap, and it is appended to the end of its new section. Other moves and
 * newly arriving tasks wait until the pointer leaves the button. A successful explicit Done on a bound
 * task also moves inbox → working immediately; its marker is consumed after layout commit.
 */
export function freezeInboxLayout<T>(
  fresh: ReadonlyMap<TaskInboxSection, readonly T[]>,
  keyOf: (item: T) => string,
  frozen: FrozenInboxLayout,
  explicitMoves: ReadonlySet<string> = NO_EXPLICIT_MOVES,
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
      if (current.section !== section && (SETTLED.has(current.section) || SETTLED.has(section)
        || (section === 'inbox' && current.section === 'working' && explicitMoves.has(key)))) {
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
