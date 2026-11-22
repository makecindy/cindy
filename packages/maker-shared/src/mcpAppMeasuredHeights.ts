// Coordinates are CSS pixels on this viewing device. Preserve the existing 100-card LRU.
type Measurement = [key: string, width: number, height: number];
const limit = 100;
export function parseMcpAppMeasurements(raw: string | null): Measurement[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? data.slice(-limit).filter((item): item is Measurement =>
      Array.isArray(item) && item.length === 3 && typeof item[0] === 'string' &&
      Number.isFinite(item[1]) && item[1] > 0 && Number.isInteger(item[2]) && item[2] >= 80 && item[2] <= 5000) : [];
  } catch { return []; }
}

export class McpAppMeasuredHeights {
  private entries = new Map<string, Measurement>();
  private changed = new Map<string, Measurement>();
  private timer?: ReturnType<typeof setTimeout>;
  private firstChange?: number;
  private writing = false;
  private disposed = false;

  private hydrated = false;

  constructor(initial: string | null | undefined, private readonly write: (snapshot: Measurement[], changes: Measurement[]) => void | Promise<void>) {
    if (initial !== undefined) this.restore(initial);
  }

  // Mobile can measure before its account storage is ready. Those newer entries
  // keep their order and take precedence over the older persisted snapshot.
  restore(initial: string | null): void {
    if (this.disposed || this.hydrated) return;
    const older = parseMcpAppMeasurements(initial).filter(([key]) => !this.entries.has(key));
    const newest = [...older, ...this.entries.values()].slice(-limit);
    this.entries = new Map(newest.map(entry => [entry[0], entry]));
    this.hydrated = true;
    if (this.changed.size) this.schedule();
  }

  get(key: string, width: number): number | undefined {
    const entry = this.entries.get(key);
    if (!entry || !Number.isFinite(width) || width <= 0 || Math.abs(width - entry[1]) > 16) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry[2];
  }

  remember(key: string, width: number, height: number): void {
    if (this.disposed || !Number.isFinite(width) || width <= 0 ||
        !Number.isInteger(height) || height < 80 || height > 5000) return;
    const previous = this.entries.get(key);
    if (previous?.[1] === width && previous[2] === height) return;
    const entry: Measurement = [key, width, height];
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.changed.set(key, entry);
    if (this.entries.size > limit) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
      this.changed.delete(oldest);
    }
    this.firstChange ??= Date.now();
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.hydrated || this.writing || this.disposed || this.firstChange === undefined) return;
    const delay = Math.min(500, Math.max(0, this.firstChange + 2000 - Date.now()));
    this.timer = setTimeout(() => { void this.flush(); }, delay);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.hydrated || this.disposed || this.writing || !this.changed.size) return;
    const changes = [...this.changed.values()];
    this.changed.clear();
    this.firstChange = undefined;
    this.writing = true;
    try { await this.write([...this.entries.values()], changes); }
    catch { /* An unavailable layout cache must not block the task or retry in a loop. */ }
    finally { this.writing = false; this.schedule(); }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.entries.clear();
    this.changed.clear();
  }
}
