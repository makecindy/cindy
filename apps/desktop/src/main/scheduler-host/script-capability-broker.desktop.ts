import { findTrustedXdGhostForScript, getGhostCardService, getGhostPipeDispatcher } from '../cindy-brain/index.js';
import { tryGetOrcaCollabService } from '../maker-ipc/register.js';
import { getSessionRowSnapshotStrict, restoreArchivedSessionForSend } from '../localDb/ipc/sessions';
import { SchedulerScriptCapabilityBroker as SharedBroker } from './script-capability-broker';

export class SchedulerScriptCapabilityBroker extends SharedBroker {
  constructor(deps: ConstructorParameters<typeof SharedBroker>[0] = {}) {
    super(deps, {
      findTrustedXdGhostForScript: (...args) => findTrustedXdGhostForScript(...args),
      getGhostCardService: () => getGhostCardService(),
      getGhostPipeDispatcher: () => getGhostPipeDispatcher(),
      tryGetOrcaCollabService: () => tryGetOrcaCollabService(),
      getSessionRowSnapshotStrict: (...args) => getSessionRowSnapshotStrict(...args),
      restoreArchivedSessionForSend: (...args) => restoreArchivedSessionForSend(...args),
    });
  }
}
