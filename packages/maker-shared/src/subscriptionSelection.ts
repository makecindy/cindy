import { resetTimeLevel, willLeaveQuotaUnused } from './quotaLevel';

/** A picker previews candidate accounts. It never reserves or rebinds a task. */
export function selectableSubscriptionAccount<
  T extends {
    id?: string;
    paused: boolean;
    status: string;
    running: number;
    limit: number;
    identity?: string;
  },
>(
  pool: {
    configured: boolean;
    accounts: readonly T[];
    boundAccountId?: string | null;
  },
  taskScoped = false,
): T | null | undefined {
  // undefined preserves legacy single-account presentation only when the host
  // explicitly confirms there is no pool. null means unknown/unassigned.
  if (!pool.configured) return undefined;
  if (taskScoped && pool.boundAccountId === undefined) return null;
  if (pool.boundAccountId)
    return (
      pool.accounts.find((account) => account.id === pool.boundAccountId) ??
      null
    );
  const available = pool.accounts.filter(
    (account) =>
      !account.paused &&
      account.status === "ready" &&
      account.running < account.limit,
  );
  return available.length === 1 && available[0].identity?.trim()
    ? available[0]
    : null;
}

/** Quota visibility is independent of a new task's allocation. Busy and limited
 * accounts still have useful quota; paused accounts are excluded unless bound.
 * Never sum percentages across accounts with different plans or windows. */
export function subscriptionQuotaAccounts<
  T extends {
    id?: string;
    paused: boolean;
    status: string;
  },
>(pool: {
  accounts: readonly T[];
  boundAccountId?: string | null;
}): readonly T[] {
  if (pool.boundAccountId)
    return pool.accounts.filter(
      (account) => account.id === pool.boundAccountId,
    );
  return pool.accounts.filter(
    (account) =>
      !account.paused &&
      (account.status === "ready" || account.status === "limited"),
  );
}

/** Weekly account-pool overview, never an execution/admission decision.
 * Equal account weights because comparable absolute capacities are not available.
 * A missing/expired member makes the average unknown; known members may still
 * carry a reset reminder. Reset colors reuse the shared weekly consumption-pace
 * rule; this coarse estimate never grants permission to switch an account. */
export function subscriptionQuotaOverview(
  accounts: readonly { remaining?: number | null; resetsAt?: number | null }[],
  nowMs: number,
) {
  const members = accounts.map((account) => {
    const resetMs =
      typeof account.resetsAt === "number" &&
      Number.isFinite(account.resetsAt) &&
      account.resetsAt > 0
        ? account.resetsAt * 1000
        : null;
    const remaining =
      typeof account.remaining === "number" &&
      Number.isFinite(account.remaining) &&
      (resetMs === null || resetMs > nowMs)
        ? Math.round(Math.max(0, Math.min(100, account.remaining)))
        : null;
    const leftMs = resetMs === null ? 0 : resetMs - nowMs;
    const resetLevel = resetTimeLevel(leftMs, remaining !== null && willLeaveQuotaUnused({
      usedPercent: 100 - remaining, windowMs: 7 * 24 * 60 * 60_000, leftMs,
    }));
    return { remaining, resetLevel, resetSoon: resetLevel !== 'normal' };
  });
  const nextResetIndex = members.reduce<number | null>((earliest, member, index) => {
    if (!member.resetSoon) return earliest;
    return earliest === null || accounts[index].resetsAt! < accounts[earliest].resetsAt!
      ? index : earliest;
  }, null);
  // A compact, unit-symbol countdown; full localized wording lives in details.
  const resetMs = nextResetIndex === null ? null : accounts[nextResetIndex].resetsAt! * 1000 - nowMs;
  const resetHours = resetMs === null ? 0 : Math.floor(resetMs / 3_600_000);
  const resetTime = resetMs === null ? null : resetHours > 0
    ? `${resetHours}h` : `${Math.max(1, Math.ceil(resetMs / 60_000))}m`;
  return {
    members,
    nextResetIndex,
    reset: nextResetIndex === null ? null : {
      remaining: members[nextResetIndex].remaining!, time: resetTime!, level: members[nextResetIndex].resetLevel,
    },
    average:
      members.length && members.every((member) => member.remaining !== null)
        ? Math.round(
            members.reduce((sum, member) => sum + member.remaining!, 0) /
              members.length,
          )
        : null,
    resetSoonCount: members.filter((member) => member.resetSoon).length,
  };
}
