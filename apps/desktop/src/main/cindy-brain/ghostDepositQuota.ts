// Both picked files and legacy deposit_media spend the same ghost-deposit quota.
// Keep the balance read and reference publication in one per-instance operation.
const pending = new Map<string, Promise<void>>();

export async function acquireGhostDepositLock(ghostId: string): Promise<() => void> {
  const previous = pending.get(ghostId);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pending.set(ghostId, current);
  await previous;
  return () => {
    release();
    if (pending.get(ghostId) === current) pending.delete(ghostId);
  };
}
