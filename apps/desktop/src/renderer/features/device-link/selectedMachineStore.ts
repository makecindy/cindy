/**
 * selectedMachineStore —— 控制端「机器切换栏」当前选择态(device-link 远程机器切换)。
 * ---------------------------------------------------------------------------
 * 选择态(多选,默认「所有」):
 *   - MACHINE_ALL ('all')          → 所有:本机 + 所有已连接远程机器的会话(默认视图);
 *   - string[](非空,规范序)      → 勾选集:元素为 MACHINE_LOCAL('local') 和/或 <deviceId>。
 *
 * deviceId 是服务端下发的 UUID,不会与 'all' / 'local' 这两个 sentinel 撞值。
 *
 * 设计同 remoteProjectsStore:模块级 vanilla store + useSyncExternalStore。
 * 选择按 Cindy data owner 隔离并跨重启持久化到 localStorage
 * (与侧边栏折叠态 useCollapsedProjects 同模式)。
 * store 只存**原始勾选集**(raw),不做「设备掉线就裁剪」的写时清理——临时离线的设备
 * 必须留在勾选集里(重启 / 重连后自动生效),展示与过滤由消费侧(useMachineSwitcher)
 * 读时归一化(normalizeSelectedMachineId)按当前可选集回落。
 */

import { useSyncExternalStore } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';

/** 「所有」:本机 + 全部已连接远程机器(默认)。 */
export const MACHINE_ALL = 'all';
/** 「本机」:勾选集里代表本地会话的 sentinel 条目。 */
export const MACHINE_LOCAL = 'local';

/** 切换栏选择值:MACHINE_ALL | 非空勾选集(MACHINE_LOCAL / <deviceId>,规范序)。 */
export type MachineSelection = typeof MACHINE_ALL | readonly string[];

/** owner-scoped localStorage base key(选择态持久化;JSON: "all" 或 string[])。 */
const STORAGE_KEY = 'cc-agent.sidebar.selectedMachines';

/** 勾选集规范化:去重 + 稳定排序(本机在前,设备按 id 字典序),保证同集合同引用语义可比。 */
export function canonicalizeMachineEntries(entries: readonly string[]): string[] {
  const set = new Set(entries);
  const hasLocal = set.delete(MACHINE_LOCAL);
  const ids = [...set].sort((a, b) => a.localeCompare(b));
  return hasLocal ? [MACHINE_LOCAL, ...ids] : ids;
}

/** 选择相等(MACHINE_ALL 或规范序勾选集逐项比较)。 */
export function machineSelectionEquals(a: MachineSelection, b: MachineSelection): boolean {
  if (a === MACHINE_ALL || b === MACHINE_ALL) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 勾选集是否包含某条目(MACHINE_ALL 视为不显式包含任何单项,菜单里只勾「所有」)。 */
export function isMachineSelected(selection: MachineSelection, id: string): boolean {
  return selection !== MACHINE_ALL && selection.includes(id);
}

/** 序列化(持久化用,纯函数可单测)。 */
export function serializeMachineSelection(selection: MachineSelection): string {
  return JSON.stringify(selection);
}

/**
 * 反序列化:任何异常 / 非法形状(空数组、非字符串元素)→ 回落 MACHINE_ALL。
 * 数组里的 `'all'` sentinel 条目会被剔除(脏数据防御:它不是 deviceId,混进勾选集会让
 * 「所有」菜单项凭 includes 误判为勾选),剔空后回落 MACHINE_ALL。
 */
export function parseMachineSelection(raw: string | null): MachineSelection {
  if (!raw) return MACHINE_ALL;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === MACHINE_ALL) return MACHINE_ALL;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((v): v is string => typeof v === 'string' && v.length > 0)
    ) {
      const canonical = canonicalizeMachineEntries(parsed.filter((v) => v !== MACHINE_ALL));
      return canonical.length > 0 ? canonical : MACHINE_ALL;
    }
  } catch {
    // 损坏数据 → 回落默认
  }
  return MACHINE_ALL;
}

function loadPersistedSelection(ownerId: string | null): MachineSelection {
  return parseMachineSelection(readSidebarOwnerStorage(STORAGE_KEY, ownerId));
}

function persistSelection(selection: MachineSelection): void {
  writeSidebarOwnerStorage(STORAGE_KEY, activeOwnerId, serializeMachineSelection(selection));
}

let activeOwnerId: string | null = null;
let currentSelection: MachineSelection = MACHINE_ALL;
const subs = new Set<() => void>();

function emit(): void {
  subs.forEach((fn) => fn());
}

function commit(next: MachineSelection): boolean {
  if (machineSelectionEquals(currentSelection, next)) return false;
  currentSelection = next === MACHINE_ALL ? MACHINE_ALL : canonicalizeMachineEntries(next);
  emit();
  return true;
}

/** Rebind the module singleton before owner-scoped routes render. */
export function setSelectedMachineOwner(ownerId: string | null): void {
  if (activeOwnerId === ownerId) return;
  activeOwnerId = ownerId;
  const next = loadPersistedSelection(ownerId);
  if (machineSelectionEquals(currentSelection, next)) return;
  currentSelection = next;
  emit();
}

