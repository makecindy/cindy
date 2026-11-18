// The dialogue group is a viewer-side section. Keep its neighbours separate from
// host project order, whose keys must identify real working directories.
import { useMemo, useState } from 'react';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';
import type { MainListEntry } from '../lib/mainListModel';

const STORAGE_KEY = 'cc-agent.sidebar.dialogueGroupOrder';
export const DIALOGUE_SORT_ID = 'dialogue-group';
type Position = { previous: string | null; next: string | null };
type Positions = ReadonlyMap<string, Position>;
type SortableEntry = Extract<MainListEntry, { kind: 'project' | 'dialogue-group' }>;

export function isSortableEntry(entry: MainListEntry): entry is SortableEntry {
  return entry.kind === 'project' || entry.kind === 'dialogue-group';
}

export function entrySortId(entry: SortableEntry): string {
  return entry.kind === 'project' ? entry.project.projectKey : DIALOGUE_SORT_ID;
}

function readPositions(owner: string | null): Positions {
  const raw = readSidebarOwnerStorage(STORAGE_KEY, owner);
  const result = new Map<string, Position>();
  if (!raw) return result;
  try {
    for (const [key, pos] of Object.entries(JSON.parse(raw))) {
      if (pos && typeof pos === 'object' && 'previous' in pos && 'next' in pos &&
          (pos.previous === null || typeof pos.previous === 'string') &&
          (pos.next === null || typeof pos.next === 'string')) {
        result.set(key, { previous: pos.previous, next: pos.next });
      }
    }
  } catch { /* A malformed display preference falls back to the existing order. */ }
  return result;
}

export function useDialogueGroupOrder(enabled: boolean) {
  const owner = getDataOwnerGeneration().dataOwnerId;
  const [revision, setRevision] = useState(0);
  const positions = useMemo(() => enabled ? readPositions(owner) : new Map<string, Position>(), [enabled, owner, revision]);
  function remember(scope: string, ids: string[]) {
    const index = ids.indexOf(DIALOGUE_SORT_ID);
    if (index < 0 || getDataOwnerGeneration().dataOwnerId !== owner) return;
    const next = new Map(readPositions(owner));
    next.set(scope, { previous: ids[index - 1] ?? null, next: ids[index + 1] ?? null });
    if (writeSidebarOwnerStorage(STORAGE_KEY, owner, JSON.stringify(Object.fromEntries(next)))) {
      setRevision(value => value + 1);
    }
  }
  return { positions, remember };
}

/** Place before truncation so a group moved to the top stays there in a short list. */
export function placeDialogueGroup(entries: readonly MainListEntry[], position: Position | undefined, comparisonKey: (key: string) => string): readonly MainListEntry[] {
  if (!position) return entries;
  const dialogue = entries.find(entry => entry.kind === 'dialogue-group');
  if (!dialogue) return entries;
  const projects = entries.filter(entry => entry.kind === 'project');
  const projectKeys = projects.map(entry => comparisonKey(entry.project.projectKey));
  const next = position.next === null ? -1 : projectKeys.indexOf(comparisonKey(position.next));
  const previous = position.previous === null ? -1 : projectKeys.indexOf(comparisonKey(position.previous));
  let index = projects.length;
  if (position.previous === null) index = 0;
  else if (position.next !== null && next >= 0) index = next;
  else if (position.next !== null && previous >= 0) index = previous + 1;
  return [
    ...entries.filter(entry => entry.kind === 'cindy-make-group'),
    ...projects.slice(0, index), dialogue, ...projects.slice(index),
    ...entries.filter(entry => !isSortableEntry(entry) && entry.kind !== 'cindy-make-group'),
  ];
}
