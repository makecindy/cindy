import { networkInterfaces } from 'node:os';

/** Observe interface/address changes without recording addresses in logs. Some
 * route-only VPN/proxy changes remain covered by the regular relay heartbeat. */
export function watchNetworkChanges(onChange: () => void): () => void {
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
  const poll = (): void => {
    try {
      const next = snapshot();
      const changed = previous !== undefined && previous !== next;
      previous = next;
      if (changed) onChange();
    } catch {
      // An OS enumeration failure is not evidence that the relay is broken.
    }
  };
  poll();
  const timer = setInterval(poll, 2_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
