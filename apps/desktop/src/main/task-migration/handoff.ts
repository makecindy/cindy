/** Durable handoff protocol. A timeout never grants permission to run the source again. */
export type MigrationStage = 'preparing' | 'transferring' | 'moved' | 'complete' | 'cancelled';
export interface MigrationHandoff {
  id: string;
  sessionId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  targetSessionId: string;
  targetProject: string | null;
  workingDir: string;
  stage: MigrationStage;
  error?: string;
}
export interface HandoffDependencies {
  save(record: MigrationHandoff): Promise<void>;
  prepare(record: MigrationHandoff): Promise<void>;
  import(record: MigrationHandoff): Promise<void>;
  activate(record: MigrationHandoff): Promise<void>;
  assertCurrent(): void;
}

/** Every stage is replayable. Target import is idempotent by id and remains non-executable. */
export async function advanceHandoff(
  record: MigrationHandoff,
  deps: HandoffDependencies,
): Promise<void> {
  const transition = async (stage: MigrationStage) => {
    deps.assertCurrent();
    const next = { ...record, stage, error: undefined };
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
    // This durable write is the point of no return. A lost activation reply cannot unfreeze source.
    await transition('moved');
  }
  if (record.stage === 'moved') {
    await deps.activate(record);
    await transition('complete');
  }
}

export function canCancelHandoff(record: MigrationHandoff): boolean {
  // No target side effect has been attempted in preparing. Once transferring, query/retry only.
  return record.stage === 'preparing';
}
