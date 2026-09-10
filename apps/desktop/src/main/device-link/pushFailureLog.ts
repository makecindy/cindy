/** Aggregate repeated failures without retaining payloads, paths or error messages. */
export function createPushFailureLog(emit: (summary: {
  peer: string; channel: string; code: string; count: number; elapsedMs: number;
}) => void, now = () => performance.now()) {
  const pending = new Map<string, { peer: string; channel: string; code: string; count: number; started: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const item of pending.values()) {
      if (item.count > 1) emit({ peer: item.peer, channel: item.channel, code: item.code,
        count: item.count - 1, elapsedMs: Math.max(0, Math.round(now() - item.started)) });
    }
    pending.clear();
  };
  return {
    record(peer: string, channel: string, code: string) {
      const key = JSON.stringify([peer, channel, code]);
      const existing = pending.get(key);
      if (existing) existing.count++;
      else {
        pending.set(key, { peer, channel, code, count: 1, started: now() });
        emit({ peer, channel, code, count: 1, elapsedMs: 0 });
      }
      if (!timer) timer = setTimeout(flush, 5000);
    },
    flush,
  };
}
