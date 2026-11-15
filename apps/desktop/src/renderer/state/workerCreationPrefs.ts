import { normalizeWorkerCreationSelection, type WorkerCreationSelection } from '../../shared/workerCreationSelection';
import type { Effort } from '@/lib/userPreferences.types';
import {
  DEFAULT_ORCA_WORKER_AGENT,
  DEFAULT_ORCA_WORKER_EFFORT,
  DEFAULT_ORCA_WORKER_MODELS,
  ORCA_PREDEFINED_WORKER_ROLES,
  normalizeOrcaWorkerRole,
} from '@cindy/maker-shared/orca-team';

import type { OrcaWorkerRoles, OrcaWorkerRolesMutation } from '@cindy/device-link';
import {
  DEFAULT_ORCA_WORKER_PERMISSION_MODE,
  isOrcaWorkerPermissionMode,
  resolveOrcaWorkerPermissionMode,
  type OrcaWorkerPermissionMode,
} from '../../shared/orca-worker-permission-mode';

const STORAGE_KEY = 'workerCreationPrefs';
const CHANGE_EVENT = 'cindy:worker-creation-prefs-changed';

export type WorkerAgentKind = 'codex' | 'claude-code' | 'pi';

export interface WorkerAgentPrefs {
  model: string;
  effort: Effort;
  fast: boolean | 'ultrafast';
  /** 上次显式选定的模型来源；null = 未显式选择，跟随默认路由解析。 */
  providerId: string | null;
}

/** 手动选定并提交的完整模型路线；null 位置表示任务所在电脑。 */
export interface WorkerModelSelection extends WorkerAgentPrefs {
  agent: WorkerAgentKind;
  agentDeviceId: string | null;
}

export interface WorkerCreationPrefs {
  lastAgent: WorkerAgentKind;
  codex: WorkerAgentPrefs;
  'claude-code': WorkerAgentPrefs;
  pi: WorkerAgentPrefs;
  /** 新 Worker 的默认权限；UI 与 Orca tool 共用。 */
  workerPermissionMode: OrcaWorkerPermissionMode;
  /** 按账号与任务所在电脑隔离（JSON 二元组）；缺项时继续跟随 Lead 的位置。 */
  modelSelectionByHost?: Record<string, WorkerModelSelection>;
  /** 角色预设的记忆，按账号隔离（key 见 workerRoleOwnerKey）：任务文字是用户内容，不带到另一个账号。 */
  rolesByOwner?: Record<string, WorkerRolePrefs>;
}

/** 一个角色（内置预设或用户添加的）上次提交时的内容；缺省的字段表示没有自己的记忆，跟随通用默认。 */
export interface WorkerRoleMemory {
  /** 上次提交的首条任务；提交时为空或与预设自带的任务相同则不记。 */
  task?: string;
  permission?: OrcaWorkerPermissionMode;
  /** 手动选定并提交的模型路线，key 与 WorkerCreationPrefs.modelSelectionByHost 相同。 */
  modelSelectionByHost?: Record<string, WorkerModelSelection>;
}

export interface WorkerRolePrefs {
  /** 用过的角色（内置或用户添加的），最近用的在前；第一个也就是上次用的角色。 */
  recentRoles: string[];
  /** 用户移除的内置预设；再用这个角色创建一次就回来。 */
  removedBuiltinRoles: string[];
  /** 只保留仍列在预设里的角色。 */
  memory: Record<string, WorkerRoleMemory>;
}

/** 用户添加的角色最多保留这么多；再添加时最久没用的让位，避免这一排无限变长。 */
export const MAX_CUSTOM_WORKER_ROLES = 12;
/** 超过这个长度的任务不记：那样长的内容基本是一次性的，也不该撑大本机偏好。 */
export const MAX_REMEMBERED_WORKER_TASK_LENGTH = 2000;

/** 还没有任何记录时的角色记忆：只列内置预设。 */
export const EMPTY_WORKER_ROLE_PREFS: WorkerRolePrefs = {
  recentRoles: [],
  removedBuiltinRoles: [],
  memory: {},
};

function isPredefinedWorkerRole(role: string): boolean {
  return (ORCA_PREDEFINED_WORKER_ROLES as readonly string[]).includes(role);
}

