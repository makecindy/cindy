import { throwIpcError } from '../utils/ipcValidate.js';

/** Orca service result 到 IPC 错误协议的统一翻译，避免不同 handler 的错误码漂移。 */
export function throwOrcaServiceFailure(result: { ok: false; errorCode: string; message: string }): never {
  switch (result.errorCode) {
    case 'INVALID_PARAMS':
      return throwIpcError('INVALID_PARAMS', result.message);
    case 'NOT_FOUND':
      return throwIpcError('NOT_FOUND', result.message);
    case 'ALREADY_EXISTS':
      return throwIpcError('ALREADY_EXISTS', result.message);
    case 'DUPLICATE_LABEL':
      return throwIpcError('DUPLICATE_LABEL', result.message);
    case 'WORKER_CREATION_IN_PROGRESS':
      return throwIpcError('WORKER_CREATION_IN_PROGRESS', result.message);
    case 'WORKER_LIMIT_HARD_EXCEEDED':
      return throwIpcError('WORKER_LIMIT_HARD_EXCEEDED', result.message);
    case 'WORKER_NOT_FOUND':
      return throwIpcError('WORKER_NOT_FOUND', result.message);
    case 'ALREADY_IDLE':
      return throwIpcError('ALREADY_IDLE', result.message);
    case 'WORKER_STATE_CHANGED':
      return throwIpcError('WORKER_STATE_CHANGED', result.message);
    case 'BUDGET_MODEL_REQUIRES_API_MODE':
      return throwIpcError('BUDGET_MODEL_REQUIRES_API_MODE', result.message);
    case 'NO_PROVIDER_FOR_AGENT':
      return throwIpcError('NO_PROVIDER_FOR_AGENT', result.message);
    case 'PROVIDER_ROUTE_UNAVAILABLE':
      return throwIpcError('PROVIDER_ROUTE_UNAVAILABLE', result.message);
    case 'BUSY':
      return throwIpcError('SESSION_RUNNING', result.message);
    // 协同远端 Worker：运行设备不可达 / 版本过旧。device-link 控制端按既有规则降级。
    case 'REMOTE_AGENT_DEVICE_UNREACHABLE':
      return throwIpcError('REMOTE_AGENT_DEVICE_UNREACHABLE', result.message);
    // Worker 用分享来的供应商：分享已暂停 / 已不可用 / 暂时不可用。
    case 'REMOTE_AGENT_SHARE_PAUSED':
      return throwIpcError('REMOTE_AGENT_SHARE_PAUSED', result.message);
    case 'REMOTE_AGENT_SHARE_REMOVED':
      return throwIpcError('REMOTE_AGENT_SHARE_REMOVED', result.message);
    case 'REMOTE_AGENT_SHARE_UNAVAILABLE':
      return throwIpcError('REMOTE_AGENT_SHARE_UNAVAILABLE', result.message);
    case 'UNSUPPORTED_CAPABILITY':
      return throwIpcError('UNSUPPORTED_CAPABILITY', result.message);
    default:
      return throwIpcError('INTERNAL', result.message);
  }
}
