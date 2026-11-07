/**
 * Runtime event hub for the browser client.
 *
 * The renderer consumes one event stream (`maker.onEvent`) for everything that
 * happens in a task: the input queue dispatches turns, the agent streams, the
 * queue emits its projection. The host keeps the subscribers and fans out.
 *
 * Events are stamped with a strictly monotonic sequence ID (`seq`), and a bounded
 * history buffer is maintained so clients reconnecting via `/events` (with
 * `Last-Event-ID` or `?since=<seq>`) can replay missed events in order.
 */

export function createEventHub() {
  const subscribers = new Set();
  /** Last event per session so a late page can catch a running turn's tail. */

  const RECENT_LIMIT = 200;
  const MAX_HISTORY = 1000;
  let currentSeq = 0;
  const history = [];

  return {
    clear() { history.length = 0; },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    publish(rawEvent) {
      if (!rawEvent || typeof rawEvent !== 'object') return null;
      currentSeq += 1;
      const event = { ...rawEvent, seq: currentSeq };
      history.push(event);
      if (history.length > MAX_HISTORY) {
        history.shift();
      }
      for (const listener of subscribers) {
        try {
          listener(event);
        } catch {
          // A broken browser tab must not break the runtime.
        }
      }
      return event;
    },
    getEventsSince(sinceSeq) {
      const seq = Number(sinceSeq);
      if (!Number.isFinite(seq)) return [];
      return history.filter((e) => e.seq > seq);
    },
    currentSeq() {
      return currentSeq;
    },
    size() {
      return subscribers.size;
    },
    RECENT_LIMIT,
  };
}
