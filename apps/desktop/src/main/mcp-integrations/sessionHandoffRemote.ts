import {
  DeviceLinkError,
  DL_SESSION_HANDOFF_CHANNEL,
  type InvokeResultPayload,
} from '@cindy/device-link';

/**
 * send_to_session 的跨电脑发送端：把消息交给目标电脑，由它用本机 send_to_session 的
 * 同一条通路投递到既有任务（恢复、排队、落库一致）。授权沿用同账号远程控制。
 * 不重试：没有回执时报 DELIVERY_UNKNOWN，由调用方先查再决定是否重发。
 */
export interface QualifiedSessionTarget {
  deviceId: string;
  sessionId: string;
}

export interface RemoteSessionHandoffRequest {
  sessionId: string;
  message: string;
  sender: { sessionId: string; title?: string };
}

export type RemoteSessionHandoffResult =
  | {
      ok: true;
      agentKind: 'claude-code' | 'codex' | 'pi';
      wakeKind: 'resumed' | 'already-active' | 'queued';
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
    }
  | { ok: false; errorCode: RemoteSessionHandoffErrorCode; message: string };

export type RemoteSessionHandoffErrorCode =
  | 'NOT_FOUND'
  | 'ARCHIVED'
  | 'DELETED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INVALID_ARGS'
  | 'HOST_NOT_READY'
  | 'REMOTE_UNSUPPORTED'
  | 'REMOTE_DEVICE_OFFLINE'
  | 'REMOTE_DISABLED'
  | 'REMOTE_UNAVAILABLE'
  | 'DELIVERY_UNKNOWN';

/**
 * 目标电脑明确拒绝、消息没有进入目标任务的错误码（与本机 send_to_session 同名同义）。
 * AGENT_NOT_READY 不在其中：它可能发生在消息已记入目标任务之后，按结果未知处理。
 */
const TARGET_REJECTIONS = new Set<string>([
  'NOT_FOUND',
  'ARCHIVED',
  'DELETED',
  'UNSUPPORTED_CAPABILITY',
  'INVALID_ARGS',
  'HOST_NOT_READY',
]);
const AGENT_KINDS = new Set(['claude-code', 'codex', 'pi']);
const WAKE_KINDS = new Set(['resumed', 'already-active', 'queued']);

function encodedIpcCode(message: string): string | null {
  return /(?:^|:\s*(?:Error:\s*)?)\[([A-Z0-9_]+)]/.exec(message)?.[1] ?? null;
}

/** 只有能证明「请求没有到达对方业务处理」的错误才报未发出；其余一律按结果未知。 */
function transportFailure(
  code: string,
  message: string,
): RemoteSessionHandoffResult & { ok: false } {
  const actual = code === 'IPC_ERROR' ? (encodedIpcCode(message) ?? code) : code;
  switch (actual) {
    case 'CHANNEL_NOT_ALLOWED':
    case 'VERSION_MISMATCH':
      return {
        ok: false,
        errorCode: 'REMOTE_UNSUPPORTED',
        message: '目标电脑的版本不支持接收其它电脑的任务消息，消息没有发出。',
      };
    case 'DEVICE_OFFLINE':
      return {
        ok: false,
        errorCode: 'REMOTE_DEVICE_OFFLINE',
        message: '目标电脑不在线，消息没有发出。',
      };
    case 'REMOTE_DISABLED':
    case 'DEVICE_LINK_CONTROL_DISABLED':
    case 'ACCESS_REVOKED':
    case 'PERMISSION_DENIED':
      return {
        ok: false,
        errorCode: 'REMOTE_DISABLED',
        message: '目标电脑未允许本机远程控制，消息没有发出。',
      };
    case 'LINK_NOT_OPEN':
    case 'NOT_CONNECTED':
    case 'BACKPRESSURE':
    case 'DEVICE_LINK_NOT_CONNECTED':
    case 'DEVICE_LINK_STANDBY':
      return {
        ok: false,
        errorCode: 'REMOTE_UNAVAILABLE',
        message: '暂时无法连接目标电脑，消息没有发出。',
      };
    // 隧道层的 NOT_FOUND 不在此列：被控端在 handler 完成后复核可见性与账号时也抛它，
    // 无法与投递前的拒绝区分，落到下面的结果未知。目标任务不存在由 handler 以数据返回。
    case 'INVALID_PARAMS':
      return { ok: false, errorCode: 'INVALID_ARGS', message: '目标电脑拒绝了这条消息的参数。' };
    default:
      return {
        ok: false,
        errorCode: 'DELIVERY_UNKNOWN',
        message: '没有收到目标电脑的回执，消息可能已送达。重发前请先读取该任务的聊天记录确认。',
      };
  }
}

