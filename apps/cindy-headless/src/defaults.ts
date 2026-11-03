export const DEFAULT_HEADLESS_TIMEOUT_MS = 1_800_000;

export type TimeoutOwner = 'headless' | 'external';

export interface HeadlessTimeoutConfig {
  owner: TimeoutOwner;
  timeoutMs: number | null;
}

export function resolveHeadlessTimeout(
  ownerValue: string | undefined,
  timeoutValue: string | undefined,
): HeadlessTimeoutConfig {
  const owner = ownerValue ?? 'headless';
  if (owner !== 'headless' && owner !== 'external') {
    throw new Error('--timeout-owner must be headless or external');
  }
  if (owner === 'external') {
    if (timeoutValue !== undefined) {
      throw new Error('--timeout-ms cannot be used with --timeout-owner external');
    }
    return { owner, timeoutMs: null };
  }
  const timeoutMs = Number(timeoutValue ?? String(DEFAULT_HEADLESS_TIMEOUT_MS));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return { owner, timeoutMs };
}
