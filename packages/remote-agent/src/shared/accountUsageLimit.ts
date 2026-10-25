/** Pure quota checks shared by automatic continuation and provider-group routing. */
import { matchScopedWindowForModel, type ClaudeSubscriptionUsageSnapshot } from '@cindy/maker-shared/subscription-usage';

export interface AccountUsageLimit {
  limited: boolean;
  /** Latest reset among exhausted windows; null if any exhausted window has no reset. */
  resetAtMs: number | null;
}

export interface UsageWindow {
  usedPercent: number;
  resetsAtSec: number | null | undefined;
}

function hasReset(w: UsageWindow): w is UsageWindow & { resetsAtSec: number } {
  return typeof w.resetsAtSec === 'number' && Number.isFinite(w.resetsAtSec) && w.resetsAtSec > 0;
}

/** Expired windows cannot keep an account blocked; unknown resets cannot borrow another window's reset. */
export function accountUsageLimitFromWindows(windows: readonly UsageWindow[], nowMs: number): AccountUsageLimit {
  const live = windows.filter((w) => !hasReset(w) || w.resetsAtSec * 1000 > nowMs);
  const exhausted = live.filter((w) => w.usedPercent >= 100);
  if (exhausted.length === 0) return { limited: false, resetAtMs: null };
  if (exhausted.some((w) => !hasReset(w))) return { limited: true, resetAtMs: null };
  return { limited: true, resetAtMs: Math.max(...exhausted.map((w) => w.resetsAtSec as number)) * 1000 };
}

/** Only this model's scoped weekly window can restrict the selected model. */
export function claudeAccountUsageLimit(
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
  modelId?: string | null,
  nowMs = Date.now(),
): AccountUsageLimit | null {
  if (!snapshot) return null;
  const scoped = matchScopedWindowForModel(snapshot.scoped, modelId);
  const windows: UsageWindow[] = [snapshot.fiveHour, snapshot.sevenDay, scoped]
    .filter((w): w is NonNullable<typeof w> => !!w && typeof w.utilization === 'number')
    .map((w) => ({ usedPercent: w.utilization, resetsAtSec: w.resetsAt }));
  const claim = snapshot.rateLimitStatus === 'rejected' ? snapshot.representativeClaim : null;
  const rejectedWindow = claim === 'five_hour' ? snapshot.fiveHour : claim === 'seven_day' ? snapshot.sevenDay : null;
  if (rejectedWindow) windows.push({ usedPercent: 100, resetsAtSec: rejectedWindow.resetsAt });
  return windows.length === 0 ? null : accountUsageLimitFromWindows(windows, nowMs);
}