export function createRemoteSessionHandoff(deps: {
  captureAccess(): () => void;
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void },
  ): Promise<InvokeResultPayload>;
}) {
  return async (
    target: QualifiedSessionTarget,
    request: {
      message: string;
      /** 在账号记录之后读取，使来源查询也落在同一道 owner 检查之内。 */
      sender(): Promise<RemoteSessionHandoffRequest['sender']>;
    },
  ): Promise<RemoteSessionHandoffResult> => {
    const notSent = (): RemoteSessionHandoffResult => ({
      ok: false,
      errorCode: 'HOST_NOT_READY',
      message: '账号正在切换，消息没有发出。',
    });
    // 同一份账号记录覆盖整次调用：读来源之前记录，发送前与收到回执后各核对一次。
    let assertCurrent: () => void;
    let sender: RemoteSessionHandoffRequest['sender'];
    try {
      assertCurrent = deps.captureAccess();
      sender = await request.sender();
      assertCurrent();
    } catch {
      return notSent();
    }
    let response: InvokeResultPayload;
    try {
      const wire: RemoteSessionHandoffRequest = {
        sessionId: target.sessionId,
        message: request.message,
        sender,
      };
      response = await deps.invoke(target.deviceId, DL_SESSION_HANDOFF_CHANNEL, [wire], {
        preSend: assertCurrent,
      });
    } catch (error) {
      // inFlight = 请求帧已发出、只是回执丢了：对端可能已执行，不能报「没有发出」。
      if (error instanceof DeviceLinkError) {
        return transportFailure(error.inFlight ? 'UNKNOWN' : error.code, error.message);
      }
      // 发送前的本机拒绝（另一实例持有连接、本机关闭了对该设备的控制等）以 [CODE] 前缀抛出。
      return transportFailure('IPC_ERROR', error instanceof Error ? error.message : '');
    }
    try {
      assertCurrent();
    } catch {
      // 请求已发出、账号随后切换：回执属于上一个账号，不读取也不返回其中的任务信息。
      return transportFailure('UNKNOWN', '');
    }
    if (!response.ok) return transportFailure(response.error.code, response.error.message);
    const result = response.result as Record<string, unknown> | null;
    if (!result || typeof result !== 'object' || Array.isArray(result))
      return transportFailure('UNKNOWN', '');
    if (result.ok === false) {
      // 其它错误（如目标电脑的内部错误）可能发生在消息已记入目标任务之后，不能说没有发出。
      if (typeof result.errorCode !== 'string' || !TARGET_REJECTIONS.has(result.errorCode)) {
        return transportFailure('UNKNOWN', '');
      }
      return {
        ok: false,
        errorCode: result.errorCode as RemoteSessionHandoffErrorCode,
        message:
          typeof result.message === 'string'
            ? result.message.slice(0, 500)
            : '目标电脑没有接受这条消息。',
      };
    }
    if (
      result.ok !== true ||
      !AGENT_KINDS.has(String(result.agentKind)) ||
      !WAKE_KINDS.has(String(result.wakeKind))
    ) {
      return transportFailure('UNKNOWN', '');
    }
    return {
      ok: true,
      agentKind: result.agentKind as 'claude-code' | 'codex' | 'pi',
      wakeKind: result.wakeKind as 'resumed' | 'already-active' | 'queued',
      targetTitle: typeof result.targetTitle === 'string' ? result.targetTitle : null,
      targetLastUserSendAt:
        typeof result.targetLastUserSendAt === 'string' ? result.targetLastUserSendAt : null,
    };
  };
}
