import type { PerformanceTraceEvent } from '../../shared/performanceTrace';

/** Exact operations only: no caller-controlled channel names or arguments leave this boundary. */
export const TRACE_OPERATIONS = new Set([
  'local-db:sessions:list',
  'local-db:sessions:get',
  'local-db:messages:list',
  'local-db:messages:view',
  'maker:list-agent-skills',
  'maker:list-agent-skills:project-links',
  'maker:list-agent-skills:global-assets',
  'maker:list-agent-skills:scan',
  'maker:list-agent-skills:identity',
  'maker:list-customizations',
  // Screenshot backend/fallback diagnostics: static labels, no screen contents,
  // window titles, display identifiers or raw color profiles.
  'region-screenshot:windows',
  'region-screenshot:native',
  'region-screenshot:electron:platform',
  'region-screenshot:electron:helper-missing',
  'region-screenshot:electron:color-space',
  'region-screenshot:electron:native-frame-unavailable',
  'region-screenshot:electron:native-size-mismatch',
  'region-screenshot:electron:native-image-empty',
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
