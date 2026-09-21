const PASSING_SCAN_STATUSES = new Set(['pass', 'passed', 'approved', 'published']);
const FAILING_SCAN_STATUSES = new Set(['fail', 'failed', 'quarantine', 'rejected', 'blocked']);
export const MAX_SCAN_STATUS_FAILURES = 3;

export function normalizeScanStatus(status: string): string {
  return status.trim().toLowerCase();
}

export function isPassingScanStatus(status: string): boolean {
  return PASSING_SCAN_STATUSES.has(normalizeScanStatus(status));
}

export function isPendingManualReviewStatus(status: string): boolean {
  return normalizeScanStatus(status) === 'pending';
}

export function isTerminalScanStatus(status: string): boolean {
  const normalized = normalizeScanStatus(status);
  return PASSING_SCAN_STATUSES.has(normalized) || FAILING_SCAN_STATUSES.has(normalized);
}

export function isScanStatusUnavailable(
  failedAttempts: number,
  maxFailures = MAX_SCAN_STATUS_FAILURES,
): boolean {
  return failedAttempts >= maxFailures;
}
