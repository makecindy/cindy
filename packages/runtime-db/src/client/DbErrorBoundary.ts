import type { DbLogger } from '../logging.js';

export interface DbErrorBoundaryOptions {
  maxAutoRestart?: number;
  logger: Pick<DbLogger, 'warn' | 'error'>;
}

export class DbErrorBoundary {
  private terminatedCount = 0;
  private readonly maxAutoRestart: number;

  constructor(private readonly options: DbErrorBoundaryOptions) {
    this.maxAutoRestart = options.maxAutoRestart ?? 1;
  }

  async wrap<T>(opName: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.options.logger.error('db client rpc failed', {
        op: opName,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  onWorkerTerminated(info: { code: number | null; signal: string | null }): {
    shouldRestart: boolean;
  } {
    this.terminatedCount += 1;
    const shouldRestart = this.terminatedCount <= this.maxAutoRestart;
    this.options.logger.warn('db worker terminated', {
      code: info.code,
      signal: info.signal,
      terminatedCount: this.terminatedCount,
      shouldRestart,
    });
    return { shouldRestart };
  }
}
