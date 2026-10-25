import { createToolResultCompaction } from '@cindy/app-runtime/toolResultCompaction';
import { createLogger } from '../logger';
import { drainPersistQueue } from '../messagePersistBroadcaster';
export const { compactSessionToolResultsBestEffort } = createToolResultCompaction({
  logger: createLogger('localDb/toolResultCompaction'),
  drainPersistQueue: () => drainPersistQueue(),
});
