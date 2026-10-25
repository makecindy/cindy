type LogLike = {
  warn(message: string, fields?: Record<string, unknown>): void;
};

export interface WorkerTurnStartSequencer {
  start(sessionId: string, run: () => Promise<void>): void;
  waitForStart(sessionId: string): Promise<void>;
}

export function createWorkerTurnStartSequencer(log: LogLike): WorkerTurnStartSequencer {
  const inFlightBySession = new Map<string, Promise<void>>();

  return {
    start(sessionId, run) {
      const promise = run().catch((err) => {
        log.warn('orca worker turn start status update failed', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
      inFlightBySession.set(sessionId, promise);
      void promise.finally(() => {
        if (inFlightBySession.get(sessionId) === promise) {
          inFlightBySession.delete(sessionId);
        }
      });
    },
    async waitForStart(sessionId) {
      await inFlightBySession.get(sessionId);
    },
  };
}
