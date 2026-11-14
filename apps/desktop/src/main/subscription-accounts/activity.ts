/** Live root activity supplements pre-pool sessions, never historical transcripts or child threads. */
export interface SubscriptionRootActivity {
  sessionId: string;
  nativeId: string;
  provider: 'openai' | 'anthropic';
  accountId: string;
  running: boolean;
  isRunning?: () => boolean;
}

export function unleasedSubscriptionActivity(
  roots: readonly SubscriptionRootActivity[],
  represented: (sessionId: string) => boolean,
): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const seenTasks = new Set<string>();
  for (const root of roots) {
    if (represented(root.sessionId)) {
      seen.add(`${root.provider}:${root.nativeId}`);
      seenTasks.add(`${root.provider}:${root.sessionId}`);
    }
  }
  for (const root of roots) {
    if (!(root.isRunning?.() ?? root.running) || represented(root.sessionId)) continue;
    // Both identifiers can occur in lifecycle snapshots; one native root consumes one slot.
    const key = `${root.provider}:${root.nativeId}`;
    const task = `${root.provider}:${root.sessionId}`;
    if (seen.has(key) || seenTasks.has(task)) continue;
    seen.add(key);
    seenTasks.add(task);
    const account = `${root.provider}:${root.accountId}`;
    counts.set(account, (counts.get(account) ?? 0) + 1);
  }
  return counts;
}
