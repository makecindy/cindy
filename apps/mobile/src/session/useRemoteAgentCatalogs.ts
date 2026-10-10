/**
 * 远程 Agent:读同账号其他电脑的模型目录,供模型选择器按电脑分段列出(见 remoteAgentCatalogs)。
 *
 * - 电脑清单 = 账号设备列表(readDeviceList,与首页同一次 single-flight 读取);
 * - 每台电脑的目录 = 手机直接经 device-link 向那台电脑取 `maker:provider:list`(与被控电脑
 *   同参数、同一份按设备隔离的供应商缓存);有缓存先显示,再在后台刷新;
 * - 读不到(离线 / 没开远程控制 / 旧版本)只影响那一台,绝不挡住被控电脑自己的列表。
 * - 供应商分享:别人分享给被控电脑的供应商由被控电脑代读(手机读不到另一个账号的电脑),
 *   每个分享接在同账号电脑之后当作一台「电脑」(`share:<shareId>`);同样先用缓存再后台刷新。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
  PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL,
} from '@cindy/device-link';

import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import {
  fetchDeviceProviders,
  fetchDeviceProvidersFresh,
  getCachedDeviceProviders,
  subscribeDeviceProviders,
  subscribeDeviceProvidersError,
  type DeviceProvidersPayload,
} from '@/device-link/deviceProvidersCache';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import {
  getCachedProviderShareCatalogs,
  refreshProviderShareCatalogs,
  subscribeProviderShareCatalogs,
  type ProviderShareCatalogEntry,
} from '@/device-link/providerShareCatalogCache';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';

import {
  isProviderShareAgentDeviceId,
  providerShareRemoteCatalogs,
  remoteAgentProviders,
  selectRemoteAgentDevices,
  type RemoteAgentCatalog,
} from './remoteAgentCatalogs';

type CatalogState = { status: RemoteAgentCatalog['status']; payload?: DeviceProvidersPayload };
/** 被控电脑收到的分享;loaded = 已拿到过一次权威列表(含缓存)。 */
type ShareState = { controlledDeviceId: string; shares: readonly ProviderShareCatalogEntry[]; loaded: boolean };

const NO_CATALOGS: RemoteAgentCatalog[] = [];

function cachedShareState(controlledDeviceId: string): ShareState {
  const cached = controlledDeviceId ? getCachedProviderShareCatalogs(controlledDeviceId) : undefined;
  return { controlledDeviceId, shares: cached ?? [], loaded: !!cached };
}

