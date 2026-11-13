import { readProviderGroup } from '../provider-group/store.js';
import { isRemoteProviderInvocationAllowed, isRemoteProviderOpenToOwnComputers } from './remote-provider-access-store.js';

/**
 * 自己的其他电脑能否用本机的这个供应商：逐个打开过的，或「远程连接」里打开了「让我的其他电脑用本机模型」。
 * 建了供应商组的供应商不随这个开关打开：组内选电脑仍按逐个供应商的「允许被远程调用」，否则会绕过组
 * 直接在组所在电脑上运行。直接启动任务与组内续用(连续性核对)共用这一条，两边不能各判各的。
 * 受邀者不走这里，一律看「允许被远程调用」。
 */
export function ownComputersMayUseProvider(providerId: string): boolean {
  return isRemoteProviderInvocationAllowed(providerId)
    || (isRemoteProviderOpenToOwnComputers(providerId) && !readProviderGroup(providerId));
}
