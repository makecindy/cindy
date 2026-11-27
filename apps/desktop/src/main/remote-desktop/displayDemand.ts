/**
 * Whether work needs this computer's screen awake behind the privacy screen
 * (docs/product-rules/privacy-screen.md, "只在需要时常亮"). Without work the display is
 * left to the system, which sleeps and locks on its own schedule; an LCD backlight
 * stays lit even behind a black cover, so an idle machine must not hold it.
 */

/** Keep the display awake this long before a scheduled task starts. */
export const SCHEDULE_LEAD_MS = 3 * 60_000;
/** Schedule times are read from the database at most this often, not on every tick. */
export const SCHEDULE_REFRESH_MS = 60_000;

export interface DisplayDemandSources {
  /** Agent tasks currently running on this computer. */
  runningTasks(): number;
  /** Earliest next run of an active scheduled task on this computer, or null. */
  nextScheduledRunAt(): Promise<number | null>;
  now(): number;
}

export class DisplayDemand {
  private nextRunAt: number | null = null;
  private readAt = Number.NEGATIVE_INFINITY;
  private reading = false;

  constructor(private readonly sources: DisplayDemandSources) {}

  needed(): boolean {
    this.refreshSchedules();
    if (this.sources.runningTasks() > 0) return true;
    // A run that is due or overdue counts until the next read sees it started.
    return this.nextRunAt !== null && this.nextRunAt - this.sources.now() <= SCHEDULE_LEAD_MS;
  }

  private refreshSchedules(): void {
    const now = this.sources.now();
    if (this.reading || now - this.readAt < SCHEDULE_REFRESH_MS) return;
    this.reading = true;
    this.readAt = now;
    void this.sources
      .nextScheduledRunAt()
      .then((next) => {
        this.nextRunAt = next;
      })
      // An unreadable schedule list must not hold the display on.
      .catch(() => {
        this.nextRunAt = null;
      })
      .finally(() => {
        this.reading = false;
      });
  }
}