export function useRemoteAgentCatalogs(input: {
  /** 只在需要时读(选择器打开,或任务的 Agent 在另一台电脑)。 */
  enabled: boolean;
  controlledDeviceId: string;
  /** 任务当前 / 挂着的 Agent 所在电脑:离线也保留在清单里。 */
  keepDeviceIds: readonly string[];
  /** 只读 keepDeviceIds 里的电脑(选择器没打开、只为模型药丸取 Agent 所在那台的目录时)。 */
  keepOnly?: boolean;
}): RemoteAgentCatalog[] {
  const { readDeviceList, invoke, openLink, connectionEpoch, status } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const { t } = useTranslation();
  const revoked = useRevokedDevices();
  const [devices, setDevices] = useState<{ deviceId: string; name: string; canOpen: boolean }[]>([]);
  const [catalogs, setCatalogs] = useState<ReadonlyMap<string, CatalogState>>(new Map());
  const [shareState, setShareState] = useState<ShareState>(() => cachedShareState(input.controlledDeviceId));
  const ownerRef = useRef({ accountGeneration, controlledDeviceId: input.controlledDeviceId });
  const keepKey = input.keepDeviceIds.join('\n');
  const keepOnly = input.keepOnly === true;
  // 选择器没打开时只为药丸取目录:Agent 不在某个分享上就不必去读分享。
  const readShares = !keepOnly || input.keepDeviceIds.some(isProviderShareAgentDeviceId);

  // 换账号 / 换被控电脑:旧清单不再属于当前视图。
  useEffect(() => {
    const owner = ownerRef.current;
    if (owner.accountGeneration === accountGeneration
      && owner.controlledDeviceId === input.controlledDeviceId) return;
    ownerRef.current = { accountGeneration, controlledDeviceId: input.controlledDeviceId };
    setDevices([]);
    setCatalogs(new Map());
    setShareState(cachedShareState(input.controlledDeviceId));
  }, [accountGeneration, input.controlledDeviceId]);

  // 供应商分享:被控电脑代读它收到的分享与各自的目录。有缓存先显示,再在后台刷新;
  // 读不到(离线 / 旧版桌面)保留上一份,绝不影响被控电脑自己与同账号电脑的列表。
  useEffect(() => {
    const controlledDeviceId = input.controlledDeviceId;
    if (!input.enabled || !controlledDeviceId || status !== 'online' || !readShares) return;
    let cancelled = false;
    setShareState(cachedShareState(controlledDeviceId));
    const unsubscribe = subscribeProviderShareCatalogs(controlledDeviceId, (shares) => {
      if (!cancelled) setShareState({ controlledDeviceId, shares, loaded: true });
    });
    void refreshProviderShareCatalogs(controlledDeviceId, () => invoke(
      controlledDeviceId,
      PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL,
      [{ capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2] }],
    )).catch(() => {
      // 保留缓存;下次打开选择器或重连时再读。
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // keepOnly 也在依赖里:打开选择器时即使分享列表已在显示,也在后台再读一次。
  }, [connectionEpoch, input.controlledDeviceId, input.enabled, invoke, keepOnly, readShares, status]);

  useEffect(() => {
    if (!input.enabled || !input.controlledDeviceId || status !== 'online') return;
    let cancelled = false;
    const cleanups: (() => void)[] = [];
    const patch = (deviceId: string, next: CatalogState) => {
      if (cancelled) return;
      setCatalogs((current) => {
        const map = new Map(current);
        map.set(deviceId, next);
        return map;
      });
    };
    void readDeviceList()
      .then((response) => {
        if (cancelled) return;
        const keepDeviceIds = keepKey ? keepKey.split('\n') : [];
        const selected = selectRemoteAgentDevices({
          devices: response.devices,
          controlledDeviceId: input.controlledDeviceId,
          keepDeviceIds,
          revokedDeviceIds: revoked,
        }).filter((device) => !keepOnly || keepDeviceIds.includes(device.deviceId));
        setDevices(selected);
        for (const device of selected) {
          const cached = getCachedDeviceProviders(device.deviceId);
          patch(device.deviceId, cached
            ? { status: 'ready', payload: cached }
            : { status: device.canOpen ? 'loading' : 'error' });
          cleanups.push(subscribeDeviceProviders(device.deviceId, (payload) => {
            patch(device.deviceId, { status: 'ready', payload });
          }));
          cleanups.push(subscribeDeviceProvidersError(device.deviceId, () => {
            // 有缓存继续显示缓存;从未读到过才标成读不到。
            const fallback = getCachedDeviceProviders(device.deviceId);
            patch(device.deviceId, fallback ? { status: 'ready', payload: fallback } : { status: 'error' });
          }));
          if (!device.canOpen) continue;
          const transport = createMobileMakerTransport({
            deviceId: device.deviceId,
            invoke,
            isCurrent: () => !cancelled,
          });
          const read = () => transport.listProviders();
          void openLink(device.deviceId)
            .then(() => (cached
              ? fetchDeviceProvidersFresh(device.deviceId, read)
              : fetchDeviceProviders(device.deviceId, read)))
            .catch(() => {
              if (!getCachedDeviceProviders(device.deviceId)) patch(device.deviceId, { status: 'error' });
            });
        }
      })
      .catch(() => {
        // 设备清单读不到时保留上一份;被控电脑自己的列表不受影响。
      });
    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [
    connectionEpoch,
    input.controlledDeviceId,
    input.enabled,
    invoke,
    keepKey,
    keepOnly,
    openLink,
    readDeviceList,
    revoked,
    status,
  ]);

  const shareCatalogs = useMemo(() => {
    if (!input.enabled || !readShares || shareState.controlledDeviceId !== input.controlledDeviceId) {
      return NO_CATALOGS;
    }
    // 只写来自谁，不写分享者的电脑名(provider-sharing.md §5.1、§6)；同一位分享者的同一个供应商
    // 分享了不止一份时，按列表顺序给后面的加序号(与桌面一致)。
    const names = new Map<string, string>();
    const seen = new Map<string, number>();
    for (const share of shareState.shares) {
      const base = t('providerShare.picker.shareName', { owner: share.ownerName });
      const key = `${share.ownerName}\n${share.providerLabel}`;
      const index = (seen.get(key) ?? 0) + 1;
      seen.set(key, index);
      names.set(share.agentDeviceId, index > 1 ? t('providerShare.picker.numbered', { name: base, index }) : base);
    }
    return providerShareRemoteCatalogs({
      shares: shareState.shares,
      loaded: shareState.loaded,
      keepDeviceIds: keepKey ? keepKey.split('\n') : [],
      keepOnly,
      deviceName: (share) => names.get(share.agentDeviceId) ?? t('providerShare.picker.shareName', { owner: share.ownerName }),
      unavailableName: t('providerShare.picker.unavailable'),
    });
  }, [input.controlledDeviceId, input.enabled, keepKey, keepOnly, readShares, shareState, t]);

  return useMemo(() => {
    if (devices.length === 0 && shareCatalogs.length === 0) return NO_CATALOGS;
    const deviceCatalogs = devices.map((device): RemoteAgentCatalog => {
      const state = catalogs.get(device.deviceId);
      const payload = state?.payload;
      return {
        deviceId: device.deviceId,
        name: device.name,
        status: state?.status ?? (device.canOpen ? 'loading' : 'error'),
        providers: payload ? remoteAgentProviders(payload.providers) : [],
        ...(payload?.modelVisibilityOverrides !== undefined
          ? { modelVisibilityOverrides: payload.modelVisibilityOverrides }
          : {}),
      };
    });
    return shareCatalogs.length === 0 ? deviceCatalogs : [...deviceCatalogs, ...shareCatalogs];
  }, [catalogs, devices, shareCatalogs]);
}
