/**
 * get_message_status 的 device-link adapter。
 *
 * 目标会话形如 deviceId::sessionId 时，经现有 device-link 只读 invoke 通道
 * （maker:input:message-status，被控端复用本机同一份状态判定）查询；
 * 隧道/IPC 错误复用 classifyRemoteHistoryError 收敛成稳定 REMOTE_* 业务码，
 * 老被控端无 handler 时 CHANNEL_NOT_ALLOWED → REMOTE_UNSUPPORTED。
 */
import {
  DeviceLinkError,
  type InvokeResultPayload,
} from '@cindy/device-link';
import type {
  ControlResult,
  MessageStatusErrorCode,
  MessageStatusSnapshot,
} from '@cindy/mcps';

import { MAKER_INVOKE } from '../maker-ipc/channels.js';
import { classifyRemoteHistoryError } from './remoteChatHistory.js';

export interface RemoteMessageStatusDeps {
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
  ): Promise<InvokeResultPayload>;
}

const STATUS_VALUES = new Set([
  'queued',
  'processing',
  'dispatched',
  'consumed',
  'failed',
]);

function errorResult(
  errorCode: MessageStatusErrorCode,
  message: string,
): ControlResult<MessageStatusSnapshot, MessageStatusErrorCode> {
  return { ok: false, errorCode, message };
}

function isSnapshot(value: unknown): value is MessageStatusSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === false) return false;
  return typeof record.status === 'string' && STATUS_VALUES.has(record.status);
}

/** Query one delivered message's status on the device that owns the session. */
export async function readRemoteMessageStatus(
  target: { deviceId: string; sessionId: string; messageId: string },
  deps: RemoteMessageStatusDeps,
): Promise<ControlResult<MessageStatusSnapshot, MessageStatusErrorCode>> {
  let response: InvokeResultPayload;
  try {
    response = await deps.invoke(target.deviceId, MAKER_INVOKE.INPUT_MESSAGE_STATUS, [
      target.sessionId,
      target.messageId,
    ]);
  } catch (err) {
    if (err instanceof DeviceLinkError) {
      const classified = classifyRemoteHistoryError(err.code, err.message);
      return errorResult(classified.errorCode, classified.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    const encoded = /(?:^|:\s*(?:Error:\s*)?)\[([A-Z0-9_]+)]/.exec(message);
    const classified = encoded
      ? classifyRemoteHistoryError(encoded[1], message)
      : classifyRemoteHistoryError('INTERNAL', message);
    return errorResult(classified.errorCode, classified.message);
  }

  if (!response.ok) {
    const classified = classifyRemoteHistoryError(
      response.error.code,
      response.error.message,
    );
    return errorResult(classified.errorCode, classified.message);
  }
  const result = response.result as Record<string, unknown> | null;
  if (result && result.ok === false) {
    const code = typeof result.errorCode === 'string' ? result.errorCode : 'INTERNAL';
    const message = typeof result.message === 'string' ? result.message : 'remote query failed';
    // 远端业务错误码与本机一致；不在公开词汇表内的归一成 INTERNAL。
    const known = new Set([
      'NOT_FOUND',
      'INVALID_ARGS',
      'HOST_NOT_READY',
      'INTERNAL',
      'REMOTE_UNSUPPORTED_QUERY',
      'REMOTE_DEVICE_OFFLINE',
      'REMOTE_LINK_REQUIRED',
      'DEVICE_LINK_NOT_READY',
      'REMOTE_DISABLED',
      'REMOTE_ACCESS_REVOKED',
      'REMOTE_UNSUPPORTED',
      'REMOTE_TIMEOUT',
      'REMOTE_PAYLOAD_TOO_LARGE',
    ]);
    return errorResult(
      (known.has(code) ? code : 'INTERNAL') as MessageStatusErrorCode,
      message.slice(0, 500),
    );
  }
  const { ok: _ok, ...snapshot } = (result ?? {}) as Record<string, unknown> & { ok?: unknown };
  if (!isSnapshot(snapshot)) {
    return errorResult('INTERNAL', 'remote message status returned a malformed result');
  }
  return { ok: true, ...(snapshot as MessageStatusSnapshot) };
}
