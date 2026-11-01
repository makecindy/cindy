import type { PerformanceTraceEvent } from '../../shared/performanceTrace';

/** Exact operations only: no caller-controlled channel names or arguments leave this boundary. */
export const TRACE_OPERATIONS = new Set([
  'local-db:sessions:list',
  'local-db:sessions:get',
  'local-db:messages:list',
  'local-db:messages:view',
  'maker:list-agent-skills',
  'maker:list-customizations',
]);
let observer: ((event: PerformanceTraceEvent) => void) | null = null;
export function setTraceOperationObserver(next: typeof observer): void {
  observer = next;
}

/** Preserve synchronous returns, thrown errors and promise outcomes; never observe payloads. */
export function measureTraceOperation<T>(channel: string, run: () => T): T {
  const current = observer;
  if (!current || !TRACE_OPERATIONS.has(channel)) return run();
  const at = Date.now();
  const started = performance.now();
  const finish = () => {
    if (observer !== current) return;
    try {
      current({ at, kind: 'ipc', label: channel, durationMs: performance.now() - started });
    } catch {
      /* Diagnostics must not change the operation. */
    }
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(finish) as T;
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}
