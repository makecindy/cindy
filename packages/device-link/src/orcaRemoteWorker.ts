/**
 * 协同远端 Worker(同账号)：Lead 与团队留在发起电脑(控制端)，单个 Worker 的任务、目录、
 * 命令与文件都在运行设备(被控端)上。运行设备上的 Worker 是一条普通任务，带「来自哪台
 * 电脑的协同」标记；派活、停止与回报复用现有会话通道，这里只登记运行设备新增的三个入口：
 *
 *  - `caps`：能力探测。老版本没有该 channel → CHANNEL_NOT_ALLOWED，控制端据此提示更新，
 *    不回退到普通建任务(普通任务没有防嵌套与来源标记)。
 *  - `open`：按控制端给定的 sessionId 新建 Worker 任务，幂等(同一控制端重复 open 返回同一任务)。
 *    来源电脑身份取 server 盖章的 src，不采信载荷自报。
 *  - `release`：通知运行设备这个 Worker 已结束协同，任务与文件保留。幂等。
 */
export const ORCA_REMOTE_WORKER_CAPS_CHANNEL = 'maker:orca:remote-worker:caps';
export const ORCA_REMOTE_WORKER_OPEN_CHANNEL = 'maker:orca:remote-worker:open';
export const ORCA_REMOTE_WORKER_RELEASE_CHANNEL = 'maker:orca:remote-worker:release';
export const ORCA_REMOTE_WORKER_VERSION = 1;

/**
 * Lead 所在电脑的只读查询：哪些同账号电脑可以被选为运行设备。控制端(远程控制这台
 * Lead 电脑的手机或另一台桌面)经设备互联读取，结果以 Lead 所在电脑的视角为准。
 * 老版本没有该 channel → CHANNEL_NOT_ALLOWED，控制端按「不支持远端 Worker」隐藏入口。
 */
export const ORCA_EXECUTION_DEVICES_CHANNEL = 'maker:orca:execution-devices';

export interface OrcaExecutionDeviceView {
  deviceId: string;
  name: string;
  platform: string | null;
  /** false = 那台电脑版本过旧，不支持协同远端 Worker(显示为需要更新)。 */
  supported: boolean;
}

/** 运行设备上 open 可能要准备工作目录并启动 Agent，给足执行与回程余量。 */
export const ORCA_REMOTE_WORKER_OPEN_TIMEOUT_MS = 60_000;

export const ORCA_REMOTE_WORKER_AGENT_KINDS = ['claude-code', 'codex', 'pi'] as const;
export type OrcaRemoteWorkerAgentKind = (typeof ORCA_REMOTE_WORKER_AGENT_KINDS)[number];

export const ORCA_REMOTE_WORKER_PERMISSION_MODES = ['auto', 'bypassPermissions'] as const;
export type OrcaRemoteWorkerPermissionMode =
  (typeof ORCA_REMOTE_WORKER_PERMISSION_MODES)[number];

export interface OrcaRemoteWorkerCaps {
  version: number;
}

export interface OrcaRemoteWorkerOpenRequest {
  /** 控制端生成的运行设备任务 id；同一 id 重复 open 幂等。 */
  sessionId: string;
  agentKind: OrcaRemoteWorkerAgentKind;
  /** 缺省 = 运行设备的默认模型与来源。 */
  model?: string;
  providerId?: string;
  effort?: string;
  fastMode?: boolean;
  permissionMode: OrcaRemoteWorkerPermissionMode;
  /** 运行设备上的绝对目录；缺省 = 运行设备按自身设置分配任务目录。 */
  workingDir?: string;
  title: string;
  lead: {
    leadSessionId: string;
    leadTitle: string;
    workerLabel: string;
  };
}

