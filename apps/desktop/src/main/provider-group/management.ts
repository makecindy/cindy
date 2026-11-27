/** dispatch 已验证同账号身份；管理范围只含组设置和分享者操作，禁止继续转发。 */
import type { ProviderManagementReply, ProviderManagementRequest } from '../../shared/providerManagement.js';
import type { ProviderGroupManagementCommand, ProviderShareManagementCommand } from '../../shared/providerManagement.js';
import { isProviderManagementRequest } from '../../shared/providerManagement.js';
import { executeProviderShareManagementCommand, parseProviderShareCommand } from '../device-link/providerShareRuntime.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createProviderGroupCommandDeps, executeProviderGroupCommand, parseProviderGroupCommand } from './ipc.js';
import { captureProviderManagementScope } from './managementScope.js';
import { publicProviderGroupConfig, type ProviderGroupView } from '../../shared/providerGroup.js';
import { runReportedRemoteChange } from '../instance-runtime/maintenance.js';

// 只读的管理操作。其余都会改状态，以后加进管理范围的操作没登记在这里也按改动处理。
const GROUP_READS = new Set<ProviderGroupManagementCommand['action']>(['get', 'candidates']);
const SHARE_READS = new Set<ProviderShareManagementCommand['action']>([
  'owned', 'shared-provider-ids', 'own-usage', 'usage-history', 'get-run-limits', 'get-visibility',
  'quota-account', 'get-model-access', 'get-fast-policy',
]);

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
  if (!['owned', 'shared-provider-ids', 'own-usage', 'usage-history', 'create-link', 'approve', 'reject', 'set-member', 'set-member-note', 'reshare-decide', 'get-run-limits', 'set-run-limits', 'reset-run-limits', 'get-visibility', 'set-visibility', 'quota-account', 'get-model-access', 'set-model-access', 'get-fast-policy', 'set-fast-policy'].includes(command.action)) {
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
  const execute = async (): Promise<unknown> => request.action === 'manage-group'
    ? executeProviderGroupCommand(createProviderGroupCommandDeps(options), request.command)
    : executeProviderShareManagementCommand(request.command);
  const reads = request.action === 'manage-group'
    ? GROUP_READS.has(request.command.action)
    : SHARE_READS.has(request.command.action);
  // 同账号电脑经 DeviceLink、云服务网页经中转都走到这里。云实例上，改动计入维护在途直到落定，
  // 维护开始后可重试地拒绝；读取照常回答。普通电脑没有维护门，直接执行。
  const result = reads ? await execute() : await runReportedRemoteChange(execute);
  assertCurrent();
  if (request.action === 'manage-group' && request.command.action !== 'candidates') {
    const view = result as ProviderGroupView;
    return { result: { ...view, config: view.config ? publicProviderGroupConfig(view.config) : null }, respondedAt: Date.now() };
  }
  return { result, respondedAt: Date.now() };
}
