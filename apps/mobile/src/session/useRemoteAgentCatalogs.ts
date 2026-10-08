/**
 * 远程 Agent:读同账号其他电脑的模型目录,供模型选择器按电脑分段列出(见 remoteAgentCatalogs)。
 *
 * - 电脑清单 = 账号设备列表(readDeviceList,与首页同一次 single-flight 读取);
 * - 每台电脑的目录 = 手机直接经 device-link 向那台电脑取 `maker:provider:list`(与被控电脑
 *   同参数、同一份按设备隔离的供应商缓存);有缓存先显示,再在后台刷新;
 * - 读不到(离线 / 没开远程控制 / 旧版本)只影响那一台,绝不挡住被控电脑自己的列表。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

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
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';

import {
  remoteAgentProviders,
  selectRemoteAgentDevices,
  type RemoteAgentCatalog,
} from './remoteAgentCatalogs';

type CatalogState = { status: RemoteAgentCatalog['status']; payload?: DeviceProvidersPayload };

const NO_CATALOGS: RemoteAgentCatalog[] = [];

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
  const revoked = useRevokedDevices();
  const [devices, setDevices] = useState<{ deviceId: string; name: string; canOpen: boolean }[]>([]);
  const [catalogs, setCatalogs] = useState<ReadonlyMap<string, CatalogState>>(new Map());
  const ownerRef = useRef({ accountGeneration, controlledDeviceId: input.controlledDeviceId });
  const keepKey = input.keepDeviceIds.join('\n');
  const keepOnly = input.keepOnly === true;

  // 换账号 / 换被控电脑:旧清单不再属于当前视图。
  useEffect(() => {
    const owner = ownerRef.current;
    if (owner.accountGeneration === accountGeneration
      && owner.controlledDeviceId === input.controlledDeviceId) return;
    ownerRef.current = { accountGeneration, controlledDeviceId: input.controlledDeviceId };
    setDevices([]);
    setCatalogs(new Map());
  }, [accountGeneration, input.controlledDeviceId]);

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

  return useMemo(() => {
    if (devices.length === 0) return NO_CATALOGS;
    return devices.map((device): RemoteAgentCatalog => {
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
  }, [catalogs, devices]);
}
