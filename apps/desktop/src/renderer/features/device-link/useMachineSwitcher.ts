/**
 * useMachineSwitcher —— 机器切换栏的状态收口 hook(device-link 远程机器切换,多选)。
 * ---------------------------------------------------------------------------
 * 设备列表(含三态)由 buildSwitcherDevices 综合三份数据得出:
 *   - useDeviceLinkDeviceList() 全量设备(在线 / 被控开关 → 识别可控);
 *   - useRemoteDevices() 已同步设备(remoteProjectsStore → 识别「已连接」vs「连接中」);
 *   - revokedDevicesStore 被拒设备(→「被拒」)。
 *
 * 可选中集 = 已连接 + 连接中(被拒仅展示)。连接中设备**也可点击切换**——它在线可控,只是会话尚未
 * 同步完(选中后先空、同步完自然填充),不该因「列表没拉到」就不可点(这是 2026-06 的修复:之前把
 * 可点性错绑在会话镜像上,导致刚连上的机器看着正常却点不动)。
 *
 * 选择是**多选勾选集**(MACHINE_ALL | (MACHINE_LOCAL|deviceId)[]),跨重启持久化
 * (selectedMachineStore 落 localStorage)。**store 始终持有原始勾选集(raw),不做写时清理**:
 * 展示与过滤走读时归一化(useEffectiveSelectedMachineId)——勾选的设备掉线 / 被拒 / 消失时
 * 仅在展示层裁掉、裁空回落「所有」,raw 与持久化值保留完整勾选集,设备重连 / 重启后自动生效。
 * 归一化在全量设备列表尚未加载(null)时不裁剪:启动瞬间列表为空,裁剪会把持久化恢复的选择
 * 误判成「设备已消失」而清成「所有」——这正是「重启后恢复成全部」的坑。
 * toggle 同样基于 raw:点选只改「可见半」,暂时不可选的持久化设备原样保留
 * (toggleMachineSelection 内部拆分,防止一次无关点选把离线设备从落盘值里冲掉)。
 * 各 hook 共用 useSwitcherDevices(),读同一份共享设备列表,无重复拉取。
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  useRemoteBootstrapFailedDeviceIds,
  useRemoteDevices,
  type RemoteDeviceSummary,
} from './remoteProjectsStore';
import { revokedDevicesStore } from './revokedDevicesStore';
import {
  useDeviceLinkDeviceList,
  useDeviceLinkDeviceListSettled,
} from './useDeviceLinkDeviceList';
import { buildSwitcherDevices, selectableDeviceIds, type SwitcherDevice } from './switcherDevices';
import {
  MACHINE_ALL,
  MACHINE_LOCAL,
  normalizeSelectedMachineId,
  setSelectedMachineId,
  toggleMachineSelection,
  useSelectedMachineId,
  type MachineSelection,
} from './selectedMachineStore';

export interface SelectedMachineConnectingInput {
  rawSelection: MachineSelection;
  devices: readonly SwitcherDevice[];
  syncedDevices: readonly RemoteDeviceSummary[];
  bootstrapFailedDeviceIds: ReadonlySet<string>;
}

export interface RemoteSessionBootstrapLoadingInput {
  selectedMachineId: MachineSelection;
  deviceListSettled: boolean;
  devices: readonly SwitcherDevice[];
  syncedDevices: readonly RemoteDeviceSummary[];
  bootstrapFailedDeviceIds: ReadonlySet<string>;
}

/**
 * 当前机器作用域是否仍包含尚未完成首次 sessions snapshot 的远程设备。
 * syncedDevices 即使 sessionCount=0 也代表 bootstrap 已落过权威空快照；
 * connecting 且没有对应分片才是冷启动中的未知状态。
 */
