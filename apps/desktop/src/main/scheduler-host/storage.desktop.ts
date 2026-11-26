import type { Schedule } from '@cindy/maker-scheduler';
import { runAsRetryableDbWrite } from '../localDb/client/rpcAdmission.js';
import { broadcastSessionPatched } from '../localDb/ipc/sessions.js';
import { DrizzleScheduleStorage as SharedScheduleStorage, type SchedulerDrizzleDb } from './storage.js';

export * from './storage.js';

/** Desktop supplies presentation; storage and its migration chain are shared. */
export class DrizzleScheduleStorage extends SharedScheduleStorage {
  constructor(getDb: () => SchedulerDrizzleDb) {
    super(getDb, (...args) => broadcastSessionPatched(...args));
  }

  override update(id: string, patch: Partial<Schedule>, expected?: Schedule): Promise<Schedule | null> {
    const write = () => super.update(id, patch, expected);
    // Only a compare-and-swap that restores the next run can be abandoned here.
    return expected && patch.nextFireAt !== undefined && Object.keys(patch).length === 1
      ? runAsRetryableDbWrite(write)
      : write();
  }
}
