// The dialogue group is a viewer-side section. Keep its neighbours separate from
// host project order, whose keys must identify real working directories.
import { useMemo, useRef, useState } from 'react';
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
  const lastGroupDrag = useRef(new Map<string, number>());
  function preparePlacement(
    scope: string, before: readonly string[], after: readonly string[],
    comparisonKey: (key: string) => string, groupOnly: boolean,
  ) {
    if (getDataOwnerGeneration().dataOwnerId !== owner) return;
    // A delayed project acknowledgement must not overwrite a newer explicit group drag.
    if (groupOnly) lastGroupDrag.current.set(scope, (lastGroupDrag.current.get(scope) ?? 0) + 1);
    const groupDrag = lastGroupDrag.current.get(scope);
    const index = after.indexOf(DIALOGUE_SORT_ID);
    const saved = readPositions(owner).get(scope);
    let position: Position;
    const dialogueMoved = index >= 0 && index !== before.indexOf(DIALOGUE_SORT_ID);
    if (!dialogueMoved) {
      if (!saved) return;
      // Project-only drops permute project slots, even when the group is hidden.
      // Hidden neighbours and true list boundaries keep their existing anchors.
      const atSlot = (anchor: string | null) => {
        if (anchor === null) return null;
        const identity = comparisonKey(anchor);
        const slot = before.findIndex(id => id !== DIALOGUE_SORT_ID && comparisonKey(id) === identity);
        return slot < 0 ? anchor : after[slot];
      };
      position = { previous: atSlot(saved.previous), next: atSlot(saved.next) };
    } else {
      position = { previous: after[index - 1] ?? null, next: after[index + 1] ?? null };
    }
    // Capture the absolute destination at drop time. Two drops from the same
    // visible order can both succeed; replaying a relative swap would undo it.
    return () => {
      if (getDataOwnerGeneration().dataOwnerId !== owner || lastGroupDrag.current.get(scope) !== groupDrag) return;
      const next = new Map(readPositions(owner));
      const current = next.get(scope);
      if (position.previous === current?.previous && position.next === current?.next) return;
      next.set(scope, position);
      if (writeSidebarOwnerStorage(STORAGE_KEY, owner, JSON.stringify(Object.fromEntries(next)))) {
        setRevision(value => value + 1);
      }
    };
  }
  return { positions, preparePlacement };
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