export function workerRoleOwnerKey(ownerId: string | null): string {
  return JSON.stringify([ownerId]);
}

/** 当前账号的角色预设记忆；没有时返回空表。 */
export function readWorkerRolePrefs(
  prefs: WorkerCreationPrefs,
  ownerId: string | null,
): WorkerRolePrefs {
  return prefs.rolesByOwner?.[workerRoleOwnerKey(ownerId)] ?? EMPTY_WORKER_ROLE_PREFS;
}

/**
 * 预设这一排列出的角色：用过的按最近使用排在前面，没用过的内置预设按默认顺序跟在后面，
 * 被移除的内置预设不列。
 */
export function listedWorkerRoles(roles: WorkerRolePrefs): string[] {
  return [
    ...roles.recentRoles,
    ...ORCA_PREDEFINED_WORKER_ROLES.filter(
      (role) => !roles.recentRoles.includes(role) && !roles.removedBuiltinRoles.includes(role),
    ),
  ];
}

/**
 * 某个角色记下的内容。角色名是用户起的，可能与对象的内置属性同名(constructor、__proto__ 等)，
 * 只认自己的属性，不读到原型上去。
 */
export function workerRoleMemory(
  roles: WorkerRolePrefs,
  role: string,
): WorkerRoleMemory | undefined {
  return Object.prototype.hasOwnProperty.call(roles.memory, role) ? roles.memory[role] : undefined;
}

export interface WorkerRoleSubmission {
  role: string;
  /** 这次要记的任务文字；undefined = 不记（清掉这个角色之前记的）。 */
  task?: string;
  /** undefined = 这次没有可记的权限选择，保留之前记的。 */
  permission?: OrcaWorkerPermissionMode;
  /** 有手动选定的模型路线时带上；缺省 = 保留这个角色之前记的。 */
  model?: { scope: string; selection: WorkerModelSelection };
}

/**
 * 提交创建后记下这个角色这次的内容，并把它排到最前。内置预设之外的角色名同时成为新的预设；
 * 之前移除过的内置预设再次使用即恢复。
 */
export function rememberWorkerRoleSubmission(
  prefs: WorkerCreationPrefs,
  ownerId: string | null,
  submission: WorkerRoleSubmission,
): WorkerCreationPrefs {
  const role = normalizeOrcaWorkerRole(submission.role);
  if (!role.ok) return prefs;
  const current = readWorkerRolePrefs(prefs, ownerId);
  // 用 Map 逐项增删再整体生成对象：角色名可以是任意文字，不能当普通属性直接赋值。
  const memory = new Map(Object.entries(current.memory));
  let recentRoles = [role.value, ...current.recentRoles.filter((item) => item !== role.value)];
  const customRoles = recentRoles.filter((item) => !isPredefinedWorkerRole(item));
  const dropped = new Set(customRoles.slice(MAX_CUSTOM_WORKER_ROLES));
  if (dropped.size > 0) {
    recentRoles = recentRoles.filter((item) => !dropped.has(item));
    for (const item of dropped) memory.delete(item);
  }
  const previous = memory.get(role.value);
  const permission = submission.permission ?? previous?.permission;
  const modelSelectionByHost = submission.model
    ? { ...previous?.modelSelectionByHost, [submission.model.scope]: submission.model.selection }
    : previous?.modelSelectionByHost;
  const task =
    submission.task !== undefined
    && submission.task.trim() !== ''
    && submission.task.length <= MAX_REMEMBERED_WORKER_TASK_LENGTH
      ? submission.task
      : undefined;
  memory.set(role.value, {
    ...(task !== undefined ? { task } : {}),
    ...(permission ? { permission } : {}),
    ...(modelSelectionByHost ? { modelSelectionByHost } : {}),
  });
  return {
    ...prefs,
    rolesByOwner: {
      ...prefs.rolesByOwner,
      [workerRoleOwnerKey(ownerId)]: {
        recentRoles,
        removedBuiltinRoles: current.removedBuiltinRoles.filter((item) => item !== role.value),
        memory: Object.fromEntries(memory),
      },
    },
  };
}

