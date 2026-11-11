import {
  ORCA_PREDEFINED_WORKER_ROLES,
  ORCA_STARTER_TASK_WORKER_ROLES,
  orcaWorkerTaskAfterRoleChange,
  resolveOrcaWorkerRoleName,
} from '@cindy/maker-shared/orca-team';

/**
 * 「让 Worker 做什么」的预设。内置预设与预设角色一一对应；用户用加号添加并提交过的角色名会成为
 * 新的预设。所有预设都可以移除，按最近使用排序。角色名本身不改变 Worker 的能力：预设的作用是
 * 一键带回这类分工上次用的任务文字、模型和权限，内置的检查类预设另带一句现成的首条任务。
 * 判定规则与手机共用(@cindy/maker-shared/orca-team)，这里只接上电脑端的文案。
 */
export const BUILTIN_WORKER_ROLES: readonly string[] = ORCA_PREDEFINED_WORKER_ROLES;

/** 内置预设自带的首条任务的文案 key；没有则为 null。 */
export function workerStarterTaskKey(role: string): string | null {
  return ORCA_STARTER_TASK_WORKER_ROLES.includes(role)
    ? `orca.createWorker.templates.${role}.task`
    : null;
}

/** 添加角色时输入的名字对应的角色(输入内置预设的名字就是那个内置预设)。 */
export const resolveCustomWorkerRole = resolveOrcaWorkerRoleName;

/** 切换预设后任务框里应有的内容(用户写过或改过的不动)。 */
export const taskAfterTemplateChange = orcaWorkerTaskAfterRoleChange;
