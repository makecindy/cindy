import { networkInterfaces } from 'node:os';

export interface WatchNetworkChangesOptions {
  /** Optional system proxy snapshot reader (e.g. Electron `session.defaultSession.resolveProxy`).
   * Returning null/undefined or throwing is treated as unreadable and never triggers a change. */
  readProxy?: () => Promise<string | null | undefined>;
}

/**
 * macOS peer-to-peer / Apple-internal virtual interfaces (AirDrop/Handoff/Continuity/USB bridge)
 * come and go every few seconds during normal desktop use and never carry routable traffic.
 */
const IGNORED_INTERFACE = /^(?:awdl|llw|anpi|anri)\d+$/i;

function isLinkLocalAddress(address: string): boolean {
  const lower = address.toLowerCase();
  return lower.startsWith('169.254.') || /^fe[89ab][0-9a-f]:/.test(lower);
}

/** Observe routable interface/address and optional system proxy changes without recording addresses in logs.
 * Link-local addresses (fe80::/10, 169.254.0.0/16) and ephemeral macOS P2P interfaces (awdl/llw/anpi/anri)
 * are ignored so AirDrop/Continuity/idle utun churn does not trigger spurious network resets or UDP rebinds.
 * Pure route-only VPN/transparent-proxy changes without interface or proxy updates remain covered by
 * the relay heartbeat and Agent-Net's UDP socket blackhole recovery. */
export function watchNetworkChanges(onChange: () => void, options?: WatchNetworkChangesOptions): () => void {
  const snapshot = (): string =>
    JSON.stringify(
      Object.entries(networkInterfaces())
        .filter(([name]) => !IGNORED_INTERFACE.test(name))
        .flatMap(([name, addresses]) =>
          (addresses ?? [])
            .filter((address) => !address.internal && !isLinkLocalAddress(address.address))
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
