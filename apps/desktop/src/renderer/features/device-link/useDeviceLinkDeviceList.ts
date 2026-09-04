/**
 * useDeviceLinkDeviceList —— 机器切换栏用的「全量同账号设备」共享只读列表(push 驱动,失败低频退避)。
 * ---------------------------------------------------------------------------
 * 切换栏要区分「已连接 / 连接中 / 被拒」三态,需要 remoteProjectsStore(只含已同步设备)之外的
 * 全量设备(含在线未同步、离线、被拒)。这里做最小读:listDevices 初始拉取,之后靠 push 重拉；
 * 失败时按低频退避静默恢复 —— presence 变化、relay 重连 'online'、关「我控制它」
 * (control-target-changed,改 controlEnabled);relay 'stopped'(登出 / 停服)则清空缓存设备,
 * 避免登出后残留上一账号的远程机器。
 *
 * **模块级共享单例**:切换栏组件 + CCAgentSidebarUpper 的两个合并点都要读这份列表做归一化,若各挂
 * 一个 hook 就会有 3 次 listDevices + 3 套监听且可能短暂不一致。这里收成一份:首个订阅者触发启动,
 * 之后所有消费者共享同一快照(app 生命周期常驻,与 useDeviceLinkRemoteProjects 同口径:稳态靠 push,
 * 失败时仅按低频退避静默重试)。
 *
 * 故意不复用 useDeviceLinkSettings:那是设置页数据层,带 30s 轮询 + 一堆写操作回调,常驻侧边栏太重。
 */

import { useSyncExternalStore } from 'react';

let devices: DeviceLinkDeviceView[] | null = null;
const subs = new Set<() => void>();
let started = false;
const DEVICE_LIST_RETRY_BASE_MS = 2_000;
const DEVICE_LIST_RETRY_MAX_MS = 30_000;
export type DeviceLinkDeviceListStatus = 'loading' | 'ready' | 'error';
export interface DeviceLinkDeviceListRequestState {
  status: DeviceLinkDeviceListStatus;
  error: string | null;
}
let requestState: DeviceLinkDeviceListRequestState = { status: 'loading', error: null };
let refreshImpl: (() => void) | null = null;
/**
 * 设备目录是否已进入终态 —— 上层(shouldWaitForRemoteSessionBootstrap)据此决定还要不要等。
 * 两种终态:最新一次 listDevices 已 resolve / reject(见 setDevices / markRequestFailed),
 * 或 relay 已停(登出 / 本地模式,见 clearDevices)。false 必须意味着「还有结果会来」。
 */
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

