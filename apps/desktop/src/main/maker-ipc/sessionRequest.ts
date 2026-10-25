import path from 'node:path';
import { isLibraryExtraDirSlot } from './extraDirsValidator.js';

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

export type { MakerSessionCreateOpts } from '@cindy/orca-workflow/host/sessionTypes';
import type { MakerSessionCreateOpts } from '@cindy/orca-workflow/host/sessionTypes';

type StderrLogger = (agentKind: AgentKind, line: string) => void;

export interface ReadCreateSessionOptsDeps {
  allocateDialogueWorkspace?: (sessionId: string, nowMs: number) => string;
  createSessionId?: () => string;
  now?: () => number;
}

function readAgentKind(value: unknown): AgentKind {
  if (value === 'claude-code' || value === 'codex' || value === 'pi') return value;
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
  if (typeof id === 'string' && id.length > 0 && !isSafePathSegment(id)) {
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
