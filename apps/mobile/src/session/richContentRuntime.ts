/** Per-list, disposable work queue and LRU. Nothing is persisted or shared across tasks. */
export class RichContentRuntime {
  private pending = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private quietUntil = 0;
  private entries = new Map<string, string>();
  private bytes = 0;

  constructor(private readonly maxBytes = 8 * 1024 * 1024) {}

  /** Scroll events only move a deadline; they never cause a React tree update. */
  onScroll = () => {
    this.quietUntil = Date.now() + 180;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule();
  };

  request(run: () => void): () => void {
    this.pending.add(run);
    this.schedule();
    return () => { this.pending.delete(run); };
  }

  private schedule() {
    if (this.timer !== undefined || !this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = this.pending.values().next().value;
      if (run) { this.pending.delete(run); run(); }
      // Stagger native mounts instead of creating every visible WebView in one batch.
      this.quietUntil = Date.now() + 100;
      this.schedule();
    }, Math.max(40, this.quietUntil - Date.now()));
  }

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): boolean {
    const size = 2 * (key.length + value.length);
    if (size > Math.min(this.maxBytes, 2 * 1024 * 1024)) return false;
    this.delete(key);
    while (this.entries.size >= 100 || this.bytes + size > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(key, value);
    this.bytes += size;
    return true;
  }

  delete(key: string) {
    const previous = this.entries.get(key);
    if (previous !== undefined) this.bytes -= 2 * (key.length + previous.length);
    this.entries.delete(key);
  }

  clear() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.entries.clear();
    this.bytes = 0;
    this.quietUntil = 0;
  }
}
