/** 页面复用本机管理组件，所有远程操作由本机 Main 转交原来的组所在电脑。 */
import type { ProviderGroupCommandResult } from '../../../shared/providerGroup';
import type { ProviderGroupManagementCommand, ProviderShareManagementCommand } from '../../../shared/providerManagement';
import type { ProviderShareCommandResult } from '../../../shared/providerShare';
import { extractIpcError, mapIpcErrorToI18nKey } from '@/utils/ipcError';

export function providerGroupManagementCommand<C extends ProviderGroupManagementCommand>(
  command: C, deviceId?: string,
): Promise<ProviderGroupCommandResult<C>> {
  return deviceId
    ? window.electronAPI.providerGroup.command({ action: 'remote-manage', deviceId, request: { action: 'manage-group', command } }) as Promise<ProviderGroupCommandResult<C>>
    : window.electronAPI.providerGroup.command(command);
}

export function providerShareManagementCommand<C extends ProviderShareManagementCommand>(
  command: C, deviceId?: string,
): Promise<ProviderShareCommandResult[C['action']]> {
  return deviceId
    ? window.electronAPI.providerGroup.command({ action: 'remote-manage', deviceId, request: { action: 'manage-share', command } })
    : window.electronAPI.providerShare.command(command);
}

/** 远程管理时那台电脑是旧版本、明确不认识这个命令(Main 已统一成 UNSUPPORTED_CAPABILITY)。 */
export function isProviderManagementOutdated(error: unknown): boolean {
  return extractIpcError(error)?.code === 'UNSUPPORTED_CAPABILITY';
}

export function providerManagementErrorKey(error: unknown, remote: boolean): string {
  const code = extractIpcError(error)?.code;
  if (remote && code === 'UNSUPPORTED_CAPABILITY') return 'providerGroup.management.unsupported';
  return mapIpcErrorToI18nKey(error);
}
