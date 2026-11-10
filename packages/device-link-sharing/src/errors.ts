/**
 * device-link-server 错误类型。错误体统一 { error: { code, message } } +
 * HTTP status，与 auth-server / @cindy/auth-verify 的契约一致
 * （requireAuth 的 401/403 也是这个结构），客户端解码共用一套逻辑。
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function invalidParams(message: string): AppError {
  return new AppError('INVALID_PARAMS', 400, message);
}

export function unauthorized(message = '未授权'): AppError {
  return new AppError('UNAUTHORIZED', 401, message);
}

export function permissionDenied(message = '无权操作'): AppError {
  return new AppError('PERMISSION_DENIED', 403, message);
}

export function notFound(message = '资源不存在'): AppError {
  return new AppError('NOT_FOUND', 404, message);
}

export function conflict(message = '资源已存在'): AppError {
  return new AppError('CONFLICT', 409, message);
}

export function rateLimited(): AppError {
  return new AppError('RATE_LIMITED', 429, '请求过于频繁');
}

export function internalError(message = '服务内部错误'): AppError {
  return new AppError('INTERNAL_ERROR', 500, message);
}

export function serviceUnavailable(message = '服务暂不可用'): AppError {
  return new AppError('SERVICE_UNAVAILABLE', 503, message);
}

export function ossObjectNotFound(message = '上传对象不存在'): AppError {
  return new AppError('OSS_OBJECT_NOT_FOUND', 404, message);
}
