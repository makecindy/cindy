/**
 * Runtime event hub for the browser client.
 *
 * The renderer consumes one event stream (`maker.onEvent`) for everything that
 * happens in a task: the input queue dispatches turns, the agent streams, the
 * queue emits its projection. The host keeps the subscribers and fans out.
 */

export function createEventHub() {
  const subscribers = new Set();
  /** Last event per session so a late page can catch a running turn's tail. */
  const recent = new Map();
  const RECENT_LIMIT = 200;

  return {
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    publish(event) {
      if (event && typeof event.sessionId === 'string') {
        recent.set(event.sessionId, event);
      }
      for (const listener of subscribers) {
        try {
          listener(event);
        } catch {
          // A broken browser tab must not break the runtime.
        }
      }
    },
    size() {
      return subscribers.size;
    },
    RECENT_LIMIT,
  };
}
