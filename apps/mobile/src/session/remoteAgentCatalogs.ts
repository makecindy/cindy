import { deviceDisplayName } from '@/device-link/deviceName';
/**
 * 远程 Agent 的「其他电脑」模型目录(纯逻辑,与桌面模型面板同口径):
 * 手机的模型选择器在被控电脑自己的供应商之后,列出同账号其他电脑上开了「允许被远程调用」的
 * 供应商,每个供应商一段、标题带电脑名;来源页里每台电脑一块,块标题就是电脑名,没有总的
 * 「其他电脑」标题。一个都没开的电脑不出现,列表不随设备数变长。
 * 别人分享给被控电脑的供应商(供应商分享)同样按「一台电脑」接在后面,见 providerShareRemoteCatalogs。
 */
import { providerSharePickerState, type DeviceView, type ProviderShareFavoriteSource } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers/registry';
import { remoteInvocationModels } from '@cindy/model-providers';
import type { NewSessionRemoteAgentPick } from './newSession';
import { matchesEntry, mobileUnifiedEntries } from './unifiedMobileModels';

import { toDeviceListItems } from '@/device-link/devices';
import type { ProviderShareCatalogEntry } from '@/device-link/providerShareCatalogCache';

import { isProviderShareAgentDeviceId } from './providerShareAgentDevice';

/** 一台可选电脑的目录状态(providers 只含开了远程调用的供应商)。 */
export interface RemoteAgentCatalog {
  deviceId: string;
  name: string;
  /** loading = 还没读到;error = 读不到(离线 / 没开远程控制 / 旧版本)且没有缓存。 */
  status: 'loading' | 'ready' | 'error';
  /** 此刻连不上(只因任务的 Agent 在这台才留在清单里,目录可能来自缓存)。 */
  offline?: true;
  /** 分享来的供应商的收藏身份。同账号电脑没有这个字段。 */
  favoriteSource?: ProviderShareFavoriteSource;
  providers: ProviderView[];
  modelVisibilityOverrides?: Record<string, boolean>;
}

/** 那台电脑允许远程调用的供应商;没有该标记(旧数据)按未开放处理。 */
export function remoteAgentProviders(providers: readonly ProviderView[]): ProviderView[] {
  return providers.filter(
    (provider) => (provider as { remoteInvocationEnabled?: unknown }).remoteInvocationEnabled === true,
  ).map(remoteInvocationModels);
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
      name: deviceDisplayName(item.device.deviceId, item.device.name, input.devices),
      canOpen: item.canOpen,
    }));
}

export { isProviderShareAgentDeviceId, PROVIDER_SHARE_AGENT_DEVICE_PREFIX } from './providerShareAgentDevice';

/**
 * 供应商分享:被控电脑收到的分享,每个分享当作一台「电脑」接在同账号其他电脑之后
 * (设备 id = `share:<shareId>`),名字由调用方写成「{电脑名} · 来自 {昵称} 的分享」,
 * 模型列表分组标题沿用「{供应商} · {电脑名}」,于是成为产品规则 §5.1 的写法。
 *
 * 已暂停的分享不列;分享者电脑暂时离线的分享照常列出,名字后标「暂时离线」(providerSharePickerState,
 * 与 Desktop 同一条规则,2026-11-23 用户裁决「保留并标注」),不随在线状态来回出现、消失。
 * 目录仍在信任期内的离线分享可以选;没有可信目录时标成离线、选不了。
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
  /** 分享者电脑暂时离线时的名字(「{名字} · 暂时离线」)。 */
  offlineName(name: string): string;
  unavailableName: string;
}): RemoteAgentCatalog[] {
  const keep = new Set(input.keepDeviceIds.filter(isProviderShareAgentDeviceId));
  const catalogs: RemoteAgentCatalog[] = [];
  const seen = new Set<string>();
  for (const share of input.shares) {
    if (seen.has(share.agentDeviceId)) continue;
    seen.add(share.agentDeviceId);
    const kept = keep.delete(share.agentDeviceId);
    const state = providerSharePickerState(share);
    const reachable = state === 'available'
      || (state === 'offline' && (share.payload?.providerContinuity?.remainingMs ?? 0) > 0);
    if (!kept && (input.keepOnly || state === 'paused')) continue;
    const payload = share.payload;
    const name = input.deviceName(share);
    catalogs.push({
      deviceId: share.agentDeviceId,
      name: state === 'offline' ? input.offlineName(name) : name,
      status: payload ? 'ready' : 'error',
      // 已暂停 / 分享者电脑不在线的分享只因被选着才留在清单里:与留下的离线电脑一样标出,选不了。
      ...(reachable ? {} : { offline: true as const }),
      ...(share.favoriteSource ? { favoriteSource: share.favoriteSource } : {}),
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

/**
 * 按记忆恢复的远程选择此刻还能不能用:清单读完后那台电脑 / 分享不在了、读不到、离线,或模型已不在
 * 那份目录里「可选」的条目(供应商断开 / 停用、模型被隐藏)都算不能用。清单没读完先不下结论。
 */
export function restoredRemoteAgentUnusable(input: {
  pick: NewSessionRemoteAgentPick;
  catalog: RemoteAgentCatalog | undefined;
  settled: boolean;
}): boolean {
  const { pick, catalog } = input;
  if (!catalog) return input.settled;
  if (catalog.status === 'loading') return false;
  if (catalog.status === 'error' || catalog.offline) return true;
  return !mobileUnifiedEntries(catalog.providers, [pick.agentKind], catalog.modelVisibilityOverrides, false)
    .some((entry) => (pick.providerId === null || entry.providerId === pick.providerId)
      && matchesEntry(entry, pick.model));
}
