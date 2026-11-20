import { isSqliteCorruption, createCorruptDbUnavailableError } from './sqliteCorruption.js';
import { createLogger } from '../../logger.js';

const log = createLogger('db-worker');

export interface DbErrorBoundaryOptions {
  maxAutoRestart?: number;
  onCorruption?: (error: Error) => void;
}

export class DbErrorBoundary {
  private terminatedCount = 0;
  private corruptionError: Error | null = null;
  private readonly onCorruption?: (error: Error) => void;
  private readonly maxAutoRestart: number;

  constructor(options: DbErrorBoundaryOptions = {}) {
    this.onCorruption = options.onCorruption;
    this.maxAutoRestart = options.maxAutoRestart ?? 1;
  }

  async wrap<T>(opName: string, fn: () => Promise<T>): Promise<T> {
    if (opName !== 'dispose') this.assertAvailable();
    try {
      return await fn();
    } catch (err) {
      this.observeError(err);
      log.error('db client rpc failed', {
        op: opName,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  get failure(): Error | null { return this.corruptionError; }

  assertAvailable(): void {
    if (this.corruptionError) throw createCorruptDbUnavailableError(this.corruptionError);
  }

  observeError(error: unknown): void {
    if (this.corruptionError || !isSqliteCorruption(error)) return;
    this.corruptionError = error instanceof Error ? error : Object.assign(new Error('SQLite corruption'), error);
    try { this.onCorruption?.(this.corruptionError); } catch (err) {
      log.warn('database corruption notification failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  onWorkerTerminated(info: { code: number | null; signal: string | null }): {
    shouldRestart: boolean;
  } {
    this.terminatedCount += 1;
    const shouldRestart = !this.corruptionError && this.terminatedCount <= this.maxAutoRestart;
    log.warn('db worker terminated', {
      code: info.code,
      signal: info.signal,
      terminatedCount: this.terminatedCount,
      shouldRestart,
    });
    return { shouldRestart };
  }
}