/** 更新设备目录请求态但不通知，便于与列表快照合并成一次发布。 */
function setRequestState(status: DeviceLinkDeviceListStatus, error: string | null): boolean {
  if (requestState.status === status && requestState.error === error) return false;
  requestState = { status, error };
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isDeviceLinkDeviceView(value: unknown): value is DeviceLinkDeviceView {
  if (!isRecord(value)) return false;
  return (
    typeof value.deviceId === 'string' &&
    value.deviceId.length > 0 &&
    typeof value.name === 'string' &&
    isNullableString(value.platform) &&
    typeof value.online === 'boolean' &&
    typeof value.remoteControlEnabled === 'boolean' &&
    typeof value.controlEnabled === 'boolean' &&
    typeof value.isSelf === 'boolean'
  );
}

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

/** platform 在目录里可为 null、在 presence 里是字符串;比较前归一化,空值等价。 */
function normalizePlatform(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/**
 * 这条 presence 是否可能改变切换栏关心的字段 —— 不可能就别重拉整份目录(纯函数,可单测)。
 *
 * relay 把 presence-changed 广播给同账号所有连接、**含本机**(dispatch.ts 写明这是控制端崩溃 /
 * 拔网后回收僵尸订阅的兜底信号,刻意保留)。而本机每开始 / 跑完一轮任务都会翻转 busy 并上报,
 * 于是自己的 busy 绕一圈回来就触发一次全量 listDevices —— 开跑一次、跑完一次,纯浪费(issue #1726)。
 *
 * 判据与 `relevantEqual` 同源:只有切换栏真正消费的字段变化才值得重拉。`busy` / `lastSeenAt` /
 * `appVersion` / `deviceInfo` 虽然在 `DeviceLinkDeviceView` 里,但 `relevantEqual` 刻意不比较
 * 它们(「忽略 busy / lastSeenAt 等高频字段,避免无谓重渲染」)—— 既然它们变了也不会让快照替换,
 * 为它们重拉一整份目录就纯是浪费。
 *
 * 刻意**不**比较 `controlEnabled`:它由本地 opt-out 决定、不在 presence 里,其改动走
 * `control-target-changed` 事件的既有刷新路径。
 *
 * `isSelf` 直接跳过是安全的:`switcherDevices.ts` 明确「本机(isSelf)排除」,本机行的
 * online / remoteControlEnabled 不参与列表内容。
 */
export function shouldRefreshForPresence(
  current: readonly DeviceLinkDeviceView[] | null,
  snap: DeviceLinkPresenceSnapshot,
  requestStatus: DeviceLinkDeviceListStatus,
): boolean {
  // 上一次拉取失败(且此前已有快照 → `devices` 仍非空、状态停在 'error')时**一律放行**:
  // 自动退避之外,这条 push 信号也是低延迟恢复机会;若此时还按「字段没变」把 presence 滤掉,
  // 一次瞬时 REST 失败就会把侧栏钉在错误 / 陈旧目录上,直到下一次退避、status 或
  // control-target 事件 (review: codex P1)。
  //
  // 'loading' 不放行:那说明已有一笔在飞,`loadGeneration` 会让后到的结果胜出,再叠一次
  // refresh 只是徒增请求;它若失败会落到 'error',下一条 presence 自然接管重试。
  if (requestStatus === 'error') return true;
  // 还没有首份目录 → 照常拉(这条 presence 可能正是「终于连上了」的信号)。
  if (current === null) return true;
  const row = current.find((d) => d.deviceId === snap.deviceId);
  // 目录里没有这台设备 → 它是新出现的,必须重拉才能进列表。
  if (row === undefined) return true;
  // 自 presence 自回声:本机不进切换栏,重拉不会改变任何可见内容。
  if (row.isSelf) return false;
  return (
    row.online !== snap.online ||
    row.remoteControlEnabled !== snap.remoteControlEnabled ||
    normalizePlatform(row.platform) !== normalizePlatform(snap.platform) ||
    row.name.trim() !== snap.deviceName.trim()
  );
}

/** 设备目录静默恢复的退避:持续恢复,但长期故障时不每 2 秒打一次 IPC。 */
export function nextDeviceListRetryDelay(previousMs: number): number {
  if (!Number.isFinite(previousMs) || previousMs < DEVICE_LIST_RETRY_BASE_MS) {
    return DEVICE_LIST_RETRY_BASE_MS;
  }
  return Math.min(previousMs * 2, DEVICE_LIST_RETRY_MAX_MS);
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
  const requestChanged = setRequestState('ready', null);
  if (!devicesChanged && !settledChanged && !requestChanged) return;
  devices = sorted;
  initialRequestSettled = true;
  subs.forEach((fn) => fn());
}

/**
 * 清空缓存设备(null → 切换栏隐藏)。登出 / relay 停止时调用。
 *
 * `initialRequestSettled` **置 true**:link 已停 = 此刻确定没有可用的远端设备目录,而且在途
 * 请求刚被 loadGeneration 作废、不会再有结果落地 —— 这与 refresh 失败兜底同一个终态
 * (devices=null + settled=true)。若像早先那样置回 false,登出后进入本地模式 / 保持未登录
 * 就再也收不到 relay 'online' 来重新结算,shouldWaitForRemoteSessionBootstrap 恒为 true,
 * 侧栏「对话」分区卡在「加载中…」直到冷重启(#797)。
 * 重新登录不受影响:relay 'online' → refresh() 会因 `devices === null && initialRequestSettled`
 * 主动退回 loading,远程设备首快照的等待行为保持原样。
 */
function clearDevices(): void {
  loadGeneration += 1; // 作废所有在途 listDevices 响应(见 loadGeneration 注释)。
  const requestChanged = setRequestState('ready', null);
  const changed = devices !== null || !initialRequestSettled || requestChanged;
  if (!changed) return;
  devices = null;
  initialRequestSettled = true;
  subs.forEach((fn) => fn());
}

function markRequestFailed(error: unknown): void {
  const requestChanged = setRequestState(
    'error',
    error instanceof Error ? error.message : String(error),
  );
  if (initialRequestSettled && !requestChanged) return;
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
  let linkStatus: 'stopped' | 'connecting' | 'online' | null = null;
  let linkStatusRevision = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = 0;
  let backgroundRetryGeneration: number | null = null;
  let backgroundRetryRefreshPending = false;
  let backgroundRetryReplayActive = false;

  const finishRefresh = (gen: number, background: boolean): void => {
    // A foreground refresh can supersede a background retry. In that case the old
    // retry must not consume a presence queued for the newer operation; the
    // current operation will replay it when it settles.
    if (background) {
      if (backgroundRetryGeneration !== gen) return;
      backgroundRetryGeneration = null;
    }
    if (gen !== loadGeneration) return;
    const shouldRefresh = backgroundRetryRefreshPending && linkStatus !== 'stopped';
    backgroundRetryRefreshPending = false;
    backgroundRetryReplayActive = false;
    if (shouldRefresh) refresh(false, true);
  };

  const clearRetryTimer = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleRetry = (): void => {
    if (retryTimer !== null || linkStatus === 'stopped') return;
    retryDelayMs = nextDeviceListRetryDelay(retryDelayMs);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      // 后台恢复不能把已结算的目录重新打回 initialRequestSettled=false；否则持久化的
      // 远端选择会在每次退避尝试时暂时恢复、遮住本地侧栏。请求仍在飞，但选择/加载态保持稳定。
      refresh(false, true);
    }, retryDelayMs);
  };

  const enterLoading = (): void => {
    // 上一轮在尚无设备快照时失败只代表「该次请求已结算」。新的有效拉取开始后要重新
    // 进入 loading，直到本轮成功或失败；已有快照则保留，requestState 单独表达正在刷新。
    const settledChanged = devices === null && initialRequestSettled;
    if (settledChanged) initialRequestSettled = false;
    const requestChanged = setRequestState('loading', null);
    if (settledChanged || requestChanged) subs.forEach((fn) => fn());
  };

  const runRefresh = async (probeState: boolean, background = false): Promise<void> => {
    // getState 与 listDevices 共用同一个 operation generation。stop、状态 push、手动重试或
    // 更晚的 refresh 都会令旧操作失效，迟到的状态快照和目录快照都不得落地。
    loadGeneration += 1;
    const gen = loadGeneration;
    const statusRevisionAtStart = linkStatusRevision;
    if (background) backgroundRetryGeneration = gen;
    if (!background) {
      // The foreground operation owns the current generation now; any pending
      // presence from a superseded background retry must be replayed after it.
      if (backgroundRetryGeneration !== null) backgroundRetryReplayActive = true;
      backgroundRetryGeneration = null;
      enterLoading();
    }

    if (probeState || linkStatus === null) {
      try {
        const state = await window.electronAPI.deviceLink.getState();
        if (gen !== loadGeneration || statusRevisionAtStart !== linkStatusRevision) {
          finishRefresh(gen, background);
          return;
        }
        linkStatus = state.linkStatus;
      } catch {
        if (gen !== loadGeneration || statusRevisionAtStart !== linkStatusRevision) {
          finishRefresh(gen, background);
          return;
        }
        // getState 本身失败时保留既有 status 判断；未知 / 在线态仍尝试目录请求，让真正的
        // listDevices 结果决定 ready/error。已知 stopped 则不能误打成远程连接失败。
      }
    }

    // 未登录 / 本地模式 / Device Link 停服不是「远程目录读取失败」：此刻远端能力
    // 不在产品作用域内，目录应结算为 ready + null。手动重试也不能把 stopped 重新
    // 打成 error；只有 online / connecting 下真实发出的 listDevices 失败才是连接错误。
    if (linkStatus === 'stopped') {
      clearDevices();
      finishRefresh(gen, background);
      return;
    }

    try {
      const result = await window.electronAPI.deviceLink.listDevices();
      // 期间发生过清空(stop / 登出)或更晚的 refresh → 本次响应已陈旧,丢弃。
      if (gen !== loadGeneration) {
        finishRefresh(gen, background);
        return;
      }
      const list = result?.devices;
      if (!Array.isArray(list) || !list.every(isDeviceLinkDeviceView)) {
        throw new Error('Invalid device list response');
      }
      clearRetryTimer();
      retryDelayMs = 0;
      setDevices(list);
    } catch (error) {
      // 只有最新请求的失败才算本轮首拉已经结算；更晚的 refresh 仍在途时继续等待它。
      if (gen !== loadGeneration) {
        finishRefresh(gen, background);
        return;
      }
      markRequestFailed(error);
      // 瞬态拉取失败(relay 重连中等)保持当前快照;登出 / relay 停止由下面的 'stopped'
      // 状态事件显式清空,不靠这里的失败兜底(避免一次网络抖动就清掉、闪烁)。但把请求
      // 标成已结算，避免远端 sidebar bootstrap 因 devices 仍为 null 永久显示加载态。
      scheduleRetry();
    }
    finishRefresh(gen, background);
  };

  const refresh = (probeState = false, background = false): void => {
    clearRetryTimer();
    void runRefresh(probeState, background);
  };
  refreshImpl = () => refresh(true);
  // app 生命周期常驻(侧边栏始终有订阅者),不解绑监听。
  // 只有相关 presence 才重拉目录(见 shouldRefreshForPresence):本机 busy 自回声与对端的
  // busy / lastSeenAt 心跳都不改变切换栏内容,却各触发一次全量 listDevices(issue #1726)。
  window.electronAPI.deviceLink.onPresenceChanged((snap) => {
    // 后台退避请求在飞时保留 error/settled 快照；不要让 presence 噪音把它升级成前台
    // refresh，再次触发 loading 并恢复悬空的持久化远端选择。
    if (backgroundRetryGeneration !== null || backgroundRetryReplayActive) {
      // 不能丢掉真实的上线 / 改名 / 能力变化:本次 REST 响应可能早于 presence,结束后
      // 追加一次后台 refresh；同一请求期间的多条 presence 合并成一次。这里按 ready
      // 语义判断字段变化，避免 error 快速路径把本机 busy / lastSeenAt 噪音也排进补拉；
      // devices=null 时仍会放行，因为这时无法从快照判断设备是否新出现。
      if (shouldRefreshForPresence(devices, snap, 'ready')) backgroundRetryRefreshPending = true;
      return;
    }
    // A failed request may already have a backoff timer waiting. Treat presence
    // as a settled snapshot in that window so busy/lastSeen heartbeats do not
    // cancel the backoff and reopen the foreground loading state. Relevant
    // presence can still recover promptly, but stays in the background path.
    const retryPending = retryTimer !== null;
    // Without a directory snapshot there is no safe way to distinguish a new
    // device from this machine's heartbeat. Keep the scheduled backoff as the
    // recovery source instead of letting every presence cancel it.
    if (retryPending && devices === null) return;
    if (!shouldRefreshForPresence(devices, snap, retryPending ? 'ready' : requestState.status))
      return;
    refresh(false, retryPending);
  });
  window.electronAPI.deviceLink.onStatusChanged((p) => {
    linkStatusRevision += 1;
    linkStatus = p.status;
    if (p.status === 'stopped') {
      // 登出 / relay 停止:清掉缓存设备。否则登出后(或同进程换账号)上一账号的远程机器会
      // 一直留在切换栏里被当成可选 / 连接中(listDevices 此时多半失败,catch 又保留旧快照)。
      // 重新登录 → relay 重连到 'online' 时下面重新拉取。
      clearRetryTimer();
      retryDelayMs = 0;
      clearDevices();
      backgroundRetryGeneration = null;
      backgroundRetryRefreshPending = false;
      backgroundRetryReplayActive = false;
      return;
    }
    // online / connecting 都是远端目录仍在作用域内的状态：开始新一轮读取。connecting 下
    // 若 REST 仍可达可直接拿到目录；不可达则明确落 error，而不是误装成空列表。
    refresh();
  });
  // 关掉「我控制它」(本地 opt-out)只广播 control-target-changed、不发 presence;listDevices 的
  // controlEnabled 已据 disabledControlDeviceIds 计算,故重拉即可让被 opt-out 的设备立刻退出切换栏。
  window.electronAPI.deviceLink.onControlTargetChanged(() => refresh());

  // 监听必须先挂，再读初值：否则 hook 挂载前 relay 已 stopped，或 getState 在 push 后迟到，
  // 都可能把本地/未登录态误报成 listDevices 失败。revision + generation 保证 push 永远胜出。
  refresh(true);
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

/** 首次设备清单请求是否已结算；失败也算结算，后续退避 / push / online 事件仍会继续 refresh。 */
export function useDeviceLinkDeviceListSettled(): boolean {
  return useSyncExternalStore(subscribe, getInitialRequestSettledSnapshot);
}

function getRequestStateSnapshot(): DeviceLinkDeviceListRequestState {
  return requestState;
}

/** 设备目录的 loading / ready / error 状态；只有 ready + [] 才是权威空目录。 */
export function useDeviceLinkDeviceListRequestState(): DeviceLinkDeviceListRequestState {
  return useSyncExternalStore(subscribe, getRequestStateSnapshot);
}

/** 兼容现有调用方的显式重试入口；正常失败恢复由上面的静默退避自动完成。 */
export function retryDeviceLinkDeviceList(): void {
  if (!started) {
    ensureStarted();
    return;
  }
  refreshImpl?.();
}
