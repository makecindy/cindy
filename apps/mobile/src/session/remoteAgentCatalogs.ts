/**
 * 远程 Agent 的「其他电脑」模型目录(纯逻辑,与桌面模型面板同口径):
 * 手机的模型选择器在被控电脑自己的供应商之后,列出同账号其他电脑上开了「允许被远程调用」的
 * 供应商,每个供应商一段、标题带电脑名;来源页里每台电脑一块,块标题就是电脑名,没有总的
 * 「其他电脑」标题。一个都没开的电脑不出现,列表不随设备数变长。
 */
import type { DeviceView } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers/registry';

import { toDeviceListItems } from '@/device-link/devices';

/** 一台可选电脑的目录状态(providers 只含开了远程调用的供应商)。 */
export interface RemoteAgentCatalog {
  deviceId: string;
  name: string;
  /** loading = 还没读到;error = 读不到(离线 / 没开远程控制 / 旧版本)且没有缓存。 */
  status: 'loading' | 'ready' | 'error';
  providers: ProviderView[];
  modelVisibilityOverrides?: Record<string, boolean>;
}

/** 那台电脑允许远程调用的供应商;没有该标记(旧数据)按未开放处理。 */
export function remoteAgentProviders(providers: readonly ProviderView[]): ProviderView[] {
  return providers.filter(
    (provider) => (provider as { remoteInvocationEnabled?: unknown }).remoteInvocationEnabled === true,
  );
}

/**
 * 可以让 Agent 运行的其他电脑,顺序同设备列表(可用在前、再按名字,稳定)。排除被控电脑、
 * 手机与已撤销的电脑;离线 / 没开远程控制的电脑读不了目录也不列,但任务当前(或挂着的)
 * Agent 所在电脑始终保留,让用户看得到 Agent 在哪台。
 */
export function selectRemoteAgentDevices(input: {
  devices: readonly DeviceView[];
  controlledDeviceId: string;
  keepDeviceIds: readonly string[];
  revokedDeviceIds?: ReadonlySet<string>;
  now?: number;
}): { deviceId: string; name: string; canOpen: boolean }[] {
  return toDeviceListItems(input.devices, input.now ?? Date.now(), input.revokedDeviceIds)
    .filter((item) => item.device.deviceId !== input.controlledDeviceId)
    .filter((item) => item.state !== 'access_revoked')
    .filter((item) => item.canOpen || input.keepDeviceIds.includes(item.device.deviceId))
    .map((item) => ({
      deviceId: item.device.deviceId,
      name: item.device.name?.trim() || item.device.deviceId,
      canOpen: item.canOpen,
    }));
}
