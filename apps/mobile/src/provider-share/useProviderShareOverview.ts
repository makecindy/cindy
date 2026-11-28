/**
 * 「我分享的供应商」列表的数据：账号下每台电脑上的分享。
 *
 * 读取节奏(docs/dev-rules/server-channel-review.md)：进入页面、回到前台或下拉时各读一轮，不设定时器。
 * 一轮 = 一次设备名单 + 每台可控电脑一次 `owned`(不含用量)；同时最多读 4 台，离开页面或换账号后的
 * 迟到结果丢弃。读不到的电脑保留上一轮的内容并标出原因，不当成「没有分享」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { toDeviceListItems } from '@/device-link/devices';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';

import {
  classifyShareManagementError,
  readOwnedShares,
  type ShareManagementErrorCode,
  type ShareManagementShare,
} from './providerShareManagement';

const READ_CONCURRENCY = 4;

export interface ProviderShareComputer {
  deviceId: string;
  name: string;
  /** 在线并允许这台手机远程控制；否则不读取，只在页面底部说明。 */
  reachable: boolean;
  loading: boolean;
  /** null = 还没读到过。 */
  shares: ShareManagementShare[] | null;
  error: ShareManagementErrorCode | null;
}

export interface ProviderShareOverview {
  computers: ProviderShareComputer[];
  /** 设备名单读过至少一次。 */
  loaded: boolean;
  loading: boolean;
  /** 设备名单本身没读到。 */
  failed: boolean;
  refresh(): Promise<void>;
}

export function useProviderShareOverview(active: boolean, onlyDeviceId?: string): ProviderShareOverview {
  const { invoke, readDeviceList } = useDeviceLink();
  const revoked = useRevokedDevices();
  const revokedRef = useRef(revoked);
  revokedRef.current = revoked;
  const [computers, setComputers] = useState<ProviderShareComputer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const epoch = useRef(0);
  const running = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);

  const load = useCallback(async () => {
    const round = ++epoch.current;
    const owner = getMobileAuthOwner();
    const current = () => round === epoch.current && isMobileAuthOwnerCurrent(owner);
    setLoading(true);
    try {
      const roster = await readDeviceList();
      if (!current()) return;
      const items = toDeviceListItems(roster.devices, Date.now(), revokedRef.current)
        .filter((item) => !onlyDeviceId || item.device.deviceId === onlyDeviceId);
      setFailed(false);
      setLoaded(true);
      setComputers((previous) => items.map((item) => {
        const before = previous.find((entry) => entry.deviceId === item.device.deviceId);
        return {
          deviceId: item.device.deviceId,
          name: item.device.name,
          reachable: item.canOpen,
          loading: item.canOpen,
          shares: before?.shares ?? null,
          error: null,
        };
      }));
      const queue = items.filter((item) => item.canOpen).map((item) => item.device.deviceId);
      const settle = (deviceId: string, patch: Partial<ProviderShareComputer>) => {
        if (!current()) return;
        setComputers((value) => value.map((entry) => entry.deviceId === deviceId
          ? { ...entry, loading: false, ...patch }
          : entry));
      };
      await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, async () => {
        for (let deviceId = queue.shift(); deviceId; deviceId = queue.shift()) {
          if (!current()) return;
          try {
            settle(deviceId, { shares: await readOwnedShares(invoke, deviceId), error: null });
          } catch (error) {
            settle(deviceId, { error: classifyShareManagementError(error) });
          }
        }
      }));
    } catch {
      if (current()) {
        setFailed(true);
        setLoaded(true);
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [invoke, onlyDeviceId, readDeviceList]);

  // 同一时间只跑一轮：下拉与回到前台撞在一起时共用在途的那一轮。
  const refresh = useCallback(() => {
    if (!running.current) {
      const round: Promise<void> = load().finally(() => {
        // 离开页面后重新进入会另起一轮：迟到的上一轮不能把新一轮的占位清掉。
        if (running.current === round) running.current = null;
      });
      running.current = round;
    }
    return running.current;
  }, [load]);

  useEffect(() => {
    if (!active || !foreground) return;
    void refresh();
    return () => {
      // 离开页面：在途结果作废，不再更新界面。
      epoch.current++;
      running.current = null;
    };
  }, [active, foreground, refresh]);

  return { computers, loaded, loading, failed, refresh };
}
