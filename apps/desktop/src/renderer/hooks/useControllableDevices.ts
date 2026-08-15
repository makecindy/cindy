/**
 * useControllableDevices —— 当前可作为「远程项目」目标的同账号被控设备(轻量版)。
 *
 * 与 useDeviceLinkSettings(被控开关 / controlledBy / 轮询 / getState 全套)不同,这里只
 * 拉设备列表 + 订阅 presence / 本地控制偏好,筛出**可控目标**:
 * `online && remoteControlEnabled && controlEnabled && !isSelf && !isMobilePlatform(platform)`。
 * 供「添加远程项目」弹窗的设备下拉 + 入口 gate(useHasAnyRemoteTarget)共用,避免在首页
 * 常驻时背上整套设置页的订阅开销。device-link 不可用(未登录 / relay 断)→ 静默空列表。
 */

import { useEffect, useRef, useState } from 'react';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';

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
  return (
    d.online &&
    d.remoteControlEnabled &&
    d.controlEnabled &&
    !d.isSelf &&
    !isMobilePlatform(d.platform)
  );
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
  if (d.isSelf || !d.controlEnabled || isMobilePlatform(d.platform)) return false;
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
 * 故意不与 useControllableDevices 共用订阅:那个 hook 服务「添加远程项目」弹窗与入口 gate,
 * 语义是「现在就能建远程项目的目标」(必须在线),行为不能动。两者同页挂载会各自订阅一次
 * presence —— 代价是一次 listDevices + 一个监听,换来两套语义互不干扰。
 *
 * 返回值带 `loaded`:**空列表必须能区分「还没拉到」和「拉到了,确实一台都没有」**。
 * 唯一配对的对端被解除配对 / 关掉被控时列表会合法地变空,下游要靠这个标志把草稿里的
 * stale deviceId 收敛回本机 —— 否则 pill 因为没有设备而消失,草稿却还指着那台机器,
 * 用户在 UI 上再也切不回本机。反过来,首帧未就绪或 device-link 暂时不可用(抛错)时的空
 * 不能当权威,否则一次抖动就把用户刚选的设备抹掉。
 */
export function useSelectableDevices(): { devices: SelectableDevice[]; loaded: boolean } {
  const [devices, setDevices] = useState<SelectableDevice[]>([]);
  const [loaded, setLoaded] = useState(false);
  /**
   * 请求序号:首次加载与两个监听(presence / control-target)都会并发调 refresh,而 REST 响应可能
   * 乱序返回。没有它,一个更早的 listDevices 晚到就会把新的权威快照覆盖掉 —— 设备刚被解除配对
   * 或撤销控制时,那份过期响应会把它连同 loaded=true 一起写回来,于是失效回落认为目标仍有效、
   * picker 也允许再次选中它,直到下一次事件才纠正。同 useDeviceLinkProjects 的做法。
   */
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      try {
        const { devices: list } = await window.electronAPI.deviceLink.listDevices();
        if (cancelled || requestIdRef.current !== requestId) return;
        const next = toSelectableDevices(list);
        setDevices((prev) => (sameSelectableList(prev, next) ? prev : next));
        // 成功拿到快照 —— 哪怕是空的,也是权威的空。
        setLoaded(true);
      } catch {
        // device-link 暂时不可用(未登录 / relay 断)。
        //
        // **保留上次已知的设备行**,只把 loaded 置回 false。清空会造成一个死角:选了远程设备后
        // 一次瞬时失败就让 DeviceSwitcherPill 因为没有设备而返回 null,而失效回落 effect 又
        // (正确地)因为这个空不权威而不动草稿 —— 于是草稿仍指着那台设备,UI 上却没有任何控件能
        // 切回本机,直到下一次成功刷新。保留旧行的代价只是它们可能已过期(在线状态尤其),
        // 而 loaded=false 已经如实表达了「这份快照不权威」。
        if (cancelled || requestIdRef.current !== requestId) return;
        setLoaded(false);
      }
    };
    void refresh();
    const off = window.electronAPI.deviceLink.onPresenceChanged(() => {
      void refresh();
    });
    const offControlTarget = window.electronAPI.deviceLink.onControlTargetChanged(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
      offControlTarget();
    };
  }, []);

  return { devices, loaded };
}

export function useControllableDevices(): ControllableDevice[] {
  const [devices, setDevices] = useState<ControllableDevice[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const { devices: list } = await window.electronAPI.deviceLink.listDevices();
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
    const off = window.electronAPI.deviceLink.onPresenceChanged(() => {
      void refresh();
    });
    const offControlTarget = window.electronAPI.deviceLink.onControlTargetChanged(() => {
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
