import type { DialogueDeviceTarget } from './dialogueCreateTarget';
import type { NewMakerSessionSeed } from './newMakerSessionSeed';

export interface NewMakerDialogueTargetRequest {
  requestId: string;
  deviceId: string | null;
  deviceName: string | null;
}

export interface NewMakerFolderPickerRequest {
  requestId: string;
}

export interface NewMakerRouteState {
  workspacePrompt: 'generic' | 'dialogue';
  dialogueTargetRequest?: NewMakerDialogueTargetRequest;
  sessionTargetRequest?: NewMakerSessionTargetRequest;
  folderPickerRequest?: NewMakerFolderPickerRequest;
}

let dialogueTargetRequestSequence = 0;
let folderPickerRequestSequence = 0;
let sessionTargetRequestSequence = 0;

export interface NewMakerSessionTargetRequest {
  requestId: string;
  deviceId: string | null;
  deviceName: string | null;
  workingDir: string | null;
  remoteHostId: string | null;
  runtime: NewMakerSessionSeed['runtime'];
}

/**
 * “对话”分组每次点击都生成新 requestId。同路由重复 navigate 不会 remount 创建页，
 * 但 location.state 会更新，创建页可据此再次执行完整 target transition。
 */
export function makeDialogueNewMakerRouteState(
  target: DialogueDeviceTarget | null,
): NewMakerRouteState {
  dialogueTargetRequestSequence += 1;
  return {
    workspacePrompt: 'dialogue',
    dialogueTargetRequest: {
      requestId: `${Date.now()}-${dialogueTargetRequestSequence}`,
      deviceId: target?.deviceId ?? null,
      deviceName: target?.deviceName ?? null,
    },
  };
}

export function makeSessionTargetRouteState(
  seed: NewMakerSessionSeed,
  workspacePrompt: 'generic' | 'dialogue',
): NewMakerRouteState {
  sessionTargetRequestSequence += 1;
  return {
    workspacePrompt,
    sessionTargetRequest: {
      requestId: 'seed-request-' + Date.now() + '-' + sessionTargetRequestSequence,
      deviceId: seed.target.deviceId,
      deviceName: seed.target.deviceName,
      workingDir: seed.target.workingDir,
      remoteHostId: seed.target.remoteHostId,
      runtime: seed.runtime,
    },
  };
}

export function makeFolderPickerNewMakerRouteState(): NewMakerRouteState {
  folderPickerRequestSequence += 1;
  return {
    workspacePrompt: 'generic',
    folderPickerRequest: {
      requestId: `${Date.now()}-${folderPickerRequestSequence}`,
    },
  };
}

export function readNewMakerFolderPickerRequest(state: unknown): NewMakerFolderPickerRequest | null {
  if (!state || typeof state !== 'object') return null;
  const request = (state as Record<string, unknown>).folderPickerRequest;
  if (!request || typeof request !== 'object') return null;
  const requestId = (request as Record<string, unknown>).requestId;
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  return { requestId };
}

export function consumeNewMakerFolderPickerRequest(state: unknown): unknown {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  if (!Object.prototype.hasOwnProperty.call(state, 'folderPickerRequest')) return state;
  const { folderPickerRequest: _consumed, ...remainingState } = state as Record<string, unknown>;
  return remainingState;
}

export function readNewMakerDialogueTargetRequest(
  state: unknown,
): NewMakerDialogueTargetRequest | null {
  if (!state || typeof state !== 'object') return null;
  const request = (state as Record<string, unknown>).dialogueTargetRequest;
  if (!request || typeof request !== 'object') return null;
  const record = request as Record<string, unknown>;
  if (typeof record.requestId !== 'string' || record.requestId.length === 0) return null;
  const deviceId = record.deviceId;
  const deviceName = record.deviceName;
  if (deviceId !== null && (typeof deviceId !== 'string' || deviceId.length === 0)) return null;
  if (deviceName !== null && typeof deviceName !== 'string') return null;
  if (deviceId === null && deviceName !== null) return null;
  return { requestId: record.requestId, deviceId, deviceName };
}

/**
 * dialogueTargetRequest 是一次性导航指令。首次应用后从当前 history entry 移除，避免用户
 * 浏览器后退到旧的 /cc-agent/new 记录时再次迁移草稿目标；其它 route state 必须原样保留。
 */
export function consumeNewMakerDialogueTargetRequest(state: unknown): unknown {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  if (!Object.prototype.hasOwnProperty.call(state, 'dialogueTargetRequest')) return state;
  const { dialogueTargetRequest: _consumed, ...remainingState } = state as Record<string, unknown>;
  return remainingState;
}

export function readNewMakerSessionTargetRequest(
  state: unknown,
): NewMakerSessionTargetRequest | null {
  if (!state || typeof state !== 'object') return null;
  const request = (state as Record<string, unknown>).sessionTargetRequest;
  if (!request || typeof request !== 'object') return null;
  const record = request as Record<string, unknown>;
  if (typeof record.requestId !== 'string' || record.requestId.length === 0) return null;
  const deviceId = record.deviceId;
  const deviceName = record.deviceName;
  const workingDir = record.workingDir;
  const remoteHostId = record.remoteHostId;
  if (
    (deviceId !== null && (typeof deviceId !== 'string' || deviceId.length === 0))
    || (deviceName !== null && typeof deviceName !== 'string')
    || (workingDir !== null && (typeof workingDir !== 'string' || workingDir.length === 0))
    || (remoteHostId !== null && (typeof remoteHostId !== 'string' || remoteHostId.length === 0))
  ) {
    return null;
  }
  if (deviceId === null && deviceName !== null) return null;
  if (deviceId !== null && remoteHostId !== null) return null;
  const runtime = record.runtime;
  const runtimeRecord = runtime as Record<string, unknown> | undefined;
  if (
    !runtimeRecord
    || typeof runtimeRecord !== 'object'
    || (
      runtimeRecord.vendor !== 'cc'
      && runtimeRecord.vendor !== 'codex'
      && runtimeRecord.vendor !== 'pi'
    )
    || typeof runtimeRecord.model !== 'string'
    || runtimeRecord.model.length === 0
    || typeof runtimeRecord.effort !== 'string'
    || runtimeRecord.effort.length === 0
    || (
      typeof runtimeRecord.providerId !== 'string'
      && runtimeRecord.providerId !== null
    )
    || typeof runtimeRecord.permissionMode !== 'string'
    || runtimeRecord.permissionMode.length === 0
    || typeof runtimeRecord.planMode !== 'boolean'
    || typeof runtimeRecord.fastMode !== 'boolean'
  ) {
    return null;
  }
  return {
    requestId: record.requestId,
    deviceId,
    deviceName,
    workingDir,
    remoteHostId,
    runtime: runtimeRecord as NewMakerSessionTargetRequest['runtime'],
  };
}

export function consumeNewMakerSessionTargetRequest(state: unknown): unknown {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  if (!Object.prototype.hasOwnProperty.call(state, 'sessionTargetRequest')) return state;
  const { sessionTargetRequest: _consumed, ...remainingState } = state as Record<string, unknown>;
  return remainingState;
}