/** 把一个角色从预设里移除，连同它记下的内容；内置预设记为已移除，用户添加的直接删掉。 */
export function forgetWorkerRole(
  prefs: WorkerCreationPrefs,
  ownerId: string | null,
  role: string,
): WorkerCreationPrefs {
  const current = readWorkerRolePrefs(prefs, ownerId);
  if (!listedWorkerRoles(current).includes(role)) return prefs;
  return {
    ...prefs,
    rolesByOwner: {
      ...prefs.rolesByOwner,
      [workerRoleOwnerKey(ownerId)]: {
        recentRoles: current.recentRoles.filter((item) => item !== role),
        removedBuiltinRoles: isPredefinedWorkerRole(role)
          ? [...current.removedBuiltinRoles, role]
          : current.removedBuiltinRoles,
        memory: Object.fromEntries(Object.entries(current.memory).filter(([item]) => item !== role)),
      },
    },
  };
}

/** 这台电脑上本机任务的模型路线在 modelSelectionByHost 里的 key。 */
function localModelScope(ownerId: string | null): string {
  return JSON.stringify([ownerId, 'local']);
}

/**
 * 当前账号的角色清单，按远程读写的形态给出：顺序即显示顺序，每个角色带它记的内容；同时带上
 * 这台电脑不分角色的「上次选择」(上次用的 Agent、各 Agent 的模型、权限、手动选定的路线)。
 * 模型路线只给这台电脑本机任务的那一条 —— 远程读它的一端操作的正是这台电脑上的任务。
 */
export function toRemoteWorkerRoles(
  prefs: WorkerCreationPrefs,
  ownerId: string | null,
): OrcaWorkerRoles {
  const roles = readWorkerRolePrefs(prefs, ownerId);
  const scope = localModelScope(ownerId);
  const route = prefs.modelSelectionByHost?.[scope];
  return {
    roles: listedWorkerRoles(roles).map((role) => {
      const memory = workerRoleMemory(roles, role);
      const model = memory?.modelSelectionByHost?.[scope];
      return {
        role,
        ...(memory?.task !== undefined ? { task: memory.task } : {}),
        ...(memory?.permission ? { permission: memory.permission } : {}),
        ...(model ? { model } : {}),
      };
    }),
    defaults: {
      agent: prefs.lastAgent,
      permission: prefs.workerPermissionMode,
      agents: { codex: prefs.codex, 'claude-code': prefs['claude-code'], pi: prefs.pi },
      ...(route ? { model: route } : {}),
    },
  };
}

/**
 * 远程读到的「上次选择」还原成弹窗用的偏好：完整路线挂在调用方给的 scope 下。那台电脑没给
 * (读不懂)时返回 null，弹窗按首次默认值起步。
 */
export function fromRemoteWorkerDefaults(
  remote: OrcaWorkerRoles,
  scope: string,
): WorkerCreationPrefs | null {
  const defaults = remote.defaults;
  if (!defaults) return null;
  return {
    lastAgent: defaults.agent,
    codex: defaults.agents.codex,
    'claude-code': defaults.agents['claude-code'],
    pi: defaults.agents.pi,
    workerPermissionMode: defaults.permission,
    ...(defaults.model ? { modelSelectionByHost: { [scope]: defaults.model } } : {}),
  };
}

/**
 * 把远程读到的角色清单还原成弹窗用的形态：清单里的顺序原样保留，不在清单里的内置预设算作已移除；
 * 模型路线挂在调用方给的 scope 下，弹窗按同一个 scope 查。
 */
export function fromRemoteWorkerRoles(remote: OrcaWorkerRoles, scope: string): WorkerRolePrefs {
  const recentRoles = remote.roles.map((entry) => entry.role);
  return {
    recentRoles,
    removedBuiltinRoles: ORCA_PREDEFINED_WORKER_ROLES.filter((role) => !recentRoles.includes(role)),
    memory: Object.fromEntries(remote.roles.map((entry) => [entry.role, {
      ...(entry.task !== undefined ? { task: entry.task } : {}),
      ...(entry.permission ? { permission: entry.permission } : {}),
      ...(entry.model ? { modelSelectionByHost: { [scope]: entry.model } } : {}),
    } satisfies WorkerRoleMemory])),
  };
}

