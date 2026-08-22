/**
 * Synchronous ingress gate for the current authenticated account boundary.
 * Transport shutdown may await network I/O, but no newly delivered event may
 * enter account-scoped orchestration after logout has started.
 */
export type ImAccountGeneration = number;

let active = true;
let generation: ImAccountGeneration = 0;
const inFlightByGeneration = new Map<ImAccountGeneration, Set<Promise<unknown>>>();

const ACCOUNT_SCOPE_CLOSED_CODE = 'IM_ACCOUNT_SCOPE_CLOSED';

/** Error used to silently discard work invalidated by logout/account replacement. */
export class ImAccountScopeClosedError extends Error {
  readonly code = ACCOUNT_SCOPE_CLOSED_CODE;

  constructor() {
    super('[IM_NOT_READY] IM account changed before operation ran');
    this.name = 'ImAccountScopeClosedError';
  }
}

/** 边界从关闭走到激活(false→true 转换)时同步触发的监听器。 */
export type ImAccountBoundaryActivationListener = () => void;

const activationListeners = new Set<ImAccountBoundaryActivationListener>();

/**
 * 订阅账号边界的下一次(及后续)激活。仅在实际转换时触发 — 已激活状态下的
 * 重复 activate 是 no-op, 不通知。返回取消订阅函数。
 */
export function onImAccountBoundaryActivated(
  listener: ImAccountBoundaryActivationListener,
): () => void {
  activationListeners.add(listener);
  return () => {
    activationListeners.delete(listener);
  };
}

export function activateImAccountBoundary(): void {
  if (active) return;
  generation += 1;
  active = true;
  for (const listener of activationListeners) listener();
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
): Promise<T> {
  const tracked = Promise.resolve().then(async () => {
    if (!isImAccountGenerationCurrent(token)) throw new ImAccountScopeClosedError();
    return operation();
  });
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
