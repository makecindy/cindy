export interface BotCanonicalReplacementActivity {
  turnRunning: boolean;
  backgroundTaskCount: number;
  trackedTurn: boolean;
  leasedTurn: boolean;
  pendingInteraction: boolean;
}

/** Missing/deleted canonical recovery may replace a task only after every execution owner is idle. */
export function isBotCanonicalReplacementBusy(
  activity: BotCanonicalReplacementActivity,
): boolean {
  return (
    activity.turnRunning ||
    activity.backgroundTaskCount > 0 ||
    activity.trackedTurn ||
    activity.leasedTurn ||
    activity.pendingInteraction
  );
}
