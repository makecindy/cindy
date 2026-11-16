/**
 * 手机端协同表单的记忆(与桌面 CreateWorkerPopover 同一套规则)。
 *
 * 角色清单、每个角色记的任务 / 权限 / 模型，以及不分角色的「上次选择」(上次用的 Agent、各 Agent 的
 * 模型、权限、手动选定的路线)都存在任务所在的电脑上(`maker:worker-roles:get` / `apply`)，手机只在
 * 表单打开期间拿在手里，不落盘 —— 换一部手机、或在电脑上打开，看到的是同一份。
 * 电脑版本太旧、没有这组通道时只列内置角色，不能增删；「上次选择」沿用手机原有的本地记忆
 * (orcaWorkerPrefs)，那是给旧电脑留的兼容。
 */
import {
  ORCA_WORKER_ROLE_TASK_MAX_LENGTH,
  parseOrcaWorkerRoles,
  type OrcaWorkerChoice,
  type OrcaWorkerDefaults,
  type OrcaWorkerRoleEntry,
  type OrcaWorkerRolesMutation,
} from '@cindy/device-link';
import {
  DEFAULT_ORCA_WORKER_EFFORT,
  ORCA_PREDEFINED_WORKER_ROLES,
  ORCA_STARTER_TASK_WORKER_ROLES,
  resolveOrcaWorkerRoleName,
} from '@cindy/maker-shared/orca-team';
import { i18n } from '@/i18n';
import type { OrcaWorkerFormValue } from '@/session/orcaTeam';
import { defaultOrcaWorkerCreationPrefs, type OrcaWorkerCreationPrefs } from '@/session/orcaWorkerPrefs';

export type { OrcaWorkerRoleEntry };

/** 读不到电脑上的清单时用的清单：只有内置角色，什么都没记。 */
export const BUILTIN_ORCA_ROLE_ENTRIES: readonly OrcaWorkerRoleEntry[] =
  ORCA_PREDEFINED_WORKER_ROLES.map((role) => ({ role }));

export function isBuiltinOrcaRole(role: string): boolean {
  return (ORCA_PREDEFINED_WORKER_ROLES as readonly string[]).includes(role);
}

/** 角色在界面上的名字：内置角色用当前语言的名字，用户添加的就是他输入的名字。 */
export function orcaRoleDisplayName(role: string): string {
  return isBuiltinOrcaRole(role) ? i18n.t(`session.collab.roles.${role}.name`) : role;
}

/** 内置的检查类角色自带的首条任务；其余角色没有。 */
export function orcaRoleStarterTask(role: string): string {
  return ORCA_STARTER_TASK_WORKER_ROLES.includes(role) ? i18n.t(`session.collab.roles.${role}.task`) : '';
}

/**
 * 选中一个角色时任务框里的内容：电脑上记的上次任务，没记过则是内置角色自带的那句。自带的任务
 * 只在 Lead 已有工作可查时提供：新建任务的草稿还没有可审查、可测试的东西，不带出。
 */
export function orcaRoleDefaultTask(
  role: string,
  entries: readonly OrcaWorkerRoleEntry[],
  leadHasWork = true,
): string {
  return entries.find((entry) => entry.role === role)?.task ?? (leadHasWork ? orcaRoleStarterTask(role) : '');
}

/** 添加角色时输入的名字对应的角色：输入内置角色的名字就是那个内置角色，不另建一个同名的。 */
export function resolveOrcaRoleInput(name: string): string {
  return resolveOrcaWorkerRoleName(name, orcaRoleDisplayName);
}

/**
 * 电脑上的「上次选择」换成表单沿用的偏好形状；完整路线挂在这台电脑名下。电脑没给(读不懂)时
 * 按首次默认值起步。
 */
export function orcaPrefsFromHostDefaults(
  defaults: OrcaWorkerDefaults | undefined,
  taskHostDeviceId: string | null | undefined,
): OrcaWorkerCreationPrefs {
  if (!defaults) return defaultOrcaWorkerCreationPrefs();
  const agent = (kind: OrcaWorkerDefaults['agent']) => ({
    model: defaults.agents[kind].model,
    effort: defaults.agents[kind].effort || DEFAULT_ORCA_WORKER_EFFORT,
    fast: defaults.agents[kind].fast,
    // 那台电脑记的来源要带着走：同一个模型在多个来源下，不能悄悄换成别的来源运行。
    providerId: defaults.agents[kind].providerId,
  });
  const route = defaults.model;
  return {
    lastAgent: defaults.agent,
    agents: { codex: agent('codex'), 'claude-code': agent('claude-code'), pi: agent('pi') },
    workerPermissionMode: defaults.permission,
    ...(route && taskHostDeviceId ? {
      modelSelectionByHost: {
        [taskHostDeviceId]: {
          agent: route.agent,
          agentDeviceId: route.agentDeviceId,
          model: { id: route.model, providerId: route.providerId, effort: route.effort || null, fast: route.fast },
        },
      },
    } : {}),
  };
}

