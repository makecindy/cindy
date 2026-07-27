import type { LegacyGhostRecoveryStatus } from '../../shared/legacyGhostRecovery.js';

export const LEGACY_GHOST_RECOVERY_STATUS_CHANNEL = 'ghosts:legacy-recovery-status';
export const LEGACY_GHOST_RECOVERY_RETRY_CHANNEL = 'ghosts:retry-legacy-recovery';

interface LegacyGhostRecoveryIpcDeps<Event> {
  assertTrusted(event: Event): void;
  invalid(message: string): never;
  failure(error: unknown): never;
  getStatus(): LegacyGhostRecoveryStatus;
  retry(): Promise<LegacyGhostRecoveryStatus>;
}

/**
 * Small injectable IPC boundary: both channels accept zero renderer payload
 * and authenticate the sender before reading or moving any local data.
 */
export function createLegacyGhostRecoveryIpcHandlers<Event>(
  deps: LegacyGhostRecoveryIpcDeps<Event>,
) {
  const assertRequest = (event: Event, args: unknown[]): void => {
    deps.assertTrusted(event);
    if (args.length !== 0) {
      deps.invalid('legacy Plugin recovery IPC does not accept renderer payload');
    }
  };
  return {
    status: (event: Event, ...args: unknown[]): LegacyGhostRecoveryStatus => {
      assertRequest(event, args);
      return deps.getStatus();
    },
    retry: async (event: Event, ...args: unknown[]): Promise<LegacyGhostRecoveryStatus> => {
      assertRequest(event, args);
      try {
        return await deps.retry();
      } catch (error) {
        return deps.failure(error);
      }
    },
  };
}
