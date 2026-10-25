/**
 * Resolve the authoritative /clear boundary used by main-side queue guards and
 * controlled-host DB persistence.
 */
export function resolveClearSessionBoundary(params: {
  clearedAt?: string;
  isRemoteInvoke: boolean;
  nowMs?: number;
}): string | number {
  const nowMs = params.nowMs ?? Date.now();
  if (params.isRemoteInvoke) {
    return nowMs;
  }
  return params.clearedAt ?? nowMs;
}
