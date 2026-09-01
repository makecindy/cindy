export type PeerRecoveryPhase = 'idle' | 'queued' | 'running' | 'waiting-retry';

export interface PeerRecoveryResult {
  /** True when this peer still has transient work and needs a later retry. */
  retry: boolean;
}

export interface PeerRecoverySchedulerOptions {
  maxConcurrent?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onError?(deviceId: string, error: unknown): void;
}

export interface PeerRecoverySnapshot {
  deviceId: string;
  phase: PeerRecoveryPhase;
  retryAttempt: number;
}

interface PeerRecoveryEntry {
  phase: PeerRecoveryPhase;
  generation: number;
  running: boolean;
  rerun: boolean;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_MAX_CONCURRENT = 6;
const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_RETRY_MAX_MS = 30_000;

/**
 * Transient open intent created by a peer-level transport reset. Generations never reuse
 * within this provider lifetime, so an old A recovery cannot clear a newer A intent after
 * cancel → reacquire (the same ABA fence used by the scheduler itself).
 */
export class PeerRecoveryOpenIntentRegistry {
  private readonly generations = new Map<string, number>();
  private nextGeneration = 0;

  request(deviceId: string): number {
    if (!deviceId) return 0;
    const generation = ++this.nextGeneration;
    this.generations.set(deviceId, generation);
    return generation;
  }

  getGeneration(deviceId: string): number | undefined {
    return this.generations.get(deviceId);
  }

  has(deviceId: string): boolean {
    return this.generations.has(deviceId);
  }

  complete(deviceId: string, generation: number): boolean {
    if (this.generations.get(deviceId) !== generation) return false;
    this.generations.delete(deviceId);
    return true;
  }

  cancel(deviceId: string): void {
    this.generations.delete(deviceId);
  }

  clear(): void {
    // Keep nextGeneration monotonic: a settling pre-clear run must never collide with a
    // post-clear intent if the provider/client is replaced while its promise unwinds.
    this.generations.clear();
  }

  deviceIds(): string[] {
    return [...this.generations.keys()];
  }
}

/**
 * Runs recovery independently per remote device while sharing a small global
 * concurrency budget. A slow peer occupies at most one slot, so it cannot hold
 * every other desktop behind its timeout. Each peer owns its own rerun flag,
 * retry attempt and timer.
 */
export class PeerRecoveryScheduler {
  private readonly runPeer: (deviceId: string) => Promise<PeerRecoveryResult>;
  private readonly onError?: PeerRecoverySchedulerOptions['onError'];
  private readonly maxConcurrent: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly entries = new Map<string, PeerRecoveryEntry>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private active = 0;
  private paused = false;

  constructor(
    run: (deviceId: string) => Promise<PeerRecoveryResult>,
    options: PeerRecoverySchedulerOptions = {},
  ) {
    this.runPeer = run;
    this.onError = options.onError;
    this.maxConcurrent = normalizePositiveInteger(
      options.maxConcurrent,
      DEFAULT_MAX_CONCURRENT,
    );
    this.retryBaseMs = normalizePositiveInteger(
      options.retryBaseMs,
      DEFAULT_RETRY_BASE_MS,
    );
    this.retryMaxMs = Math.max(
      this.retryBaseMs,
      normalizePositiveInteger(options.retryMaxMs, DEFAULT_RETRY_MAX_MS),
    );
  }

  request(deviceId: string): void {
    if (!deviceId) return;
    const entry = this.getOrCreateEntry(deviceId);
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    // A cancelled generation may still be settling. Keep the next generation
    // serialized behind it so one peer never has two recovery runs in flight.
    if (entry.running) {
      entry.rerun = true;
      return;
    }
    this.enqueue(deviceId, entry);
  }

  requestMany(deviceIds: Iterable<string>): void {
    for (const deviceId of deviceIds) this.request(deviceId);
  }