/** 手机或远程控制的电脑发来的一次改动，落到这台电脑当前账号的角色清单上。 */
export function applyWorkerRolesMutation(
  prefs: WorkerCreationPrefs,
  ownerId: string | null,
  mutation: OrcaWorkerRolesMutation,
): WorkerCreationPrefs {
  if (mutation.kind === 'forget') return forgetWorkerRole(prefs, ownerId, mutation.role);
  const scope = localModelScope(ownerId);
  const remembered = rememberWorkerRoleSubmission(prefs, ownerId, {
    role: mutation.role,
    ...(mutation.task !== undefined ? { task: mutation.task } : {}),
    ...(mutation.permission ? { permission: mutation.permission } : {}),
    ...(mutation.model ? { model: { scope, selection: mutation.model } } : {}),
  });
  const choice = mutation.choice;
  if (!choice) return remembered;
  // 同一次创建也更新不分角色的「上次选择」，与在这台电脑上提交弹窗时记的内容相同。
  let modelSelectionByHost = remembered.modelSelectionByHost;
  if (choice.route !== undefined) {
    const next = { ...modelSelectionByHost };
    if (choice.route) next[scope] = choice.route;
    else delete next[scope];
    modelSelectionByHost = next;
  }
  return {
    ...remembered,
    lastAgent: choice.agent,
    ...(mutation.permission ? { workerPermissionMode: mutation.permission } : {}),
    ...(choice.agentModel ? { [choice.agent]: choice.agentModel } : {}),
    ...(modelSelectionByHost ? { modelSelectionByHost } : {}),
  };
}

// 首次默认值与手机端共用(@cindy/maker-shared/orca-team)。
export const DEFAULT_WORKER_CREATION_PREFS: WorkerCreationPrefs = {
  lastAgent: DEFAULT_ORCA_WORKER_AGENT,
  codex: { model: DEFAULT_ORCA_WORKER_MODELS.codex, effort: DEFAULT_ORCA_WORKER_EFFORT as Effort, fast: false, providerId: null },
  'claude-code': { model: DEFAULT_ORCA_WORKER_MODELS['claude-code'], effort: DEFAULT_ORCA_WORKER_EFFORT as Effort, fast: false, providerId: null },
  pi: { model: DEFAULT_ORCA_WORKER_MODELS.pi, effort: DEFAULT_ORCA_WORKER_EFFORT as Effort, fast: false, providerId: null },
  workerPermissionMode: DEFAULT_ORCA_WORKER_PERMISSION_MODE,
};

function defaultPrefs(): WorkerCreationPrefs {
  return {
    ...DEFAULT_WORKER_CREATION_PREFS,
    codex: { ...DEFAULT_WORKER_CREATION_PREFS.codex },
    'claude-code': { ...DEFAULT_WORKER_CREATION_PREFS['claude-code'] },
    pi: { ...DEFAULT_WORKER_CREATION_PREFS.pi },
  };
}

export function readWorkerCreationPrefs(): WorkerCreationPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPrefs();
    const parsed = JSON.parse(raw) as Partial<WorkerCreationPrefs>;
    const agentPrefs = (agent: WorkerAgentKind): WorkerAgentPrefs => {
      const fallback = DEFAULT_WORKER_CREATION_PREFS[agent];
      const value = parsed[agent];
      return {
        ...fallback,
        ...(value ?? {}),
        fast: (value?.fast === 'ultrafast' ? 'ultrafast' : value?.fast === true),
        providerId:
          typeof value?.providerId === 'string' && value.providerId.trim()
            ? value.providerId.trim()
            : null,
      };
    };
    return {
      lastAgent:
        parsed.lastAgent === 'claude-code'
          ? 'claude-code'
          : parsed.lastAgent === 'pi'
            ? 'pi'
            : 'codex',
      codex: agentPrefs('codex'),
      'claude-code': agentPrefs('claude-code'),
      pi: agentPrefs('pi'),
      workerPermissionMode: resolveOrcaWorkerPermissionMode(parsed.workerPermissionMode),
      modelSelectionByHost: readModelSelections(parsed.modelSelectionByHost),
      ...readRolesByOwner(parsed.rolesByOwner),
    };
  } catch {
    return defaultPrefs();
  }
}

function readRole(value: unknown): string | null {
  const role = typeof value === 'string' ? normalizeOrcaWorkerRole(value) : null;
  return role?.ok ? role.value : null;
}

