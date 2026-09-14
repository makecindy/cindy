import type { DbSlimmingMaintenanceProgress } from '../../shared/localDbMaintenance';
import type { RunDbSlimmingMaintenanceOutcome } from './dbSlimmingMaintenance';
import type { DbSlimmingRequestRecord } from './maintenanceStore';

export interface DbSlimmingProcessInput {
  userDataDir: string;
  dbFilePath: string;
  request: DbSlimmingRequestRecord;
  sqliteVecExtensionPath?: string;
}

export type DbSlimmingProcessCommand =
  | { type: 'start'; input: DbSlimmingProcessInput }
  | { type: 'commit' };

export type DbSlimmingProcessMessage =
  | { type: 'ready' }
  | { type: 'progress'; progress: DbSlimmingMaintenanceProgress }
  | { type: 'commit-ready' }
  | {
      type: 'log';
      level: 'info' | 'warn' | 'error';
      message: string;
      meta?: unknown;
    }
  | { type: 'result'; outcome: RunDbSlimmingMaintenanceOutcome }
  | { type: 'error'; error: { message: string; stack?: string } };
