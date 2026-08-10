import type { DialogueDeviceTarget } from './dialogueCreateTarget';

export interface NewMakerDialogueTargetRequest {
  requestId: string;
  deviceId: string | null;
  deviceName: string | null;
}

export interface NewMakerRouteState {
  workspacePrompt: 'generic' | 'dialogue';
  dialogueTargetRequest?: NewMakerDialogueTargetRequest;
}

let dialogueTargetRequestSequence = 0;

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
