import type { ProviderReadRequest } from '@cindy/mcps';
import type { ProviderManagementRequest } from '../../shared/providerManagement.js';
import type { ProviderGroupView } from '../../shared/providerGroup.js';

export interface ProviderReadPorts {
  local(request: ProviderManagementRequest, assertCurrent: () => void): Promise<unknown>;
  remote(device: string, request: ProviderManagementRequest, assertCurrent: () => void): Promise<unknown>;
}

// subscription-accounts/runtime names signed-in providers as brand · identity.
// Keep the UI's original object; only the plugin projection loses that identity.
function withoutAccountName<T extends { providerName?: string }>(member: T): T {
  return typeof member.providerName === 'string'
    ? { ...member, providerName: member.providerName.replace(/^(Claude|OpenAI) · .+$/s, '$1') }
    : member;
}

/** Caller adapter only: original management commands own data and business rules. */
export async function runProviderReadRequest(request: ProviderReadRequest, ports: ProviderReadPorts,
  assertCurrent: () => void, redactAccountNames = false): Promise<Record<string, unknown>> {
  const command: ProviderManagementRequest = request.action === 'usage-history'
    ? { action: 'manage-share', command: { action: 'usage-history', providerId: request.providerId } }
    : { action: 'manage-group', command: { action: 'get', providerId: request.providerId } };
  assertCurrent();
  const result = request.device && request.device !== 'local'
    ? await ports.remote(request.device, command, assertCurrent) : await ports.local(command, assertCurrent);
  assertCurrent();
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('PRECONDITION_FAILED');
  if (redactAccountNames && request.action === 'group') {
    const group = result as unknown as ProviderGroupView;
    return { ...group, members: group.members.map(withoutAccountName), config: group.config
      ? { ...group.config, members: group.config.members.map(withoutAccountName) } : group.config };
  }
  return result as Record<string, unknown>;
}
