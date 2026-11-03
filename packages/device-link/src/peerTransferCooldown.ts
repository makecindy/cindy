/** Per owner/device circuit breaker. No timers, polling or cross-device failures. */
export function createPeerTransferCooldown(now = Date.now) {
  const states = new Map<string, { failures: number; until: number }>();
  return {
    remaining(key: string) {
      return Math.max(0, (states.get(key)?.until ?? 0) - now());
    },
    fail(key: string) {
      const failures = Math.min(5, (states.get(key)?.failures ?? 0) + 1);
      const delay = Math.min(300_000, 30_000 * 2 ** (failures - 1));
      states.delete(key);
      if (states.size >= 128) states.delete(states.keys().next().value!);
      states.set(key, { failures, until: now() + delay });
      return delay;
    },
    success(key: string) {
      states.delete(key);
    },
    clear() {
      states.clear();
    },
  };
}
