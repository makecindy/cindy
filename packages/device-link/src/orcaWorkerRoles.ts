/**
 * 协同里创建 Worker 的记忆：角色清单、每个角色记住的任务文字、权限和模型路线，以及不分角色的
 * 「上次选择」(上次用的 Agent、各 Agent 的模型、权限、手动选定的完整路线)。
 * 真相在任务所在的电脑(被控端)：手机与远程控制的电脑只读写这一份，不在自己这边另存。
 * 不含凭证，也不是可执行的路由数据 —— 创建 Worker 仍走原有通道并在被控端校验。
 */
export const ORCA_WORKER_ROLES_GET = "maker:worker-roles:get";
export const ORCA_WORKER_ROLES_APPLY = "maker:worker-roles:apply";

export const ORCA_WORKER_ROLE_NAME_MAX_LENGTH = 32;
/** 超过这个长度的任务不记：那样长的内容基本是一次性的。 */
export const ORCA_WORKER_ROLE_TASK_MAX_LENGTH = 2000;
/** 一份清单里最多这么多个角色(内置加用户添加的)，多出的在解析时拒绝。 */
export const ORCA_WORKER_ROLES_MAX = 32;
const ID_MAX_LENGTH = 512;

export type OrcaWorkerRolePermission = "auto" | "bypassPermissions";

/** 手动选定并提交过的模型路线；agentDeviceId 为 null 表示 Agent 就在任务所在的电脑上。 */
export interface OrcaWorkerRoleModel {
  agent: "codex" | "claude-code" | "pi";
  agentDeviceId: string | null;
  model: string;
  effort: string;
  fast: boolean | "ultrafast";
  providerId: string | null;
}

/** 一个角色和它记住的内容；没记过的字段缺省。 */
export interface OrcaWorkerRoleEntry {
  role: string;
  task?: string;
  permission?: OrcaWorkerRolePermission;
  model?: OrcaWorkerRoleModel;
}

export type OrcaWorkerRoleAgent = OrcaWorkerRoleModel["agent"];

/** 某个 Agent 上次用的模型，属于任务所在电脑自己的目录；providerId 为 null 表示没有指定来源。 */
export interface OrcaWorkerAgentModel {
  model: string;
  effort: string;
  fast: boolean | "ultrafast";
  providerId: string | null;
}

/** 不分角色的「上次选择」：角色自己没记过时，表单从这里起步。 */
export interface OrcaWorkerDefaults {
  /** 上次用的 Agent。 */
  agent: OrcaWorkerRoleAgent;
  permission: OrcaWorkerRolePermission;
  /** 各 Agent 上次用的模型。 */
  agents: Record<OrcaWorkerRoleAgent, OrcaWorkerAgentModel>;
  /** 手动选定并提交过的完整路线；没有则缺省。 */
  model?: OrcaWorkerRoleModel;
}

/** 被控端当前账号的角色清单(顺序即显示顺序，最近使用在前)和「上次选择」。 */
export interface OrcaWorkerRoles {
  roles: OrcaWorkerRoleEntry[];
  /** 读不懂时缺省，操作端按首次默认值起步。 */
  defaults?: OrcaWorkerDefaults;
}

/** 这次创建实际用的选择，更新被控端的「上次选择」；缺省的字段保持不动。 */
export interface OrcaWorkerChoice {
  agent: OrcaWorkerRoleAgent;
  /** 这个 Agent 这次用的模型；只在模型属于任务所在电脑自己的目录时带上。 */
  agentModel?: OrcaWorkerAgentModel;
  /** 完整路线：对象 = 记下这条手动选定的路线；null = 清掉之前记的；缺省 = 不动。 */
  route?: OrcaWorkerRoleModel | null;
}

export type OrcaWorkerRolesMutation =
  /**
   * 用这个角色创建了一个 Worker：记下这次的内容并把它排到最前。缺省的字段按被控端规则处理。
   * 带 choice 时同时更新「上次选择」(权限取本次的 permission)。
   */
  | ({ kind: "remember"; choice?: OrcaWorkerChoice } & OrcaWorkerRoleEntry)
  /** 把这个角色从清单里移除，连同它记住的内容。 */
  | { kind: "forget"; role: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid worker roles payload");
  return value as Record<string, unknown>;
}

function roleName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid worker role");
  const role = value.trim();
  if (!role || role.length > ORCA_WORKER_ROLE_NAME_MAX_LENGTH)
    throw new Error("Invalid worker role");
  return role;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > ID_MAX_LENGTH)
    throw new Error("Invalid worker role model");
  return value;
}

