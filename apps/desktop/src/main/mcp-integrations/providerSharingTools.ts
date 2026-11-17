import type { ProviderSharingRequest } from '@cindy/mcps';
import type { ProviderShareManagementCommand } from '../../shared/providerManagement.js';
import type { ProviderShareOwnerState } from '../../shared/providerShare.js';
import type { RemoteModelAccessView } from '../../shared/remoteModelAccess.js';

export interface ProviderSharingPorts {
  command(command: ProviderShareManagementCommand, assertCurrent: () => void): Promise<unknown>;
  remote(device: string, command: ProviderShareManagementCommand, assertCurrent: () => void): Promise<unknown>;
}

/** The UI's management operations, projected for both Agent and plugin callers. */
export async function runProviderSharingRequest(request: ProviderSharingRequest, ports: ProviderSharingPorts,
  assertCurrent: () => void): Promise<Record<string, unknown>> {
  const deviceId = request.device ?? 'local';
  const remote = deviceId !== 'local';
  const scope = { scope: remote ? 'remote' : 'local', deviceId };
  const call = async (command: ProviderShareManagementCommand) => {
    assertCurrent();
    const result = remote ? await ports.remote(deviceId, command, assertCurrent) : await ports.command(command, assertCurrent);
    assertCurrent();
    return result;
  };
  if (request.action === 'members') {
    const owned = await call({ action: 'owned', range: 'all', includeUsage: false }) as ProviderShareOwnerState;
    if (owned.includeUsage !== false) throw new Error('UNSUPPORTED_CAPABILITY');
    if (!owned.ready) throw new Error('HOST_NOT_READY');
    const members = owned.shares.filter(share => !request.providerId || share.providerId === request.providerId)
      .flatMap(share => share.members.map(member => ({
        shareId: share.shareId, providerId: share.providerId, memberId: member.memberId,
        name: member.displayName, status: member.status,
      })));
    return { ...scope, members };
  }
  if (request.action === 'status') {
    await call({ action: 'set-member', memberId: request.memberId, status: request.status });
    return { ...scope, memberId: request.memberId, status: request.status === 'pause' ? 'paused' : 'active',
      ...(request.status === 'pause' ? { shutdown: 'requested' } : {}) };
  }
  const result = await call({ action: request.action === 'get-models' ? 'get-model-access' : 'set-model-access',
    providerId: request.providerId, memberId: request.memberId,
    ...(request.action === 'set-models' ? { models: request.models } : {}),
  } as ProviderShareManagementCommand) as RemoteModelAccessView;
  return { ...scope, models: result.models, providerModels: result.providerModels, availableModels: result.availableModels };
}
