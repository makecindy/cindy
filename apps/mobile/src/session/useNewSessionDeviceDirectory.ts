/**
 * 入口没带候选电脑时（桌面入口组件、只带 deviceId 的深链），由新建页自己补一份设备目录。
 *
 * 只读缓存目录（非 fresh；`readDeviceList` 与首页、连接建立后的名册读取共用同一次 in-flight
 * 请求），打开时读一次、连接纪元变化再读一次，不在这里加轮询与重试循环。读不到就返回空，
 * 屏幕退回路由里的那台或记住的那台。候选列表同时喂给默认电脑解析与设备选择器，所以从这里
 * 进来的新建页也能换电脑。
 */
import { useEffect, useMemo, useState } from 'react';
import type { DeviceView } from '@cindy/device-link';

import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { toDeviceListItems } from '@/device-link/devices';
import type { NewSessionDeviceOption } from './newSession';

export function useNewSessionDeviceDirectory(input: {
  /** 路由已经带来候选列表时不再读目录。 */
  enabled: boolean;
  connectionEpoch: number;
  revokedDevices: ReadonlySet<string>;
  readDeviceList: () => Promise<{ devices: DeviceView[] }>;
}): NewSessionDeviceOption[] {
  const { enabled, connectionEpoch, readDeviceList, revokedDevices } = input;
  const [devices, setDevices] = useState<readonly DeviceView[]>([]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const owner = getMobileAuthOwner();
    void readDeviceList()
      .then((response) => {
        if (cancelled || !isMobileAuthOwnerCurrent(owner)) return;
        setDevices(response.devices);
      })
      .catch(() => {
        // 目录读不到时保持空：默认电脑退回记住的那台，不阻塞新建。
      });
    return () => { cancelled = true; };
    // 连接纪元变化（重连 / 换账号）值得再读一次；同一纪元内不重复请求。
  }, [connectionEpoch, enabled, readDeviceList]);

  // 撤权后的电脑即使仍在目录里也不能当候选，与首页同一套 canOpen 判据。
  return useMemo(
    () => toDeviceListItems(devices, Date.now(), revokedDevices)
      .filter((item) => item.canOpen)
      .map((item) => ({ deviceId: item.device.deviceId, name: item.device.name })),
    [devices, revokedDevices],
  );
}