/** 本机存储可能被手工改过：逐项校验，读不懂的项丢掉，不让整份偏好作废。 */
function readRolesByOwner(value: unknown): { rolesByOwner?: Record<string, WorkerRolePrefs> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const roleList = (raw: unknown): string[] => [...new Set(
    (Array.isArray(raw) ? raw : []).map(readRole).filter((role): role is string => role !== null),
  )];
  const rolesByOwner = Object.fromEntries(Object.entries(value).flatMap(([owner, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as { recentRoles?: unknown; removedBuiltinRoles?: unknown; memory?: unknown };
    let recentRoles = roleList(item.recentRoles);
    const overflow = new Set(
      recentRoles.filter((role) => !isPredefinedWorkerRole(role)).slice(MAX_CUSTOM_WORKER_ROLES),
    );
    recentRoles = recentRoles.filter((role) => !overflow.has(role));
    // 同一个内置预设不能既用过又被移除：以用过为准。
    const removedBuiltinRoles = roleList(item.removedBuiltinRoles)
      .filter((role) => isPredefinedWorkerRole(role) && !recentRoles.includes(role));
    const roles: WorkerRolePrefs = { recentRoles, removedBuiltinRoles, memory: {} };
    const listed = listedWorkerRoles(roles);
    const rawMemory = item.memory && typeof item.memory === 'object' && !Array.isArray(item.memory)
      ? item.memory as Record<string, unknown>
      : {};
    roles.memory = Object.fromEntries(Object.entries(rawMemory).flatMap(([role, entry]) => {
      if (!listed.includes(role) || !entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const stored = entry as { task?: unknown; permission?: unknown; modelSelectionByHost?: unknown };
      const selections = readModelSelections(stored.modelSelectionByHost);
      const remembered: WorkerRoleMemory = {
        ...(typeof stored.task === 'string'
          && stored.task.trim() !== ''
          && stored.task.length <= MAX_REMEMBERED_WORKER_TASK_LENGTH
          ? { task: stored.task }
          : {}),
        ...(isOrcaWorkerPermissionMode(stored.permission) ? { permission: stored.permission } : {}),
        ...(Object.keys(selections).length > 0 ? { modelSelectionByHost: selections } : {}),
      };
      return [[role, remembered]];
    }));
    return [[owner, roles]];
  }));
  return Object.keys(rolesByOwner).length > 0 ? { rolesByOwner } : {};
}

function readModelSelections(value: unknown): Record<string, WorkerModelSelection> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([host, selection]) => {
    if (!selection || typeof selection !== 'object') return [];
    const item = selection as Partial<WorkerModelSelection>;
    if (
      (item.agent !== 'codex' && item.agent !== 'claude-code' && item.agent !== 'pi')
      || typeof item.model !== 'string' || !item.model.trim()
      || typeof item.effort !== 'string'
      || (item.agentDeviceId !== null && (typeof item.agentDeviceId !== 'string' || !item.agentDeviceId.trim()))
      || (item.providerId !== null && (typeof item.providerId !== 'string' || !item.providerId.trim()))
    ) return [];
    return [[host, {
      agent: item.agent,
      agentDeviceId: item.agentDeviceId,
      model: item.model,
      effort: item.effort,
      fast: (item.fast === 'ultrafast' ? 'ultrafast' : item.fast === true),
      providerId: item.providerId,
    }]];
  }));
}

export function writeWorkerCreationPrefs(prefs: WorkerCreationPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // localStorage 在受限上下文中可能不可用；偏好保存是 best-effort。
  }
}

export function setWorkerPermissionModePreference(mode: OrcaWorkerPermissionMode): void {
  const prefs = readWorkerCreationPrefs();
  if (prefs.workerPermissionMode === mode) return;
  writeWorkerCreationPrefs({ ...prefs, workerPermissionMode: mode });
}

export function subscribeWorkerCreationPrefs(listener: () => void): () => void {
  const onCustomChange = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, onCustomChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustomChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** Only the current owner's local, submitted route is eligible for tool defaults. */
export function readLocalWorkerCreationSelection(owner: string | null): WorkerCreationSelection | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    return normalizeWorkerCreationSelection(raw?.modelSelectionByHost?.[JSON.stringify([owner, 'local'])]);
  } catch { return null; }
}