  /** Cancels one peer without touching any other peer's timers or work. */
  cancel(deviceId: string, resetAttempt = true): void {
    const entry = this.entries.get(deviceId);
    if (!entry) return;
    entry.generation += 1;
    entry.rerun = false;
    if (resetAttempt) entry.retryAttempt = 0;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    if (this.queued.delete(deviceId)) {
      const index = this.queue.indexOf(deviceId);
      if (index >= 0) this.queue.splice(index, 1);
    }
    entry.phase = 'idle';
  }

  /**
   * Relay/background lifecycle gate. In-flight promises cannot be force-cancelled,
   * but generation fencing makes their late scheduling result inert.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.cancelAll(true);
  }

  resume(): void {
    if (!this.paused) {
      this.drain();
      return;
    }
    this.paused = false;
    this.drain();
  }

  /** Clears all queued/timed work while retaining safe fences for settling runs. */
  clear(): void {
    this.cancelAll(true);
    for (const [deviceId, entry] of this.entries) {
      if (!entry.running) this.entries.delete(deviceId);
    }
  }

  getSnapshot(deviceId: string): PeerRecoverySnapshot {
    const entry = this.entries.get(deviceId);
    return {
      deviceId,
      phase: entry?.phase ?? 'idle',
      retryAttempt: entry?.retryAttempt ?? 0,
    };
  }

  private cancelAll(resetAttempts: boolean): void {
    this.queue.length = 0;
    this.queued.clear();
    for (const [deviceId] of this.entries) this.cancel(deviceId, resetAttempts);
  }

  private getOrCreateEntry(deviceId: string): PeerRecoveryEntry {
    let entry = this.entries.get(deviceId);
    if (!entry) {
      entry = {
        phase: 'idle',
        generation: 0,
        running: false,
        rerun: false,
        retryAttempt: 0,
        retryTimer: null,
      };
      this.entries.set(deviceId, entry);
    }
    return entry;
  }

  private enqueue(deviceId: string, entry: PeerRecoveryEntry): void {
    if (this.queued.has(deviceId)) return;
    entry.phase = 'queued';
    this.queued.add(deviceId);
    this.queue.push(deviceId);
    this.drain();
  }

  private drain(): void {
    if (this.paused) return;
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const deviceId = this.queue.shift()!;
      this.queued.delete(deviceId);
      const entry = this.entries.get(deviceId);
      if (!entry || entry.phase !== 'queued' || entry.running) continue;
      this.start(deviceId, entry);
    }
  }

  private start(deviceId: string, entry: PeerRecoveryEntry): void {
    const generation = entry.generation;
    entry.phase = 'running';
    entry.running = true;
    entry.rerun = false;
    this.active += 1;

    let run: Promise<PeerRecoveryResult>;
    try {
      run = this.runPeer(deviceId);
    } catch (error) {
      try {
        this.onError?.(deviceId, error);
      } catch {
        // Diagnostics must never strand the scheduler's active-slot accounting.
      }
      this.finish(deviceId, entry, generation, { retry: true });
      return;
    }
    void run.then(
      (result) => this.finish(deviceId, entry, generation, result),
      (error: unknown) => {
        try {
          this.onError?.(deviceId, error);
        } catch {
          // Diagnostics must never strand the scheduler's active-slot accounting.
        }
        this.finish(deviceId, entry, generation, { retry: true });
      },
    );
  }

  private finish(
    deviceId: string,
    entry: PeerRecoveryEntry,
    generation: number,
    result: PeerRecoveryResult,
  ): void {
    if (entry.generation === generation && !entry.rerun) {
      if (!result.retry) {
        entry.retryAttempt = 0;
        entry.phase = 'idle';
      } else {
        const delay = Math.min(
          this.retryBaseMs * 2 ** entry.retryAttempt,
          this.retryMaxMs,
        );
        entry.retryAttempt += 1;
        entry.phase = 'waiting-retry';
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = null;
          if (entry.generation !== generation) return;
          this.enqueue(deviceId, entry);
        }, delay);
      }
    }
    entry.running = false;
    this.active -= 1;
    if (entry.rerun) {
      entry.rerun = false;
      this.enqueue(deviceId, entry);
    }
    this.drain();
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}
