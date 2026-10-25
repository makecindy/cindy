import {createSessionHandoffHandler as createSharedSessionHandoffHandler,MAX_MESSAGE_CHARS} from '@cindy/app-runtime/sessionHandoffHost';
export type {SessionHandoffSendParams,SessionHandoffSendResult} from '@cindy/app-runtime/sessionHandoffHost';
import type {SessionHandoffSendResult} from '@cindy/app-runtime/sessionHandoffHost';
import { ipcMain } from 'electron';
import { matchesForwardedRequest, readForwardedRequestSource, type AgentRequestReceipt } from '../../shared/forwardedRequest.js';
import { DL_SESSION_HANDOFF_CHANNEL } from '@cindy/device-link';
import { sanitizeSourceName } from '@cindy/maker-shared/message-source';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { hasRemoteBotSessionLookup } from '../device-link/remoteBotSessionBoundary.js';
import { requireObject, throwIpcError } from '../utils/ipcValidate.js';
import type { TaskActionDeliveryGuard } from './taskActionAuthorization.js';
import { validateRemoteTaskActionReceipt } from './remoteTaskActionReceipt.js';

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throwIpcError('INVALID_PARAMS', `Invalid ${name}`);
  }
  return value as string;
}

export function createSessionHandoffHandler(deps:Omit<Parameters<typeof createSharedSessionHandoffHandler>[0],'matchesForwardedRequest'>){return createSharedSessionHandoffHandler({...deps,matchesForwardedRequest});}
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
    const request = requireObject(value, 'request');
    if (request.action === 'task-action-capability') return { taskActionVersion: 1 };
    if (request.action === 'validate-task-action') {
      const valid = await validateRemoteTaskActionReceipt(context!.controllerDeviceId, {
        receiptId: boundedString(request.receiptId, 'receiptId', 128),
        sessionId: boundedString(request.sessionId, 'sessionId', 512),
        targetSessionId: boundedString(request.targetSessionId, 'targetSessionId', 512),
        message: boundedString(request.message, 'message', MAX_MESSAGE_CHARS),
        release: request.release === true,
      });
      return { valid, ...(request.release === true ? { released: valid } : {}) };
    }
    return handle(context!.controllerDeviceId, value);
  });
}