const AGENTS: readonly OrcaWorkerRoleAgent[] = ["codex", "claude-code", "pi"];

function agentKind(value: unknown): OrcaWorkerRoleAgent {
  if (!AGENTS.includes(value as OrcaWorkerRoleAgent)) throw new Error("Invalid worker role model");
  return value as OrcaWorkerRoleAgent;
}

function parseAgentModel(value: unknown): OrcaWorkerAgentModel {
  const raw = record(value);
  if (typeof raw.effort !== "string" || raw.effort.length > ID_MAX_LENGTH)
    throw new Error("Invalid worker role model");
  return {
    model: id(raw.model),
    effort: raw.effort,
    fast: raw.fast === "ultrafast" ? "ultrafast" : raw.fast === true,
    providerId: raw.providerId === null ? null : id(raw.providerId),
  };
}

function parseModel(value: unknown): OrcaWorkerRoleModel {
  const raw = record(value);
  return {
    agent: agentKind(raw.agent),
    agentDeviceId: raw.agentDeviceId === null ? null : id(raw.agentDeviceId),
    ...parseAgentModel(raw),
  };
}

function parsePermission(value: unknown): OrcaWorkerRolePermission {
  if (value !== "auto" && value !== "bypassPermissions") throw new Error("Invalid worker permission");
  return value;
}

function parseDefaults(value: unknown): OrcaWorkerDefaults {
  const raw = record(value);
  const agents = record(raw.agents);
  return {
    agent: agentKind(raw.agent),
    permission: parsePermission(raw.permission),
    agents: {
      codex: parseAgentModel(agents.codex),
      "claude-code": parseAgentModel(agents["claude-code"]),
      pi: parseAgentModel(agents.pi),
    },
    ...(raw.model === undefined || raw.model === null ? {} : { model: parseModel(raw.model) }),
  };
}

function parseChoice(value: unknown): OrcaWorkerChoice {
  const raw = record(value);
  return {
    agent: agentKind(raw.agent),
    ...(raw.agentModel === undefined ? {} : { agentModel: parseAgentModel(raw.agentModel) }),
    ...(raw.route === undefined ? {} : { route: raw.route === null ? null : parseModel(raw.route) }),
  };
}

/** 只留认识的字段；任务为空或过长、权限不认识时当作没记，而不是拒绝整份清单。 */
function parseEntry(value: unknown): OrcaWorkerRoleEntry {
  const raw = record(value);
  const task =
    typeof raw.task === "string" &&
    raw.task.trim() !== "" &&
    raw.task.length <= ORCA_WORKER_ROLE_TASK_MAX_LENGTH
      ? raw.task
      : undefined;
  const permission =
    raw.permission === "auto" || raw.permission === "bypassPermissions"
      ? raw.permission
      : undefined;
  return {
    role: roleName(raw.role),
    ...(task !== undefined ? { task } : {}),
    ...(permission ? { permission } : {}),
    ...(raw.model === undefined || raw.model === null ? {} : { model: parseModel(raw.model) }),
  };
}

export function parseOrcaWorkerRoles(value: unknown): OrcaWorkerRoles {
  const list = record(value).roles;
  if (!Array.isArray(list) || list.length > ORCA_WORKER_ROLES_MAX)
    throw new Error("Invalid worker roles payload");
  const roles = list.map(parseEntry);
  if (new Set(roles.map((entry) => entry.role)).size !== roles.length)
    throw new Error("Duplicate worker role");
  // 「上次选择」读不懂时当作没有，不因此丢掉整份角色清单。
  let defaults: OrcaWorkerDefaults | undefined;
  try {
    defaults = parseDefaults(record(value).defaults);
  } catch {
    defaults = undefined;
  }
  return { roles, ...(defaults ? { defaults } : {}) };
}

export function parseOrcaWorkerRolesMutation(value: unknown): OrcaWorkerRolesMutation {
  const raw = record(value);
  if (raw.kind === "forget") return { kind: "forget", role: roleName(raw.role) };
  // 写入从严：choice 带了但读不懂就整条拒绝，不写半截的「上次选择」。
  if (raw.kind === "remember")
    return {
      kind: "remember",
      ...parseEntry(raw),
      ...(raw.choice === undefined ? {} : { choice: parseChoice(raw.choice) }),
    };
  throw new Error("Invalid worker roles mutation");
}
