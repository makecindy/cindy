/**
 * useControllableDevices —— 当前可作为「远程项目」目标的同账号被控设备(轻量版)。
 *
 * 与 useDeviceLinkSettings(被控开关 / controlledBy / 轮询 / getState 全套)不同,这里只
 * 拉设备列表 + 订阅 presence / 本地控制偏好,筛出**可控目标**:
 * `online && remoteControlEnabled && controlEnabled && !isSelf && isCindyApp(app) && !isMobilePlatform(platform)`。
 * 供「添加远程项目」弹窗的设备下拉 + 入口 gate(useHasAnyRemoteTarget)共用,避免在首页
 * 常驻时背上整套设置页的订阅开销。device-link 不可用(未登录 / relay 断)→ 静默空列表。
 */

import { useEffect, useMemo, useState } from 'react';
import { isCindyApp, isControllableDevice as isControllableCindyDevice, isMobilePlatform } from '@cindy/maker-shared/device-list';
import {
  useDeviceLinkDeviceList,
  useDeviceLinkDeviceListRequestState,
} from '@/features/device-link/useDeviceLinkDeviceList';

export interface ControllableDevice {
  deviceId: string;
  name: string;
  platform: string | null;
}

/**
 * 可作为远程项目目标的判定:同账号、在线、对方已开「允许被控」、本机未关闭控制、
 * 不是本机、且不是只能作为控制端的手机。
 * 纯函数,供 hook 过滤 + 单测复用(守住这条准入,避免误把离线 / 未开被控 / 本机 / 手机列进去)。
 */
export function isControllableDevice(d: DeviceLinkDeviceView): boolean {
  return d.controlEnabled && isControllableCindyDevice(d);
}

/** 把设备全量列表(含本机/离线/未开被控)收敛成可控目标视图。纯函数,便于单测整条 transform。 */
export function toControllableDevices(list: readonly DeviceLinkDeviceView[]): ControllableDevice[] {
  return list
    .filter(isControllableDevice)
    .map((d) => ({ deviceId: d.deviceId, name: d.name, platform: d.platform }));
}

/**
 * 两个可控设备列表内容是否等价(deviceId/name/platform 全等且顺序一致)。
 * presence 推送高频且多为无关变更(他机改名 / busy 翻转),据此跳过无变化的 setState,
 * 避免每次 ping 都产出新数组引用、churn 下游 memo(useHasAnyRemoteTarget / 弹窗 targets)。
 */
export function sameControllableList(
  a: readonly ControllableDevice[],
  b: readonly ControllableDevice[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].deviceId !== b[i].deviceId || a[i].name !== b[i].name || a[i].platform !== b[i].platform) {
      return false;
    }
  }
  return true;
}

/**
 * 创建页设备切换器里的一项。与 ControllableDevice 的差别只有一个:**包含离线设备**。
 * 设备掉线时若直接从列表消失,用户会以为配对丢了(而实际只是没连上),所以离线的照样列出、
 * 带 online=false 由 UI 置灰禁用。
 */
export interface SelectableDevice extends ControllableDevice {
  online: boolean;
}

/**
 * 设备切换器的准入:同账号、非本机、非手机、本机未关闭控制;对方的「允许被控」
 * **只在它在线时才作数**。
 *
 * 与 isControllableDevice 的差别是不要求 online —— 见 SelectableDevice。
 *
 * 为什么离线时不看 remoteControlEnabled:presence 掉线的行会把这一位报成 false,即使对方并没有
 * 主动关闭远程控制(`useDeviceLinkRemoteProjects` 的 ineligible 判定早就写明「只有 online 的
 * false 才权威」,离线一律当 transient disconnect)。要是照着这一位过滤,设备一掉线就整行消失、
 * 唯一对端掉线时 pill 会整个不见 —— 恰好把本控件承诺的「离线也列出、置灰禁用」打死。
 * `controlEnabled` 是控制端本地偏好,任何时候都权威,照常要求。
 */
export function isSelectableDevice(d: DeviceLinkDeviceView): boolean {
  // 手机端是控制端而非被控端。即便旧版本或异常 presence 报出 remoteControlEnabled=true，
  // 也不能把 iOS / Android 暴露成新建对话的运行目标。
  if (d.isSelf || !d.controlEnabled || !isCindyApp(d.app) || isMobilePlatform(d.platform)) return false;
  return d.online ? d.remoteControlEnabled : true;
}

/** 设备全量列表 → 切换器视图(含离线)。纯函数,便于单测整条 transform。 */
export function toSelectableDevices(list: readonly DeviceLinkDeviceView[]): SelectableDevice[] {
  return list
    .filter(isSelectableDevice)
    .map((d) => ({ deviceId: d.deviceId, name: d.name, platform: d.platform, online: d.online }));
}

/** 同 sameControllableList,但把 online 也纳入比较(掉线/上线必须触发重渲染)。 */
export function sameSelectableList(
  a: readonly SelectableDevice[],
  b: readonly SelectableDevice[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].deviceId !== b[i].deviceId ||
      a[i].name !== b[i].name ||
      a[i].platform !== b[i].platform ||
      a[i].online !== b[i].online
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 创建页设备切换器的数据源(含离线设备)。
 *
 * 读侧栏共用的设备目录(useDeviceLinkDeviceList):继承它的中继重连刷新、失败退避重试、
 * Device Link 停用时清空和乱序响应保护,各处挂载不再各自 listDevices。这里只投影创建页
 * 的准入语义(保留离线设备)。
 *
 * 返回值带 `loaded`:**空列表必须能区分「还没拉到」和「拉到了,确实一台都没有」**。
 * 唯一配对的对端被解除配对 / 关掉被控时列表会合法地变空,下游要靠这个标志把草稿里的
 * stale deviceId 收敛回本机 —— 否则 pill 因为没有设备而消失,草稿却还指着那台机器,
 * 用户在 UI 上再也切不回本机。反过来,首帧未就绪或 device-link 暂时不可用(抛错)时的空
 * 不能当权威,否则一次抖动就把用户刚选的设备抹掉。
 */
export function useSelectableDevices(): { devices: SelectableDevice[]; loaded: boolean } {
  const list = useDeviceLinkDeviceList();
  const request = useDeviceLinkDeviceListRequestState();
  const devices = useMemo(() => toSelectableDevices(list ?? []), [list]);
  // 读取失败时共享目录保留旧行但不是权威快照，不能据此清掉草稿里的设备；
  // Device Link 停用后清空则是权威的空。
  return { devices, loaded: request.status === 'ready' };
}

export function useControllableDevices(): ControllableDevice[] {
  const [devices, setDevices] = useState<ControllableDevice[]>([]);

  useEffect(() => {
    // 没有设备互联接口(测试、未挂 preload 的窗口)时当作没有可控设备。
    const deviceLink = (window as Partial<Window>).electronAPI?.deviceLink;
    if (!deviceLink) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const { devices: list } = await deviceLink.listDevices();
        if (cancelled) return;
        const next = toControllableDevices(list);
        // 内容无变化则保持旧引用,避免无谓重渲染。
        setDevices((prev) => (sameControllableList(prev, next) ? prev : next));
      } catch {
        // device-link 不可用 → 当作没有可控设备。
        if (!cancelled) setDevices((prev) => (prev.length === 0 ? prev : []));
      }
    };
    void refresh();
    const off = deviceLink.onPresenceChanged(() => {
      void refresh();
    });
    const offControlTarget = deviceLink.onControlTargetChanged(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
      offControlTarget();
    };
  }, []);

  return devices;
}
