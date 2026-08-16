/**
 * Synchronous ingress gate for the current authenticated account boundary.
 * Transport shutdown may await network I/O, but no newly delivered event may
 * enter account-scoped orchestration after logout has started.
 */
export type ImAccountGeneration = number;

let active = true;
let generation: ImAccountGeneration = 0;
const inFlightByGeneration = new Map<ImAccountGeneration, Set<Promise<unknown>>>();
const GLOBAL_MIGRATION_SCOPE = '*';
const migrationBarriers = new Map<string, Promise<void>>();
const operationScopes = new WeakMap<Promise<unknown>, string>();

const ACCOUNT_SCOPE_CLOSED_CODE = 'IM_ACCOUNT_SCOPE_CLOSED';

/** Error used to silently discard work invalidated by logout/account replacement. */
export class ImAccountScopeClosedError extends Error {
  readonly code = ACCOUNT_SCOPE_CLOSED_CODE;

  constructor() {
    super('[IM_NOT_READY] IM account changed before operation ran');
    this.name = 'ImAccountScopeClosedError';
  }
}

export function activateImAccountBoundary(): void {
  if (active) return;
  generation += 1;
  active = true;
}

export function deactivateImAccountBoundary(): void {
  if (!active) return;
  active = false;
  generation += 1;
}

/** Capture the active account generation at synchronous event ingress. */
export function captureImAccountGeneration(): ImAccountGeneration | null {
  return active ? generation : null;
}

/** Reject queued work captured by a logged-out or replaced account. */
export function isImAccountGenerationCurrent(token: ImAccountGeneration): boolean {
  return active && token === generation;
}

/** Keep a complete async handler attached to the account generation that admitted it. */
export function runInImAccountGeneration<T>(
  token: ImAccountGeneration,
  operation: () => Promise<T>,
  migrationScope = GLOBAL_MIGRATION_SCOPE,
): Promise<T> {
  // Capture at admission. Reading the global barrier later would make a
  // pre-migration handler wait on a gate that is simultaneously draining it.
  const admittedBarriers =
    migrationScope === GLOBAL_MIGRATION_SCOPE
      ? [...migrationBarriers.values()]
      : [
          migrationBarriers.get(GLOBAL_MIGRATION_SCOPE),
          migrationBarriers.get(migrationScope),
        ].filter((barrier): barrier is Promise<void> => Boolean(barrier));
  const tracked = Promise.resolve().then(async () => {
    await Promise.all(admittedBarriers);
    if (!isImAccountGenerationCurrent(token)) throw new ImAccountScopeClosedError();
    return operation();
  });
  operationScopes.set(tracked, migrationScope);
  const inFlight = inFlightByGeneration.get(token) ?? new Set<Promise<unknown>>();
  inFlightByGeneration.set(token, inFlight);
  inFlight.add(tracked);
  const remove = (): void => {
    inFlight.delete(tracked);
    if (inFlight.size === 0) inFlightByGeneration.delete(token);
  };
  void tracked.then(remove, remove);
  return tracked;
}

/**
 * Blocks new local-IM handlers, drains the handlers admitted before the gate,
 * then runs one migration mutation. Existing transports stay connected and
 * queued messages resume against the newly committed Bot Route.
 */
export async function runImMigrationExclusive<T>(
  migrationScope: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (migrationBarriers.has(migrationScope)) {
    throw new Error('Another IM migration is already running for this Channel');
  }
  const token = captureImAccountGeneration();
  const admitted =
    token === null
      ? []
      : [...(inFlightByGeneration.get(token) ?? [])].filter((promise) => {
          const scope = operationScopes.get(promise) ?? GLOBAL_MIGRATION_SCOPE;
          return scope === GLOBAL_MIGRATION_SCOPE || scope === migrationScope;
        });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  migrationBarriers.set(migrationScope, barrier);
  try {
    await Promise.allSettled(admitted);
    return await operation();
  } finally {
    if (migrationBarriers.get(migrationScope) === barrier) {
      migrationBarriers.delete(migrationScope);
    }
    release();
    await barrier;
  }
}

/** Wait until every handler admitted by this account has crossed its final async boundary. */
export async function waitForImAccountGenerationIdle(token: ImAccountGeneration): Promise<void> {
  while (true) {
    const inFlight = inFlightByGeneration.get(token);
    if (!inFlight || inFlight.size === 0) return;
    await Promise.allSettled([...inFlight]);
  }
}

/** Identify the expected rejection used when queued work loses its account generation. */
export function isImAccountScopeClosedError(error: unknown): boolean {
  return (
    error instanceof ImAccountScopeClosedError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === ACCOUNT_SCOPE_CLOSED_CODE)
  );
}
