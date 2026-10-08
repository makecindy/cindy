/**
 * 远程 Agent 的「其他电脑」模型目录(纯逻辑,与桌面模型面板同口径):
 * 手机的模型选择器在被控电脑自己的供应商之后,列出同账号其他电脑上开了「允许被远程调用」的
 * 供应商,每个供应商一段、标题带电脑名;来源页里每台电脑一块,块标题就是电脑名,没有总的
 * 「其他电脑」标题。一个都没开的电脑不出现,列表不随设备数变长。
 * 别人分享给被控电脑的供应商(供应商分享)同样按「一台电脑」接在后面,见 providerShareRemoteCatalogs。
 */
import type { DeviceView } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers/registry';

import { toDeviceListItems } from '@/device-link/devices';
import type { ProviderShareCatalogEntry } from '@/device-link/providerShareCatalogCache';

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

/** 任务记录里「Agent 在某个分享者的电脑上」的设备 id 前缀(与桌面同构:`share:<shareId>`)。 */
export const PROVIDER_SHARE_AGENT_DEVICE_PREFIX = 'share:';

export function isProviderShareAgentDeviceId(deviceId: string | null | undefined): deviceId is string {
  return typeof deviceId === 'string'
    && deviceId.length > PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length
    && deviceId.startsWith(PROVIDER_SHARE_AGENT_DEVICE_PREFIX);
}

/**
 * 供应商分享:被控电脑收到的分享,每个分享当作一台「电脑」接在同账号其他电脑之后
 * (设备 id = `share:<shareId>`),名字由调用方写成「{电脑名} · 来自 {昵称} 的分享」,
 * 模型列表分组标题沿用「{供应商} · {电脑名}」,于是成为产品规则 §5.1 的写法。
 *
 * 与同账号电脑同口径:已暂停、分享者电脑不在线的分享不列(读不了目录,选了也用不了);
 * 任务当前(或挂着的)Agent 所在的分享始终保留,让用户看得到 Agent 在哪、换得走。
 * 已不在列表里的分享(被删除或已退出)在拿到过一次权威列表后保留一行「已不可用的分享」。
 * 目录只认被分享的那个供应商,并且同样要求开了「允许被远程调用」。
 */
export function providerShareRemoteCatalogs(input: {
  shares: readonly ProviderShareCatalogEntry[];
  /** 已拿到过一次被控电脑的权威列表。 */
  loaded: boolean;
  keepDeviceIds: readonly string[];
  /** 只要 keepDeviceIds 里的分享(选择器没打开、只为模型药丸取目录时)。 */
  keepOnly?: boolean;
  deviceName(share: ProviderShareCatalogEntry): string;
  unavailableName: string;
}): RemoteAgentCatalog[] {
  const keep = new Set(input.keepDeviceIds.filter(isProviderShareAgentDeviceId));
  const catalogs: RemoteAgentCatalog[] = [];
  const seen = new Set<string>();
  for (const share of input.shares) {
    if (seen.has(share.agentDeviceId)) continue;
    seen.add(share.agentDeviceId);
    const kept = keep.delete(share.agentDeviceId);
    const reachable = share.status === 'active' && share.hostOnline;
    if (!kept && (input.keepOnly || !reachable)) continue;
    const payload = share.payload;
    catalogs.push({
      deviceId: share.agentDeviceId,
      name: input.deviceName(share),
      status: payload ? 'ready' : 'error',
      providers: payload
        ? remoteAgentProviders(payload.providers).filter((provider) => provider.id === share.providerId)
        : [],
      ...(payload?.modelVisibilityOverrides !== undefined
        ? { modelVisibilityOverrides: payload.modelVisibilityOverrides }
        : {}),
    });
  }
  if (input.loaded) {
    for (const deviceId of keep) {
      catalogs.push({ deviceId, name: input.unavailableName, status: 'error', providers: [] });
    }
  }
  return catalogs;
}
