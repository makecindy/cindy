import type { ProviderReadRequest } from '@cindy/mcps';
import type { ProviderManagementRequest } from '../../shared/providerManagement.js';

export interface ProviderReadPorts {
  local(request: ProviderManagementRequest, assertCurrent: () => void): Promise<unknown>;
  remote(device: string, request: ProviderManagementRequest, assertCurrent: () => void): Promise<unknown>;
}

/** Caller adapter only: original management commands own data and business rules. */
export async function runProviderReadRequest(request: ProviderReadRequest, ports: ProviderReadPorts,
  assertCurrent: () => void): Promise<Record<string, unknown>> {
  const command: ProviderManagementRequest = request.action === 'usage-history'
    ? { action: 'manage-share', command: { action: 'usage-history', providerId: request.providerId } }
    : { action: 'manage-group', command: { action: 'get', providerId: request.providerId } };
  assertCurrent();
  const result = request.device && request.device !== 'local'
    ? await ports.remote(request.device, command, assertCurrent) : await ports.local(command, assertCurrent);
  assertCurrent();
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('PRECONDITION_FAILED');
  return result as Record<string, unknown>;
}
