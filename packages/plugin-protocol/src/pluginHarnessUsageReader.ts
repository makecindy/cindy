import { parseGhostHarnessUsage, type GhostHarnessUsage } from './pluginHarnesses.js';

export const PLUGIN_USAGE_READ_INTERVAL_MS = 60_000;

interface UsageRead {
  result: Promise<GhostHarnessUsage | null>;
  /** A pending request is shared even if it outlives the normal cooldown. */
  freshUntil: number;
}

/** A client shares a read across tasks on the same account generation, computer and engine.
 * The cleanup timer releases the settled entry one minute after the start. It never fetches.
 */
export function createPluginHarnessUsageReader() {
  const owners = new WeakMap<object, Map<string | null, Map<string, UsageRead>>>();
  return {
    read(owner: object, device: string | null, engine: string, request: () => Promise<unknown> | undefined): UsageRead {
      const targets = owners.get(owner) ?? new Map<string | null, Map<string, UsageRead>>();
      const scope = targets.get(device) ?? new Map<string, UsageRead>();
      const existing = scope.get(engine);
      if (existing && Date.now() < existing.freshUntil) return existing;

      owners.set(owner, targets);
      targets.set(device, scope);
      const nextReadAt = Date.now() + PLUGIN_USAGE_READ_INTERVAL_MS;
      const fetchUsage = async () => {
        if (scope.get(engine) !== read) return null;
        const raw = await request();
        return scope.get(engine) === read ? parseGhostHarnessUsage(raw) ?? null : null;
      };
      const read: UsageRead = {
        freshUntil: Infinity,
        result: Promise.resolve().then(fetchUsage).catch(() => null).finally(() => {
          read.freshUntil = nextReadAt;
          if (scope.get(engine) !== read) return;
          setTimeout(() => {
            if (scope.get(engine) === read) scope.delete(engine);
            if (!scope.size && targets.get(device) === scope) targets.delete(device);
          }, Math.max(0, nextReadAt - Date.now()));
        }),
      };
      scope.set(engine, read);
      return read;
    },
    /**
     * A catalogue is authoritative for which engines can report usage. Model changes leave their reads
     * intact. A read of one task's account (`<engine>|task:<id>`, engines with several accounts) belongs
     * to its engine; engine keys never contain `|`.
     */
    retainReportingEngines(owner: object, device: string | null, engines: readonly { key: string; reportsUsage?: boolean }[]): void {
      const targets = owners.get(owner);
      const scope = targets?.get(device);
      if (!targets || !scope) return;
      const reporting = new Set(engines.filter(engine => engine.reportsUsage === true).map(engine => engine.key));
      for (const key of scope.keys()) {
        const separator = key.indexOf('|');
        if (!reporting.has(separator < 0 ? key : key.slice(0, separator))) scope.delete(key);
      }
      if (!scope.size) targets.delete(device);
    },
  };
}
