import { enqueueDurableWrite } from '../messagePersistBroadcaster.desktop.js';
import { getDbClient } from '../localDb/client/current.js';
import { messageCostDatabase, turnUsageAdmission } from './turnUsageAdmission.js';

export const enqueueMessageUsageWrite: typeof enqueueDurableWrite = (label, write) => {
  const current = turnUsageAdmission.getStore();
  if (!current) return enqueueDurableWrite(label, write);
  return enqueueDurableWrite(label, scope => messageCostDatabase.run(getDbClient(), () => write(scope)), current);
};
