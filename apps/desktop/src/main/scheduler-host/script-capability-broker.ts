import { createSchedulerScriptCapabilityBroker } from '@cindy/app-runtime/scheduleScriptCapabilityBroker';
import { findTrustedXdGhostForScript, getGhostCardService, getGhostPipeDispatcher } from '../cindy-brain/index.js';
import { tryGetOrcaCollabService } from '../maker-ipc/register.js';
import { getSessionRowSnapshotStrict, restoreArchivedSessionForSend } from '../localDb/ipc/sessions';
export const { SchedulerScriptCapabilityBroker } = createSchedulerScriptCapabilityBroker({
  findTrustedXdGhostForScript, getGhostCardService, getGhostPipeDispatcher,
  tryGetOrcaCollabService, getSessionRowSnapshotStrict, restoreArchivedSessionForSend,
});
export type SchedulerScriptCapabilityBroker = InstanceType<typeof SchedulerScriptCapabilityBroker>;
