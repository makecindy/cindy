/** dispatch 已验证同账号身份；管理范围只含组设置和分享者操作，禁止继续转发。 */
import type { ProviderManagementReply, ProviderManagementRequest } from '../../shared/providerManagement.js';
import type { ProviderGroupManagementCommand, ProviderShareManagementCommand } from '../../shared/providerManagement.js';
import { isProviderManagementRequest } from '../../shared/providerManagement.js';
import { executeProviderShareManagementCommand, parseProviderShareCommand } from '../device-link/providerShareRuntime.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createProviderGroupCommandDeps, executeProviderGroupCommand, parseProviderGroupCommand } from './ipc.js';
import { captureProviderManagementScope } from './managementScope.js';

export function parseProviderManagementRequest(raw: unknown): ProviderManagementRequest {
  if (!isProviderManagementRequest(raw)) throwIpcError('INVALID_PARAMS', 'Invalid provider management request');
  if (raw.action === 'manage-group') {
    const command = parseProviderGroupCommand(raw.command);
    if (command.action === 'save' || command.action === 'delete') {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Update the managing computer to save provider groups with conflict checks');
    }
    if (!['get', 'candidates', 'save-if-current', 'delete-if-current'].includes(command.action)) {
      throwIpcError('PERMISSION_DENIED', 'This group operation is not available through management');
    }
    return { action: 'manage-group', command: command as ProviderGroupManagementCommand };
  }
  const command = parseProviderShareCommand(raw.command);
  if (!['owned', 'own-usage', 'usage-history', 'create-link', 'approve', 'reject', 'set-member', 'set-member-note', 'reshare-decide', 'get-run-limits', 'set-run-limits', 'reset-run-limits', 'get-visibility', 'set-visibility', 'quota-account', 'get-model-access', 'set-model-access', 'get-fast-policy', 'set-fast-policy'].includes(command.action)) {
    throwIpcError('PERMISSION_DENIED', 'Only owner operations are available through management');
  }
  return { action: 'manage-share', command: command as ProviderShareManagementCommand };
}

export async function handleProviderManagementRequest(
  raw: unknown,
  options: { onGroupChanged?: (providerId: string) => void } = {},
): Promise<ProviderManagementReply> {
  const assertCurrent = captureProviderManagementScope();
  const request = parseProviderManagementRequest(raw);
  const result = request.action === 'manage-group'
    ? await executeProviderGroupCommand(createProviderGroupCommandDeps(options), request.command)
    : await executeProviderShareManagementCommand(request.command);
  assertCurrent();
  return { result, respondedAt: Date.now() };
}
