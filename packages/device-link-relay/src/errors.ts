/**
 * REST 错误:响应体沿用官方 relay 的 `{error:{code,message}}`。
 *
 * 凭证无效用专属的 `RELAY_CREDENTIAL_INVALID`,刻意不用 `UNAUTHORIZED` / `INVALID_TOKEN` /
 * `TOKEN_EXPIRED`:Desktop `serverApiFetch` 收到这三种 401 会刷新并可能登出 Cindy 账号,
 * 自建中转的凭证失效不能牵连官方登录态。
 */
export type RelayErrorCode =
  | 'BAD_REQUEST'
  | 'RELAY_CREDENTIAL_INVALID'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'NOT_SUPPORTED'
  | 'ACCOUNT_MISMATCH'
  | 'QUOTA_EXCEEDED'
  | 'ALREADY_INITIALIZED'
  | 'NOT_INITIALIZED'
  | 'STATE_INVALID'
  | 'INTERNAL';

const HTTP_STATUS: Record<RelayErrorCode, number> = {
  BAD_REQUEST: 400,
  RELAY_CREDENTIAL_INVALID: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  NOT_SUPPORTED: 501,
  ACCOUNT_MISMATCH: 403,
  QUOTA_EXCEEDED: 507,
  ALREADY_INITIALIZED: 409,
  NOT_INITIALIZED: 500,
  STATE_INVALID: 500,
  INTERNAL: 500,
};

export class RelayError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}
