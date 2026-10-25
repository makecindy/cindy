/**
 * Synchronous ingress gate for the current authenticated account boundary.
 * Transport shutdown may await network I/O, but no newly delivered event may
 * enter account-scoped orchestration after logout has started.
 */
export type ImAccountGeneration = number;

const ACCOUNT_SCOPE_CLOSED_CODE = "IM_ACCOUNT_SCOPE_CLOSED";

/** Error used to silently discard work invalidated by logout/account replacement. */
export class ImAccountScopeClosedError extends Error {
  readonly code = ACCOUNT_SCOPE_CLOSED_CODE;

  constructor() {
    super("[IM_NOT_READY] IM account changed before operation ran");
    this.name = "ImAccountScopeClosedError";
  }
}
export function createImAccountBoundary() {
  let active = true;
  let generation: ImAccountGeneration = 0;
  const inFlightByGeneration = new Map<
    ImAccountGeneration,
    Set<Promise<unknown>>
  >();

  function activateImAccountBoundary(): void {
    if (active) return;
    generation += 1;
    active = true;
  }

  function deactivateImAccountBoundary(): void {
    if (!active) return;
    active = false;
    generation += 1;
  }

  /** Capture the active account generation at synchronous event ingress. */
  function captureImAccountGeneration(): ImAccountGeneration | null {
    return active ? generation : null;
  }

  /** Reject queued work captured by a logged-out or replaced account. */
  function isImAccountGenerationCurrent(token: ImAccountGeneration): boolean {
    return active && token === generation;
  }

  /** Keep a complete async handler attached to the account generation that admitted it. */
  function runInImAccountGeneration<T>(
    token: ImAccountGeneration,
    operation: () => Promise<T>,
  ): Promise<T> {
    const tracked = Promise.resolve().then(async () => {
      if (!isImAccountGenerationCurrent(token))
        throw new ImAccountScopeClosedError();
      return operation();
    });
    const inFlight =
      inFlightByGeneration.get(token) ?? new Set<Promise<unknown>>();
    inFlightByGeneration.set(token, inFlight);
    inFlight.add(tracked);
    const remove = (): void => {
      inFlight.delete(tracked);
      if (inFlight.size === 0) inFlightByGeneration.delete(token);
    };
    void tracked.then(remove, remove);
    return tracked;
  }

  /** Wait until every handler admitted by this account has crossed its final async boundary. */
  async function waitForImAccountGenerationIdle(
    token: ImAccountGeneration,
  ): Promise<void> {
    while (true) {
      const inFlight = inFlightByGeneration.get(token);
      if (!inFlight || inFlight.size === 0) return;
      await Promise.allSettled([...inFlight]);
    }
  }

  /** Identify the expected rejection used when queued work loses its account generation. */
  function isImAccountScopeClosedError(error: unknown): boolean {
    return (
      error instanceof ImAccountScopeClosedError ||
      (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === ACCOUNT_SCOPE_CLOSED_CODE)
    );
  }

  return {
    activateImAccountBoundary,
    deactivateImAccountBoundary,
    captureImAccountGeneration,
    isImAccountGenerationCurrent,
    runInImAccountGeneration,
    waitForImAccountGenerationIdle,
    isImAccountScopeClosedError,
  };
}
export const {
  activateImAccountBoundary,
  deactivateImAccountBoundary,
  captureImAccountGeneration,
  isImAccountGenerationCurrent,
  runInImAccountGeneration,
  waitForImAccountGenerationIdle,
  isImAccountScopeClosedError,
} = createImAccountBoundary();
