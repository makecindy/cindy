export interface BotRuntimeRestoreIdentity {
  userId: string;
  clientEpoch: number;
}

export interface BotRuntimeRestoreService {
  restore(): Promise<void>;
}

export interface BotRuntimeRestoreServices {
  delegation: BotRuntimeRestoreService | null;
}

export interface BotRuntimeRestoreLog {
  warn(message: string, meta?: unknown): void;
}

interface BotRuntimeRestoreCoordinatorDeps {
  readDbIdentity(): BotRuntimeRestoreIdentity | null;
  readServices(): BotRuntimeRestoreServices;
  log: BotRuntimeRestoreLog;
}

/**
 * Restores every durable Bot queue only after the current owner's DbClient is
 * ready. Calls are serialized and idempotent per client generation so startup,
 * secondary windows and same-owner auth refreshes cannot run overlapping
 * recovery passes. A failed pass remains retryable on the next ready signal.
 */
export function createBotRuntimeRestoreCoordinator(
  deps: BotRuntimeRestoreCoordinatorDeps,
): { restoreCurrentOwner(): Promise<boolean> } {
  let restoredClientEpoch: number | null = null;
  let tail: Promise<boolean> = Promise.resolve(false);

  const restoreOnce = async (): Promise<boolean> => {
    const identity = deps.readDbIdentity();
    if (!identity) return false;
    if (restoredClientEpoch === identity.clientEpoch) return true;

    const services = deps.readServices();
    if (Object.values(services).some((service) => service === null)) return false;

    const stages = [
      ['Bot delegation', services.delegation],
    ] as const;

    for (const [label, service] of stages) {
      const current = deps.readDbIdentity();
      if (!current || current.clientEpoch !== identity.clientEpoch) return false;
      try {
        await service!.restore();
      } catch (error) {
        deps.log.warn(`${label} restore failed`, {
          userId: identity.userId,
          clientEpoch: identity.clientEpoch,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }

    const current = deps.readDbIdentity();
    if (!current || current.clientEpoch !== identity.clientEpoch) return false;
    restoredClientEpoch = identity.clientEpoch;
    return true;
  };

  return {
    restoreCurrentOwner(): Promise<boolean> {
      const current = tail.catch(() => false).then(restoreOnce);
      tail = current;
      return current;
    },
  };
}