export function shouldWaitForRemoteSessionBootstrap({
  selectedMachineId,
  deviceListSettled,
  devices,
  syncedDevices,
  bootstrapFailedDeviceIds,
}: RemoteSessionBootstrapLoadingInput): boolean {
  const selectedRemoteIds =
    selectedMachineId === MACHINE_ALL
      ? null
      : new Set(selectedMachineId.filter((id) => id !== MACHINE_LOCAL));
  if (selectedRemoteIds?.size === 0) return false;

  const syncedIds = new Set(syncedDevices.map((device) => device.deviceId));
  // 明确选择的远端设备若都已有权威 shard（包括 0 会话），设备目录的独立重试不应
  // 把已知作用域重新挡回 loading；「所有」仍必须等目录结算，才能知道完整远端集合。
  if (
    selectedRemoteIds !== null &&
    [...selectedRemoteIds].every((deviceId) => syncedIds.has(deviceId))
  ) {
    return false;
  }
  if (!deviceListSettled) return true;

  return devices.some(
    (device) =>
      device.status === 'connecting' &&
      !syncedIds.has(device.deviceId) &&
      !bootstrapFailedDeviceIds.has(device.deviceId) &&
      (selectedRemoteIds === null || selectedRemoteIds.has(device.deviceId)),
  );
}

/**
 * 只有「勾选集里全是连接中设备(不含本机)且没有任何缓存会话可显示」时才显示连接中占位。
 * 离线但已有 cached sessions 的设备仍会被 buildSwitcherDevices 标成 connecting
 * (chip 保持重连视觉),但侧边栏列表应该展示缓存会话,不能被 loading 占位盖掉;
 * 勾选里含本机 / 任一已连接设备时同理(有真实会话可展示)。
 */
export function shouldShowSelectedMachineConnectingPlaceholder({
  rawSelection,
  devices,
  syncedDevices,
  bootstrapFailedDeviceIds,
}: SelectedMachineConnectingInput): boolean {
  const effective = normalizeSelectedMachineId(rawSelection, selectableDeviceIds(devices));
  if (effective === MACHINE_ALL || effective.includes(MACHINE_LOCAL)) return false;
  for (const deviceId of effective) {
    const selectedDevice = devices.find((d) => d.deviceId === deviceId);
    if (selectedDevice?.status !== 'connecting') return false;
    if (bootstrapFailedDeviceIds.has(deviceId)) return false;
    const cachedSessionCount =
      syncedDevices.find((d) => d.deviceId === deviceId)?.sessionCount ?? 0;
    if (cachedSessionCount > 0) return false;
  }
  return true;
}

/** 三态设备列表(已连接 / 连接中 / 被拒,已排序)。综合共享设备列表 + 已同步集 + 被拒集。 */
export function useSwitcherDevices(): SwitcherDevice[] {
  const fullList = useDeviceLinkDeviceList();
  const synced = useRemoteDevices();
  const revoked = useSyncExternalStore(
    revokedDevicesStore.subscribe,
    revokedDevicesStore.getSnapshot,
  );
  return useMemo(
    () => buildSwitcherDevices({ fullList, syncedDevices: synced, revoked }),
    [fullList, synced, revoked],
  );
}

/**
 * 归一化可选中集:全量设备列表尚未加载(null)时返回 null(= 不裁剪,保留持久化恢复的选择,
 * 避免启动瞬间列表为空把选择误判成「设备已消失」)。
 */
function useSelectableIdsForNormalize(devices: readonly SwitcherDevice[]): readonly string[] | null {
  const loaded = useDeviceLinkDeviceList() !== null;
  return useMemo(() => (loaded ? selectableDeviceIds(devices) : null), [loaded, devices]);
}

/** 勾选的设备仍可选中(已连接 / 连接中)则保留,否则从勾选集裁掉(裁空回落「所有」)。供侧边栏合并点过滤用。 */
export function useEffectiveSelectedMachineId(): MachineSelection {
  const raw = useSelectedMachineId();
  const devices = useSwitcherDevices();
  const selectable = useSelectableIdsForNormalize(devices);
  return useMemo(() => normalizeSelectedMachineId(raw, selectable), [raw, selectable]);
}

