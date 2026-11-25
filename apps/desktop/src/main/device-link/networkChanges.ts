import { networkInterfaces } from 'node:os';

export interface WatchNetworkChangesOptions {
  /** Optional system proxy snapshot reader (e.g. Electron `session.defaultSession.resolveProxy`).
   * Returning null/undefined or throwing is treated as unreadable and never triggers a change. */
  readProxy?: () => Promise<string | null | undefined>;
}

/** Observe interface/address and optional system proxy changes without recording addresses in logs.
 * Pure route-only VPN/transparent-proxy changes without interface or proxy updates remain covered by
 * the relay heartbeat and Agent-Net's UDP socket blackhole recovery. */
export function watchNetworkChanges(onChange: () => void, options?: WatchNetworkChangesOptions): () => void {
  const snapshot = (): string =>
    JSON.stringify(
      Object.entries(networkInterfaces())
        .flatMap(([name, addresses]) =>
          (addresses ?? [])
            .filter((address) => !address.internal)
            .map((address) => `${name}:${address.family}:${address.address}`),
        )
        .sort(),
    );
  let previous: string | undefined;
  let previousProxy: string | undefined;
  let readingProxy = false;
  let stopped = false;
  let pollSeq = 0;
  let notifiedSeq = 0;
  const notify = (seq: number): void => {
    if (stopped || notifiedSeq === seq) return;
    notifiedSeq = seq;
    onChange();
  };
  const poll = (): void => {
    const seq = ++pollSeq;
    try {
      const next = snapshot();
      const changed = previous !== undefined && previous !== next;
      previous = next;
      if (changed) notify(seq);
    } catch {
      // An OS enumeration failure is not evidence that the relay is broken.
    }
    if (!options?.readProxy || readingProxy || stopped) return;
    readingProxy = true;
    void options.readProxy().then((nextProxy) => {
      if (stopped || typeof nextProxy !== 'string') return;
      const changed = previousProxy !== undefined && previousProxy !== nextProxy;
      previousProxy = nextProxy;
      if (changed) notify(seq);
    }).catch(() => {
      // Proxy lookup errors must not trigger false network-change resets.
    }).finally(() => {
      readingProxy = false;
    });
  };
  poll();
  const timer = setInterval(poll, 2_000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
