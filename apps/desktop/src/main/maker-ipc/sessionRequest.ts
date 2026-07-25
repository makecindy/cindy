import path from 'node:path';

import type { AgentKind, CreateSessionOptions, WorkspaceKind } from '@cindy/maker-core';

import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';

/**
 * A caller-supplied dialogue session id becomes a path segment under the app-managed
 * dialogue root (buildDialogueWorkspaceDir → path.join). Only accept a single safe
 * basename so a remote `maker:create-session` caller can't use `..` / path separators /
 * absolute paths in `id` to escape that root and bypass the remote working-directory guard.
 */
function isSafePathSegment(value: string): boolean {
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false;
  return path.basename(value) === value;
}

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
  /**
   * 远端目标 host id。非空表示 session 跑在远端机器上，workingDir 必须是远端路径。
   * 目前仅 Codex 支持，Claude session 会忽略。
   */
  remoteHostId?: string;
  /**
   * per-session 来源(供应商)显式选择。device-link 远程 create 由控制端透传被控端供应商 id
   * (见 deviceLinkCreateArgs);bootstrapSession 据此把 sessions.provider_id 落库,使新会话首个
   * 请求即按所选来源路由。本机交互建会话不经此路径(走 sessionService→sessionCreateToRow 落盘),
   * scheduler / Feishu 不传 → 不写(provider_id 留 NULL = 默认路由);Orca Worker 会传入
   * 已解析的来源,保证 Worker 与其模型选择使用同一条凭证路由。
   */
  providerId?: string | null;
  [key: string]: unknown;
}

type StderrLogger = (agentKind: AgentKind, line: string) => void;

export interface ReadCreateSessionOptsDeps {
  allocateDialogueWorkspace?: (sessionId: string, nowMs: number) => string;
  createSessionId?: () => string;
  now?: () => number;
}

function readAgentKind(value: unknown): AgentKind {
  if (value === 'claude-code' || value === 'codex') return value;
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
  if (!isSafePathSegment(value)) {
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
  const agentKind = readAgentKind(body.agentKind);
  const model = requireString(body.model, 'model');
  const workspaceKind = readWorkspaceKind(body.workspaceKind);
  const explicitWorkingDir = readExplicitWorkingDir(body.workingDir);
  const needsDialogueWorkspace =
    workspaceKind === 'dialogue' && !explicitWorkingDir && !!deps.allocateDialogueWorkspace;
  const id = needsDialogueWorkspace
    ? readDialogueSessionId(body.id, deps.createSessionId)
    : body.id;
  const workingDir = needsDialogueWorkspace
    ? deps.allocateDialogueWorkspace!(
        id as string,
        deps.now ? deps.now() : Date.now(),
      )
    : requireString(body.workingDir, 'workingDir');
  return {
    ...body,
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
