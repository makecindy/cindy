/** Hints wake scheduling only; the durable journal and live guards remain authoritative. */
export interface WorktreeRecycleEvent {
  resourceId: string;
  opportunity: boolean;
}

export function createWorktreeRecycleEvents(
  worktreeResourceId: (key: string) => string,
) {
  const listeners = new Set<(event: WorktreeRecycleEvent) => void>();

  function subscribeWorktreeRecycleEvents(
    listener: (event: WorktreeRecycleEvent) => void,
  ): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function notifyWorktreeRecycleRecordChanged(resourceId: string): void {
    for (const listener of listeners)
      listener({ resourceId, opportunity: false });
  }

  /** The caller supplies the resolved physical path, as recorded by the runtime lease. */
  function notifyWorktreeRecycleOpportunity(physicalPath: string): void {
    for (const listener of listeners)
      listener({
        resourceId: worktreeResourceId(physicalPath),
        opportunity: true,
      });
  }

  return {
    subscribeWorktreeRecycleEvents,
    notifyWorktreeRecycleRecordChanged,
    notifyWorktreeRecycleOpportunity,
  };
}
