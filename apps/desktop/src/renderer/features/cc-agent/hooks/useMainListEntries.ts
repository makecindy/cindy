import { useMemo } from 'react';
import { buildMainListEntries, type BuildMainListEntriesInput } from '../lib/mainListModel';

/** Browsing priority changes cannot invalidate time-based sorting. */
export function useMainListEntries(input: BuildMainListEntriesInput) {
  const { projects, dialogues, unclassified, groupBy, groupDialogue, sortBy,
    projectOrder, manualProjectOrder, notifications, scheduleSessionIndex } = input;
  const priorityContext = sortBy === 'priority' ? input.priorityContext : undefined;
  return useMemo(() => buildMainListEntries({
    projects, dialogues, unclassified, groupBy, groupDialogue, sortBy,
    projectOrder, manualProjectOrder, notifications, scheduleSessionIndex, priorityContext,
  }), [projects, dialogues, unclassified, groupBy, groupDialogue, sortBy,
    projectOrder, manualProjectOrder, notifications, scheduleSessionIndex, priorityContext]);
}
