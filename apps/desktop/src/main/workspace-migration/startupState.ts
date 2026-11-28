import type {
  WorkspaceMigrationStartupPhase,
  WorkspaceMigrationStartupProgress,
} from '../../shared/workspaceMigration.js';

type ProgressListener = (progress: WorkspaceMigrationStartupProgress | null) => void;

export interface WorkspaceMigrationStartupProgressJob {
  update(patch: {
    phase?: WorkspaceMigrationStartupPhase;
    progress?: number;
    copiedBytes?: number;
    totalBytes?: number;
    currentIndex?: number;
    totalCount?: number;
  }): void;
  finish(): void;
}

let activeState: WorkspaceMigrationStartupProgress | null = null;
const listeners = new Set<ProgressListener>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function emit(progress: WorkspaceMigrationStartupProgress | null): void {
  for (const listener of listeners) {
    try {
      listener(progress ? { ...progress } : null);
    } catch {
      // Presentation listeners must never interfere with workspace migration.
    }
  }
}

export function beginWorkspaceMigrationStartupProgress(
  requestId: string,
  totalCount: number,
  now: () => number = Date.now,
): WorkspaceMigrationStartupProgressJob {
  const startedAt = now();
  const jobState: WorkspaceMigrationStartupProgress = {
    requestId,
    phase: 'preparing',
    progress: 1,
    copiedBytes: 0,
    totalBytes: 0,
    currentIndex: 1,
    totalCount: Math.max(1, totalCount),
    startedAt,
    updatedAt: startedAt,
  };
  activeState = jobState;
  emit(jobState);

  let finished = false;
  return {
    update(patch) {
      if (finished || activeState !== jobState) return;
      const nextIndex = patch.currentIndex ?? jobState.currentIndex;
      const indexAdvanced = nextIndex !== jobState.currentIndex;
      const nextProgress =
        patch.progress !== undefined
          ? clamp(
              indexAdvanced ? patch.progress : Math.max(jobState.progress, patch.progress),
              0,
              100,
            )
          : jobState.progress;
      jobState.phase = patch.phase ?? jobState.phase;
      jobState.progress = nextProgress;
      if (patch.copiedBytes !== undefined) jobState.copiedBytes = Math.max(0, patch.copiedBytes);
      if (patch.totalBytes !== undefined) jobState.totalBytes = Math.max(0, patch.totalBytes);
      jobState.currentIndex = nextIndex;
      if (patch.totalCount !== undefined) jobState.totalCount = Math.max(1, patch.totalCount);
      jobState.updatedAt = now();
      emit(jobState);
    },
    finish() {
      if (finished) return;
      finished = true;
      if (activeState !== jobState) return;
      activeState = null;
      emit(null);
    },
  };
}

export function getWorkspaceMigrationStartupProgress(): WorkspaceMigrationStartupProgress | null {
  return activeState ? { ...activeState } : null;
}

export function subscribeWorkspaceMigrationStartupProgress(
  listener: ProgressListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
