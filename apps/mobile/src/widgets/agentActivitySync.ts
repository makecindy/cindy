export interface AgentActivitySink {
  setState(json: string | null): void;
  markStale(): void;
}

/** Coalesce store bursts without postponing the latest state indefinitely. Undefined
 * means the connection cannot attest to the snapshot; null means no tasks remain. */
export function createAgentActivitySync(read: () => string | null | undefined, sink: AgentActivitySink) {
  let last: string | null | undefined;
  let lastWrite = -Infinity;
  let stale = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sync = (force = false) => {
    if (disposed) return;
    const json = read();
    if (json === undefined) {
      clearTimeout(timer);
      timer = undefined;
      if (!stale) sink.markStale();
      stale = true;
      return;
    }
    const elapsed = Date.now() - lastWrite;
    // Refresh the native stale deadline while a healthy foreground connection
    // still confirms the same task. No network request is involved.
    if (!force && !stale && json === last && (json === null || elapsed < 60_000)) return;
    if (!force && !stale && json !== null && elapsed < 1_000) {
      timer ??= setTimeout(() => { timer = undefined; sync(); }, 1_000 - elapsed);
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    sink.setState(json);
    last = json;
    lastWrite = Date.now();
    stale = false;
  };
  return {
    sync,
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
