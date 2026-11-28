import { isSafeSessionPathSegment } from '../sessionIds.js';
import { isLibraryExtraDirSlot } from './extraDirsValidator.js';

import { acpHarnessKeyFromProviderId, type CreateSessionOptions, type EngineKind, type WorkspaceKind } from '@cindy/maker-core';

import { isSharedTaskPeer, parseProviderSharePeer } from '@cindy/device-link';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';

/**
 * A caller-supplied dialogue session id becomes a path segment under the app-managed
 * dialogue root (buildDialogueWorkspaceDir → path.join). Only accept a single safe
 * basename so a remote `maker:create-session` caller can't use `..` / path separators /
 * absolute paths in `id` to escape that root and bypass the remote working-directory guard.
 */

export interface MakerSessionCreateOpts extends CreateSessionOptions {
  orcaRole?: 'lead' | 'worker' | null;
  /**
   * Codex-only escape hatch for tests / special callers. Normal desktop paths
   * leave this undefined; Maker lifecycle hooks read the DB bit for every
   * maker.createSession caller (IPC / scheduler / Feishu).
   */
  codexHistoryHasProductPrompt?: boolean;
  /**
   * 用户级 system prompt 末段；renderer 的 userPromptStore 来源，不写 DB。
   * 仅 lazy-create 那一次生效，已 spawn 的 session 走 maker.getSession 直送，
   * 自然忽略此字段。
   */
  userPrompt?: string;
  /**
   * Maker Memory 启用 flag。跟 userPrompt 同语义：老 session 维持启动时快照，
   * 不 hot-reload。
   */
  makerMemoryEnabled?: boolean;
  /**
   * 附加只读引用目录列表。Claude 透传到 SDK additionalDirectories；
   * Codex 透传到 app-server runtimeWorkspaceRoots + 只读 permission profile。
   * main 端仍统一校验，防 IPC 直调 / 老 DB 残留 / bug 数据。
   */
  extraDirs?: string[];
  /** 用户逐目录明确授予的附加可读写目录；不从 extraDirs 推导。 */
  writableDirs?: string[];
  /**
   * 远端目标 host id。非空表示 session 跑在远端机器上，workingDir 必须是远端路径。
   * 目前仅 Codex 支持，Claude session 会忽略。
   */
  remoteHostId?: string;
  /** Agent 在同账号另一台电脑上运行时那台电脑的 deviceId(任务与文件仍在本机)。 */
  agentDeviceId?: string;
  /**
   * per-session 来源(供应商)显式选择。device-link 远程 create 由控制端透传被控端供应商 id
   * (见 deviceLinkCreateArgs);bootstrapSession 据此把 sessions.provider_id 落库,使新会话首个
   * 请求即按所选来源路由。本机交互建会话不经此路径(走 sessionService→sessionCreateToRow 落盘),
   * scheduler / Feishu 不传 → 不写(provider_id 留 NULL = 默认路由);Orca Worker 会传入
   * 已解析的来源,保证 Worker 与其模型选择使用同一条凭证路由。
   */
  providerId?: string | null;
  /**
   * 入口按模式选好来源时的凭据(model-groups/sessionStart.ts prepare)：bootstrapSession 把它挂到这个任务上，
   * 第一轮派发时提交选路、记下任务经哪个模式建的并写说明。不传 = 没经模式。只在 main 内部传。
   */
  modelGroupStart?: string;
  [key: string]: unknown;
}

type StderrLogger = (agentKind: EngineKind, line: string) => void;

export interface ReadCreateSessionOptsDeps {
  allocateDialogueWorkspace?: (sessionId: string, nowMs: number) => string;
  createSessionId?: () => string;
  now?: () => number;
}

function readAgentKind(value: unknown): EngineKind {
  if (value === 'claude-code' || value === 'codex' || value === 'pi') return value;
  // Plugin ACP engine (docs/plans/acp-plugin-bridge.md); further checks in readCreateSessionOpts.
  if (value === 'acp') return value;
  throwIpcError('INVALID_PARAMS', 'agentKind required');
}

function readVendorOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readExplicitWorkingDir(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readWorkspaceKind(value: unknown): WorkspaceKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'project' || value === 'dialogue') return value;
  throwIpcError('INVALID_PARAMS', `invalid workspaceKind: ${String(value)}`);
}

function readDialogueSessionId(value: unknown, createSessionId: (() => string) | undefined): string {
  if (value === undefined || value === null) {
    const id = createSessionId?.();
    if (!id) throwIpcError('INVALID_PARAMS', 'id generator required for dialogue workspace');
    return id;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throwIpcError('INVALID_PARAMS', 'id must be a non-empty string');
  }
  if (!isSafeSessionPathSegment(value)) {
    throwIpcError('INVALID_PARAMS', 'id must be a safe path segment (no separators or ..)');
  }
  return value;
}

