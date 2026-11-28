import type { RsbWindowCommandRouteResult } from '../../../../shared/rightSidebarWindow';

const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_RETRY_DELAY_MS = 50;

export interface RevealOrcaWorkersWithRetryOptions {
  reveal: () => Promise<RsbWindowCommandRouteResult>;
  maxAttempts?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}

/** Only these route results prove that the collaboration tab was actually opened. */
export function didOpenOrcaWorkersTab(result: RsbWindowCommandRouteResult): boolean {
  return result === 'attached' || result === 'routed';
}

/**
 * Retry an explicit collaboration-tab reveal while the sidebar window context is converging.
 * `queued` is a terminal handoff result; only `stale-context` is transient and retryable.
 */
export async function revealOrcaWorkersWithRetry({
  reveal,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  wait = (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
}: RevealOrcaWorkersWithRetryOptions): Promise<RsbWindowCommandRouteResult> {
  const attempts = Math.max(1, maxAttempts);
  let result = await reveal();
  for (let attempt = 1; result === 'stale-context' && attempt < attempts; attempt += 1) {
    await wait(retryDelayMs);
    result = await reveal();
  }
  return result;
}

/** The sidebar may live in another window. Hold the same origin-wide lock from
 * optimistic reveal through enable/rollback, and across the restore read and close. */
export async function withOrcaTabLifecycle(
  sessionId: string,
  operation: 'enable' | 'reconcile',
  run: () => Promise<void>,
): Promise<void> {
  const locks = navigator.locks;
  if (!locks) {
    if (operation === 'enable') await run();
    return;
  }
  await locks.request(
    `orca-tab-lifecycle:${sessionId}`,
    { ifAvailable: operation === 'reconcile' },
    async lock => { if (lock) await run(); },
  );
}
