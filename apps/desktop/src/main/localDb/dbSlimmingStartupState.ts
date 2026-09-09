import type {
  DbSlimmingMaintenanceProgress,
  DbSlimmingStartupProgress,
} from '../../shared/localDbMaintenance';
import type { DbSlimmingRequestRecord } from './maintenanceStore';

const ESTIMATED_BYTES_PER_SECOND = 96 * 1024 * 1024;
const MIN_ESTIMATED_TOTAL_MS = 12_000;
const MAX_ESTIMATED_TOTAL_MS = 60 * 60 * 1000;

type ProgressListener = (progress: DbSlimmingStartupProgress | null) => void;

interface ActiveProgressJob {
  state: DbSlimmingStartupProgress;
  abortController: AbortController;
}

export interface DbSlimmingStartupProgressJob {
  signal: AbortSignal;
  update(progress: DbSlimmingMaintenanceProgress): void;
  finish(): void;
}

let activeJob: ActiveProgressJob | null = null;
const listeners = new Set<ProgressListener>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function emit(progress: DbSlimmingStartupProgress | null): void {
  for (const listener of listeners) {
    try {
      listener(progress ? { ...progress } : null);
    } catch {
      // A presentation listener must never affect database maintenance.
    }
  }
}

function initialEstimatedTotalMs(databaseBytes: number): number {
  return clamp(
    Math.round((Math.max(0, databaseBytes) / ESTIMATED_BYTES_PER_SECOND) * 1000),
    MIN_ESTIMATED_TOTAL_MS,
    MAX_ESTIMATED_TOTAL_MS,
  );
}

export function beginDbSlimmingStartupProgress(
  request: DbSlimmingRequestRecord,
  now: () => number = Date.now,
): DbSlimmingStartupProgressJob {
  if (activeJob) throw new Error('database cleanup startup progress is already active');
  const startedAt = now();
  const abortController = new AbortController();
  const job: ActiveProgressJob = {
    abortController,
    state: {
      requestId: request.id,
      phase: 'preparing',
      progress: 1,
      cancellable: request.phase === 'scheduled',
      startedAt,
      updatedAt: startedAt,
      estimatedTotalMs: initialEstimatedTotalMs(request.beforeBytes),
    },
  };
  activeJob = job;
  emit(job.state);

  return {
    signal: abortController.signal,
    update(progress) {
      if (activeJob !== job || abortController.signal.aborted) return;
      const updatedAt = now();
      const nextProgress = clamp(Math.max(job.state.progress, progress.progress), 0, 100);
      let estimatedTotalMs = job.state.estimatedTotalMs;
      const elapsedMs = Math.max(0, updatedAt - startedAt);
      if (nextProgress >= 15 && nextProgress < 96 && elapsedMs >= 1_000) {
        const observedTotalMs = (elapsedMs * 100) / nextProgress;
        estimatedTotalMs = clamp(
          Math.round(estimatedTotalMs * 0.7 + observedTotalMs * 0.3),
          elapsedMs + 1_000,
          MAX_ESTIMATED_TOTAL_MS,
        );
      }
      job.state = {
        ...job.state,
        ...progress,
        progress: nextProgress,
        updatedAt,
        estimatedTotalMs,
      };
      emit(job.state);
    },
    finish() {
      if (activeJob !== job) return;
      activeJob = null;
      emit(null);
    },
  };
}

export function getDbSlimmingStartupProgress(): DbSlimmingStartupProgress | null {
  return activeJob ? { ...activeJob.state } : null;
}

export function cancelDbSlimmingStartupProgress(): boolean {
  if (!activeJob || !activeJob.state.cancellable || activeJob.abortController.signal.aborted) {
    return false;
  }
  activeJob.state = {
    ...activeJob.state,
    phase: 'cancelling',
    cancellable: false,
    updatedAt: Date.now(),
  };
  emit(activeJob.state);
  activeJob.abortController.abort();
  return true;
}

export function subscribeDbSlimmingStartupProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
