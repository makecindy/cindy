export type RemoteDirectoryGrantAxis = 'extraDirs' | 'writableDirs';

export interface RemoteDirectoryGrantSession {
  setExtraDirs(dirs: string[]): Promise<void>;
  setWritableDirs(dirs: string[]): Promise<void>;
}

export interface RemoteDirectoryGrantUpdateDeps {
  validate(dirs: string[]): Promise<{ valid: string[]; rejected: unknown[] }>;
  readExtraDirs(): Promise<string[]>;
  readWritableDirs(): Promise<string[]>;
  excludeConflicts(candidates: readonly string[], blocked: readonly string[]): Promise<string[]>;
  persist(patch: { extraDirs?: string[]; writableDirs?: string[] }): Promise<void>;
}

export interface RemoteDirectoryGrantUpdateResult {
  dirs: string[];
  rejectedCount: number;
}

/**
 * Apply one remote directory-grant axis while the caller holds the session route lock.
 * Both persisted axes are read inside that lock, so a concurrent controller validates
 * against the latest complete grant state. Persistence failure restores the harness
 * closure first, then best-effort restores SQLite + patched-session mirrors.
 */
export async function applyRemoteDirectoryGrantUpdate(
  axis: RemoteDirectoryGrantAxis,
  requestedDirs: string[],
  session: RemoteDirectoryGrantSession,
  deps: RemoteDirectoryGrantUpdateDeps,
): Promise<RemoteDirectoryGrantUpdateResult> {
  const validation = await deps.validate(requestedDirs);
  const [previousExtraDirs, previousWritableDirs] = await Promise.all([
    deps.readExtraDirs(),
    deps.readWritableDirs(),
  ]);
  const previousDirs = axis === 'extraDirs' ? previousExtraDirs : previousWritableDirs;
  const blockedDirs = axis === 'extraDirs' ? previousWritableDirs : previousExtraDirs;
  const nextDirs = await deps.excludeConflicts(validation.valid, blockedDirs);
  const applyRuntime = axis === 'extraDirs'
    ? (dirs: string[]) => session.setExtraDirs(dirs)
    : (dirs: string[]) => session.setWritableDirs(dirs);
  const patch = (dirs: string[]) => axis === 'extraDirs'
    ? { extraDirs: dirs }
    : { writableDirs: dirs };

  try {
    await applyRuntime(nextDirs);
  } catch (applyError) {
    try {
      await applyRuntime(previousDirs);
    } catch (rollbackError) {
      throw new AggregateError(
        [applyError, rollbackError],
        `remote ${axis} runtime apply and rollback both failed`,
      );
    }
    throw applyError;
  }

  try {
    await deps.persist(patch(nextDirs));
  } catch (persistenceError) {
    const rollbackErrors: unknown[] = [];
    try {
      await applyRuntime(previousDirs);
    } catch (error) {
      rollbackErrors.push(error);
    }
    try {
      await deps.persist(patch(previousDirs));
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [persistenceError, ...rollbackErrors],
        `remote ${axis} persistence rollback failed`,
      );
    }
    throw persistenceError;
  }

  return {
    dirs: nextDirs,
    rejectedCount: validation.rejected.length + validation.valid.length - nextDirs.length,
  };
}
