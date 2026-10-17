import { ipcMain } from 'electron';
import { DL_SESSION_HANDOFF_CHANNEL } from '@cindy/device-link';
import { sanitizeSourceName } from '@cindy/maker-shared/message-source';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { hasRemoteBotSessionLookup } from '../device-link/remoteBotSessionBoundary.js';
import { requireObject, throwIpcError } from '../utils/ipcValidate.js';

/**
 * `maker:session:handoff` 的被控端业务体：同账号另一台电脑上的任务，把一条消息发给
 * 本机的既有任务。投递复用本机 send_to_session 的同一条通路（恢复、繁忙排队、落库）。
 *
 * - 只投递到既有任务：不新建、不向第三台电脑转发。
 * - 来源只用于归属展示，不是权限判据：发送方任务 id 加上**服务端认证的控制端设备 id**
 *   前缀（`deviceId::sessionId`，接收方可原样用它回信）；标题来自对端，按不可信文本清洗。
 * - 恢复不在运行的目标任务时按它落库的权限档启动，另一台电脑的来信不提权。
 */
const MAX_MESSAGE_CHARS = 200_000;

export interface SessionHandoffSendParams {
  targetSessionId: string;
  message: string;
  origin: NonNullable<AgentInputQueuedMessage['origin']>;
  resumeWithStoredPermissionMode: true;
}

export type SessionHandoffSendResult =
  | {
      ok: true;
      agentKind: string;
      wakeKind: 'resumed' | 'already-active' | 'created' | 'queued';
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
    }
  | { ok: false; errorCode: string; message: string };

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throwIpcError('INVALID_PARAMS', `Invalid ${name}`);
  }
  return value as string;
}

export function createSessionHandoffHandler(deps: {
  send(params: SessionHandoffSendParams): Promise<SessionHandoffSendResult>;
}) {
  return async (controllerDeviceId: string, value: unknown): Promise<SessionHandoffSendResult> => {
    const request = requireObject(value, 'request');
    const targetSessionId = boundedString(request.sessionId, 'sessionId', 512);
    // 目标必须是本机任务；带设备前缀的 id 属于别的电脑，不代为转发。
    if (targetSessionId.includes('::'))
      throwIpcError('INVALID_PARAMS', 'Handoff cannot forward to another device');
    const message = boundedString(request.message, 'message', MAX_MESSAGE_CHARS);
    const sender = requireObject(request.sender, 'sender');
    // 任务 id 是不透明字符串（IM 任务的 id 可以很长）；只拒绝会伪造设备前缀或说明结构的写法。
    const senderSessionId = boundedString(sender.sessionId, 'sender.sessionId', 512);
    if (senderSessionId.includes('::') || /[\s()「」]/.test(senderSessionId)) {
      throwIpcError('INVALID_PARAMS', 'Invalid sender.sessionId');
    }
    const senderSessionTitle = sanitizeSourceName(sender.title);
    const result = await deps.send({
      targetSessionId,
      message,
      origin: {
        kind: 'session',
        senderSessionId: `${controllerDeviceId}::${senderSessionId}`,
        displayText: message,
        ...(senderSessionTitle ? { senderSessionTitle } : {}),
      },
      resumeWithStoredPermissionMode: true,
    });
    if (!result.ok) return { ok: false, errorCode: result.errorCode, message: result.message };
    return {
      ok: true,
      agentKind: result.agentKind,
      wakeKind: result.wakeKind,
      targetTitle: result.targetTitle,
      targetLastUserSendAt: result.targetLastUserSendAt,
    };
  };
}

/**
 * 不经 preload 暴露。只有已认证的同账号 device-link 隧道能派发；共享任务对端不可用。
 * 隐藏伙伴任务的可见性检查由 dispatch 在可见性查询就绪后执行，未就绪时这里直接拒绝。
 */
export function registerSessionHandoffIpc(
  deps: Parameters<typeof createSessionHandoffHandler>[0],
): void {
  const handle = createSessionHandoffHandler(deps);
  ipcMain.handle(DL_SESSION_HANDOFF_CHANNEL, async (_event, value: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (!context || context.sharedTask || context.channel !== DL_SESSION_HANDOFF_CHANNEL) {
      throwIpcError('PERMISSION_DENIED', 'An authorized device link is required');
    }
    if (!hasRemoteBotSessionLookup())
      throwIpcError('PRECONDITION_FAILED', 'Task visibility is not ready');
    return handle(context!.controllerDeviceId, value);
  });
}