export interface OrcaRemoteWorkerOpenResult {
  sessionId: string;
  workingDir: string;
  model: string;
  agentKind: OrcaRemoteWorkerAgentKind;
  /** 运行设备实际保存的档位；空字符串 = 不使用档位，缺省 = 旧设备未返回。 */
  effort?: string;
  /** 运行设备实际保存的 Fast 状态；缺省 = 旧设备未返回。 */
  fastMode?: boolean;
}

export interface OrcaRemoteWorkerReleaseRequest {
  sessionId: string;
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_TEXT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optString(value: unknown, max = MAX_TEXT): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('[INVALID_PARAMS] expected string');
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > max) throw new Error('[INVALID_PARAMS] value too long');
  return trimmed;
}

function requiredString(value: unknown, field: string, max = MAX_TEXT): string {
  const parsed = optString(value, max);
  if (!parsed) throw new Error(`[INVALID_PARAMS] ${field} is required`);
  return parsed;
}

export function isOrcaRemoteWorkerSessionId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

/** 运行设备侧权威校验：不认识的字段丢弃，类型不符一律 INVALID_PARAMS。 */
export function parseOrcaRemoteWorkerOpenRequest(raw: unknown): OrcaRemoteWorkerOpenRequest {
  if (!isRecord(raw)) throw new Error('[INVALID_PARAMS] open request must be an object');
  if (!isOrcaRemoteWorkerSessionId(raw.sessionId)) {
    throw new Error('[INVALID_PARAMS] sessionId must be a safe id');
  }
  const agentKind = raw.agentKind;
  if (!ORCA_REMOTE_WORKER_AGENT_KINDS.includes(agentKind as OrcaRemoteWorkerAgentKind)) {
    throw new Error('[INVALID_PARAMS] invalid agentKind');
  }
  const permissionMode = raw.permissionMode;
  if (!ORCA_REMOTE_WORKER_PERMISSION_MODES.includes(permissionMode as OrcaRemoteWorkerPermissionMode)) {
    throw new Error('[INVALID_PARAMS] invalid permissionMode');
  }
  if (raw.fastMode !== undefined && typeof raw.fastMode !== 'boolean') {
    throw new Error('[INVALID_PARAMS] fastMode must be boolean');
  }
  if (!isRecord(raw.lead)) throw new Error('[INVALID_PARAMS] lead is required');
  const leadSessionId = raw.lead.leadSessionId;
  if (!isOrcaRemoteWorkerSessionId(leadSessionId)) {
    throw new Error('[INVALID_PARAMS] lead.leadSessionId must be a safe id');
  }
  const workingDir = optString(raw.workingDir, 4096);
  if (workingDir && /[\r\n\0]/.test(workingDir)) {
    throw new Error('[INVALID_PARAMS] workingDir contains control characters');
  }
  const model = optString(raw.model);
  const providerId = optString(raw.providerId);
  const effort = optString(raw.effort, 32);
  return {
    sessionId: raw.sessionId,
    agentKind: agentKind as OrcaRemoteWorkerAgentKind,
    ...(model ? { model } : {}),
    ...(providerId ? { providerId } : {}),
    ...(effort ? { effort } : {}),
    ...(typeof raw.fastMode === 'boolean' ? { fastMode: raw.fastMode } : {}),
    permissionMode: permissionMode as OrcaRemoteWorkerPermissionMode,
    ...(workingDir ? { workingDir } : {}),
    title: requiredString(raw.title, 'title'),
    lead: {
      leadSessionId,
      leadTitle: optString(raw.lead.leadTitle) ?? '',
      workerLabel: requiredString(raw.lead.workerLabel, 'lead.workerLabel', 32),
    },
  };
}

export function parseOrcaRemoteWorkerReleaseRequest(raw: unknown): OrcaRemoteWorkerReleaseRequest {
  if (!isRecord(raw) || !isOrcaRemoteWorkerSessionId(raw.sessionId)) {
    throw new Error('[INVALID_PARAMS] sessionId must be a safe id');
  }
  return { sessionId: raw.sessionId };
}
