import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DeviceView } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import {
  collectMobileVoiceDictionaryHosts,
  patchMobileVoiceDictionaryHosts,
  type MobileVoiceDictionaryHost,
} from '@/session/mobileVoiceDictionaryView';

export const SETTINGS_DEVICE_TIMEOUT_MS = 12_000;

/**
 * 本机名称的进程内最新值。设置页与「设备名称」子页是两个路由:子页保存成功后
 * 在这里发布,设置页返回时立即显示新名称,不用等下一次设备清单请求。
 * 按「账号代次 + deviceId」记:同一台手机换账号时 deviceId 不变,只按 deviceId
 * 会把上一个账号的名称显示给新账号。
 */
let publishedSelfDeviceName: { key: string; name: string } | null = null;
/** 每次保存成功 +1;读取只在发起后没有新保存时才发布,避免旧快照盖掉刚存的名称。 */
let selfDeviceNameWrites = 0;
const selfDeviceNameListeners = new Set<() => void>();

export function selfDeviceNameKey(accountGeneration: number, deviceId: string): string {
  return `${accountGeneration}:${deviceId}`;
}

function publish(value: { key: string; name: string } | null): void {
  publishedSelfDeviceName = value;
  selfDeviceNameListeners.forEach((listener) => listener());
}

/** 保存(改名 / 恢复默认)成功后发布服务端返回的名称。 */
export function publishSavedSelfDeviceName(key: string, name: string | null): void {
  selfDeviceNameWrites += 1;
  publish(name ? { key, name } : null);
}

function subscribeSelfDeviceName(listener: () => void): () => void {
  selfDeviceNameListeners.add(listener);
  return () => selfDeviceNameListeners.delete(listener);
}

function usePublishedSelfDeviceName(key: string | null): string | null {
  const published = useSyncExternalStore(subscribeSelfDeviceName, () => publishedSelfDeviceName);
  return key && published?.key === key ? published.name : null;
}

/**
 * 设置页及其子页共用的设备清单读取:本机名称(正本在 device-link 服务端)+ 词典宿主电脑。
 * 电脑的在线状态跟 presence 实时修补 —— 设置页可能开着很久,REST 快照会过期。
 */
export function useSettingsDeviceDirectory(): {
  desktopDevices: readonly MobileVoiceDictionaryHost[];
  selfDeviceName: string | null;
} {
  const auth = useAuth();
  const { lastPresenceSnapshot } = useDeviceLink();
  const [desktopDevices, setDesktopDevices] = useState<readonly MobileVoiceDictionaryHost[]>([]);
  const selfKey = auth.isAuthenticated && auth.deviceId ? selfDeviceNameKey(auth.accountGeneration, auth.deviceId) : null;
  const publishedName = usePublishedSelfDeviceName(selfKey);

  useEffect(() => {
    if (!auth.isAuthenticated || !auth.deviceId) {
      if (publishedSelfDeviceName) publish(null);
      // 登出/未登录才清空电脑列表 —— 拉取失败不清(见下面 catch 的说明)。
      setDesktopDevices([]);
      return;
    }

    const selfDeviceId = auth.deviceId;
    const key = selfDeviceNameKey(auth.accountGeneration, selfDeviceId);
    const writesAtStart = selfDeviceNameWrites;
    let cancelled = false;
    void auth.apiFetch<{ devices: DeviceView[] }>('/api/device-link/devices', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      timeoutMs: SETTINGS_DEVICE_TIMEOUT_MS,
    })
      .then((res) => {
        if (cancelled) return;
        const self = res.devices.find((device) => device.deviceId === selfDeviceId);
        // 请求期间刚保存过名称时,这份快照可能早于那次写入,不能拿来覆盖。
        if (selfDeviceNameWrites === writesAtStart) publish(self?.name?.trim() ? { key, name: self.name.trim() } : null);
        // 同一份设备清单顺带筛出电脑:词典正本在电脑上,手机按电脑分别展示。
        setDesktopDevices(collectMobileVoiceDictionaryHosts(res.devices));
      })
      .catch(() => {
        if (cancelled) return;
        // 本机名称保留上一次已知值(没有时回退系统名)。电脑列表刻意不清空:这只是一次
        // 拉取失败(断网、超时),不代表用户没有电脑。
        // 清掉的话词典页会显示成「还没有电脑」,连带 hydrate/refresh 也没有 host 可
        // 跑 —— 明明本地还有一份可用的离线缓存。真正该清空的时机是登出。
      });

    return () => {
      cancelled = true;
    };
  }, [auth]);

  useEffect(() => {
    if (!lastPresenceSnapshot) return;
    setDesktopDevices((current) => patchMobileVoiceDictionaryHosts(current, lastPresenceSnapshot));
  }, [lastPresenceSnapshot]);

  return { desktopDevices, selfDeviceName: publishedName };
}