export function readCreateSessionOpts(
  input: unknown,
  deps: ReadCreateSessionOptsDeps = {},
): MakerSessionCreateOpts {
  if (Array.isArray(input)) {
    throwIpcError('INVALID_PARAMS', 'createSession opts must be an object');
  }
  const body = requireObject(input, 'createSession opts');
  if (body.planMode !== undefined && typeof body.planMode !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'planMode must be a boolean');
  }
  if (Array.isArray(body.extraDirs) && body.extraDirs.some((dir) =>
    typeof dir === 'string' && isLibraryExtraDirSlot(dir.trim()))) {
    throwIpcError('INVALID_PARAMS', 'extraDirs must not contain Host-owned library slots');
  }
  const agentKind = readAgentKind(body.agentKind);
  const model = requireString(body.model, 'model');
  const workspaceKind = readWorkspaceKind(body.workspaceKind);
  const explicitWorkingDir = readExplicitWorkingDir(body.workingDir);
  const needsDialogueWorkspace =
    workspaceKind === 'dialogue' && !explicitWorkingDir && !!deps.allocateDialogueWorkspace;
  const id = needsDialogueWorkspace
    ? readDialogueSessionId(body.id, deps.createSessionId)
    : body.id;
  // 外部(含 device-link)可控的 session id 会被下游拼进磁盘路径(如 Pi 权限档
  // perm-<id>.json)。未校验的 `../../..` 之类 id 经 path.join 逃出 runtimeDir,writeFile
  // 可覆盖任意可写文件(codex review)。在边界统一限制为安全单段值;缺省(自动生成)放行。
  if (typeof id === 'string' && id.length > 0 && !isSafeSessionPathSegment(id)) {
    throwIpcError('INVALID_PARAMS', 'session id must be a safe path segment');
  }
  const workingDir = needsDialogueWorkspace
    ? deps.allocateDialogueWorkspace!(
        id as string,
        deps.now ? deps.now() : Date.now(),
      )
    : requireString(body.workingDir, 'workingDir');
  // Agent 运行在同账号另一台电脑上：只接受设备 id 形态的值，且不能与 SSH 远端同时使用。
  if (body.agentDeviceId !== undefined && body.agentDeviceId !== null) {
    if (typeof body.agentDeviceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.agentDeviceId)) {
      throwIpcError('INVALID_PARAMS', 'agentDeviceId must be a device id');
    }
    if (typeof body.remoteHostId === 'string' && body.remoteHostId.trim()) {
      throwIpcError('INVALID_PARAMS', 'agentDeviceId cannot be combined with remoteHostId');
    }
  }
  if (agentKind === 'acp') {
    // Plugin engines are chosen through their harness id. They run on this computer, on another
    // computer of the same account, or on a direct provider share (never SSH or invalid peer ids).
    if (!acpHarnessKeyFromProviderId(typeof body.providerId === 'string' ? body.providerId : null)) {
      throwIpcError('INVALID_PARAMS', 'a plugin engine task needs providerId acp-plugin:<plugin>:<harness>');
    }
    if (typeof body.remoteHostId === 'string' && body.remoteHostId.trim()) {
      throwIpcError('INVALID_PARAMS', 'plugin engine tasks do not run in SSH workspaces');
    }
    if (typeof body.agentDeviceId === 'string' && (isSharedTaskPeer(body.agentDeviceId) || parseProviderSharePeer(body.agentDeviceId))) {
      throwIpcError('INVALID_PARAMS', 'invalid plugin engine target device');
    }
  }
  // 模型组凭据只由 main 内部的入口交给 bootstrapSession，界面与其他设备传来的一律不认。
  const callerOpts: Record<string, unknown> = { ...body };
  delete callerOpts.modelGroupStart;
  return {
    ...callerOpts,
    id,
    agentKind,
    workspaceKind,
    workingDir,
    model,
  } as MakerSessionCreateOpts;
}

export function withCreateSessionStderr(
  opts: MakerSessionCreateOpts,
  warnStderr: StderrLogger,
): MakerSessionCreateOpts {
  const vendorOptions = readVendorOptions(opts.vendorOptions);
  const existingHook = vendorOptions.onStderrLine;
  const onStderrLine =
    typeof existingHook === 'function'
      ? existingHook
      : (line: string) => {
          if (line.trim()) warnStderr(opts.agentKind, line);
        };
  return {
    ...opts,
    vendorOptions: { ...vendorOptions, onStderrLine },
  };
}

export function createSessionStderrOptions(log: { warn(message: string): void }) {
  return function buildCreateOptsWithStderr(o: MakerSessionCreateOpts) {
    // 把 vendor 子进程 stderr 引到主进程日志,否则 "process exited with code 1" 之类
    // 的失败信息会被默默丢掉。renderer 仍可以通过 vendorOptions 自定义,这里只在缺省时兜底。
    return withCreateSessionStderr(o, (agentKind, line) =>
      log.warn(`[${agentKind}/stderr] ${line}`),
    );
  };
}

export function isSessionRunningError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'SESSION_RUNNING') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.startsWith('SESSION_RUNNING:');
}
