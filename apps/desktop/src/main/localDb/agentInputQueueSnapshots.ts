import { createAgentInputQueueStore } from '@cindy/runtime-db/agentInputQueueSnapshots';
import { getDbClient, getCurrentDbClientSnapshot } from './client/current';
import { createLogger } from '../logger';
export { AgentInputQueueSnapshotTooLargeError, isRestorableQueuedMessage } from '@cindy/runtime-db/agentInputQueueSnapshots';
export const { getPersistedInputClientIds, hasInputDeliveryCancellation, awaitAgentInputQueueSnapshotPersistence, saveCancelledInputDelivery, readInputDeliveryReceipts, saveAgentInputQueueSnapshot, loadAllQueueSnapshotPayloads, loadAgentInputQueueSnapshotCounts, loadAgentInputQueueSnapshot } = createAgentInputQueueStore({ getDbClient, getCurrentDbClientSnapshot: () => getCurrentDbClientSnapshot(), logger: createLogger('agent-input-queue-snapshots') });
