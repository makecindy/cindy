import { worktreeResourceId } from './resourceLock';

/** Hints wake scheduling only; the durable journal and live guards remain authoritative. */
export interface WorktreeRecycleEvent {
  resourceId: string;
  opportunity: boolean;
}

const listeners = new Set<(event: WorktreeRecycleEvent) => void>();

export function subscribeWorktreeRecycleEvents(listener: (event: WorktreeRecycleEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyWorktreeRecycleRecordChanged(resourceId: string): void {
  for (const listener of listeners) listener({ resourceId, opportunity: false });
}

/** The caller supplies the resolved physical path, as recorded by the runtime lease. */
export function notifyWorktreeRecycleOpportunity(physicalPath: string): void {
  for (const listener of listeners) listener({ resourceId: worktreeResourceId(physicalPath), opportunity: true });
}