/** 当前选择(默认 MACHINE_ALL)。 */
export function getSelectedMachineId(): MachineSelection {
  return currentSelection;
}

/** 用户显式切换选择:更新 + 落盘。值未变时不通知,避免无谓重渲染。 */
export function setSelectedMachineId(next: MachineSelection): void {
  if (!activeOwnerId) return;
  if (commit(next)) persistSelection(currentSelection);
}

/**
 * 会话内临时覆写:只改内存**不落盘**。供「深链越过机器过滤」这类系统性回落使用——
 * 它不是用户对勾选集的表态,不能把用户持久化的多选集永久冲掉(重启后仍恢复原勾选;
 * 用户此后若显式点选,才以新选择落盘)。
 */
export function setSelectedMachineIdTransient(next: MachineSelection): void {
  commit(next);
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** 组件内订阅当前选择(原始值,未按设备在线情况归一化)。 */
export function useSelectedMachineId(): MachineSelection {
  return useSyncExternalStore(subscribe, getSelectedMachineId);
}

/**
 * 点选一项(菜单多选交互,纯函数,供 useMachineSwitcher 调用 + 单测)。
 * `current` 传**原始选择**(raw,未归一化),函数内部按可选集拆成两半:
 *  - 可见半(本机 + 可选集内的设备,= 菜单里勾选可见的部分)承接点选语义:
 *    「所有」→ 收窄为只看该项;已勾选 → 取消;未勾选 → 追加;
 *    可见半清空 → 回落「所有」;可见半勾满「本机 + 全部可选设备」→ 收敛回「所有」
 *    (语义等价,且未来新上线的设备自动包含在内);
 *  - 隐藏半(勾选集中暂时不可选的设备:离线 / 尚未加载)**原样保留**——
 *    持久化恢复的离线设备不能因为一次无关点选就被永久冲掉,等它上线自动生效;
 *    仅当结果收敛回「所有」时一并放下(「所有」本就覆盖它们)。
 */
export function toggleMachineSelection(
  current: MachineSelection,
  id: string,
  selectableIds: readonly string[],
): MachineSelection {
  const universe = new Set([MACHINE_LOCAL, ...selectableIds]);
  const visible = current === MACHINE_ALL ? null : current.filter((e) => universe.has(e));
  const hidden = current === MACHINE_ALL ? [] : current.filter((e) => !universe.has(e));
  let entries: string[];
  if (visible === null) {
    entries = [id];
  } else if (visible.includes(id)) {
    entries = visible.filter((e) => e !== id);
  } else {
    entries = [...visible, id];
  }
  if (entries.length === 0) return MACHINE_ALL;
  const set = new Set(entries);
  if ([...universe].every((u) => set.has(u))) return MACHINE_ALL;
  return canonicalizeMachineEntries([...entries, ...hidden]);
}

/**
 * 选择归一化(纯函数,供 useMachineSwitcher 调用 + 单测):
 *  - MACHINE_ALL 恒有效;
 *  - availableDeviceIds 为 null(全量设备列表尚未加载)→ 原样保留,不裁剪 ——
 *    启动瞬间列表为空,此时裁剪会把持久化恢复的选择误清成「所有」;
 *  - 勾选集裁掉已不可选的设备(掉线 / 被拒 / 消失),MACHINE_LOCAL 恒有效;
 *    裁空 → 回落「所有」;无变化 → 返回原引用(消费侧 useMemo 依赖引用稳定)。
 */
export function normalizeSelectedMachineId(
  raw: MachineSelection,
  availableDeviceIds: readonly string[] | null,
): MachineSelection {
  if (raw === MACHINE_ALL || availableDeviceIds === null) return raw;
  const kept = raw.filter((e) => e === MACHINE_LOCAL || availableDeviceIds.includes(e));
  if (kept.length === raw.length) return raw;
  return kept.length > 0 ? kept : MACHINE_ALL;
}

/**
 * 按当前选择过滤出侧边栏应展示的会话(纯函数,供合并点调用 + 单测):
 *  - MACHINE_ALL → 本机 + 所有远程(合并,与未加切换栏前一致);
 *  - 勾选集     → 含 MACHINE_LOCAL 则并入本机会话;远程会话按 deviceId 命中勾选集过滤
 *                  (勾选的机器在线但暂无会话 → 不贡献条目)。
 */
export function selectVisibleSessions(
  localSessions: Session[],
  remoteSessions: Session[],
  selection: MachineSelection,
): Session[] {
  if (selection === MACHINE_ALL) return [...localSessions, ...remoteSessions];
  const set = new Set(selection);
  const out = set.has(MACHINE_LOCAL) ? [...localSessions] : [];
  for (const s of remoteSessions) {
    if (s.deviceLinkDeviceId && set.has(s.deviceLinkDeviceId)) out.push(s);
  }
  return out;
}
