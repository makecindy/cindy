import { findTrustedXdGhostForScript, getGhostCardService, getGhostPipeDispatcher } from '../cindy-brain/index.js';
import { tryGetOrcaCollabService } from '../maker-ipc/register.js';
import { getSessionRowSnapshotStrict, restoreArchivedSessionForSend } from '../localDb/ipc/sessions';
import { SchedulerScriptCapabilityBroker as SharedBroker } from './script-capability-broker';
import { readSubscriptionUsage } from '../subscription-accounts/runtime.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { executeProviderShareManagementCommand } from '../device-link/providerShareRuntime.js';
import { createProviderGroupCommandDeps, executeProviderGroupCommand } from '../provider-group/ipc.js';
import { invokeProviderManagement } from '../provider-group/managementClient.js';
import { remoteInvoke } from '../device-link/index.js';
import { getDeviceId } from '../authManager.js';

export class SchedulerScriptCapabilityBroker extends SharedBroker {
  constructor(deps: ConstructorParameters<typeof SharedBroker>[0] = {}) {
    super(deps, {
      findTrustedXdGhostForScript: (...args) => findTrustedXdGhostForScript(...args),
      getGhostCardService: () => getGhostCardService(),
      getGhostPipeDispatcher: () => getGhostPipeDispatcher(),
      tryGetOrcaCollabService: () => tryGetOrcaCollabService(),
      getSessionRowSnapshotStrict: (...args) => getSessionRowSnapshotStrict(...args),
      restoreArchivedSessionForSend: (...args) => restoreArchivedSessionForSend(...args),
      settings: {
        captureScope: () => captureProviderManagementScope(),
        deviceId: () => getDeviceId(),
        usage: (...args) => readSubscriptionUsage(...args),
        shares: (...args) => executeProviderShareManagementCommand(...args),
        group: command => executeProviderGroupCommand(createProviderGroupCommandDeps(), command),
        remote: (device, request, guard) => invokeProviderManagement(
          (target, channel, args, options) => remoteInvoke(target, channel, args, { ...options,
            preSend: () => { guard(); options?.preSend?.(); } }), device, request),
      },
    });
  }
}
