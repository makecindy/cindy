type Subscribe = (notify: () => void) => () => void;

/** A stable subscription boundary: covering a route must not itself render all
 * its rows. Resume asks each subscriber to check its snapshot; React updates
 * only consumers whose selected value actually changed. */
export class PausableSubscriptions {
  private entries = new Set<{ subscribe: Subscribe; notify: () => void; stop?: () => void }>();

  constructor(public enabled: boolean) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const entry of this.entries) {
      if (enabled) {
        entry.stop = entry.subscribe(entry.notify);
        entry.notify();
      } else {
        entry.stop?.();
        entry.stop = undefined;
      }
    }
  }

  subscribe(subscribe: Subscribe, notify: () => void): () => void {
    const entry = { subscribe, notify, stop: this.enabled ? subscribe(notify) : undefined };
    this.entries.add(entry);
    return () => {
      this.entries.delete(entry);
      entry.stop?.();
    };
  }
}
