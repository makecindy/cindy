/**
 * Local Goal + Worktree preparation as a compensated transaction.
 *
 * The local worktree API needs a session id, so the renderer first creates an
 * empty session against the base repository. If worktree creation or the
 * managed-path update fails, that brand-new session must be soft-deleted before
 * the caller lets the user retry; otherwise each retry leaves another empty
 * base-repo task behind.
 */

export type LocalGoalWorktreeCreateResponse =
  | { ok: true; meta: { path: string; branch: string } }
  | { ok: false; error: { kind: string; message?: string } };

export type LocalGoalWorktreeProgress =
  | { status: 'creating'; name: string }
  | { status: 'failed'; name: string; error: string };

export class LocalGoalWorktreeCleanupPendingError extends Error {
  readonly setupError: unknown;
  readonly cleanupError: unknown;

  constructor(setupError: unknown, cleanupError: unknown) {
    super('Local Goal worktree cleanup is pending', { cause: cleanupError });
    this.name = 'LocalGoalWorktreeCleanupPendingError';
    this.setupError = setupError;
    this.cleanupError = cleanupError;
  }
}

export function isLocalGoalWorktreeCleanupPendingError(
  error: unknown,
): error is LocalGoalWorktreeCleanupPendingError {
  return error instanceof LocalGoalWorktreeCleanupPendingError;
}

export async function prepareLocalGoalWorktree(input: {
  sessionId: string;
  baseRepo: string;
  name: string;
  initialBranchName: string;
  sourceBranch: string;
  createWorktree: (request: {
    sessionId: string;
    baseRepo: string;
    name: string;
    sourceBranch: string;
  }) => Promise<LocalGoalWorktreeCreateResponse>;
  updateWorkingDir: (path: string) => Promise<void>;
  patchWorkingDir: (path: string) => void;
  rollbackSession: () => Promise<void>;
  patchDeleted: () => void;
  setProgress: (progress: LocalGoalWorktreeProgress) => void;
  clearProgress: () => void;
}): Promise<{ path: string; branch: string }> {
  let branchName = input.initialBranchName;
  input.setProgress({ status: 'creating', name: branchName });

  try {
    const response = await input.createWorktree({
      sessionId: input.sessionId,
      baseRepo: input.baseRepo,
      name: input.name,
      sourceBranch: input.sourceBranch,
    });
    if (!response.ok) {
      throw new Error(response.error.message ?? response.error.kind);
    }

    branchName = response.meta.branch;
    await input.updateWorkingDir(response.meta.path);
    input.patchWorkingDir(response.meta.path);
    input.clearProgress();
    return response.meta;
  } catch (setupError) {
    input.setProgress({
      status: 'failed',
      name: branchName,
      error: setupError instanceof Error ? setupError.message : String(setupError),
    });
    try {
      await input.rollbackSession();
      input.patchDeleted();
      input.clearProgress();
    } catch (cleanupError) {
      throw new LocalGoalWorktreeCleanupPendingError(setupError, cleanupError);
    }
    throw setupError;
  }
}
