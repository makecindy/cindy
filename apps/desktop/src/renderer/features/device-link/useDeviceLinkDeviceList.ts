/**
 * useDeviceLinkDeviceList —— 机器切换栏用的「全量同账号设备」共享只读列表(push 驱动,无轮询)。
 * ---------------------------------------------------------------------------
 * 切换栏要区分「已连接 / 连接中 / 被拒」三态,需要 remoteProjectsStore(只含已同步设备)之外的
 * 全量设备(含在线未同步、离线、被拒)。这里做最小读:listDevices 拉一次,之后靠 push 重拉 ——
 * presence 变化、relay 重连 'online'、关「我控制它」(control-target-changed,改 controlEnabled);
 * relay 'stopped'(登出 / 停服)则清空缓存设备,避免登出后残留上一账号的远程机器。
 *
 * **模块级共享单例**:切换栏组件 + CCAgentSidebarUpper 的两个合并点都要读这份列表做归一化,若各挂
 * 一个 hook 就会有 3 次 listDevices + 3 套监听且可能短暂不一致。这里收成一份:首个订阅者触发启动,
 * 之后所有消费者共享同一快照(app 生命周期常驻,与 useDeviceLinkRemoteProjects 同口径:稳态靠 push,
 * 不轮询)。
 *
 * 故意不复用 useDeviceLinkSettings:那是设置页数据层,带 30s 轮询 + 一堆写操作回调,常驻侧边栏太重。
 */

import { useSyncExternalStore } from 'react';

let devices: DeviceLinkDeviceView[] | null = null;
const subs = new Set<() => void>();
let started = false;
/** 当前账号 / relay 生命周期内，至少一次最新的 listDevices 请求已经 resolve 或 reject。 */
let initialRequestSettled = false;
/**
 * 加载代次:**每次 refresh 发起**与**每次清空(登出 / relay stop)**都自增,作废所有更早的在途
 * listDevices 响应 —— 只有"最新一次操作"的响应能落地(同 remoteProjectsStore 的 snapshotEpoch 思路)。
 * 解决两类乱序:
 *  - stop / 登出后,早发的 listDevices 晚到 → 不得回填上个账号 / 旧 server 快照;
 *  - 同期并发的两次 refresh(如 presence 与 control-target 接连触发)乱序 resolve → 较早那次
 *    (可能还带着已 opt-out 的设备)不得盖掉较新一次的结果。
 * refresh 发起前自增并抓代次,resolve 时代次变了就丢弃。
 */
let loadGeneration = 0;