/**
 * 当前选择是否只覆盖「连接中」(在线可控但会话尚未同步)的远程机器。
 * 侧边栏据此把空列表的「暂无对话」换成「连接中」提示(选了它们但还没拉到会话时)。
 */
export function useSelectedMachineConnecting(): boolean {
  const raw = useSelectedMachineId();
  const devices = useSwitcherDevices();
  const synced = useRemoteDevices();
  const bootstrapFailedDeviceIds = useRemoteBootstrapFailedDeviceIds();
  return shouldShowSelectedMachineConnectingPlaceholder({
    rawSelection: raw,
    devices,
    syncedDevices: synced,
    bootstrapFailedDeviceIds,
  });
}

/**
 * 当前可见列表是否还在等待 device-link 远程会话的首次 bootstrap。
 * 「所有」作用域包含本机与全部远程源，因此远端设备清单或任一相关首快照未落地时，
 * 侧栏继续显示加载态，避免本地 sessions 先完成后短暂误报真实空态。
 */
export function useRemoteSessionBootstrapLoading(
  selectedMachineId: MachineSelection,
): boolean {
  const deviceListSettled = useDeviceLinkDeviceListSettled();
  const devices = useSwitcherDevices();
  const synced = useRemoteDevices();
  const bootstrapFailedDeviceIds = useRemoteBootstrapFailedDeviceIds();
  return useMemo(
    () =>
      shouldWaitForRemoteSessionBootstrap({
        selectedMachineId,
        deviceListSettled,
        devices,
        syncedDevices: synced,
        bootstrapFailedDeviceIds,
      }),
    [selectedMachineId, deviceListSettled, devices, synced, bootstrapFailedDeviceIds],
  );
}

export interface MachineSwitcherState {
  /** 切换栏设备(已连接 / 连接中 / 被拒,已排序)。 */
  devices: SwitcherDevice[];
  /** 归一化后的选择(MACHINE_ALL 或勾选集:MACHINE_LOCAL / 可选中设备 deviceId)。 */
  selectedDeviceId: MachineSelection;
  /** 是否有 ≥1 台相关远程机器(切换栏是否应显示)。 */
  hasRemote: boolean;
  /** 直接设置选择(菜单「所有」项 / 深链回落用)。 */
  select: (next: MachineSelection) => void;
  /** 勾选 / 取消勾选一项(MACHINE_LOCAL / deviceId,多选交互)。 */
  toggle: (id: string) => void;
}

/** 机器切换栏组件用:三态设备列表 + 归一化选择(展示用)+ 切换动作(基于 raw)。 */
export function useMachineSwitcher(): MachineSwitcherState {
  const devices = useSwitcherDevices();
  const raw = useSelectedMachineId();
  const normalizeSelectable = useSelectableIdsForNormalize(devices);
  const effective = useMemo(
    () => normalizeSelectedMachineId(raw, normalizeSelectable),
    [raw, normalizeSelectable],
  );

  // toggle 基于 **raw**(不是 effective):暂时不可选的持久化设备要原样保留在勾选集里,
  // toggleMachineSelection 内部按可选集拆「可见半 / 隐藏半」,点选语义只作用于可见半。
  // 可选集用**当前展示的**设备(不做加载门控):设备列表未加载完时菜单里可见的设备来自
  // 同步缓存,以它们为准;若此时传空集会把「只勾本机」误收敛回「所有」。
  const toggleSelectable = useMemo(() => selectableDeviceIds(devices), [devices]);
  const toggle = useCallback(
    (id: string) => {
      setSelectedMachineId(toggleMachineSelection(raw, id, toggleSelectable));
    },
    [raw, toggleSelectable],
  );

  return {
    devices,
    selectedDeviceId: effective,
    hasRemote: devices.length > 0,
    select: setSelectedMachineId,
    toggle,
  };
}
