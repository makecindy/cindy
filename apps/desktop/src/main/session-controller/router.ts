import type { SessionControlRequest, SessionControllerErrorCode, SessionControllerResult, SessionControllerSnapshot, SessionDiagnosis } from '@cindy/maker-shared/session-controller';
import { SESSION_READ_OPERATIONS } from '@cindy/maker-shared/session-controller';
import type { InvokeResultPayload } from '@cindy/device-link';
import { SessionAdmissionError } from './controller.js';
import { remoteSessionTickets, type RemoteSessionTicketOwner } from './remoteTickets.js';

export const SESSION_CONTROL_CHANNEL = 'maker:session-control:v1';

function remoteObservation(request: SessionControlRequest, result: SessionControllerResult<unknown>): SessionControllerResult<unknown> {
  if (!result.ok) return result;
  const project = (snapshot: SessionControllerSnapshot): SessionControllerSnapshot => {
    if (snapshot.target.deviceId !== request.deviceId) throw new SessionAdmissionError('INVALID_ARGS', '远程快照归属与目标不一致。');
    return { ...snapshot, connection: 'online' };
  };
  switch (request.command.operation) {
    case 'inspect': case 'ensureRuntime': return { ok: true, value: project(result.value as SessionControllerSnapshot) };
    case 'listActive': return { ok: true, value: (result.value as SessionControllerSnapshot[]).map(project) };
    case 'diagnose': {
      const diagnosis = result.value as SessionDiagnosis;
      return { ok: true, value: { ...diagnosis, snapshot: project(diagnosis.snapshot) } };
    }
    default: return result;
  }
}

export function remoteSessionFailure(error: unknown, request: SessionControlRequest): SessionControllerResult<never> {
  const raw = error as { code?: string; message?: string };
  const text = raw.message ?? '';
  const code = /\[([A-Z_]+)\]/.exec(text)?.[1] ?? raw.code ?? '';
  const businessKey = 'businessKey' in request.command.args ? request.command.args.businessKey : undefined;
  let errorCode: SessionControllerErrorCode;
  if (error instanceof SessionAdmissionError) errorCode = error.code;
  else if (['NOT_FOUND', 'CONFLICT', 'HOST_NOT_READY', 'UNSUPPORTED_CAPABILITY', 'ROUTE_UNAVAILABLE', 'RESOURCE_UNREACHABLE',
    'UNKNOWN_OUTCOME', 'INVALID_ARGS', 'OWNER_SCOPE_CHANGED', 'DEVICE_OFFLINE', 'DEVICE_UNRESPONSIVE', 'CONTROL_DISABLED'].includes(code)) {
    errorCode = code as SessionControllerErrorCode;
  }
  else if (code === 'INVALID_PARAMS' || code === 'VALIDATION_ERROR') errorCode = 'INVALID_ARGS';
  else if (/CHANNEL_NOT_ALLOWED|PROTOCOL_VERSION/.test(code)) errorCode = 'UNSUPPORTED_CAPABILITY';
  else if (/ACCESS_REVOKED|NOT_AUTHORIZED|PERMISSION_DENIED/.test(code)) errorCode = 'NOT_AUTHORIZED';
  else if (/REMOTE_DISABLED|TARGET_DISABLED/.test(code)) errorCode = 'CONTROL_DISABLED';
  else if (/TIMEOUT|DISCONNECTED|LINK_NOT_OPEN|ECONNRESET|SOCKET|NETWORK_ERROR/.test(code + text)) errorCode = SESSION_READ_OPERATIONS.includes(request.command.operation) ? 'DEVICE_UNRESPONSIVE' : 'UNKNOWN_OUTCOME';
  else if (/OFFLINE|NOT_CONNECTED/.test(code + text)) errorCode = 'DEVICE_OFFLINE';
  else errorCode = 'INTERNAL';
  return { ok: false, errorCode, message: errorCode === 'UNKNOWN_OUTCOME'
    ? '请求结果未知，请使用原业务标识核对结果，不要重复创建或发送。' : text || '设备调用失败。',
    requestId: request.requestId, ...(businessKey ? { idempotencyKey: businessKey } : {}) };
}

/** One device choice; no local fallback, no transport retry for mutations. */
export function createSessionRouter(deps: {
  deviceId(): string;
  local(request: SessionControlRequest): Promise<unknown>;
  remoteInvoke(deviceId: string, channel: string, args: unknown[], options?: { preSend(): void }): Promise<InvokeResultPayload>;
}) {
  return async (request: SessionControlRequest, owner: RemoteSessionTicketOwner): Promise<SessionControllerResult<unknown>> => {
    if (request.target && request.target.deviceId !== request.deviceId) {
      return remoteSessionFailure(new SessionAdmissionError('INVALID_ARGS', '目标设备不一致。'), request);
    }
    if (request.deviceId === deps.deviceId()) {
      try { return { ok: true, value: await deps.local(request) }; }
      catch (error) { return remoteSessionFailure(error, request); }
    }
    let ticket: Awaited<ReturnType<typeof remoteSessionTickets.issue>> | undefined;
    try {
      ticket = await remoteSessionTickets.issue(request, owner);
      const response = await deps.remoteInvoke(request.deviceId, SESSION_CONTROL_CHANNEL,
        [{ request, token: ticket.token, digest: ticket.digest }], { preSend: () => owner.assertCurrent() });
      owner.assertCurrent();
      if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
      return remoteObservation(request, response.result as SessionControllerResult<unknown>);
    } catch (error) { return remoteSessionFailure(error, request); }
    finally { ticket?.release(); }
  };
}