/** 仅比较切换栏关心的字段(忽略 busy / lastSeenAt 等高频字段,避免无谓重渲染)。 */
function relevantEqual(a: DeviceLinkDeviceView[] | null, b: DeviceLinkDeviceView[]): boolean {
  if (a === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.deviceId !== y.deviceId ||
      x.name !== y.name ||
      // platform 决定移动端过滤(buildSwitcherDevices 用 isMobilePlatform):若首次上报 null
      // 后变 'ios',不比较 platform 会让快照不刷新、该手机继续留在切换栏。
      x.platform !== y.platform ||
      x.online !== y.online ||
      x.remoteControlEnabled !== y.remoteControlEnabled ||
      x.controlEnabled !== y.controlEnabled ||
      x.isSelf !== y.isSelf
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 就地改名(纯函数,可单测):返回把 `deviceId` 的 name 改成 `name`(trim 后)的新数组;
 * 无需改动(空名 / null 列表 / 设备不在列表 / 名字未变)时**返回原引用**,调用方可用 `===` 判定 no-op。
 */
export function applyDeviceRename(
  list: readonly DeviceLinkDeviceView[] | null,
  deviceId: string,
  name: string,
): readonly DeviceLinkDeviceView[] | null {
  const trimmed = name.trim();
  if (!trimmed || list === null) return list;
  const idx = list.findIndex((d) => d.deviceId === deviceId);
  if (idx < 0 || list[idx].name === trimmed) return list;
  const next = list.slice();
  next[idx] = { ...next[idx], name: trimmed };
  return next;
}

function setDevices(next: DeviceLinkDeviceView[]): void {
  // 按 deviceId 稳定排序,避免服务端返回顺序抖动触发无谓重渲染。
  const sorted = [...next].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  const devicesChanged = !relevantEqual(devices, sorted);
  const settledChanged = !initialRequestSettled;
  if (!devicesChanged && !settledChanged) return;
  devices = sorted;
  initialRequestSettled = true;
  subs.forEach((fn) => fn());
}

/** 清空缓存设备,回到「未加载」态(null → 切换栏隐藏)。登出 / relay 停止时调用。 */
function clearDevices(): void {
  loadGeneration += 1; // 作废所有在途 listDevices 响应(见 loadGeneration 注释)。
  const changed = devices !== null || initialRequestSettled;
  if (!changed) return;
  devices = null;
  initialRequestSettled = false;
  subs.forEach((fn) => fn());
}

function markInitialRequestSettled(): void {
  if (initialRequestSettled) return;
  initialRequestSettled = true;
  subs.forEach((fn) => fn());
}

/**
 * 设备改名传播:REST 改名只持久化 + 更新 remoteProjectsStore(已同步设备),**不**广播
 * presence / status,故本「全量设备」单例不会自动重拉 —— 连接中 / 被拒(无同步分片)的设备其切换栏
 * chip 名取自这里的缓存 `fullList`,会一直停在旧名,直到下一次无关的 presence / status / control-target
 * 事件触发 refresh。这里就地改名 + 通知,使 chip 即时刷新,与 remoteProjectsStore.renameDevice 同口径
 * (二者都在 useDeviceLinkSettings.rename 成功后调用)。设备未在缓存(null / 不含该 id)→ no-op,
 * 下次 refresh 会从 REST 拿到新名。
 */
export function renameDeviceLinkDevice(deviceId: string, name: string): void {
  const next = applyDeviceRename(devices, deviceId, name);
  if (next === devices) return; // 引用未变 = 无需改动
  devices = next as DeviceLinkDeviceView[];
  subs.forEach((fn) => fn());
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  const refresh = (): void => {
    // 上一轮在尚无设备快照时失败只代表「该次请求已结算」。online / push 触发了新的
    // 有意义重试后要重新进入 loading，直到这次请求成功或失败；否则失败后重连期间会
    // 把 devices=null + settled=true 误当成权威空列表。
    if (devices === null && initialRequestSettled) {
      initialRequestSettled = false;
      subs.forEach((fn) => fn());
    }
    loadGeneration += 1; // 本次为最新一次拉取,作废所有更早的在途响应(见 loadGeneration 注释)。
    const gen = loadGeneration;
    window.electronAPI.deviceLink
      .listDevices()
      .then(({ devices: list }) => {
        // 期间发生过清空(stop / 登出)或更晚的 refresh → 本次响应已陈旧,丢弃。
        if (gen !== loadGeneration) return;
        setDevices(list);
      })
      .catch(() => {
        // 只有最新请求的失败才算本轮首拉已经结算；更晚的 refresh 仍在途时继续等待它。
        if (gen !== loadGeneration) return;
        markInitialRequestSettled();
        // 瞬态拉取失败(relay 重连中等)保持当前快照;登出 / relay 停止由下面的 'stopped'
        // 状态事件显式清空,不靠这里的失败兜底(避免一次网络抖动就清掉、闪烁)。但把请求
        // 标成已结算，避免远端 sidebar bootstrap 因 devices 仍为 null 永久显示加载态。
      });
  };
  refresh();
  // app 生命周期常驻(侧边栏始终有订阅者),不解绑监听。
  window.electronAPI.deviceLink.onPresenceChanged(() => refresh());
  window.electronAPI.deviceLink.onStatusChanged((p) => {
    if (p.status === 'stopped') {
      // 登出 / relay 停止:清掉缓存设备。否则登出后(或同进程换账号)上一账号的远程机器会
      // 一直留在切换栏里被当成可选 / 连接中(listDevices 此时多半失败,catch 又保留旧快照)。
      // 重新登录 → relay 重连到 'online' 时下面重新拉取。
      clearDevices();
      return;
    }
    // 'online' 重连成功 → 重拉;'connecting' 瞬态保持当前快照(remoteProjectsStore 标记断线,chip 转「连接中」)。
    if (p.status === 'online') refresh();
  });
  // 关掉「我控制它」(本地 opt-out)只广播 control-target-changed、不发 presence;listDevices 的
  // controlEnabled 已据 disabledControlDeviceIds 计算,故重拉即可让被 opt-out 的设备立刻退出切换栏。
  window.electronAPI.deviceLink.onControlTargetChanged(() => refresh());
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  ensureStarted();
  return () => {
    subs.delete(fn);
  };
}

function getSnapshot(): DeviceLinkDeviceView[] | null {
  return devices;
}

/** 订阅全量设备列表(共享单例);null = 尚未加载。 */
export function useDeviceLinkDeviceList(): DeviceLinkDeviceView[] | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

function getInitialRequestSettledSnapshot(): boolean {
  return initialRequestSettled;
}

/** 首次设备清单请求是否已结算；失败也算结算，后续 push / online 事件仍会继续 refresh。 */
export function useDeviceLinkDeviceListSettled(): boolean {
  return useSyncExternalStore(subscribe, getInitialRequestSettledSnapshot);
}
