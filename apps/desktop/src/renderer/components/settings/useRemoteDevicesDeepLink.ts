/**
 * useRemoteDevicesDeepLink —— 「远程连接」页「设备列表」的展开态与设备深链。
 * ---------------------------------------------------------------------------
 * 从 RemoteControlSection 抽出,旧版列表页与新版拓扑页共用同一套规则:
 *  - 深链 `?section=devices` / `?section=remoteControl.devices` 首帧就是展开态;
 *  - `&device=<id>` 只在 devices 段深链下生效,展开后把那一行滚入视野并短暂高亮(MyDevicesPanel);
 *    同一深链再次进入(location.key 变)也重新聚焦;
 *  - 设置搜索命中「设备列表」时展开;
 *  - 用户主动收起时把 section / device 参数摘掉,否则刷新 / 返回还会再展开一次。
 * 拓扑浮层的「管理设备…」走同一条深链(push 导航),于是展开 + 定位 + 高亮全部复用。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useSettingsSearchNavigation } from './SettingsSearchNavigation';

const DEVICES_SECTION_PARAMS = ['devices', 'remoteControl.devices'];

export function isDevicesSection(search: string): boolean {
  return DEVICES_SECTION_PARAMS.includes(new URLSearchParams(search).get('section') ?? '');
}

export function focusDeviceParam(search: string): string | null {
  if (!isDevicesSection(search)) return null;
  return new URLSearchParams(search).get('device')?.trim() || null;
}

export interface RemoteDevicesDeepLink {
  devicesOpen: boolean;
  toggleDevices: () => void;
  focusDeviceId: string | null;
  focusRequestKey: string | null;
  /** 展开列表并定位到某台设备(拓扑浮层「管理设备…」)。 */
  openDevice: (deviceId: string) => void;
}

export function useRemoteDevicesDeepLink(): RemoteDevicesDeepLink {
  const { entry, activation } = useSettingsSearchNavigation();
  const location = useLocation();
  const navigate = useNavigate();

  // 深链必须在首帧就是展开态:放到 effect 里会先画一帧收起,再把下方内容顶开一格。
  const [devicesOpen, setDevicesOpen] = useState(() => isDevicesSection(location.search));

  useEffect(() => {
    if (isDevicesSection(location.search)) setDevicesOpen(true);
  }, [location.search]);

  // 列表展开后才交给面板,否则隐藏的行滚不进视野。
  const focusDeviceId = devicesOpen ? focusDeviceParam(location.search) : null;
  const focusRequestKey = focusDeviceId ? `${focusDeviceId}:${location.key}` : null;

  useLayoutEffect(() => {
    if (entry?.targetId === 'settings-search-target-remote-devices') setDevicesOpen(true);
  }, [entry, activation]);

  const collapseRequestedRef = useRef(false);
  const toggleDevices = useCallback(() => {
    setDevicesOpen((previous) => {
      // 只有用户主动收起才需要清 URL;更新函数里只记录这次意图,幂等、可重入。
      collapseRequestedRef.current = previous;
      return !previous;
    });
  }, []);

  // 收起后把 ?section=devices 摘掉。挂 effect 是为了让 toggle 保持函数式更新;必须再看
  // collapseRequestedRef,否则「页面已挂载时才导航进深链」那一帧会读到还没提交的
  // devicesOpen=false,把刚进来的深链清掉。
  useEffect(() => {
    if (devicesOpen || !collapseRequestedRef.current) return;
    collapseRequestedRef.current = false;

    const next = new URLSearchParams(location.search);
    if (!DEVICES_SECTION_PARAMS.includes(next.get('section') ?? '')) return;
    next.delete('section');
    // device 聚焦参数只依附于 devices 段深链,一并摘掉。
    next.delete('device');
    const search = next.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : '',
      },
      { replace: true },
    );
  }, [devicesOpen, location.pathname, location.search, navigate]);

  const openDevice = useCallback(
    (deviceId: string) => {
      const next = new URLSearchParams(location.search);
      next.set('section', 'devices');
      next.set('device', deviceId);
      // push 而非 replace:location.key 变化才会让同一台设备再次聚焦。
      navigate({ pathname: location.pathname, search: `?${next.toString()}` });
    },
    [location.pathname, location.search, navigate],
  );

  return { devicesOpen, toggleDevices, focusDeviceId, focusRequestKey, openDevice };
}
