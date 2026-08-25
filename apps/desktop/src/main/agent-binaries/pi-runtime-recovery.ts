import type { PrepareResult } from './types.js';

/** Retry delay for an optional Pi runtime that missed the startup network. */
export const PI_RUNTIME_RECOVERY_RETRY_MS = 30_000;

export interface PiRuntimeRecoveryOptions {
  isOnline: () => boolean;
  prepare: () => Promise<PrepareResult>;
  register: () => boolean;
  onRegistered: () => void;
  logWarn?: (message: string, error?: unknown) => void;
  retryDelayMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export interface PiRuntimeRecovery {
  /** Mark the startup prepare as unavailable and begin background recovery. */
  markUnavailable(error?: string): void;
  /** Try recovery immediately; returns true only when Pi was registered. */
  retryNow(reason?: string): Promise<boolean>;
  /** Stop future retries during app shutdown or test cleanup. */
  dispose(): void;
  isDisabled(): boolean;
}

/**
 * Owns the small recovery state machine for an optional Pi runtime.
 *
 * The CDN policy remains unchanged: every retry calls the managed prepare path,
 * so a local runtime is accepted only after the manifest and verification rules
 * have succeeded. Concurrent focus/timer signals share one prepare promise.
 */
export function createPiRuntimeRecovery(options: PiRuntimeRecoveryOptions): PiRuntimeRecovery {
  const retryDelayMs = options.retryDelayMs ?? PI_RUNTIME_RECOVERY_RETRY_MS;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  let disabled = false;
  let disposed = false;
  let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let inFlight: Promise<boolean> | null = null;

  const logWarn = (message: string, error?: unknown): void => {
    options.logWarn?.(message, error);
  };

  const scheduleRetry = (): void => {
    if (disposed || !disabled || retryTimer !== null) return;
    retryTimer = schedule(() => {
      retryTimer = null;
      void recovery.retryNow('timer');
    }, retryDelayMs);
    const unref = (retryTimer as unknown as { unref?: () => void }).unref;
    unref?.call(retryTimer);
  };

  const recovery: PiRuntimeRecovery = {
    markUnavailable(error) {
      disabled = true;
      if (error) logWarn('Pi runtime unavailable; scheduling recovery', error);
      scheduleRetry();
    },

    retryNow(reason = 'manual') {
      if (disposed || !disabled) return Promise.resolve(false);
      if (inFlight) return inFlight;

      let online = false;
      try {
        online = options.isOnline();
      } catch (error) {
        logWarn('Pi runtime network state probe failed', error);
      }
      if (!online) {
        scheduleRetry();
        return Promise.resolve(false);
      }

      const attempt = (async (): Promise<boolean> => {
        try {
          const result = await options.prepare();
          if (!result.ready || !result.path) {
            logWarn(`Pi runtime recovery prepare failed (${reason})`, result.error);
            scheduleRetry();
            return false;
          }
          if (!options.register()) {
            scheduleRetry();
            return false;
          }
          disabled = false;
          options.onRegistered();
          return true;
        } catch (error) {
          logWarn(`Pi runtime recovery threw (${reason})`, error);
          scheduleRetry();
          return false;
        }
      })();
      inFlight = attempt;
      void attempt.then(() => {
        if (inFlight === attempt) inFlight = null;
      }, () => {
        if (inFlight === attempt) inFlight = null;
      });
      return attempt;
    },

    dispose() {
      disposed = true;
      if (retryTimer !== null) {
        cancel(retryTimer);
        retryTimer = null;
      }
    },

    isDisabled() {
      return disabled;
    },
  };

  return recovery;
}
