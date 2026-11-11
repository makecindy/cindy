import { broadcastSessionPatched } from '../localDb/ipc/sessions.js';
import { DrizzleScheduleStorage as SharedScheduleStorage, type SchedulerDrizzleDb } from './storage.js';

export * from './storage.js';

/** Desktop supplies presentation; storage and its migration chain are shared. */
export class DrizzleScheduleStorage extends SharedScheduleStorage {
  constructor(getDb: () => SchedulerDrizzleDb) {
    super(getDb, (...args) => broadcastSessionPatched(...args));
  }
}