/**
 * 电脑返回的记忆：角色清单(顺序即显示顺序，最近使用在前)和「上次选择」。形状不对时抛错，
 * 由调用方按读不到处理。
 */
export function parseOrcaHostMemory(
  value: unknown,
  taskHostDeviceId: string | null | undefined,
): { entries: OrcaWorkerRoleEntry[]; prefs: OrcaWorkerCreationPrefs } {
  const parsed = parseOrcaWorkerRoles(value);
  return { entries: parsed.roles, prefs: orcaPrefsFromHostDefaults(parsed.defaults, taskHostDeviceId) };
}

/**
 * 这一排显示哪些角色：电脑上的清单原样；表单当前的角色不在其中(刚恢复的草稿、清单读到之前
 * 选的)时排在最前，让选中的那个始终看得见。
 */
export function listedOrcaRoles(
  entries: readonly OrcaWorkerRoleEntry[],
  selectedRole: string | null,
): string[] {
  const roles = entries.map((entry) => entry.role);
  return selectedRole && !roles.includes(selectedRole) ? [selectedRole, ...roles] : roles;
}

/**
 * 提交后手头这份角色清单的样子：这个角色排到最前并带上这次记的内容(没带的字段保留之前记的)。
 * 只是为了马上再打开表单时不用等电脑读回来；以电脑下次返回的清单为准。
 */
export function withRememberedOrcaRole(
  entries: readonly OrcaWorkerRoleEntry[],
  mutation: OrcaWorkerRolesMutation,
): OrcaWorkerRoleEntry[] {
  if (mutation.kind !== 'remember') return entries.filter((entry) => entry.role !== mutation.role);
  const previous = entries.find((entry) => entry.role === mutation.role);
  const permission = mutation.permission ?? previous?.permission;
  const model = mutation.model ?? previous?.model;
  return [
    {
      role: mutation.role,
      ...(mutation.task !== undefined ? { task: mutation.task } : {}),
      ...(permission ? { permission } : {}),
      ...(model ? { model } : {}),
    },
    ...entries.filter((entry) => entry.role !== mutation.role),
  ];
}

/** 这次提交的模型在电脑上的归属，决定「上次选择」和角色记忆各记什么。 */
export interface OrcaSubmittedRoute {
  /** Worker 的 Agent 所在电脑；null = 任务所在的电脑。 */
  agentDeviceId: string | null;
  /** 模型是手动选定的完整路线(不是切 Agent 时自动带出的)。 */
  explicit: boolean;
  /** 模型目录属于任务所在的电脑：没有选其他运行设备，也不是 SSH 任务。 */
  hostCatalog: boolean;
  /** 模型没带推理强度时，「上次选择」里这个 Agent 沿用的强度。 */
  fallbackEffort: string;
}

/**
 * 用这个角色创建 Worker 之后记到电脑上的内容。
 *  - 角色自己的记忆：任务文字(为空、过长，或就是内置角色自带的那句则不记)、权限，以及手动选定的
 *    模型路线；这次的模型不该记(跟随默认、选了其他运行设备或 SSH 任务)时电脑保留之前记的。
 *  - 不分角色的「上次选择」(choice)：这次用的 Agent；Agent 就在任务所在的电脑上、也没选运行设备时
 *    连同它这次的模型；完整路线手动选了就记下，否则清掉(切 Agent 自动带出的模型提交后，不能再
 *    恢复上一条路线)，运行设备与 SSH 任务不动。
 */
export function orcaRoleRememberMutation(
  form: Pick<OrcaWorkerFormValue, 'role' | 'initialTask' | 'permissionMode' | 'agent' | 'model' | 'executionDeviceId'>,
  route: OrcaSubmittedRoute,
): OrcaWorkerRolesMutation {
  const task = form.initialTask;
  const rememberTask = task.trim() !== ''
    && task.length <= ORCA_WORKER_ROLE_TASK_MAX_LENGTH
    && task !== orcaRoleStarterTask(form.role);
  const model = form.model;
  const fullRoute = model && route.explicit && route.hostCatalog ? {
    agent: form.agent,
    agentDeviceId: route.agentDeviceId,
    model: model.id,
    effort: model.effort ?? '',
    fast: model.fast,
    providerId: model.providerId,
  } : null;
  const choice: OrcaWorkerChoice = {
    agent: form.agent,
    ...(model && route.agentDeviceId === null && !form.executionDeviceId ? {
      agentModel: {
        model: model.id,
        effort: model.effort ?? route.fallbackEffort,
        fast: model.fast,
        providerId: model.providerId,
      },
    } : {}),
    ...(route.hostCatalog ? { route: fullRoute } : {}),
  };
  return {
    kind: 'remember',
    role: form.role,
    ...(rememberTask ? { task } : {}),
    permission: form.permissionMode,
    ...(fullRoute ? { model: fullRoute } : {}),
    choice,
  };
}
