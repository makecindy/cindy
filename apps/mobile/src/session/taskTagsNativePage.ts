import { useCallback, useRef, useState } from 'react';
import type { TaskTagsPage } from './TaskTags';

/** Swatch diameters: list rows sit beside text; pickers are the tap target themselves. */
export const TAG_SWATCH = { row: 22, picker: 28 } as const;

/** Header state for a native sheet hosting the expanded tag pages. */
export function useTaskTagsNativePage() {
  const [page, setPage] = useState<TaskTagsPage | null>(null);
  const [backDisabled, setBackDisabled] = useState(false);
  const backRef = useRef<() => void>(() => {});
  const onPageChange = useCallback(
    (next: TaskTagsPage | null, back: () => void, blocked = false) => {
      backRef.current = back;
      setPage(next);
      setBackDisabled(blocked);
    },
    [],
  );
  const back = useCallback(() => backRef.current(), []);
  return { page, back, backDisabled, onPageChange };
}

export function taskTagsPageTitle(page: TaskTagsPage, t: (key: string) => string) {
  return t(
    page === 'add'
      ? 'taskTags.add'
      : page === 'edit'
        ? 'taskTags.editTitle'
        : page === 'delete'
          ? 'taskTags.delete'
          : 'taskTags.title',
  );
}

/**
 * SwiftUI `onMove` reports the insertion point in the array before the moved row is
 * removed, so moving down lands one slot earlier than the reported destination.
 */
export function taskTagMoveTarget(from: number, destination: number) {
  return destination > from ? destination - 1 : destination;
}
