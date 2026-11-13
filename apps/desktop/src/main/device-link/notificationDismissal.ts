/** A delivered alert is retired by its exact identity, never by clearing a task's whole thread. */
export interface TrackedNotification {
  id: string;
  sessionId: string;
  kind: 'done' | 'error' | 'needs-reply';
  requestIds: string[];
  createdAt?: number;
}

export interface NotificationDismissalState {
  pending: TrackedNotification[];
  retired: string[];
}

/** Storage and transport are account-scoped by the caller. No message text belongs here. */
export function createNotificationDismissalLedger(
  initial: NotificationDismissalState,
  save: (state: NotificationDismissalState) => void,
) {
  const pending = new Map(initial.pending.filter(item => item.createdAt === undefined || item.createdAt > Date.now() - 30 * 86400_000).slice(-2000).map(item => [item.id, { ...item, requestIds: [...item.requestIds] }]));
  const retired = new Set(initial.retired);
  const persist = () => {
    // Bounded offline outbox; retaining an old alert is safer than deleting by task.
    while (retired.size > 2000) retired.delete(retired.values().next().value!);
    save({ pending: [...pending.values()], retired: [...retired] });
  };
  const retire = (matches: (item: TrackedNotification) => boolean) => {
    let changed = false;
    for (const [id, item] of pending) {
      if (!matches(item)) continue;
      pending.delete(id);
      retired.add(id);
      changed = true;
    }
    if (changed) persist();
  };
  return {
    record(item: TrackedNotification) {
      if (retired.has(item.id) || pending.has(item.id)) return;
      const alreadyTracked = new Set([...pending.values()].filter(old => old.sessionId === item.sessionId).flatMap(old => old.requestIds));
      const newlyPending = item.requestIds.filter(id => !alreadyTracked.has(id));
      pending.set(item.id, { ...item, createdAt: Date.now(), requestIds: newlyPending.length ? newlyPending : [...item.requestIds] });
      while (pending.size > 2000) pending.delete(pending.keys().next().value!);
      persist();
    },
    read(sessionId: string) {
      retire(item => item.sessionId === sessionId && item.kind !== 'needs-reply');
    },
    resolve(sessionId: string, requestId: string) {
      let changed = false;
      for (const item of pending.values()) {
        if (item.sessionId !== sessionId || item.kind !== 'needs-reply' || !item.requestIds.includes(requestId)) continue;
        item.requestIds = item.requestIds.filter(id => id !== requestId);
        if (item.requestIds.length === 0) {
          pending.delete(item.id);
          retired.add(item.id);
        }
        changed = true;
      }
      if (changed) persist();
    },
    batch(limit = 50): string[] { return [...retired].slice(0, limit); },
    acknowledged(ids: readonly string[]) {
      let changed = false;
      for (const id of ids) changed = retired.delete(id) || changed;
      if (changed) persist();
    },
  };
}
