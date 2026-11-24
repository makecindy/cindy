/**
 * The maintenance gate of a managed cloud instance. The cloud build connects it at startup; an
 * ordinary desktop has none and runs every change directly.
 */
export interface InstanceMaintenanceGate {
  /** Throws a retryable error once maintenance has begun, before any work is accepted. */
  admit(kind: 'remote-input'): void;
  /** Runs accepted work, counted as in flight until it settles, so maintenance cannot seal under it. */
  run<T>(kind: 'remote-input', work: () => Promise<T>): Promise<T>;
}

let gate: InstanceMaintenanceGate | null = null;

export function connectInstanceMaintenance(value: InstanceMaintenanceGate): void { gate = value; }

// Changes a controller sends to the instance count as remote input, like the owner's login recovery.
export function admitRemoteChange(): void { gate?.admit('remote-input'); }
export function runRemoteChange<T>(work: () => Promise<T>): Promise<T> {
  return gate ? gate.run('remote-input', work) : work();
}

export const MAINTENANCE_RETRY = 'CLOUD_MAINTENANCE_RETRY';

/** As {@link runRemoteChange}, for handlers whose callers read a `[CODE] message` error. */
export async function runReportedRemoteChange<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await runRemoteChange(work);
  } catch (error) {
    if (isMaintenanceRetry(error)) throw new Error(`[${MAINTENANCE_RETRY}] maintenance is in progress; try again shortly`);
    throw error;
  }
}
export function isMaintenanceRetry(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === MAINTENANCE_RETRY;
}
