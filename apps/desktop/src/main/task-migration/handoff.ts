import type { SkippedEntry } from './portableEntries';

/** Resumable copy progress. The source task is never retired. */
export type MigrationStage = 'preparing' | 'transferring' | 'complete' | 'cancelled';
export interface MigrationHandoff {
  id: string;
  sessionId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  targetSessionId: string;
  targetProject: string | null;
  workingDir: string;
  /** One copy record tracks the entire team; members never advance independently. */
  workers?: Array<{ sessionId: string; targetSessionId: string; workingDir: string }>;
  stage: MigrationStage;
  error?: string;
  /** Project-relative entry that caused `error`, when one entry is to blame. */
  errorPath?: string;
  /** Bytes needed vs the limit, when `error` is a size failure. */
  errorSize?: { needed: number; limit: number };
  /** Entries the prepared copy leaves behind; `entries` is capped, `total` is not. */
  skipped?: { total: number; entries: SkippedEntry[] };
}
export interface HandoffDependencies {
  save(record: MigrationHandoff): Promise<void>;
  prepare(record: MigrationHandoff): Promise<void>;
  import(record: MigrationHandoff): Promise<void>;
  cleanup(record: MigrationHandoff): Promise<void>;
  assertCurrent(): void;
}

/** Every stage is replayable. Target import is idempotent by id and leaves the source task untouched. */
export async function advanceHandoff(
  record: MigrationHandoff,
  deps: HandoffDependencies,
): Promise<void> {
  const transition = async (stage: MigrationStage) => {
    deps.assertCurrent();
    const next = { ...record, stage, error: undefined, errorPath: undefined, errorSize: undefined };
    await deps.save(next);
    Object.assign(record, next);
    deps.assertCurrent();
  };
  deps.assertCurrent();
  if (record.stage === 'preparing') {
    await deps.prepare(record);
    await transition('transferring');
  }
  if (record.stage === 'transferring') {
    await deps.import(record);
    await deps.cleanup(record);
    await transition('complete');
  }
}

export function canCancelHandoff(record: MigrationHandoff): boolean {
  // Abandon only source staging. Never roll back a target that may have committed.
  // A running copy is cancelled only before the target starts receiving it.
  return record.stage === 'preparing' || record.stage === 'transferring';
}
