export interface BotCanonicalReplacementActivity {
  turnRunning: boolean;
  backgroundTaskCount: number;
  trackedTurn: boolean;
  leasedTurn: boolean;
  pendingInteraction: boolean;
}

/** Renew may archive a canonical task only after every execution owner is idle. */
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
