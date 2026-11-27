import { enqueueDurableWrite } from '../messagePersistBroadcaster.desktop.js';
import { retainDbClient } from '../localDb/client/pendingOperations.js';
import { getDbClient } from '../localDb/client/current.js';
import { messageCostDatabase, turnUsageAdmission } from './turnUsageAdmission.js';

export const enqueueMessageUsageWrite: typeof enqueueDurableWrite = (label, write) => {
  const current = turnUsageAdmission.getStore();
  if (!current) return enqueueDurableWrite(label, write);
  return enqueueDurableWrite(label, async scope => {
    const db = getDbClient();
    const release = retainDbClient(db);
    try { return await messageCostDatabase.run(db, () => write(scope)); }
    finally { release(); }
  }, current);
};
