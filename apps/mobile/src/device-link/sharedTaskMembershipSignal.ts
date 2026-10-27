const listeners = new Set<() => void>();

/** Rereads the shared-task directory now, e.g. after joining or leaving on this phone. */
export function notifySharedTaskMembershipChanged(): void {
  for (const listener of listeners) listener();
}

export function onSharedTaskMembershipChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
